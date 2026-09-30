'use strict';
// The dashboard console: the first write path in mcp/.
//
// Read this before changing anything here. The threat is not the user. `hostOk` in mcp/http.js
// blocks DNS rebinding, but it does not block a page the developer happens to have open in another
// tab doing fetch('http://127.0.0.1:7391/…', { method: 'POST', mode: 'no-cors' }) — that request is
// delivered; the attacker merely cannot read the reply. That was harmless while every route was a
// side-effect-free GET. A route that runs SQL or a command turns the dashboard into
// web-triggerable execution on somebody's machine, so this module refuses first and acts second.
//
// Five gates, in order, every one of which must pass:
//
//   1. console.enabled, and the per-tab setting, are on. Both default to off.
//   2. The host is loopback or a compose service name. A DSN or base_url pointing anywhere else is
//      refused by name. docs/REFERENCE.md already records "a prover can write to a real database"
//      as a kept limit; a prover is an agent inside an approved flow, and this is a button on a
//      web page. One instance of that limit is enough.
//   3. SQL is a single read. No second statement, no DDL, no write verb.
//   4. A command is a key in cfg.commands or .keel/proven.json — never a string from the page —
//      and it still has to satisfy guards.checkBash for the phase the flow is actually in.
//   5. Whatever comes back is scanned for secrets before it reaches the browser.
//
// Everything that runs is appended to the event log, so it shows up in the same feed, the same
// `keel timeline` and the same guard record as everything else. A power that leaves no trace is
// the actual escalation.
const { execFile } = require('child_process');
const path = require('path');

const config = require('../lib/config');
const events = require('../lib/events');
const guards = require('../lib/guards');
const secrets = require('../lib/secrets');
const st = require('../lib/state');
const { readJson } = require('../lib/util');

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\]|::1|0\.0\.0\.0)$/i;
const READ_ONLY_SQL = /^\s*(select|explain|show|with)\b/i;
const WRITE_METHOD = /^(POST|PUT|PATCH|DELETE)$/;
// A command whose value carries a substitution is the one place page text could reach a shell
// argument. Those keys are simply not runnable from here.
const SUBSTITUTED = /\{(AC|PKG|PATHS|BUILD|DIR|FILES?)\}/;

// A refusal used to leave no trace at all: log() is only reached on execution, so the one event
// a person debugging "why will this not run" needs was the one never written down.
function refuseLogged(cfg, tab, arg, why, fix) {
  try { log(cfg, tab, arg, false, 0, why); } catch (e) { /* never change the verdict */ }
  return refuse(why, fix);
}

function refuse(why, fix) {
  return { ok: false, status: 403, error: why, fix: fix || null };
}

function hostOf(url) {
  try { return new URL(String(url)).hostname; } catch (e) { return null; }
}

// A compose service name is a legitimate host inside the project's own network, and it is the
// normal shape of DATABASE_URL in a composed stack.
function localish(host, cfg) {
  if (!host) return false;
  if (LOOPBACK.test(host)) return true;
  try {
    const services = require('../lib/setup').discover(cfg).services || [];
    return services.some((s) => String(s).split(' ')[0] === host);
  } catch (e) { return false; }
}

function gate(cfg, tab, want) {
  const c = cfg.console || {};
  if (!c.enabled) {
    return refuse('the console is off', 'Set `console.enabled: true` in .keel/config.yml to turn it on.');
  }
  const mode = String(c[tab] || 'off');
  if (mode === 'off') return refuse(`the console's ${tab} tab is off`, `Set \`console.${tab}\` in .keel/config.yml.`);
  if (want === 'write' && mode !== 'write') {
    return refuse(`the console's ${tab} tab is read-only`, `Set \`console.${tab}: write\` if you mean it.`);
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ actions */

function callEndpoint(cfg, body) {
  const method = String(body.method || 'GET').toUpperCase();
  const g = gate(cfg, 'endpoints', WRITE_METHOD.test(method) ? 'write' : 'read');
  if (!g.ok) return Promise.resolve(g);

  const base = String((cfg.console || {}).base_url || '');
  const host = hostOf(base);
  if (!localish(host, cfg)) {
    return Promise.resolve(refuse(`console.base_url points at ${host || 'nowhere'}, which is not this machine`,
      'The console only ever talks to a local stack. Change `console.base_url`.'));
  }
  // The path must be one the map knows. A console that can reach any path is a proxy, and a proxy
  // on loopback is the thing the four barriers exist to prevent being useful.
  const known = (body.knownPaths || []).map(String);
  const target = String(body.path || '');
  if (known.length && !known.includes(target)) {
    return Promise.resolve(refuse(`${target} is not an endpoint on the map`,
      'Rebuild the map, or pick an endpoint it knows.'));
  }

  const started = Date.now();
  return fetchLocal(base.replace(/\/$/, '') + target, method, body.body)
    .then((r) => {
      log(cfg, 'endpoint', `${method} ${target}`, true, Date.now() - started);
      return { ok: true, status: 200, result: { status: r.status, ms: Date.now() - started, body: scrub(r.text) } };
    })
    .catch((e) => {
      log(cfg, 'endpoint', `${method} ${target}`, false, Date.now() - started);
      return { ok: false, status: 502, error: `could not reach ${host}: ${(e && e.message) || e}` };
    });
}

function queryDb(cfg, body) {
  const g = gate(cfg, 'db', 'read');
  if (!g.ok) return Promise.resolve(g);

  const sql = String(body.sql || '').trim();
  if (!READ_ONLY_SQL.test(sql)) {
    return Promise.resolve(refuse('the console only runs a single read',
      'SELECT, EXPLAIN, SHOW or WITH … SELECT. There is no write mode, and there is not going to be one.'));
  }
  if (sql.replace(/;\s*$/, '').includes(';')) {
    return Promise.resolve(refuse('two statements in one request', 'Send one statement.'));
  }

  const envName = String((cfg.console || {}).db_url_env || 'DATABASE_URL');
  const dsn = process.env[envName];
  if (!dsn) return Promise.resolve(refuse(`${envName} is not set`, `The DSN is read from ${envName}, never from the page.`));
  const host = hostOf(dsn);
  if (!localish(host, cfg)) {
    return Promise.resolve(refuse(`${envName} points at ${host || 'nowhere'}, which is not this machine`,
      'The console will not read a database it cannot prove is local.'));
  }
  // There is no bundled database client and there is not going to be one: that is the dependency
  // this repo has never taken. The query runs through the project's own psql, in its own stack.
  return Promise.resolve(refuse('no local database client is configured',
    'Define a `db_query` command in .keel/config.yml — for example `docker compose exec -T db psql -c`.'));
}

function publishQueue(cfg) {
  const g = gate(cfg, 'queue', 'write');
  if (!g.ok) return Promise.resolve(g);
  // Same reasoning as the database: publishing needs a broker client, and keel does not ship one.
  return Promise.resolve(refuse('no queue client is configured',
    'Define a `queue_publish` command in .keel/config.yml — for example `docker compose exec -T mq rabbitmqadmin publish`.'));
}

function runCommand(cfg, body) {
  const g = gate(cfg, 'commands', 'read');
  if (!g.ok) return Promise.resolve(g);

  // The page sends a key. It has never sent, and must never send, a string.
  const key = String(body.command || '');
  if (!/^[a-z0-9_]+$/.test(key)) {
    return Promise.resolve(refuseLogged(cfg, 'command', events.short(key), 'a command is named by key, not written out',
      'The page sends a key from .keel/config.yml. There is no free-form shell here.'));
  }
  const proven = readJson(path.join(cfg.root, '.keel', 'proven.json'), { commands: {} }).commands || {};
  // A declared tool is runnable here too, under exactly the same rules — the key shape above, the
  // substitution refusal below, and the phase guard after it. A tool taking {FILE} or {FILES} is
  // therefore unreachable from the page, which is the point: the files would have to come from
  // somewhere, and the only candidate is the page.
  let tool = null;
  try { tool = require('../lib/tools').get(cfg, key); } catch (e) { tool = null; }
  const cmd = (cfg.commands || {})[key] || proven[key] || (tool && !tool.problem ? tool.run : null);
  if (!cmd) return Promise.resolve(refuseLogged(cfg, 'command', key, `no command or tool "${key}" in .keel/config.yml`, 'Pick one the project defines.'));
  if (SUBSTITUTED.test(String(cmd))) {
    return Promise.resolve(refuseLogged(cfg, 'command', key, `"${key}" takes a substitution, so it is not runnable from here`,
      'Run it in a terminal, where the hook can see what it was given.'));
  }

  // The phase matrix, inherited rather than re-implemented. During green, a command that writes
  // into a frozen path is refused on the page exactly as it is in the terminal.
  const state = st.read(cfg);
  const verdict = guards.checkBash(cfg, state, String(cmd));
  if (verdict && verdict.ok === false) {
    return Promise.resolve({ ok: false, status: 403, error: verdict.reason || 'the guard refused this command', fix: null });
  }

  const started = Date.now();
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', String(cmd)], { cwd: cfg.root, timeout: 120000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const ms = Date.now() - started;
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        log(cfg, 'command', key, code === 0, ms);
        resolve({ ok: true, status: 200, result: { key, cmd: String(cmd), code, ms, out: scrub(String(stdout) + String(stderr)) } });
      });
  });
}

/* ------------------------------------------------------------------ plumbing */

// Nothing leaves this process unscanned. A SELECT * or a 500 stack trace will otherwise carry a
// token into the browser and into the event log, which is the same failure printsEnvFile exists
// to prevent in the other direction.
function scrub(text) {
  const s = String(text == null ? '' : text).slice(0, 20000);
  try {
    const hits = secrets.scan(s);
    if (!hits.length) return s;
    // scan reports lines, not values, so the whole line goes. A partial redaction of a line whose
    // shape is already suspect is a guess about where the secret ends.
    const lines = s.split('\n');
    for (const h of hits) lines[h.line - 1] = `[redacted: ${h.why}]`;
    return lines.join('\n');
  } catch (e) { return '[redacted: the output could not be scanned for secrets]'; }
}

function log(cfg, tab, arg, ok, ms, detail) {
  const ev = { kind: 'tool', tool: `console:${tab}`, arg, ok, ms };
  if (detail) ev.detail = events.short(String(detail), 160);
  try { events.append(cfg, ev); } catch (e) { /* the feed is not the point */ }
}

function fetchLocal(url, method, body) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad url')); }
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method,
      headers: { 'content-type': 'application/json' }, timeout: 8000 }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', reject);
    if (body && method !== 'GET') req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const ACTIONS = { endpoint: callEndpoint, db: queryDb, queue: publishQueue, command: runCommand };

// `demo` is hard-off rather than merely empty: a console bound to a fictional selection but
// pointing at somebody's real localhost:8080 is the worst confusion this feature can produce.
function run(root, tab, body, opts = {}) {
  const action = ACTIONS[tab];
  if (!action) return Promise.resolve({ ok: false, status: 404, error: `no console tab "${tab}"` });
  if (opts.demo) {
    return Promise.resolve(refuse('the console is off for the demo map',
      'The example is not your project, and its endpoints are not yours to call.'));
  }
  let cfg;
  try { cfg = config.load(root); } catch (e) { return Promise.resolve({ ok: false, status: 500, error: 'no project here' }); }
  try { return action(cfg, body || {}); } catch (e) { return Promise.resolve({ ok: false, status: 500, error: String((e && e.message) || e) }); }
}

module.exports = { run, gate, localish, scrub, READ_ONLY_SQL };
