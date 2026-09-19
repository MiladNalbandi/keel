'use strict';
const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./util');

const EMPTY = { flow: null, size: null, phase: 'none', spec: null, branch: null, lane: 'api',
  current: null, acs: {}, gates: { mode: 'every-ac', skipped: {}, log: [] },
  stall: { fingerprint: null, count: 0, step: 0 }, unlocks: [], flaky: [], last_failure: null,
  stop_blocks: 0, turns: {} };

function file(cfg) { return path.join(cfg.root, '.keel', 'state.json'); }

function read(cfg) {
  const s = readJson(file(cfg), null);
  return s ? Object.assign({}, EMPTY, s) : Object.assign({}, EMPTY);
}
function write(cfg, s) { writeJson(file(cfg), s); return s; }
function update(cfg, fn) { const s = read(cfg); fn(s); return write(cfg, s); }
function active(s) { return !!s.flow && s.phase !== 'none'; }

// Phases the CLI knows about.
const PHASES = ['none', 'setup', 'spec', 'plan', 'contract', 'red', 'green', 'gate', 'review-fix',
  'integration', 'e2e', 'smoke', 'coverage-fix', 'trivial', 'bug-report', 'bug-repro',
  'bug-investigate', 'bug-fix', 'ship'];

function recordFailure(cfg, output, fingerprint) {
  return update(cfg, (s) => {
    s.last_failure = String(output || '').split('\n').slice(0, 3).join(' ').slice(0, 300);
    if (fingerprint) {
      if (s.stall.fingerprint === fingerprint) s.stall.count += 1;
      else { s.stall.fingerprint = fingerprint; s.stall.count = 1; }
    }
  });
}
function clearStall(cfg) {
  return update(cfg, (s) => { s.stall = { fingerprint: null, count: 0, step: 0 }; s.last_failure = null; });
}

// The stall ladder: one step per stall, and a new fingerprint resets it.
const LADDER = [
  'Step 1: re-read the trimmed failure and the acceptance criterion; do not guess.',
  'Step 2: ask keel:investigator for a fresh-context diagnosis before the next attempt.',
  'Step 3: step the model up for the next attempt (`/model opus`, or Fable if the cause stays ambiguous).',
  'Step 4: stop and ask the user. Show the failure, what you tried, and the two options you see.',
];
function nextLadderStep(cfg) {
  const s = update(cfg, (x) => { x.stall.step = Math.min((x.stall.step || 0) + 1, LADDER.length); });
  return { step: s.stall.step, advice: LADDER[s.stall.step - 1] };
}
function stalled(cfg, s) {
  const limit = (cfg.loops && cfg.loops.stall_repeats) || 3;
  return s.stall.count >= limit;
}

function acList(s) { return Object.keys(s.acs).sort(); }
function acSummary(s) {
  const ids = acList(s);
  const done = ids.filter((id) => s.acs[id].status === 'done').length;
  return { done, total: ids.length, ids };
}

module.exports = { EMPTY, PHASES, LADDER, read, write, update, active, recordFailure, clearStall, stalled, nextLadderStep, acList, acSummary, file };
