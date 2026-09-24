'use strict';
// The one view object. Both the MCP tools and the web page render from this and nothing else,
// because two builders would drift and the copy the user is looking at would be the wrong one.
//
// Read-only by construction: nothing here calls st.update(). `update` is read-modify-write with
// no locking, so a dashboard that wrote would race the hooks it is watching.
const fs = require('fs');
const path = require('path');

const config = require('../lib/config');
const st = require('../lib/state');
const board = require('../lib/board');
const gates = require('../lib/gates');
const guards = require('../lib/guards');
const ask = require('../lib/ask');
const todos = require('../lib/todos');
const events = require('../lib/events');
const hooks = require('../lib/hooks');
const { gitOut, readJson } = require('../lib/util');

// Why this phase is what it is, in the user's terms. The rails and the guard matrix say what is
// allowed; this says what you are meant to be doing, which neither of them encodes.
const PHASE_BLURB = {
  preflight: 'Proving the machine is ready and cutting the branch.',
  workspace: 'Bringing the stack up and choosing the lane.',
  triage: 'Deciding how big this change is before any code moves.',
  spec: 'Writing the spec. It needs numbered, layer-tagged acceptance criteria and a human approval.',
  plan: 'Mapping what the change touches. The spec freezes once this is approved.',
  contract: 'Changing the API contract and regenerating from it.',
  red: 'Write the failing test. Production code is frozen — only test files may be edited.',
  green: 'Make the test pass with the minimum production code. Tests are frozen now.',
  ac: 'Test and code together in one commit. Nothing proves the test failed first in this mode.',
  refactor: 'Discharge duplication. Production code only, tests frozen, and it cannot reach GREEN.',
  gate: 'A human decides whether this criterion is really met before the next one starts.',
  'review-fix': 'Fixing what a review found, then going back through the gate.',
  integration: 'Running the whole module suite, not just this criterion.',
  security: 'Auditing the diff for security bugs and triaging dependency advisories.',
  e2e: 'End-to-end specs against the running stack.',
  smoke: 'The short subset that has to pass everywhere.',
  'coverage-fix': 'Closing the gaps the coverage verdict named.',
  trivial: 'A change too small for a criterion. One commit, then ship.',
  'small-change': 'A handful of criteria, no spec.',
  'bug-report': 'Capturing the symptom, before any theory about the cause.',
  'bug-repro': 'The smallest failing test that shows the bug. No fix yet.',
  'gate-r': 'Gate R — is the reproduction the bug you actually meant?',
  'bug-investigate': 'Finding the root cause. Everything is read-only until Gate F.',
  'gate-f': 'Gate F — approving the fix plan. This unlocks production code.',
  'bug-fix': 'Fixing the root cause, not the symptom.',
  ship: 'The release checks, in order, stopping at the first failure.',
  'final-review': 'The last human read before this is pushed.',
  memory: 'Bringing the knowledge base back in step with the code.',
  close: 'Archiving the flow.',
  'hunt-scope': 'Choosing the lenses to sweep with. Nothing has been searched yet.',
  'hunt-sweep': 'One hunter per lens, in parallel. Read-only — this proposes candidates, it never fixes.',
  'hunt-prove': 'Reproducing each candidate against the running stack.',
  'hunt-report': 'Grouping findings by cause and writing the backlog.',
  'hunt-triage': 'Taking items off the backlog into flows of their own.',
};

const FLOW_BLURB = {
  feature: 'a specced feature, full acceptance-criteria loop',
  change: 'a small change, no spec',
  fix: 'a bug, reproduced before it is fixed',
  hunt: 'a read-only sweep for bugs, producing a backlog',
};

function ageSeconds(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
}

// The rail, with each phase marked. `done` is positional: a rail is an ordering, so everything
// left of here has been passed through.
function buildFlow(state) {
  const names = board.RAILS[state.flow] || [];
  const here = names.indexOf(state.phase);
  return {
    flow: state.flow,
    blurb: FLOW_BLURB[state.flow] || null,
    phase: state.phase,
    phaseBlurb: PHASE_BLURB[state.phase] || null,
    index: here,
    total: names.length,
    // A phase off the rail (refactor, review-fix, coverage-fix) is real and has no position;
    // say so rather than placing it at 0 and implying the flow went backwards.
    onRail: here >= 0,
    steps: names.map((n, i) => ({
      phase: n,
      label: board.SHORT[n] || n,
      state: here < 0 ? 'pending' : i < here ? 'done' : i === here ? 'current' : 'pending',
    })),
  };
}

// The flow as the state machine actually is, not flattened to a line. RAILS gives the spine;
// TRANSITIONS gives the branches the rail cannot express — the repair routes, the amendment path
// back to spec, the gate's nine outcomes. Geometry is computed here rather than in the page so
// the layout is deterministic and a scenario can assert it.
// LEFT is the gutter every off-spine edge bows into. A feature flow puts ~27 curves in there,
// so it needs room for them to nest rather than overlap into a smear.
const G = { W: 108, H: 26, ROW: 42, LEFT: 132, GAP: 54, PAD: 16 };

function buildGraph(state, cfg) {
  const rail = board.RAILS[state.flow];
  if (!rail || !rail.length) return null;
  const railRank = new Map(rail.map((n, i) => [n, i]));
  const single = (((cfg || {}).loops) || {}).commit_style === 'single';

  // A detour is a phase that is on no flow's rail at all — refactor, review-fix, coverage-fix,
  // reset: states that exist only to repair something and hand back. A phase on ANOTHER flow's
  // rail is a handoff, not a detour, and drawing it pulls that whole flow in: `gate -> e2e` is
  // legal from a change flow, and following it rendered the feature pipeline inside the change
  // graph. It must lead back into this rail, or it is simply an exit.
  const elsewhere = new Set();
  for (const [f, names] of Object.entries(board.RAILS)) {
    if (f === state.flow) continue;
    for (const n of names) if (!railRank.has(n)) elsewhere.add(n);
  }
  const off = [];
  for (const p of rail) {
    for (const t of (st.TRANSITIONS[p] || [])) {
      if (t === 'none' || railRank.has(t) || off.includes(t) || elsewhere.has(t)) continue;
      if (!(st.TRANSITIONS[t] || []).some((x) => railRank.has(x))) continue;
      // `ac` is the other loop style. Drawing it in a paired project shows a phase that
      // project will never enter.
      if (t === 'ac' && !single) continue;
      off.push(t);
    }
  }

  const rank = new Map(railRank);
  for (const o of off) {
    let min = Infinity;
    for (const p of rail) {
      if ((st.TRANSITIONS[p] || []).includes(o)) min = Math.min(min, railRank.get(p));
    }
    rank.set(o, (min === Infinity ? rail.length : min) + 0.5);
  }
  const rows = [...new Set(rank.values())].sort((a, b) => a - b);
  const rowOf = (n) => rows.indexOf(rank.get(n));

  const legal = new Set(st.TRANSITIONS[state.phase] || []);
  const taken = new Map();                       // row -> how many side nodes already placed
  const nodes = new Map();
  for (const name of [...rail, ...off]) {
    const row = rowOf(name);
    const onRail = railRank.has(name);
    let col = 0;
    if (!onRail) { col = (taken.get(row) || 0) + 1; taken.set(row, col); }
    nodes.set(name, {
      phase: name,
      label: board.SHORT[name] || name,
      onRail,
      row,
      col,
      x: G.LEFT + col * (G.W + G.GAP),
      y: G.PAD + row * G.ROW,
      current: name === state.phase,
      legal: legal.has(name),
      // Positional, like the rail: everything before you on the spine has been passed through.
      done: onRail && railRank.has(state.phase) && railRank.get(name) < railRank.get(state.phase),
    });
  }

  const edges = [];
  for (const [name, n] of nodes) {
    for (const t of (st.TRANSITIONS[name] || [])) {
      const m = nodes.get(t);
      if (!m) continue;                          // `none` and other flows' phases
      edges.push(edgePath(n, m, name === state.phase));
    }
  }

  let width = 0;
  for (const n of nodes.values()) width = Math.max(width, n.x + G.W);
  return {
    nodes: [...nodes.values()],
    edges,
    width: width + G.PAD,
    height: G.PAD * 2 + (rows.length - 1) * G.ROW + G.H,
    box: { w: G.W, h: G.H },
    offRail: off,
  };
}

function edgePath(a, b, live) {
  const midA = a.y + G.H / 2;
  const midB = b.y + G.H / 2;
  const cxA = a.x + G.W / 2;

  if (a.col === 0 && b.col === 0) {
    if (b.row === a.row + 1) {
      return { kind: 'down', live, from: a.phase, to: b.phase,
        d: `M ${cxA} ${a.y + G.H} L ${cxA} ${b.y}` };
    }
    // Everything else on the spine bows out to the left, deeper the further it reaches, so a
    // long back-edge cannot be confused with a short one.
    const span = Math.abs(b.row - a.row);
    const bulge = Math.min(14 + span * 8, G.LEFT - 8);
    return { kind: b.row < a.row ? 'back' : 'skip', live, from: a.phase, to: b.phase,
      d: `M ${a.x} ${midA} C ${a.x - bulge} ${midA} ${b.x - bulge} ${midB} ${b.x} ${midB}` };
  }

  // Anything touching a side node attaches spine-right to side-left, whichever way it points.
  const spine = a.col === 0 ? a : b;
  const side = a.col === 0 ? b : a;
  const sx = spine.x + G.W;
  const tx = side.x;
  const bow = G.GAP * 0.6;
  const [x1, y1, x2, y2] = a.col === 0
    ? [sx, midA, tx, midB]
    : [tx, midA, sx, midB];
  return { kind: 'side', live, from: a.phase, to: b.phase,
    d: `M ${x1} ${y1} C ${x1 + (a.col === 0 ? bow : -bow)} ${y1} ${x2 + (a.col === 0 ? -bow : bow)} ${y2} ${x2} ${y2}` };
}

function buildAcs(state) {
  const ids = st.acList(state);
  const sum = st.acSummary(state);
  return {
    done: sum.done,
    total: sum.total,
    percent: sum.total ? Math.round((sum.done / sum.total) * 100) : 0,
    current: state.current || null,
    items: ids.map((id) => {
      const a = state.acs[id] || {};
      return {
        id,
        layer: a.layer || null,
        status: a.status || 'todo',
        current: id === state.current,
        red: a.red || null,
        green: a.green || null,
        fixes: a.fixes || [],
        gate: a.gate || null,
      };
    }),
  };
}

// RED / GREEN / gate as three lit or unlit steps, which is how the loop is actually experienced.
function buildCurrent(state) {
  if (!state.current) return null;
  const a = state.acs[state.current] || {};
  const step = (name, done, active) => ({ step: name, state: done ? 'done' : active ? 'running' : 'waiting' });
  const inLoop = ['red', 'green', 'gate', 'ac'].includes(state.phase);
  return {
    id: state.current,
    layer: a.layer || null,
    status: a.status || 'todo',
    red: a.red || null,
    green: a.green || null,
    steps: [
      step('RED', !!a.red || ['green', 'done'].includes(a.status), inLoop && state.phase === 'red'),
      step('GREEN', !!a.green || a.status === 'done', inLoop && (state.phase === 'green' || state.phase === 'ac')),
      step('GATE', a.status === 'done', inLoop && state.phase === 'gate'),
    ],
  };
}

function buildAgents(cfg, state) {
  let running = [];
  try { running = st.agentsRunning(state) || []; } catch (e) { running = []; }
  // The last verdict per agent, newest first, from the log rather than from state — state has
  // never held them.
  const seen = new Set();
  const verdicts = [];
  for (const e of events.read(cfg, { filter: 'agents', limit: 200 })) {
    if (e.ev !== 'stop' || !e.verdict || seen.has(e.agent)) continue;
    seen.add(e.agent);
    verdicts.push({ agent: e.agent, verdict: e.verdict, at: e.at, ok: !/fail|stalled|unconfirmed|findings|not-reproducible/i.test(e.verdict) });
    if (verdicts.length >= 6) break;
  }
  return { running, verdicts };
}

function buildChecks(cfg, state, head) {
  const rows = [];
  for (const [name, file] of [['release', 'release.json'], ['coverage', 'coverage.json'],
    ['deps', 'security.json'], ['knowledge', 'memory.json']]) {
    if (name === 'coverage' && (cfg.coverage || {}).enabled === false) {
      rows.push({ name, state: 'skipped', label: 'disabled in config' });
      continue;
    }
    if (name === 'deps') {
      let manifests = [];
      try { manifests = require('../lib/deps').manifestsChanged(cfg) || []; } catch (e) { manifests = []; }
      if (!manifests.length) { rows.push({ name, state: 'skipped', label: 'not needed — no manifest changed' }); continue; }
    }
    if (name === 'knowledge' && !fs.existsSync(path.join(cfg.root, 'docs', 'knowledge'))) continue;
    let v;
    try { v = gates.verdictState(cfg, file, head); } catch (e) { v = { state: 'none', label: 'unreadable' }; }
    rows.push({ name, state: v.state, label: v.label, verdict: v.verdict || null });
  }
  return rows;
}

// The guard matrix for this phase, split into what it permits and what it refuses. Rendering the
// table keel actually enforces means the answer cannot disagree with the hook.
function buildFrozen(state) {
  const row = guards.MATRIX[state.phase];
  if (!row) return null;
  const fallback = row['*'] || 'deny';
  const BUCKETS = ['api-main', 'api-test', 'web-src', 'web-test', 'contract', 'specs',
    'migration', 'e2e', 'smoke', 'generated', 'protected-env', 'other'];
  const allowed = [];
  const denied = [];
  const conditional = [];
  for (const b of BUCKETS) {
    const rule = row[b] || fallback;
    if (rule === 'allow') allowed.push(b);
    else if (rule === 'deny') denied.push(b);
    else conditional.push({ bucket: b, rule });
  }
  return { phase: state.phase, allowed, denied, conditional };
}

function buildHunt(cfg) {
  const p = readJson(path.join(cfg.root, '.keel', 'hunt.json'), null);
  if (!p) return null;
  const run = p.file ? readJson(path.join(cfg.root, p.file), null) : null;
  const lenses = (run && run.lenses) || {};
  return {
    run: p.run || null,
    rev: p.rev || 0,
    open: p.open || 0,
    counts: p.counts || {},
    report: p.report || null,
    lenses: {
      confirmed: lenses.confirmed || [],
      // swept is keyed by "<lens>:<lane>", so its size counts sweeps, not lenses — reporting it
      // against the confirmed count read as "19 of 11".
      sweeps: Object.keys(lenses.swept || {}).length,
      swept: new Set(Object.keys(lenses.swept || {}).map((k) => k.split(':')[0])).size,
    },
    findings: ((run && run.findings) || []).slice(0, 20).map((f) => ({
      id: f.id, title: f.title, lens: f.lens, lane: f.lane,
      severity: f.severity || null, status: f.status, where: (f.where || [])[0] || null,
    })),
  };
}

function buildQuestions(cfg) {
  let open = [];
  try { open = ask.pending(cfg) || []; } catch (e) { open = []; }
  return open
    .sort((a, b) => (b.blocking - a.blocking) || String(a.id).localeCompare(String(b.id)))
    .map((q) => ({
      id: q.id, question: q.question, because: q.because || null,
      blocking: !!q.blocking, raisedBy: q.raised_by || null,
      raisedAt: q.raised_at || null, ageSeconds: ageSeconds(q.raised_at),
    }));
}

// The whole picture, in one object.
function build(cwd, opts = {}) {
  const cfg = config.load(cwd || process.cwd());
  const state = st.read(cfg);
  const active = st.active(state);
  const head = opts.head || gitOut('rev-parse HEAD', cfg.root) || '';

  const view = {
    at: new Date().toISOString(),
    root: cfg.root,
    configured: !!cfg.configured,
    active,
    head: head ? String(head).slice(0, 7) : null,
    questions: buildQuestions(cfg),
    timeline: events.read(cfg, { filter: opts.filter || 'all', limit: opts.limit || 40 }),
    timelineTotal: events.count(cfg),
  };

  if (!active) {
    view.idle = {
      configPath: cfg.configured ? '.keel/config.yml' : null,
      flows: Object.entries(FLOW_BLURB).map(([flow, blurb]) => ({ flow, blurb })),
      lastFlow: lastArchived(cfg),
    };
    // Setup rungs are the only progress worth showing outside a flow.
    try { view.todos = todos.build(state, cfg) || []; } catch (e) { view.todos = []; }
    return view;
  }

  view.header = {
    title: state.spec ? path.basename(state.spec) : state.flow,
    flow: state.flow,
    size: state.size || null,
    spec: state.spec || null,
    branch: state.branch || null,
    lane: st.laneOf(state),
    gates: (state.gates || {}).mode || null,
  };
  view.flow = buildFlow(state);
  view.graph = buildGraph(state, cfg);
  view.acs = buildAcs(state);
  view.current = buildCurrent(state);
  view.agents = buildAgents(cfg, state);
  view.checks = buildChecks(cfg, state, head);
  view.frozen = buildFrozen(state);
  view.hunt = state.flow === 'hunt' ? buildHunt(cfg) : null;

  try { view.blockers = gates.pushBlockers(cfg, { head }) || []; } catch (e) { view.blockers = []; }
  try { view.todos = todos.build(state, cfg) || []; } catch (e) { view.todos = []; }
  try { view.next = hooks.nextStep(state); } catch (e) { view.next = 'see `keel status`'; }

  view.gateDue = state.current ? st.gateDue(state, state.current) : null;
  view.stall = state.stall && state.stall.count ? state.stall : null;
  view.flaky = (state.flaky || []).length;
  view.unlocks = (state.unlocks || []).length;
  view.gatesSkipped = (state.gates || {}).skipped || {};
  view.shipSkipped = state.ship_skipped || [];
  view.lastFailure = state.last_failure || null;

  return view;
}

// One project's card on the overview: enough to tell which of several needs you, without paying
// for the full view — no git, no gate verdicts, no guard matrix.
function summary(cwd) {
  const cfg = config.load(cwd || process.cwd());
  const state = st.read(cfg);
  const active = st.active(state);
  const questions = buildQuestions(cfg);
  const lastEvent = events.read(cfg, { limit: 1 })[0] || null;
  const out = {
    root: cfg.root,
    configured: !!cfg.configured,
    active,
    blocking: questions.filter((q) => q.blocking).length,
    questions: questions.length,
    lastAt: lastEvent ? lastEvent.at : null,
    lastFailure: state.last_failure || null,
    stalled: !!(state.stall && state.stall.count > 1),
  };
  if (!active) return out;
  const sum = st.acSummary(state);
  const rail = board.RAILS[state.flow] || [];
  return Object.assign(out, {
    flow: state.flow,
    phase: state.phase,
    phaseLabel: board.SHORT[state.phase] || state.phase,
    step: rail.indexOf(state.phase),
    steps: rail.length,
    title: state.spec ? path.basename(state.spec) : state.flow,
    current: state.current || null,
    acs: { done: sum.done, total: sum.total },
    agents: (() => { try { return (st.agentsRunning(state) || []).length; } catch (e) { return 0; } })(),
  });
}

function summaryLine(p, width) {
  const name = p.name.padEnd(width);
  if (p.error) return `${name}  unreadable: ${p.error}`;
  const wait = p.blocking ? `  WAITING ON YOU (${p.blocking})` : p.stalled ? '  stalled' : '';
  if (!p.active) return `${name}  idle${wait}`;
  const acs = p.acs && p.acs.total ? `  ${p.acs.done}/${p.acs.total} ACs` : '';
  const cur = p.current ? `  ${p.current}` : '';
  return `${name}  ${p.flow} · ${p.phase}${acs}${cur}${wait}`;
}

// Every project on the machine's list, one line each; `hereId` gets a star. Shared by
// `keel projects` and the keel_projects tool, so the two cannot disagree.
function projectsText(hereId) {
  const all = require('../lib/projects').list();
  if (!all.length) return 'no keel projects on this machine yet. A project joins the list when a session starts in it.';
  const width = Math.max(...all.map((p) => p.name.length));
  return all.map((p) => {
    let sum;
    try { sum = summary(p.root); } catch (e) { sum = { error: (e && e.message) || String(e) }; }
    return (p.id === hereId ? '* ' : '  ') + summaryLine(Object.assign({}, sum, p), width);
  }).join('\n');
}

function lastArchived(cfg) {
  try {
    const d = path.join(cfg.root, '.keel', 'archive');
    const files = fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort();
    if (!files.length) return null;
    const s = readJson(path.join(d, files[files.length - 1]), null);
    if (!s) return null;
    const sum = st.acSummary(s);
    return { flow: s.flow, spec: s.spec, done: sum.done, total: sum.total, file: files[files.length - 1] };
  } catch (e) { return null; }
}

// What a watcher compares. board.fingerprint already hashes the four verdict files; questions and
// the event log are the two things it does not know about.
function fingerprint(cwd) {
  const cfg = config.load(cwd || process.cwd());
  let fp = '';
  try { fp = board.fingerprint(cfg); } catch (e) { fp = 'x'; }
  let q = 0;
  try { q = fs.statSync(ask.file(cfg)).mtimeMs; } catch (e) { q = 0; }
  let n = 0;
  try { n = fs.statSync(events.file(cfg)).size; } catch (e) { n = 0; }
  return `${fp}:${q}:${n}`;
}

module.exports = { build, summary, projectsText, fingerprint, PHASE_BLURB, FLOW_BLURB };
