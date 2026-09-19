'use strict';
// The terminal board. Plain text, no ANSI and no cursor control — the codebase has never
// used either, the simulator runs without a TTY, and the model reads this output as text.
// Ordered so the line you act on is last.
const fs = require('fs');
const path = require('path');
const { git, gitOut } = require('./util');
const st = require('./state');
const gates = require('./gates');

// The phases a flow actually walks, in order, rather than all 28 keel knows about.
const RAILS = {
  feature: ['preflight', 'workspace', 'spec', 'plan', 'contract', 'red', 'green', 'gate',
    'integration', 'security', 'e2e', 'smoke', 'ship', 'memory', 'close'],
  change: ['triage', 'trivial', 'small-change', 'red', 'green', 'gate', 'ship', 'close'],
  fix: ['bug-report', 'workspace', 'bug-repro', 'gate-r', 'bug-investigate', 'gate-f',
    'bug-fix', 'e2e', 'ship', 'close'],
};
const SHORT = {
  preflight: 'pre', workspace: 'work', spec: 'spec', plan: 'plan', contract: 'contract',
  red: 'RED', green: 'GREEN', gate: 'gate', integration: 'integ', security: 'sec',
  e2e: 'e2e', smoke: 'smoke', ship: 'ship', memory: 'mem', close: 'close',
  triage: 'triage', trivial: 'trivial', 'small-change': 'small',
  'bug-report': 'report', 'bug-repro': 'repro', 'gate-r': 'gate R',
  'bug-investigate': 'investigate', 'gate-f': 'gate F', 'bug-fix': 'fix',
};

function rail(state) {
  const names = RAILS[state.flow] || [];
  if (!names.length) return null;
  const here = names.indexOf(state.phase);
  return 'phase   ' + names.map((n, i) => (i === here ? `[${SHORT[n] || n}]` : (SHORT[n] || n))).join(' ─ ');
}

// ACs in two columns when there are enough to warrant it, so a six-AC flow is six lines
// rather than a page.
function acGrid(state) {
  const ids = st.acList(state);
  if (!ids.length) return ['(no acceptance criteria registered yet)'];
  const cell = (id) => {
    const a = state.acs[id];
    const mark = a.status === 'done' ? '✔ red+green'
      : a.status === 'already-met' ? '✔ already met'
        : id === state.current ? `▶ ${state.phase}`
          : a.status === 'green' ? '· green'
            : a.status === 'red' ? '· red' : '⬜';
    return `${id} ${mark.padEnd(13)} [${a.layer || '?'}]`;
  };
  const cells = ids.map(cell);
  if (cells.length <= 4) return cells;
  const half = Math.ceil(cells.length / 2);
  const rows = [];
  for (let i = 0; i < half; i++) {
    const left = cells[i] || '';
    const right = cells[i + half] || '';
    rows.push(right ? `${left.padEnd(32)}${right}` : left);
  }
  return rows;
}

function agentRows(state, opts = {}) {
  const running = st.agentsRunning(state, opts);
  if (!running.length) return ['none running'];
  return running.map((r) => {
    const count = r.count > 1 ? ` ×${r.count}` : '';
    const age = `${r.oldestSeconds}s`;
    // Honest about what the hook payload can support: the oldest start of this type, not a
    // per-instance timer, because nothing identifies an instance.
    const label = r.count > 1 ? `oldest ${age}` : age;
    return `${r.agent}${count} · ${label}${r.stale ? ' · stale? no stop recorded' : ''}`;
  });
}

function checkRows(cfg, head) {
  const glyph = { pass: '✔', fail: '✗', stale: '·', none: '·', skipped: '—' };
  const cov = gates.verdictState(cfg, 'coverage.json', head);
  const rows = [`coverage ${glyph[cov.state]} ${cov.label}`];

  // "never run" would be wrong when nothing a scan could see has changed: the gate is not
  // waiting on anything, so say so rather than implying an outstanding task.
  let manifests = [];
  try { manifests = require('./deps').manifestsChanged(cfg); } catch (e) { manifests = []; }
  if (!manifests.length) rows.push('deps — not needed, no manifest changed');
  else {
    const dep = gates.verdictState(cfg, 'security.json', head);
    rows.push(`deps ${glyph[dep.state]} ${dep.label}   (${manifests.length} manifest/lockfile changed)`);
  }
  return rows;
}

function render(cfg, state, opts = {}) {
  const lines = [];
  if (!st.active(state)) {
    return [`no active flow. Config: ${cfg.configured ? '.keel/config.yml' : 'missing — run `keel init --write`'}`,
      'Start one with /keel:feature, /keel:change or /keel:fix.'].join('\n');
  }
  const head = opts.head || gitOut('rev-parse HEAD', cfg.root);
  const sum = st.acSummary(state);

  lines.push([state.spec ? state.spec.replace(/^.*\//, '') : state.flow,
    `lane: ${st.laneOf(state)}`, `flow: ${state.size || state.flow}`,
    `gates: ${(state.gates || {}).mode || '-'}`].join('   '));
  const r = rail(state);
  if (r) lines.push(r);
  lines.push('');
  lines.push(...acGrid(state));

  const tail = [`${sum.done}/${sum.total} done`];
  if (state.current) {
    const due = st.gateDue(state, state.current);
    tail.push(due.due ? `gate due for ${state.current}` : `no gate for ${state.current} (${due.why})`);
  }
  lines.push(tail.join(' · '));

  lines.push('', 'agents  ' + agentRows(state, opts).join('\n        '));

  const extra = [];
  if (state.stall && state.stall.count) extra.push(`stall ${state.stall.count}${state.stall.step ? ` · ladder ${state.stall.step}/4` : ''}`);
  if ((state.flaky || []).length) extra.push(`flaky ${state.flaky.length}`);
  if ((state.unlocks || []).length) extra.push(`unlocks ${state.unlocks.length}`);
  const skipped = Object.entries((state.gates || {}).skipped || {}).map(([k, v]) => `${k}:${v}`);
  extra.push(`gates skipped: ${skipped.length ? skipped.join(', ') : 'none'}`);
  lines.push('', 'checks  ' + checkRows(cfg, head).join('\n        '));
  if (extra.length) lines.push('        ' + extra.join('   '));

  // The same predicate the hook blocks on, so this can never disagree with reality.
  const blockers = gates.pushBlockers(cfg, { head });
  lines.push('', 'blocking a push');
  if (!blockers.length) lines.push('        nothing');
  else for (const b of blockers) lines.push(`        ${b.gate}: ${b.why} → ${b.fix}`);

  lines.push('', `next    ${require('./hooks').nextStep(state)}`);
  if (state.last_failure) lines.push(`last    ${state.last_failure}`);
  return lines.join('\n');
}

// What a watch loop compares. State plus the two verdicts: a verdict changing is exactly the
// kind of event worth reprinting for.
function fingerprint(cfg) {
  const parts = [];
  for (const f of ['state.json', 'coverage.json', 'security.json']) {
    try { parts.push(f + ':' + fs.readFileSync(path.join(cfg.root, '.keel', f), 'utf8')); }
    catch (e) { parts.push(f + ':none'); }
  }
  return require('crypto').createHash('sha1').update(parts.join('|')).digest('hex');
}

module.exports = { render, fingerprint, rail, acGrid, agentRows, RAILS };
