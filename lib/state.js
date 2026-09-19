'use strict';
const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./util');

const EMPTY = { flow: null, size: null, phase: 'none', spec: null, branch: null, lane: 'api',
  current: null, acs: {}, gates: { mode: 'every-ac', skipped: {}, log: [] },
  stall: { fingerprint: null, count: 0, step: 0 }, unlocks: [], flaky: [], last_failure: null,
  // agents: { 'keel:explorer': ['<iso start>', '<iso start>'] }. Start timestamps only, one
  // per running instance, because the subagent hooks carry no unique instance id — there is
  // no session or invocation field to key on, so two concurrent explorers are
  // indistinguishable and a per-instance timer would be a fiction.
  stop_blocks: 0, turns: {}, agents: {} };

const STALE_AFTER_SECONDS = 1800;

function file(cfg) { return path.join(cfg.root, '.keel', 'state.json'); }

function read(cfg) {
  const s = readJson(file(cfg), null);
  return s ? Object.assign({}, EMPTY, s) : Object.assign({}, EMPTY);
}
function write(cfg, s) { writeJson(file(cfg), s); return s; }
function update(cfg, fn) { const s = read(cfg); fn(s); return write(cfg, s); }
function active(s) { return !!s.flow && s.phase !== 'none'; }

// Phases the CLI knows about. Every entry needs a row in guards.MATRIX; a simulator
// scenario asserts that, because a phase with no row used to fall back to allow-all.
const PHASES = ['none', 'setup', 'preflight', 'workspace', 'triage', 'spec', 'plan', 'contract',
  'red', 'green', 'gate', 'review-fix', 'integration', 'e2e', 'smoke', 'coverage-fix',
  'trivial', 'small-change', 'bug-report', 'bug-repro', 'bug-investigate', 'gate-r', 'gate-f',
  'bug-fix', 'reset', 'security', 'ship', 'final-review', 'memory', 'close'];

// Which phase may follow which. The point is not bureaucracy: it is that the design's
// core guarantees are orderings, and a flat list let any phase follow any other — so
// `keel state phase green` from `spec` skipped RED entirely.
const TRANSITIONS = {
  none: ['setup', 'preflight', 'triage', 'bug-report', 'spec'],
  setup: ['none', 'preflight'],
  preflight: ['workspace', 'spec', 'bug-repro', 'none'],
  workspace: ['spec', 'bug-repro', 'none'],
  triage: ['trivial', 'small-change', 'spec', 'none'],
  trivial: ['ship', 'small-change', 'none'],
  'small-change': ['red', 'spec', 'none'],
  spec: ['plan', 'contract', 'red', 'none'],
  plan: ['contract', 'red', 'none'],
  contract: ['red', 'none'],
  red: ['green', 'none'],
  green: ['gate', 'red', 'integration', 'none'],
  gate: ['red', 'green', 'review-fix', 'integration', 'e2e', 'smoke', 'ship', 'none'],
  'review-fix': ['gate', 'ship', 'none'],
  // Phase 6.5: security sits between integration and E2E, so a finding is fixed before
  // any E2E, smoke or ship time is spent on the change.
  integration: ['security', 'e2e', 'smoke', 'ship', 'none'],
  security: ['e2e', 'review-fix', 'smoke', 'ship', 'none'],
  e2e: ['smoke', 'ship', 'none'],
  smoke: ['ship', 'none'],
  'coverage-fix': ['ship', 'gate', 'none'],
  'bug-report': ['bug-repro', 'workspace', 'none'],
  'bug-repro': ['gate-r', 'bug-investigate', 'none'],
  'gate-r': ['bug-investigate', 'bug-repro', 'none'],
  'bug-investigate': ['gate-f', 'bug-fix', 'none'],
  'gate-f': ['bug-fix', 'bug-investigate', 'spec', 'none'],
  'bug-fix': ['bug-investigate', 'reset', 'e2e', 'ship', 'none'],
  reset: ['bug-repro', 'none'],
  // Ship loops back when a check fails or a finding needs a new AC, and forward to the
  // final review. coverage-fix and review-fix are the two repair phases it can enter.
  ship: ['coverage-fix', 'review-fix', 'red', 'gate', 'security', 'final-review', 'close', 'none'],
  // The knowledge refresh lands after the human has reviewed the code diff, so it is its
  // own phase between the final review and the PR.
  'final-review': ['memory', 'ship', 'close', 'none'],
  memory: ['close', 'ship', 'none'],
  close: ['none'],
};

// Same phase is always fine: a phase can repeat without being a transition.
function canTransition(from, to) {
  if (from === to) return true;
  return (TRANSITIONS[from] || []).includes(to);
}

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

/* ------------------------------------------------------------------ agents */

function agentStart(cfg, agent) {
  if (!agent) return;
  return update(cfg, (s) => {
    s.agents = s.agents || {};
    (s.agents[agent] = s.agents[agent] || []).push(new Date().toISOString());
  });
}

// Clear the oldest run of this type. Oldest rather than newest because without instance ids
// that is the only defensible choice: it keeps the remaining timestamps the youngest, so a
// leaked entry from a crashed agent ages out and gets flagged rather than masking a live one.
function agentStop(cfg, agent) {
  if (!agent) return;
  return update(cfg, (s) => {
    if (!s.agents || !Array.isArray(s.agents[agent]) || !s.agents[agent].length) return;
    s.agents[agent].sort();
    s.agents[agent].shift();
    if (!s.agents[agent].length) delete s.agents[agent];
  });
}

// What is running, with the age of the oldest run of each type. An entry past the stale
// threshold is reported as possibly-finished rather than counted as live: a crashed or
// timed-out agent never fires SubagentStop, and a counter that only ever increments would
// claim it was running for the rest of the flow.
function agentsRunning(s, opts = {}) {
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const limit = (opts.staleAfter || STALE_AFTER_SECONDS) * 1000;
  const out = [];
  for (const [agent, starts] of Object.entries(s.agents || {})) {
    if (!Array.isArray(starts) || !starts.length) continue;
    const ages = starts.map((t) => now - new Date(t).getTime()).sort((a, b) => b - a);
    const oldest = ages[0];
    out.push({
      agent,
      count: starts.length,
      oldestSeconds: Math.max(0, Math.round(oldest / 1000)),
      stale: oldest > limit,
    });
  }
  return out.sort((a, b) => b.oldestSeconds - a.oldestSeconds);
}

function reapAgents(cfg, opts = {}) {
  const limit = (opts.staleAfter || STALE_AFTER_SECONDS) * 1000;
  const now = Date.now();
  let removed = 0;
  update(cfg, (s) => {
    for (const [agent, starts] of Object.entries(s.agents || {})) {
      const keep = (starts || []).filter((t) => now - new Date(t).getTime() <= limit);
      removed += (starts || []).length - keep.length;
      if (keep.length) s.agents[agent] = keep; else delete s.agents[agent];
    }
  });
  return removed;
}

function acList(s) { return Object.keys(s.acs).sort(); }

function laneOf(s) { return s.lane === 'web' ? 'web' : 'api'; }
function acLane(ac) { return String((ac && ac.layer) || 'API').toUpperCase() === 'WEB' ? 'web' : 'api'; }

// Is a human gate due for this acceptance criterion? All four skip paths from design §9
// converge here — the mode chosen at flow start, an at-gate skip with its scope, a per-AC
// [gate: skip] tag in the spec, and a background lane (which sets gates.skipped) — so a
// caller never has to reason about them separately.
function gateDue(s, acId) {
  const ac = s.acs[acId];
  if (!ac) return { due: true };
  if (ac.gate === 'skip') return { due: false, why: `${acId} is tagged [gate: skip] in the spec` };
  const skipped = (s.gates.skipped || {})[laneOf(s)];
  if (skipped) return { due: false, why: `gates are skipped for this ${skipped === 'flow' ? 'flow' : 'lane'}` };

  const mode = s.gates.mode || 'every-ac';
  if (mode === 'every-ac') return { due: true };
  const ids = acList(s);
  if (mode === 'end-of-lane') {
    const mine = ids.filter((id) => acLane(s.acs[id]) === acLane(ac));
    return mine[mine.length - 1] === acId ? { due: true } : { due: false, why: 'gate mode is end-of-lane' };
  }
  if (mode === 'end') {
    return ids[ids.length - 1] === acId ? { due: true } : { due: false, why: 'gate mode is end' };
  }
  return { due: true };
}

// The board design §9 prints at every gate.
function board(s) {
  const ids = acList(s);
  const mark = (id) => {
    const a = s.acs[id];
    if (a.status === 'done') return '✔ red+green';
    if (a.status === 'already-met') return '✔ already met';
    if (id === s.current) return '▶ ' + (s.phase || 'current');
    if (a.status === 'green') return '· green';
    if (a.status === 'red') return '· red';
    return '⬜';
  };
  const head = [s.spec ? s.spec.replace(/^.*\//, '') : (s.flow || 'no flow'),
    `lane: ${laneOf(s)}`, `flow: ${s.size || s.flow || '-'}`, `gates: ${(s.gates || {}).mode || '-'}`].join('   ');
  const rows = ids.map((id) => `${id} ${mark(id)}${s.acs[id].layer ? '  [' + s.acs[id].layer + ']' : ''}`);
  const sum = acSummary(s);
  const tail = [`${sum.done}/${sum.total} done`];
  if (s.stall && s.stall.count) tail.push(`stall ${s.stall.count}`);
  if ((s.flaky || []).length) tail.push(`${s.flaky.length} flaky`);
  if ((s.unlocks || []).length) tail.push(`${s.unlocks.length} unlock(s)`);
  return [head, ...rows, tail.join(' · ')].join('\n');
}
function acSummary(s) {
  const ids = acList(s);
  const done = ids.filter((id) => s.acs[id].status === 'done').length;
  return { done, total: ids.length, ids };
}

module.exports = { EMPTY, PHASES, TRANSITIONS, LADDER, STALE_AFTER_SECONDS, canTransition,
  read, write, update, active, recordFailure, clearStall, stalled, nextLadderStep,
  agentStart, agentStop, agentsRunning, reapAgents,
  acList, acSummary, gateDue, board, laneOf, file };
