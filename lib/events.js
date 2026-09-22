'use strict';
// The flow's timeline. keel has always known where it is and never how it got there: phases,
// gates and guard denials were last-value-wins with no timestamp, and no tool call was recorded
// at all. This is the append point for all four.
//
// Two rules hold this file together. It never throws — a logging bug must not be able to block a
// tool call, so every entry point swallows its own errors and the caller gets `false`. And it
// never stores a payload: `arg` is a display string, because the log is read by a dashboard and
// by the model, and file contents, env values and full diffs have no business in either.
const fs = require('fs');
const path = require('path');

const CAP_BYTES = 2 * 1024 * 1024;
const KINDS = ['tool', 'agent', 'phase', 'gate', 'guard'];

const FILTERS = {
  all: () => true,
  tools: (e) => e.kind === 'tool',
  agents: (e) => e.kind === 'agent',
  phases: (e) => e.kind === 'phase',
  gates: (e) => e.kind === 'gate',
  guards: (e) => e.kind === 'guard',
  // What went wrong, across kinds — the filter you actually want after a stall.
  failures: (e) => e.ok === false || e.kind === 'guard' || /fail|stalled|reject|unproven/i.test(e.verdict || ''),
};

function dir(cfg) { return path.join(cfg.root, '.keel', 'logs'); }
function file(cfg) { return path.join(dir(cfg), 'events.jsonl'); }
function rotated(cfg) { return path.join(dir(cfg), 'events.1.jsonl'); }

// One display line out of whatever the hook payload carried. A path becomes its basename
// because the feed is narrow and the tail is the identifying part; a command is truncated.
function short(value, max = 80) {
  let s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (/^(\/|\.\.?\/)/.test(s) && !s.includes(' ')) s = path.basename(s);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function rotate(cfg) {
  try {
    const f = file(cfg);
    if (!fs.existsSync(f) || fs.statSync(f).size < CAP_BYTES) return;
    fs.renameSync(f, rotated(cfg));
  } catch (e) { /* a log that cannot rotate is still a log */ }
}

// Returns true if the line landed. Callers ignore it; it exists so tests can assert.
function append(cfg, ev) {
  if (!cfg || !cfg.root || !ev || !KINDS.includes(ev.kind)) return false;
  try {
    fs.mkdirSync(dir(cfg), { recursive: true });
    rotate(cfg);
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, ev));
    // One write of one line under O_APPEND: concurrent hooks interleave lines, never split one.
    fs.appendFileSync(file(cfg), line + '\n');
    return true;
  } catch (e) { return false; }
}

// Newest first. `limit` is applied after filtering, so asking for 20 failures reads back 20
// failures rather than whatever survives the last 20 lines.
function read(cfg, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 1000));
  const keep = FILTERS[opts.filter] || FILTERS.all;
  let raw = '';
  try { raw = fs.readFileSync(file(cfg), 'utf8'); } catch (e) { return []; }
  const out = [];
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    let ev;
    try { ev = JSON.parse(lines[i]); } catch (e) { continue; }
    if (keep(ev)) out.push(ev);
  }
  return out;
}

function count(cfg) {
  try { return fs.readFileSync(file(cfg), 'utf8').split('\n').filter(Boolean).length; }
  catch (e) { return 0; }
}

function clear(cfg) {
  for (const f of [file(cfg), rotated(cfg)]) {
    try { fs.unlinkSync(f); } catch (e) { /* already gone */ }
  }
}

module.exports = { append, read, count, clear, short, file, dir, KINDS, FILTERS, CAP_BYTES };
