'use strict';
// The dashboard's transport. Localhost only, read-only, and started lazily — a session that
// never opens the dashboard never opens a port.
//
// One hub per machine, not one per session. Each session runs its own MCP server, and each used
// to open its own page on the next free port, so four projects meant four tabs and nowhere to see
// which of them was waiting on you. Now the first server to take the port is the hub and serves
// every project on the machine's list (lib/projects.js); the others see a keel hub already there
// and hand back its URL. When the hub's session ends, any server that has opened the dashboard
// takes the port over, and the list on disk brings every project back with it.
//
// Nothing registers over HTTP. The hub learns about projects only by reading the list, so no page
// on any origin can point it at a directory.
//
// Push rather than poll: `keel board --watch` sha1s four files every second, which is fine for a
// terminal and wasteful for a page that is open all day. fs.watch tells us when a project's .keel
// changed, the fingerprint tells us whether the change was one anybody cares about, and only then
// does a frame go out.
const http = require('http');
const fs = require('fs');
const path = require('path');

const view = require('./view');

// Set once by `keel dashboard --demo`: every project then draws the bundled example instead of
// its own map, so the console can be refused and a screenshot never shows somebody's real code.
let demoMode = false;
const ui = require('./ui');
const config = require('../lib/config');
const projects = require('../lib/projects');

const DEFAULT_PORT = Number(process.env.KEEL_DASHBOARD_PORT) || 7391;
const HOST = '127.0.0.1';
const DEBOUNCE_MS = 150;
const HEARTBEAT_MS = 25000;
const REGISTRY_POLL_MS = 2000;
const TAKEOVER_MS = Number(process.env.KEEL_TAKEOVER_MS) || 10000;
const PROBE_MS = 800;
const MAX_WALK = 12;

let server = null;
let url = null;
let joined = null;          // the hub URL when another process holds it
let pending = null;
let clients = new Set();    // { res, project: id | null } — null is the overview
let entries = new Map();    // id -> { id, root, name, keel, lastSeen, watchers, timer, fp, summary }
let wanted = new Map();     // id -> root, every project this process asked to show
let homeId = null;
let heartbeat = null;
let registryPoll = null;
let registryMtime = -1;
let takeover = null;
// Minted per hub and handed only to the page this server serves. A cross-origin page can read
// neither this nor set a custom header on a no-cors request, which is what stops it driving the
// console by guessing the port.
let consoleToken = require('crypto').randomBytes(24).toString('hex');

function send(res, code, type, body) {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    // The page talks only to its own origin; nothing else may read it.
    'Access-Control-Allow-Origin': 'null',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}
const json = (res, code, body) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(body));

function hello() {
  return { keel: true, version: projects.keelVersion(), pid: process.pid };
}

function viewOf(root) {
  try { return view.build(root, demoMode ? { demo: true } : {}); }
  catch (e) { return { at: new Date().toISOString(), error: String((e && e.message) || e), active: false }; }
}

// A project's map, or the bundled example when it has none. `--demo` forces the example for every
// project, which is what makes a screenshot reproducible without a repo to point it at.
function mapFor(root) {
  const map = require('../lib/map');
  try {
    if (demoMode || !root) return map.demo();
    return map.forDashboard(require('../lib/config').load(root));
  } catch (e) { return null; }
}

function summaryOf(root) {
  try { return view.summary(root); }
  catch (e) { return { root, error: String((e && e.message) || e), active: false }; }
}

function projectList() {
  const version = projects.keelVersion();
  return Array.from(entries.values())
    .map((e) => Object.assign({}, e.summary, {
      id: e.id, name: e.name, root: e.root, keel: e.keel || null, lastSeen: e.lastSeen || null,
      home: e.id === homeId,
      // Registered by a different keel than the one serving this page: its view is being built
      // by code it was not written against, and the user should know.
      mismatch: !!(e.keel && version && e.keel !== version),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function frame(res, event, data) {
  try {
    res.write((event ? `event: ${event}\n` : '') + 'data: ' + JSON.stringify(data) + '\n\n');
    return true;
  } catch (e) { return false; }
}

function broadcastProjects() {
  if (!clients.size) return;
  const list = { at: new Date().toISOString(), version: projects.keelVersion(), projects: projectList() };
  for (const c of Array.from(clients)) if (!frame(c.res, 'projects', list)) clients.delete(c);
}

function broadcastView(entry) {
  let payload = null;
  for (const c of Array.from(clients)) {
    if (c.project !== entry.id) continue;
    payload = payload || viewOf(entry.root);
    if (!frame(c.res, null, payload)) clients.delete(c);
  }
}

// Coalesce a burst of writes — a single `keel state green-done` touches several files — and then
// only push if the fingerprint actually moved.
function onChange(entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    let fp = '';
    try { fp = view.fingerprint(entry.root); } catch (e) { fp = String(Date.now()); }
    if (fp === entry.fp) return;
    entry.fp = fp;
    entry.summary = summaryOf(entry.root);
    broadcastView(entry);
    broadcastProjects();
  }, DEBOUNCE_MS);
  if (entry.timer.unref) entry.timer.unref();
}

function startWatching(entry) {
  stopWatching(entry);
  const root = entry.root;
  const dirs = [path.join(root, '.keel'), path.join(root, '.keel', 'logs')];
  for (const d of dirs) {
    try {
      if (!fs.existsSync(d)) continue;
      const w = fs.watch(d, { persistent: false }, () => onChange(entry));
      w.on('error', () => {});
      entry.watchers.push(w);
    } catch (e) { /* a directory we cannot watch just means a staler page */ }
  }
  // .keel/logs is created on the first event; without this the feed would stay dark until
  // something else in .keel changed.
  try {
    if (!entry.watchers.length) return;
    const logs = path.join(root, '.keel', 'logs');
    if (!fs.existsSync(logs)) {
      entry.retry = setInterval(() => {
        if (!fs.existsSync(logs)) return;
        clearInterval(entry.retry);
        entry.retry = null;
        if (entries.get(entry.id) === entry) startWatching(entry);
      }, 2000);
      if (entry.retry.unref) entry.retry.unref();
    }
  } catch (e) { /* best effort */ }
}

function stopWatching(entry) {
  for (const w of entry.watchers || []) { try { w.close(); } catch (e) { /* already closed */ } }
  entry.watchers = [];
  if (entry.retry) { clearInterval(entry.retry); entry.retry = null; }
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
}

// Bring the watched set in line with the list on disk, plus whatever this process asked for —
// so a machine whose ~/.keel cannot be written still shows at least its own project.
function syncProjects() {
  registryMtime = projects.mtime();
  const want = new Map(projects.list().map((p) => [p.id, p]));
  for (const [id, root] of wanted) {
    if (!want.has(id) && fs.existsSync(path.join(root, '.keel', 'config.yml'))) {
      want.set(id, { id, root, name: path.basename(root) });
    }
  }
  let changed = false;
  for (const [id, e] of entries) {
    if (want.has(id)) continue;
    stopWatching(e);
    entries.delete(id);
    changed = true;
  }
  for (const [id, p] of want) {
    const have = entries.get(id);
    if (have) {
      if (have.name !== p.name || have.keel !== p.keel || have.lastSeen !== p.lastSeen) changed = true;
      Object.assign(have, { name: p.name, keel: p.keel, lastSeen: p.lastSeen });
      continue;
    }
    const e = { id, root: p.root, name: p.name, keel: p.keel, lastSeen: p.lastSeen, watchers: [], timer: null };
    try { e.fp = view.fingerprint(e.root); } catch (err) { e.fp = ''; }
    e.summary = summaryOf(e.root);
    entries.set(id, e);
    startWatching(e);
    changed = true;
  }
  if (changed) broadcastProjects();
}

// DNS rebinding: a page on evil.example that re-resolves its own name to 127.0.0.1 would be
// same-origin with us. The Host header is the one thing it cannot fake.
function hostOk(req) {
  const h = String(req.headers.host || '');
  const port = server && server.address() ? server.address().port : null;
  return h === `${HOST}:${port}` || h === `localhost:${port}`;
}

function handle(req, res) {
  if (!hostOk(req)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden host');
  // A path like `//` is a protocol-relative URL with no host, and URL() throws on it. Uncaught,
  // that one request took down `keel dashboard`.
  let u;
  try { u = new URL(String(req.url || '/'), 'http://x'); } catch (e) { return send(res, 400, 'text/plain; charset=utf-8', 'bad request'); }
  const route = u.pathname;
  const pick = u.searchParams.get('project') || homeId;

  if (route === '/' || route === '/index.html') {
    return send(res, 200, 'text/html; charset=utf-8', ui.html(consoleToken));
  }
  if (route.startsWith('/api/console/')) return console_(req, res, route.slice('/api/console/'.length), pick);
  if (route === '/api/hello') return json(res, 200, hello());
  if (route === '/api/projects') {
    return json(res, 200, { at: new Date().toISOString(), version: projects.keelVersion(), home: homeId, projects: projectList() });
  }
  // The figure, fetched once per view rather than pushed on every frame: it is the only large
  // thing this server sends, and it changes only when somebody runs `keel map build`.
  if (route === '/api/map') {
    const e = entries.get(pick);
    if (!e && !demoMode) return json(res, 404, { error: `no project "${pick}"` });
    const m = mapFor(e ? e.root : null);
    if (!m) return json(res, 404, { error: 'no map, and no bundled example to fall back to' });
    return json(res, 200, m);
  }
  if (route === '/api/view') {
    const e = entries.get(pick);
    if (!e) return json(res, 404, { error: `no project "${pick}"` });
    return json(res, 200, Object.assign(viewOf(e.root), { project: e.id, name: e.name }));
  }
  if (route === '/events') {
    const overview = u.searchParams.has('overview');
    const e = overview ? null : entries.get(pick);
    if (!overview && !e) return json(res, 404, { error: `no project "${pick}"` });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    const c = { res, project: e ? e.id : null };
    frame(res, 'projects', { at: new Date().toISOString(), version: projects.keelVersion(), home: homeId, projects: projectList() });
    if (e) frame(res, null, Object.assign(viewOf(e.root), { project: e.id, name: e.name }));
    clients.add(c);
    req.on('close', () => clients.delete(c));
    return undefined;
  }
  return send(res, 404, 'text/plain; charset=utf-8', 'not found');
}

// Four barriers, and every one of them has to hold. hostOk (already applied above) stops DNS
// rebinding. The other three stop the case it never covered: a page the developer has open in
// another tab can POST here with mode:'no-cors' and the request is delivered, even though the
// reply is unreadable. That was harmless while every route was a side-effect-free GET.
function csrfOk(req) {
  const h = req.headers || {};
  const origin = h.origin;
  if (origin && origin !== url && origin !== `http://localhost:${server ? server.address().port : ''}`) return false;
  const site = h['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (!/^application\/json/.test(String(h['content-type'] || ''))) return false;
  return h['x-keel-console'] === consoleToken;
}

function console_(req, res, tab, pick) {
  if (req.method !== 'POST') return json(res, 405, { error: 'the console is POST only' });
  if (!csrfOk(req)) return json(res, 403, { error: 'this request did not come from the dashboard page' });
  const e = entries.get(pick);
  if (!e && !demoMode) return json(res, 404, { error: `no project "${pick}"` });
  let raw = '';
  let over = false;
  req.on('data', (d) => {
    raw += d;
    // A console request is a few hundred bytes. Anything larger is not one.
    if (raw.length > 64 * 1024) { over = true; req.destroy(); }
  });
  req.on('end', () => {
    if (over) return json(res, 413, { error: 'that request is too large to be a console request' });
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (err) { return json(res, 400, { error: 'the body is not JSON' }); }
    return require('./console').run(e ? e.root : null, tab, body, { demo: demoMode })
      .then((r) => json(res, r.status || (r.ok ? 200 : 403), r))
      .catch((err) => json(res, 500, { ok: false, error: String((err && err.message) || err) }));
  });
  return undefined;
}

function tryListen(port) {
  return new Promise((resolve) => {
    const s = http.createServer(handle);
    s.once('error', (err) => resolve({ err }));
    s.once('listening', () => {
      s.on('error', () => {});
      resolve({ server: s });
    });
    s.listen(port, HOST);
  });
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/api/hello', timeout: PROBE_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
      res.on('end', () => {
        try { const h = JSON.parse(body); resolve(h && h.keel === true ? h : null); } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function becomeHub(s) {
  server = s;
  joined = null;
  const port = s.address().port;
  url = `http://${HOST}:${port}`;
  if (takeover) { clearInterval(takeover); takeover = null; }
  syncProjects();
  registryPoll = setInterval(() => {
    if (projects.mtime() !== registryMtime) syncProjects();
  }, REGISTRY_POLL_MS);
  if (registryPoll.unref) registryPoll.unref();
  heartbeat = setInterval(() => {
    for (const c of Array.from(clients)) {
      try { c.res.write(': ping\n\n'); } catch (e) { clients.delete(c); }
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();
  // The server must not hold the MCP process open on its own.
  if (s.unref) s.unref();
}

// The hub lives inside some other session's MCP server, and goes when that session does. Keep
// trying for its port; the page reconnects by itself, and finds us there.
function armTakeover(port) {
  if (takeover || server) return;
  takeover = setInterval(() => {
    tryListen(port).then((r) => { if (r.server && !server) becomeHub(r.server); else if (r.server) r.server.close(); });
  }, TAKEOVER_MS);
  if (takeover.unref) takeover.unref();
}

// Take the port, or find the keel hub that already has it. Something that is not keel on the
// port is walked past, as before.
async function listenOrJoin(first) {
  for (let i = 0; i <= MAX_WALK; i++) {
    const port = first + i;
    const r = await tryListen(port);
    if (r.server) { becomeHub(r.server); return { url, port, started: true, hub: true }; }
    if (!r.err || r.err.code !== 'EADDRINUSE') throw r.err;
    const h = await probe(port);
    if (h) {
      joined = `http://${HOST}:${port}`;
      armTakeover(port);
      return { url: joined, port, started: false, hub: false, version: h.version || null };
    }
  }
  throw new Error(`no free port from ${first} to ${first + MAX_WALK}`);
}

function rootOf(cwd) {
  try { return config.load(cwd).root; } catch (e) { return cwd; }
}

// Resolves { url, port, started, hub, id } — `started: false` means a hub was already listening,
// in this process or another. `id` is the caller's project, for the page to open on.
function start(cwd, opts = {}) {
  if (opts.demo) demoMode = true;
  const root = cwd ? rootOf(cwd) : null;
  let id = null;
  if (root) {
    projects.register(root);
    id = projects.idOf(root);
    wanted.set(id, root);
    homeId = homeId || id;
  }
  const suffix = opts.view ? `/${opts.view}` : '';
  const finish = (r) => Object.assign({}, r, { url: r.url + (id ? `/#${id}${suffix}` : ''), id });

  if (server && url) {
    syncProjects();
    return Promise.resolve(finish({ url, port: server.address().port, started: false, hub: true }));
  }
  if (!pending) {
    pending = listenOrJoin(Number(opts.port) || DEFAULT_PORT).finally(() => { pending = null; });
  }
  return pending.then(finish);
}

function stop() {
  for (const e of entries.values()) stopWatching(e);
  entries = new Map();
  wanted = new Map();
  homeId = null;
  for (const t of [heartbeat, registryPoll, takeover]) if (t) clearInterval(t);
  heartbeat = null; registryPoll = null; takeover = null;
  registryMtime = -1;
  for (const c of Array.from(clients)) { try { c.res.end(); } catch (e) { /* gone */ } }
  clients = new Set();
  if (server) { try { server.close(); } catch (e) { /* already closed */ } }
  server = null;
  url = null;
  joined = null;
}

function status() { return { running: !!server, hub: !!server, url: url || joined }; }

module.exports = { start, stop, status, DEFAULT_PORT };
