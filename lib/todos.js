'use strict';
// The flow's steps as a checklist, for Claude Code's own todo list. Derived entirely from
// RAILS and state.acs — nothing is tracked separately, which is the only way this cannot
// drift from `keel board`.
const st = require('./state');
const { RAILS } = require('./board');

// The three phases that repeat per acceptance criterion. A flat phase list would show one
// "RED" entry sitting in progress for six criteria in a row, which tells you nothing — so
// inside the loop the list expands per criterion instead.
const LOOP_PHASES = ['red', 'green', 'gate'];

// Terse on purpose: a checklist is scanned, not read, and the explanation of each phase
// lives in its reference file. Long labels also broke the column grid.
const LABEL = {
  preflight: 'preflight', workspace: 'worktree', spec: 'spec', plan: 'plan',
  contract: 'contract', integration: 'integration', security: 'security',
  e2e: 'e2e', smoke: 'smoke', ship: 'ship', memory: 'memory', close: 'close',
  triage: 'triage', trivial: 'trivial', 'small-change': 'small change',
  'bug-report': 'report', 'bug-repro': 'reproduce', 'gate-r': 'Gate R',
  'bug-investigate': 'investigate', 'gate-f': 'Gate F', 'bug-fix': 'fix',
  reset: 'reset',
};

function acStatus(ac, current) {
  if (!ac) return 'pending';
  if (ac.status === 'done' || ac.status === 'already-met') return 'completed';
  return null; // caller decides in_progress vs pending from `current`
}

function build(state) {
  const rail = RAILS[state.flow] || [];
  if (!rail.length) return [];
  const here = rail.indexOf(state.phase);
  const inLoop = LOOP_PHASES.includes(state.phase);
  const items = [];
  let loopEmitted = false;

  rail.forEach((phase, i) => {
    if (LOOP_PHASES.includes(phase)) {
      if (loopEmitted) return;
      loopEmitted = true;
      const ids = st.acList(state);
      if (!ids.length) {
        items.push({ id: 'ac-loop', label: 'the criteria loop — none registered yet', status: here > i ? 'completed' : 'pending' });
        return;
      }
      for (const id of ids) {
        const ac = state.acs[id];
        const done = acStatus(ac, state.current);
        const status = done || (inLoop && id === state.current ? 'in_progress' : 'pending');
        // Only name the step when we are actually in the loop. Before it, "AC-001 · spec"
        // would imply the criterion is being worked when the spec is still being written.
        const where = inLoop && id === state.current ? ` · ${state.phase}` : '';
        items.push({ id, label: `${id} [${ac.layer || '?'}]${where}`, status });
      }
      return;
    }
    const status = here === -1 ? 'pending'
      : i < here ? 'completed' : i === here ? 'in_progress' : 'pending';
    items.push({ id: phase, label: LABEL[phase] || phase, status });
  });
  return items;
}

const GLYPH = { completed: '✔', in_progress: '▶', pending: '⬜' };
const WIDTH = 26;

// Truncate rather than trust the label: one long entry used to run into the next column, and
// a grid that can be broken by its own content is not a grid.
function cell(t) {
  const text = `${GLYPH[t.status]} ${t.label}`;
  return (text.length > WIDTH - 2 ? text.slice(0, WIDTH - 3) + '…' : text).padEnd(WIDTH);
}

function render(state) {
  const items = build(state);
  if (!items.length) return null;
  const done = items.filter((i) => i.status === 'completed').length;
  const rows = [];
  for (let i = 0; i < items.length; i += 3) {
    rows.push('  ' + items.slice(i, i + 3).map(cell).join('').trimEnd());
  }
  return [`todo  ${done}/${items.length}`, ...rows].join('\n');
}

// Which commands moved the flow on, and so should refresh the checklist. Anything else must
// return nothing: this rule runs on every Bash call, and a checklist after `ls` is noise.
const STATE_CHANGING = [
  /\bkeel\s+state\s+(phase|ac|advance|red-done|green-done|repro-done|close)\b/,
  /\bkeel\s+commit\s+\w+/,
  /\bkeel\s+gate\s+\w+/,
  /\bkeel\s+escalate\b/,
];
function isStateChanging(command) {
  const c = String(command || '');
  return STATE_CHANGING.some((re) => re.test(c));
}

module.exports = { build, render, isStateChanging, LOOP_PHASES, LABEL };
