'use strict';
// The projects this machine runs keel in. Every session used to start its own MCP server, and
// every server its own dashboard on the next free port, each blind to the others — four projects
// meant four tabs and no one place that said which of them was waiting on you. This list is what
// lets one dashboard show them all.
//
// It lives outside any project (~/.keel, or $KEEL_HOME) because it is about the machine, not a
// checkout. Two sessions can register at the same moment, so every write is read-merge-write
// under a lock file and lands by rename: a reader sees the old list or the new one, never half.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const STALE_DAYS = 14;
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;
// A session-start hook and an MCP server both register on startup; one write per minute per
// project is plenty, and it keeps a busy machine from rewriting the file on every resume.
const TOUCH_EVERY_MS = 60 * 1000;

function home() { return process.env.KEEL_HOME || path.join(os.homedir(), '.keel'); }
function file() { return path.join(home(), 'projects.json'); }
function lockFile() { return file() + '.lock'; }

function idOf(root) {
  return crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 8);
}

function configured(root) {
  try { return fs.existsSync(path.join(root, '.keel', 'config.yml')); } catch (e) { return false; }
}

function readRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(data.projects) ? data.projects.filter((p) => p && p.root) : [];
  } catch (e) { return []; }
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Sync on purpose: the hook that calls this is a short-lived process and has nothing to overlap
// it with. A lock older than LOCK_STALE_MS belonged to a process that died holding it.
function withLock(fn) {
  fs.mkdirSync(home(), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd = null;
  while (fd === null) {
    try { fd = fs.openSync(lockFile(), 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lockFile()).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockFile()); continue; }
      } catch (e2) { continue; }
      if (Date.now() > deadline) throw new Error('the project list is locked by another keel process');
      sleep(25);
    }
  }
  try { return fn(); } finally {
    try { fs.closeSync(fd); } catch (e) { /* closed */ }
    try { fs.unlinkSync(lockFile()); } catch (e) { /* gone */ }
  }
}

function writeRaw(list) {
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects: list }, null, 2) + '\n');
  fs.renameSync(tmp, file());
}

function alive(p, now) {
  const seen = Date.parse(p.lastSeen);
  if (Number.isFinite(seen) && now - seen > STALE_DAYS * 86400 * 1000) return false;
  return configured(p.root);
}

// Folder names collide — every monorepo has an `api` — so a duplicate name borrows its parent.
function withNames(list) {
  const count = new Map();
  for (const p of list) count.set(path.basename(p.root), (count.get(path.basename(p.root)) || 0) + 1);
  return list.map((p) => {
    const base = path.basename(p.root);
    const name = count.get(base) > 1 ? `${path.basename(path.dirname(p.root))}/${base}` : base;
    return Object.assign({}, p, { id: idOf(p.root), name });
  });
}

// The live projects, sorted by name. Dead ones — folder gone, keel removed, unseen for two
// weeks — are hidden here and dropped on the next write.
function list() {
  const now = Date.now();
  return withNames(readRaw().filter((p) => alive(p, now)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Returns the entry, or null for a directory that is not a keel project. Never throws: it runs
// inside hooks, and a list we could not update must not cost the user a session.
function register(root, meta = {}) {
  if (!root || !configured(root)) return null;
  meta = Object.assign({ keel: keelVersion() }, meta);
  const abs = path.resolve(root);
  try {
    const now = Date.now();
    const current = readRaw().find((p) => path.resolve(p.root) === abs);
    const fresh = current && now - Date.parse(current.lastSeen) < TOUCH_EVERY_MS
      && (!meta.keel || current.keel === meta.keel);
    if (!fresh) {
      withLock(() => {
        const kept = readRaw().filter((p) => path.resolve(p.root) !== abs && alive(p, now));
        const keel = meta.keel || (current && current.keel);
        kept.push(Object.assign({ root: abs, lastSeen: new Date(now).toISOString() }, keel ? { keel } : {}));
        writeRaw(kept);
      });
    }
  } catch (e) { return null; }
  return list().find((p) => path.resolve(p.root) === abs) || null;
}

// By id, name or path — whatever the user or the model has in hand.
function resolve(ref) {
  if (!ref) return null;
  const all = list();
  const s = String(ref);
  return all.find((p) => p.id === s)
    || all.find((p) => p.name === s)
    || all.find((p) => path.basename(p.root) === s)
    || all.find((p) => p.root === path.resolve(s))
    || null;
}

function forget(ref) {
  const hit = resolve(ref);
  if (!hit) return null;
  withLock(() => writeRaw(readRaw().filter((p) => path.resolve(p.root) !== hit.root)));
  return hit;
}

// The keel that is running this code, so the dashboard can say when a project was last opened by
// a different one.
function keelVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || null;
  } catch (e) { return null; }
}

function mtime() {
  try { return fs.statSync(file()).mtimeMs; } catch (e) { return 0; }
}

module.exports = { list, register, resolve, forget, idOf, file, home, mtime, keelVersion, STALE_DAYS };
