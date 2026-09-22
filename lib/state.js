'use strict';
const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./util');

const EMPTY = { flow: null, size: null, phase: 'none', spec: null, branch: null, lane: 'api',
  // gates.bug_gates is the bug flow's Gate R and Gate F waiver, set at flow start from
  // --no-gates or gates.bug_gates in the config. It lives in state because it is a decision
  // about this flow, and the PR body has to be able to report that it was taken.
  current: null, acs: {}, lanes: {}, gates: { mode: 'every-ac', bug_gates: true, skipped: {}, log: [] },
  stall: { fingerprint: null, count: 0, step: 0 }, unlocks: [], flaky: [], last_failure: null,
  // agents: { 'keel:explorer': ['<iso start>', '<iso start>'] }. Start timestamps only, one
  // per running instance, because the subagent hooks carry no unique instance id — there is
  // no session or invocation field to key on, so two concurrent explorers are
  // indistinguishable and a per-instance timer would be a fiction.
  // Ship steps the human turned off at ship's opening question, as { step, reason }. Separate
  // from gates.skipped: a skipped gate is a review nobody did, a skipped ship step is a check
  // that never ran — and for release/coverage/deps the push gate is still waiting regardless.
  ship_skipped: [],
  stop_blocks: 0, turns: {}, agents: {} };

const STALE_AFTER_SECONDS = 1800;

function file(cfg) { return path.join(cfg.root, '.keel', 'state.json'); }

function read(cfg) {
  const s = readJson(file(cfg), null);
  return s ? Object.assign({}, EMPTY, s) : Object.assign({}, EMPTY);
}
function write(cfg, s) { writeJson(file(cfg), s); return s; }

// gates.log holds free text written by nine different call sites. Splitting it into a subject
// and a decision is presentation only — the log stays exactly as it was.
function parseGateEntry(entry) {
  const short = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 120);
  let m = entry.match(/^ac\s+(\S+)\s+(\w+)\s*:?\s*(.*)$/);
  if (m) return { ac: m[1], verdict: m[2], detail: m[3] ? short(m[3]) : undefined };
  m = entry.match(/^gate\s+(\S+)\s+(\w+)\s*:?\s*(.*)$/);
  if (m) return { gate: m[1], verdict: m[2], detail: m[3] ? short(m[3]) : undefined };
  m = entry.match(/^final review\s*:?\s*(\w+)?\s*(.*)$/);
  if (m) return { gate: 'final', verdict: m[1] || 'noted', detail: m[2] ? short(m[2]) : undefined };
  m = entry.match(/^gates skipped for\s+(.+)$/);
  if (m) return { gate: 'skip', verdict: short(m[1]) };
  m = entry.match(/^([\w-]+)\s*:\s*(.+)$/);
  if (m) return { gate: m[1], verdict: short(m[2]) };
  return { gate: 'note', verdict: short(entry) };
}

// Phase and gate history, recorded here rather than at the ~28 call sites that assign them.
// Every mutation in keel goes through `update`, so one diff catches all of them — including the
// ones written after this — and the sites stay as they were.
function journal(cfg, before, s) {
  try {
    const events = require('./events');
    if (before.phase !== s.phase) {
      events.append(cfg, { kind: 'phase', from: before.phase, to: s.phase, flow: s.flow || undefined });
    }
    const log = ((s.gates || {}).log) || [];
    for (let i = before.gates; i < log.length; i++) {
      const entry = log[i];
      if (typeof entry === 'string') {
        events.append(cfg, Object.assign({ kind: 'gate' }, parseGateEntry(entry)));
      } else if (entry && entry.forced) {
        events.append(cfg, { kind: 'gate', gate: 'forced', verdict: entry.forced });
      }
    }
  } catch (e) { /* the state write is what matters; the journal is a convenience */ }
}

function update(cfg, fn) {
  const s = read(cfg);
  const before = { phase: s.phase, gates: (((s.gates || {}).log) || []).length };
  fn(s);
  const out = write(cfg, s);
  journal(cfg, before, s);
  return out;
}
function active(s) { return !!s.flow && s.phase !== 'none'; }

// Phases the CLI knows about. Every entry needs a row in guards.MATRIX; a simulator
// scenario asserts that, because a phase with no row used to fall back to allow-all.
const PHASES = ['none', 'setup', 'preflight', 'workspace', 'triage', 'spec', 'plan', 'contract',
  'red', 'green', 'ac', 'refactor', 'gate', 'review-fix', 'integration', 'e2e', 'smoke', 'coverage-fix',
  'trivial', 'small-change', 'bug-report', 'bug-repro', 'bug-investigate', 'gate-r', 'gate-f',
  'bug-fix', 'reset', 'security', 'ship', 'final-review', 'memory', 'close',
  // The hunt: frame, fan out, prove, report, triage. Read-only from end to end — its output
  // is a backlog, and every fix happens in a fix or feature flow started from it.
  'hunt-scope', 'hunt-sweep', 'hunt-prove', 'hunt-report', 'hunt-triage'];

// Which phase may follow which. The point is not bureaucracy: it is that the design's
// core guarantees are orderings, and a flat list let any phase follow any other — so
// `keel state phase green` from `spec` skipped RED entirely.
const TRANSITIONS = {
  none: ['setup', 'preflight', 'triage', 'bug-report', 'spec', 'hunt-scope'],
  setup: ['none', 'preflight'],
  preflight: ['workspace', 'spec', 'bug-repro', 'none'],
  workspace: ['spec', 'bug-repro', 'none'],
  triage: ['trivial', 'small-change', 'spec', 'none'],
  trivial: ['ship', 'small-change', 'none'],
  'small-change': ['red', 'spec', 'none'],
  spec: ['plan', 'contract', 'red', 'ac', 'none'],
  plan: ['contract', 'red', 'ac', 'none'],
  // `ac` is the single-commit loop: reachable wherever `red` is, and leading where `green` leads.
  // It cannot reach `red` or `green` — a flow picks one style per criterion rather than mixing,
  // which is what keeps `keel audit` able to tell a paired commit from a single one.
  ac: ['gate', 'refactor', 'spec', 'integration', 'none'],
  contract: ['red', 'ac', 'none'],
  // `spec` is reachable from inside the loop so a spec that turns out to be wrong can be amended
  // rather than worked around. It costs no ordering guarantee: `spec` itself only leads to plan,
  // contract, red or none, so there is still no way to reach `green` without passing through RED.
  // Without this the loop had no legal exit but `none` — abandoning the flow — while the guards
  // deny writes to specs/ in red, green and gate, so the file could not be touched either.
  red: ['green', 'spec', 'none'],
  // GREEN's "minimum code" rule is right and accumulates duplication with nowhere to discharge
  // it. `refactor` is that place: production code only, tests frozen, and it cannot reach `green`
  // — so nothing new can be built under cover of cleaning up.
  green: ['gate', 'refactor', 'red', 'spec', 'integration', 'none'],
  refactor: ['gate', 'green', 'none'],
  gate: ['red', 'green', 'ac', 'spec', 'review-fix', 'integration', 'e2e', 'smoke', 'ship', 'none'],
  // `security` here too: phase 6.6's full-diff review runs while state is still `security`
  // (read-only, needs no phase of its own), and a finding sends its fix back through
  // review-fix before code-reviewer runs again — same shape as the AC gate's review loop.
  'review-fix': ['gate', 'security', 'ship', 'none'],
  // Phase 6.5: security sits between integration and E2E, so a finding is fixed before
  // any E2E, smoke or ship time is spent on the change. Phase 6.6 (the full-diff review)
  // and its own gate run inside this same phase — see the review-fix comment above.
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
  // The hunt is a closed loop. It never transitions into the fix or feature flow: the handoff
  // is `keel state start fix`, which resets state wholesale — and that reset is exactly why
  // the backlog is a file of its own rather than a field in here.
  'hunt-scope': ['hunt-sweep', 'none'],
  'hunt-sweep': ['hunt-prove', 'hunt-report', 'none'],   // -report: the swept-and-found-nothing case
  'hunt-prove': ['hunt-report', 'hunt-sweep', 'none'],   // -sweep: a prover's evidence opened a new lens
  'hunt-report': ['hunt-triage', 'hunt-prove', 'none'],  // -prove: a verdict went stale
  'hunt-triage': ['hunt-report', 'none'],                // -report: re-render after closing one
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

// Two questions that look alike and are not. `laneOf` is which worktree this is, and keys the
// infrastructure: the Compose project, the port offset, the gate-skip bookkeeping in gateDue.
// `acLaneOf` is which side the work in front of us belongs to, and picks the test command — the
// AC's own layer answers that, and the worktree's lane is only the fallback when none is current.
// Keeping them apart is what stops a [WEB] criterion being verified with the backend build.
function acLaneOf(s) {
  const ac = s.current && s.acs[s.current];
  return ac ? acLane(ac) : laneOf(s);
}

// Lanes handed to their own worktree: their ACs are not this session's to pick up or edit.
function openLanes(s) {
  return Object.entries(s.lanes || {}).filter(([, l]) => l && l.status === 'open');
}

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
  acList, acSummary, gateDue, board, laneOf, acLane, acLaneOf, openLanes, file };
