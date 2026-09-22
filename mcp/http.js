'use strict';
// The dashboard's transport. Localhost only, read-only, and started lazily — a session that
// never opens the dashboard never opens a port.
//
// Push rather than poll: `keel board --watch` sha1s four files every second, which is fine for a
// terminal and wasteful for a page that is open all day. fs.watch tells us when .keel changed,
// the fingerprint tells us whether the change was one anybody cares about, and only then does a
// frame go out.
const http = require('http');
const fs = require('fs');
const path = require('path');

const view = require('./view');
const ui = require('./ui');

const DEFAULT_PORT = Number(process.env.KEEL_DASHBOARD_PORT) || 7391;
const HOST = '127.0.0.1';
const DEBOUNCE_MS = 150;
const HEARTBEAT_MS = 25000;

let server = null;
let url = null;
let clients = new Set();
let watchers = [];
let timer = null;
let heartbeat = null;
let lastFingerprint = '';
let projectCwd = process.cwd();

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

function currentView() {
  try { return view.build(projectCwd); }
  catch (e) { return { at: new Date().toISOString(), error: String((e && e.message) || e), active: false }; }
}

function broadcast() {
  if (!clients.size) return;
  const payload = 'data: ' + JSON.stringify(currentView()) + '\n\n';
  for (const res of Array.from(clients)) {
    try { res.write(payload); } catch (e) { clients.delete(res); }
  }
}

// Coalesce a burst of writes — a single `keel state green-done` touches several files — and then
// only push if the fingerprint actually moved.
function onChange() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    let fp = '';
    try { fp = view.fingerprint(projectCwd); } catch (e) { fp = String(Date.now()); }
    if (fp === lastFingerprint) return;
    lastFingerprint = fp;
    broadcast();
  }, DEBOUNCE_MS);
}

function startWatching(root) {
  stopWatching();
  const dirs = [path.join(root, '.keel'), path.join(root, '.keel', 'logs')];
  for (const d of dirs) {
    try {
      if (!fs.existsSync(d)) continue;
      const w = fs.watch(d, { persistent: false }, onChange);
      w.on('error', () => {});
      watchers.push(w);
    } catch (e) { /* a directory we cannot watch just means a staler page */ }
  }
  // .keel/logs is created on the first event; without this the feed would stay dark until
  // something else in .keel changed.
  try {
    if (!watchers.length) return;
    const logs = path.join(root, '.keel', 'logs');
    if (!fs.existsSync(logs)) {
      const retry = setInterval(() => {
        if (!fs.existsSync(logs)) return;
        clearInterval(retry);
        startWatching(root);
      }, 2000);
      if (retry.unref) retry.unref();
    }
  } catch (e) { /* best effort */ }
}

function stopWatching() {
  for (const w of watchers) { try { w.close(); } catch (e) { /* already closed */ } }
  watchers = [];
}

function handle(req, res) {
  const route = String(req.url || '/').split('?')[0];

  if (route === '/' || route === '/index.html') {
    return send(res, 200, 'text/html; charset=utf-8', ui.html());
  }
  if (route === '/api/view') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(currentView()));
  }
  if (route === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify(currentView()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return undefined;
  }
  return send(res, 404, 'text/plain; charset=utf-8', 'not found');
}

// Resolves { url, port, started } — `started: false` means it was already listening.
function start(cwd, opts = {}) {
  if (cwd) projectCwd = cwd;
  if (server && url) return Promise.resolve({ url, port: server.address().port, started: false });

  const first = Number(opts.port) || DEFAULT_PORT;
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const s = http.createServer(handle);
    s.on('error', (err) => {
      // Another repo's dashboard already holds the port. Walk forward rather than failing:
      // two keel projects open at once is normal, not an error.
      if (err && err.code === 'EADDRINUSE' && attempt < 12) {
        attempt += 1;
        setImmediate(() => s.listen(first + attempt, HOST));
        return;
      }
      reject(err);
    });
    s.on('listening', () => {
      server = s;
      const port = s.address().port;
      url = `http://${HOST}:${port}`;
      try { lastFingerprint = view.fingerprint(projectCwd); } catch (e) { lastFingerprint = ''; }
      let root = projectCwd;
      try { root = view.build(projectCwd).root || projectCwd; } catch (e) { root = projectCwd; }
      startWatching(root);
      heartbeat = setInterval(() => {
        for (const res of Array.from(clients)) {
          try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); }
        }
      }, HEARTBEAT_MS);
      if (heartbeat.unref) heartbeat.unref();
      // The server must not hold the MCP process open on its own.
      if (s.unref) s.unref();
      resolve({ url, port, started: true });
    });
    s.listen(first, HOST);
  });
}

function stop() {
  stopWatching();
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  for (const res of Array.from(clients)) { try { res.end(); } catch (e) { /* gone */ } }
  clients = new Set();
  if (server) { try { server.close(); } catch (e) { /* already closed */ } }
  server = null;
  url = null;
}

function status() { return { running: !!server, url }; }

module.exports = { start, stop, status, DEFAULT_PORT };
