'use strict';
const fs = require('fs');
const path = require('path');
const { run, git, gitOut, trim, fingerprint, readJson, writeJson, ensureGitignore } = require('./util');
const config = require('./config');
const st = require('./state');
const guards = require('./guards');
const verify = require('./verify');
const coverage = require('./coverage');
const setup = require('./setup');
const ops = require('./ops');

function out(s) { process.stdout.write(String(s).replace(/\n*$/, '\n')); }
function fail(s, code = 1) { process.stdout.write('keel: ' + String(s).replace(/\n*$/, '\n')); process.exit(code); }

/* ---------------------------------------------------------------- init */

// Async because --refresh runs the ladder, which is concurrent now.
// Rendering the template is shared with `keel upgrade`, which needs the same substitutions to
// see what a current config would look like before splicing anything into an older one.
function renderConfig(d, dockerOk) {
  return fs.readFileSync(path.join(__dirname, '..', 'templates', 'config.yml'), 'utf8')
    .replaceAll('{{BACKEND_DIR}}', d.backendDir || 'apps/api')
    .replaceAll('{{FRONTEND_DIR}}', d.frontendDir || 'apps/web')
    .replaceAll('{{BUILD}}', d.build || './gradlew')
    .replaceAll('{{PM}}', d.pm)
    .replaceAll('{{CONTRACT}}', d.contract || 'contracts/openapi.yaml')
    .replaceAll('{{E2E_DIR}}', d.e2e || 'e2e')
    .replaceAll('{{SERVICES}}', d.compose ? 'docker' : (dockerOk ? 'docker' : 'none'))
    .replaceAll('{{COMPOSE}}', d.compose || '')
    // Only what discovery proved. Anything unproven is left blank with its suggestion in a
    // comment — the shape the template already used well for migrate and api_health_check —
    // so a missing command fails its tier loudly at init instead of quietly at run time.
    .replaceAll('{{WEB_URL}}', `http://localhost:${d.webPort || 5173}`)
    .replaceAll('{{WEB_TEST_AC}}', d.hasVitest ? 'npx vitest run -t {AC}'
      : d.hasJest ? 'npx jest -t {AC}' : "''           # e.g. npx vitest run -t {AC}")
    .replaceAll('{{WEB_TEST_MODULE}}', d.hasVitest ? 'npx vitest run'
      : d.hasJest ? 'npx jest' : "''           # e.g. npx vitest run")
    .replaceAll('{{WEB_TEST_PATHS}}', d.hasVitest ? 'npx vitest run {PATHS}'
      : d.hasJest ? 'npx jest {PATHS}' : "''           # e.g. npx vitest run {PATHS}")
    .replaceAll('{{COVERAGE_API}}', d.coverageTool === 'kover' ? `${d.build || './gradlew'} -q koverXmlReport`
      : d.coverageTool === 'jacoco' ? `${d.build || './gradlew'} -q jacocoTestReport`
        : "''           # e.g. ./gradlew -q koverXmlReport, or jacocoTestReport")
    .replaceAll('{{COVERAGE_WEB}}', d.hasVitest ? 'npx vitest run --coverage'
      : "''           # e.g. npx vitest run --coverage")
    .replaceAll('{{E2E_CMD}}', d.hasPlaywright ? 'npx playwright test'
      : "''           # e.g. npx playwright test")
    .replaceAll('{{SMOKE_E2E_CMD}}', d.hasPlaywright ? 'npx playwright test --grep @smoke'
      : "''           # e.g. npx playwright test --grep @smoke");
}

async function init(args) {
  const cfg = config.load();
  const root = cfg.root;
  const d = config.detect(root);
  const lines = [];
  lines.push(`root: ${root}`);
  lines.push(`backend: ${d.backendDir || 'not found'}   build: ${d.build || 'not found'}`);
  lines.push(`frontend: ${d.frontendDir || 'not found'}   package manager: ${d.pm}`);
  lines.push(`contract: ${d.contract || 'none found'}`);
  lines.push(`compose: ${d.compose || 'none found'}${d.compose ? '  (recommended: use it for services)' : ''}`);
  lines.push(`e2e: ${d.e2e || 'none found'}`);

  const dockerOk = run('docker info', { timeout: 15000 }).code === 0;
  lines.push(`docker: ${dockerOk ? 'running' : 'not available'}`);
  lines.push(`java: ${run('java -version').out.split('\n')[0] || 'not found'}`);
  lines.push(`node: ${run('node -v').out.trim() || 'not found'}`);

  if (args.includes('--new')) {
    const made = setup.scaffold(cfg, 'starter');
    lines.push(...made);
  }
  if (args.includes('--dev-container')) {
    lines.push(...setup.scaffold(cfg, 'dev-container'));
    lines.push('set runtime.app to container in .keel/config.yml to use it');
  }
  if (args.includes('--refresh')) {
    const res = await setup.ladder(cfg, { resume: false });
    lines.push(...res.results.map((r) => `${r.status.toUpperCase().padEnd(9)} ${r.label}`));
    if (!res.stopped) lines.push(`runbook: ${setup.runbook(cfg, res)}`);
  }
  if (args.includes('--write')) {
    askBlocked(cfg);
    const file = path.join(root, '.keel', 'config.yml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tpl = renderConfig(d, dockerOk);
    fs.writeFileSync(file, tpl);
    ensureGitignore(root);
    lines.push(`wrote ${path.relative(root, file)} and updated .gitignore`);
  } else {
    lines.push('run `keel init --write` to write .keel/config.yml');
  }
  out(lines.join('\n'));
}

/* ------------------------------------------------------------- upgrade */

function upgrade(args) {
  const cfg = config.load();
  const write = args.includes('--write');
  if (!cfg.configured) {
    return fail('this project has no .keel/config.yml. Run `keel init --write` first; upgrade only touches an existing setup.');
  }
  const upg = require('./upgrade');
  const p = upg.plan(cfg);
  if (p.error) {
    return fail([p.error, 'Fix it by hand, or move it aside and run `keel init --write` to start from the current template.'].join('\n'), 3);
  }
  if (p.newer) {
    return fail([`.keel/config.yml is version ${p.from}, but this keel understands version ${p.target}.`,
      'It was written by a newer keel. Update the plugin rather than downgrading the config.'].join('\n'), 3);
  }
  if (!p.changed) return out(`already up to date: config version ${p.from}, nothing to add. Running this again changes nothing.`);

  const lines = [write ? 'keel upgrade' : 'keel upgrade \u2014 dry run, nothing written', ''];
  lines.push(...p.applied.map((m) => `v${m.to}: ${m.note}`));
  if (p.applied.length) lines.push('');

  lines.push(`.keel/config.yml${p.from < p.target ? `   version ${p.from} -> ${p.target}` : ''}`);
  for (const a of p.config.adds) {
    lines.push(`  + ${a.path}${a.why === 'new block' ? '  (new block)' : ''}`);
    lines.push(...a.lines.filter((l) => l.trim() !== '').map((l) => '      ' + l));
  }
  if (!p.config.adds.length) lines.push('  no keys missing');
  lines.push(`  = ${p.config.present} key(s) already present, left untouched`);

  lines.push('', '.keel/state.json');
  if (p.state.skip) lines.push(`  skipped: ${p.state.skip}`);
  else if (!p.state.changes.length) lines.push('  already the current shape');
  else lines.push(...p.state.changes.map((c) => '  + ' + c));

  lines.push('', '.gitignore');
  lines.push(...(p.gitignore.missing.length ? p.gitignore.missing.map((l) => '  + ' + l)
    : ['  = every per-machine line already present']));

  if (!write) {
    lines.push('', 'Your values, comments and layout are kept; only missing keys are added.',
      'Rerun with `keel upgrade --write` to apply.');
    return out(lines.join('\n'));
  }
  upg.apply(cfg, p);
  lines.push('', `wrote ${path.relative(cfg.root, p.config.file)}`
    + (p.state.changes.length ? ', .keel/state.json' : '')
    + (p.gitignore.missing.length ? ', .gitignore' : '') + '.',
    'Run `keel status` to check the config still reads cleanly.');
  out(lines.join('\n'));
}

/* --------------------------------------------------------------- state */

// The flows keel knows, and the phase each one starts in. Adding a flow means this table, a
// rail in board.RAILS, and a guard row per phase — the three places `keel simulate` checks.
const FLOW_START = { feature: 'spec', change: 'triage', fix: 'bug-report', hunt: 'hunt-scope' };

function stateCmd(args) {
  const cfg = config.load();
  const sub = args[0] || 'show';
  const state = st.read(cfg);

  if (sub === 'show') {
    return out(JSON.stringify(state, null, 2));
  }
  if (sub === 'start') {
    const flow = args[1] || 'feature';
    const opts = parseOpts(args.slice(2));
    // A table, not a ternary chain. The chain ended `: 'spec'`, so every flow it did not name
    // started in the spec phase — an unregistered flow, or a typo, got a phase whose guard row
    // allows writing specs and a board rail that renders as a feature. Nothing complained.
    if (!FLOW_START[flow]) return fail(`unknown flow "${flow}". Flows: ${Object.keys(FLOW_START).join(', ')}.`);
    if (opts.phase && !st.PHASES.includes(opts.phase)) {
      return fail(`unknown phase "${opts.phase}". Known: ${st.PHASES.join(', ')}`);
    }
    const branch = gitOut('rev-parse --abbrev-ref HEAD', cfg.root, null);
    // --no-gates was documented in two skills and parsed nowhere. A waiver is recorded in
    // `skipped` as well as held as a flag, so the final review and the PR body report it
    // through the path that already exists for a skipped AC gate.
    const bugGates = opts['no-gates'] ? false : cfg.gates.bug_gates !== false;
    st.update(cfg, (s) => {
      Object.assign(s, st.EMPTY, {
        flow, size: opts.size || (flow === 'change' ? 'small' : 'full'),
        phase: opts.phase || FLOW_START[flow],
        spec: opts.spec || null, branch, lane: opts.lane || 'api',
        gates: {
          mode: opts.gates || cfg.gates.mode,
          bug_gates: bugGates,
          skipped: bugGates ? {} : { 'bug-gates': opts['no-gates'] ? 'waived with --no-gates' : 'waived by gates.bug_gates: false' },
          log: [],
        },
      });
    });
    const started = st.read(cfg);
    return out(`started ${flow} flow, phase ${started.phase}`
      + (bugGates ? '' : '\nbug gates are waived: Gate R and Gate F will record an automatic approval.'));
  }
  if (sub === 'phase') {
    const to = args[1];
    const opts = parseOpts(args.slice(2));
    if (!st.PHASES.includes(to)) return fail(`unknown phase "${to}". Known: ${st.PHASES.join(', ')}`);
    const from = state.phase;
    if (!st.canTransition(from, to) && !opts.force) {
      const allowed = (st.TRANSITIONS[from] || []).join(', ') || 'none';
      return fail(`"${from}" cannot move to "${to}". From "${from}" you can go to: ${allowed}.\n`
        + `If this is genuinely the right jump, repeat it with --force and the override is recorded.`, 3);
    }
    st.update(cfg, (s) => {
      s.phase = to;
      if (opts.force && !st.canTransition(from, to)) {
        s.gates.log.push({ at: new Date().toISOString(), forced: `${from} -> ${to}` });
      }
    });
    return out(opts.force && !st.canTransition(from, to)
      ? `phase: ${to} (forced from ${from}; recorded)` : `phase: ${to}`);
  }
  if (sub === 'advance') {
    // The next phase in the flow's own order, so a skill does not hardcode it.
    const nexts = st.TRANSITIONS[state.phase] || [];
    const to = nexts.find((p) => p !== 'none');
    if (!to) return fail(`"${state.phase}" has no next phase. Use \`keel state phase <name>\`.`, 3);
    st.update(cfg, (s) => { s.phase = to; });
    return out(`phase: ${to} (advanced from ${state.phase})`);
  }
  if (sub === 'lane') {
    const to = args[1];
    if (!to) return out(`lane: ${state.lane}`);
    st.update(cfg, (s) => { s.lane = to; });
    return out(`lane: ${to}`);
  }
  // A dependency the spec asked for and a human approved. Without this the 0.40 rule had no
  // exit: the criterion could be written, agreed and committed, and the install still refused.
  if (sub === 'dep') {
    const name = args[1];
    const o = parseOpts(args.slice(2));
    if (!name) {
      const have = state.deps || [];
      return out(have.length ? `approved dependencies: ${have.join(', ')}`
        : 'no approved dependencies. `keel state dep <name> --by user` after the spec gate.');
    }
    // --by user matters here for the same reason it does on a blocking question: a model
    // approving its own dependency is the failure the rule exists to prevent, and the report
    // has to be able to say which it was.
    const by = String(o.by && o.by !== true ? o.by : 'model').toLowerCase();
    st.update(cfg, (s) => { s.deps = (s.deps || []).concat(name).filter((v, i, a) => a.indexOf(v) === i); });
    return out(`approved: ${name} (by ${by})`
      + (by === 'model' ? '\n  recorded as a self-approval — the ship report will say so.' : ''));
  }
  if (sub === 'ac') {
    // keel state ac AC-001 --layer API [--current]
    const id = args[1];
    const opts = parseOpts(args.slice(2));
    // templates/spec.md documents `[gate: skip]` for a trivial criterion, and nothing read
    // it. Read it from the spec line for this AC so the tag actually does something.
    const tagged = opts.gate ? opts.gate === 'skip' : specSaysSkipGate(cfg, state.spec, id);
    st.update(cfg, (s) => {
      s.acs[id] = Object.assign({ layer: opts.layer || 'API', status: 'todo' }, s.acs[id] || {});
      if (tagged) s.acs[id].gate = 'skip';
      if (opts.current !== undefined || Object.keys(s.acs).length === 1) { s.current = id; }
      if (opts.status) s.acs[id].status = opts.status;
    });
    return out(`AC ${id} recorded${tagged ? ' (human gate skipped: tagged [gate: skip])' : ''}`);
  }
  if (sub === 'board') return out(st.board(state));
  if (sub === 'red-done') return redDone(cfg);
  if (sub === 'green-done') return greenDone(cfg);
  // The single-commit loop's only transition check. It runs exactly what green-done runs —
  // there is no separate verification here, and no red-done before it, which is the mode.
  if (sub === 'ac-done') return greenDone(cfg, { single: true });
  // Record a ship step the human chose not to run. It lands in the final review and the PR body,
  // for the same reason an unlock does: a skip nobody sees at the end cannot be told apart from
  // a step that silently failed to run.
  if (sub === 'ship-skip') {
    const step = args[1];
    const o = parseOpts(args.slice(2));
    if (!step) {
      const had = state.ship_skipped || [];
      return out(had.length ? had.map((s) => `  ${s.step}: ${s.reason || 'no reason given'}`).join('\n')
        : 'no ship steps skipped.');
    }
    if (!o.reason || o.reason === true) return fail('usage: keel state ship-skip <step> --reason "<why>"');
    const deferred = ['release', 'coverage', 'deps'];
    st.update(cfg, (s) => {
      s.ship_skipped = (s.ship_skipped || []).filter((x) => x.step !== step)
        .concat([{ step, reason: String(o.reason), at: new Date().toISOString() }]);
    });
    return out(`recorded: ${step} skipped — ${o.reason}`
      + (deferred.includes(step)
        ? `\n  note: the push still refuses without a fresh ${step} verdict. This defers the work, it does not remove the gate.`
        : ''));
  }
  if (sub === 'repro-done') return reproDone(cfg);
  if (sub === 'close') {
    // Phase 10: archive the finished flow so the next one starts clean, and so a
    // completed flow's trace survives for the record.
    if (!state.flow) return fail('no active flow to close.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${state.flow}-${(state.spec || 'no-spec').replace(/^.*\//, '').replace(/\.md$/, '')}-${stamp}.json`;
    const dest = path.join(cfg.root, '.keel', 'archive', name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeJson(dest, state);
    const sum = st.acSummary(state);
    st.write(cfg, Object.assign({}, st.EMPTY));
    return out(`closed. ${sum.done}/${sum.total} ACs done; state archived to .keel/archive/${name}`);
  }
  if (sub === 'abort') { st.write(cfg, Object.assign({}, st.EMPTY)); return out('flow cleared'); }
  return fail(`unknown state command "${sub}"`);
}

function currentLane(state) { return st.acLaneOf(state); }

// Does the spec tag this acceptance criterion with [gate: skip]? Fenced blocks are blanked
// first: the spec now carries ASCII drawings, and one that mentions a criterion id must not
// be mistaken for the criterion's own line.
function specSaysSkipGate(cfg, spec, id) {
  if (!spec || !id) return false;
  try {
    const text = fs.readFileSync(path.join(cfg.root, spec), 'utf8');
    const line = require('./spec').unfencedLines(text).find((l) => l.includes(id));
    return !!line && /\[gate:\s*skip\]/i.test(line);
  } catch (e) { return false; }
}

function redDone(cfg) {
  const state = st.read(cfg);
  const ac = state.current;
  if (!ac) return fail('no current AC. Run `keel state ac <AC-ID> --layer API --current` first.');
  const lane = currentLane(state);
  const res = verify.acTests(cfg, ac, lane);

  if (res.ok) {
    return fail([
      `the tests for ${ac} already pass, so this is not a red state.`,
      'Either the behaviour already exists (mark it with `keel state ac ' + ac + ' --status already-met` and record the evidence),',
      'or the test asserts nothing. Fix the test and run this again.',
    ].join('\n'), 3);
  }
  const kind = verify.classifyFailure(cfg, res.raw);
  if (kind.kind === 'setup') {
    st.recordFailure(cfg, res.raw, res.fingerprint);
    return fail([
      `the tests for ${ac} fail, but from a setup problem, not an assertion (matched "${kind.matched}").`,
      'Fix the test setup first. A compile error, a Spring context failure or a Docker error is not a red test.',
      '',
      trim(res.raw, 15),
    ].join('\n'), 3);
  }
  st.update(cfg, (s) => {
    s.acs[ac] = Object.assign({ layer: 'API' }, s.acs[ac], { status: 'red' });
    s.phase = 'red';
  });
  out([`${ac}: red confirmed (assertion failure).`, '', trim(res.raw, 10), '',
    `Now commit the test: keel commit red ${ac} "<what it asserts>"`].join('\n'));
}

function greenDone(cfg, opts = {}) {
  const state = st.read(cfg);
  const ac = state.current;
  if (!ac) return fail('no current AC.');
  const lane = currentLane(state);
  const acRes = verify.withFlakeCheck(cfg, () => verify.acTests(cfg, ac, lane), `${ac} tests`);
  if (!acRes.ok) {
    st.recordFailure(cfg, acRes.raw, acRes.fingerprint);
    const s2 = st.read(cfg);
    let extra = '';
    if (st.stalled(cfg, s2)) {
      const next = st.nextLadderStep(cfg);
      extra = `\n\nStalled: the same failure ${s2.stall.count} times in a row.\nStall ladder ${next.step}/4 — ${next.advice}`;
    }
    return fail(`${ac} does not pass yet:\n\n${acRes.report}${extra}`, 3);
  }
  const moduleWhen = cfg.tests.module_suite_at;
  let modReport = '';
  if (moduleWhen === 'every-ac') {
    const mod = verify.withFlakeCheck(cfg, () => verify.moduleTests(cfg, lane), `${lane} module suite`);
    if (!mod.ok) {
      st.recordFailure(cfg, mod.raw, mod.fingerprint);
      return fail(`${ac} passes but the ${lane} module suite broke:\n\n${mod.report}`, 3);
    }
    modReport = `${lane} module suite green. `;
  }
  st.clearStall(cfg);
  st.update(cfg, (s) => {
    s.acs[ac] = Object.assign({}, s.acs[ac], { status: 'green' });
    // The single loop stays in `ac`; the paired one is already in `green` and this is a no-op
    // that used to matter when green-done could be reached from elsewhere.
    s.phase = opts.single ? 'ac' : 'green';
  });
  let covLine = '';
  const perAc = (cfg.coverage || {}).per_ac || 'off';
  if (perAc !== 'off' && (cfg.coverage.reports || {})) {
    const v = coverage.run(cfg, { base: cfg.base_branch || 'main' });
    if (v.apps && v.apps.length && !v.apps.every((a) => a.error)) {
      const worst = v.apps.filter((a) => a.changed_pct !== null && !a.error);
      const text = worst.map((a) => `${a.app} ${a.changed_pct}%`).join(', ');
      if (!v.pass && perAc === 'enforce') {
        return fail(`${ac} passes, but coverage of the changed lines is below the threshold (${text}).\n` +
          (v.apps.flatMap((a) => a.uncovered || []).map((u) => '  ' + u).join('\n') || ''), 3);
      }
      covLine = v.pass ? `\nCoverage of changed lines: ${text}.` : `\nWarning: coverage of changed lines is low (${text}); ship will enforce it.`;
    }
  }
  const flaky = acRes.flaky ? '\nNote: one test failed then passed on rerun; recorded as flaky.' : '';
  // What happens after the commit depends on whether a human gate is due for this AC —
  // the one place the four skip paths are resolved. When the gate is skipped and
  // gates.ai_review_on_skip is on, the reviewer stands in for it.
  const due = st.gateDue(st.read(cfg), ac);
  let after = `keel gate ac approve|review|reject|skip`;
  if (!due.due) {
    after = (cfg.gates || {}).ai_review_on_skip
      ? `no human gate here (${due.why}), so run keel:ac-reviewer on this AC's two commits first;\n`
        + `if it reports AC-REVIEW: findings the gate applies after all, otherwise: keel state phase red`
      : `no human gate here (${due.why}), so continue: keel state phase red`;
  }
  out([`${ac}: green. ${modReport}`.trim() + covLine + flaky, '',
    `Now commit the code: keel commit green ${ac} "<what it does>"`, `Then: ${after}`].join('\n'));
}

function reproDone(cfg) {
  const state = st.read(cfg);
  const id = state.current || 'BUG';
  const lane = currentLane(state);
  const res = verify.acTests(cfg, id, lane);
  if (res.ok) return fail(`the test for ${id} passes, so it does not reproduce the bug yet.`, 3);
  const kind = verify.classifyFailure(cfg, res.raw);
  if (kind.kind === 'setup') {
    return fail(`the test fails from a setup problem (matched "${kind.matched}"), not the bug. Fix the setup first.`, 3);
  }
  st.update(cfg, (s) => { s.phase = 'bug-repro'; });
  out([`${id}: reproduced.`, '', trim(res.raw, 10), '',
    `Commit it: keel commit red ${id} "reproduce <symptom>"`,
    'Then Gate R: ask the user whether this is the bug they meant (`keel gate R approve`).'].join('\n'));
}

/* -------------------------------------------------------------- commits */

// Phases whose whole job is repairing something a check found. A `fix` committed from one of
// these returns by the route that sent it there — ship step 1, step 2b, the AC gate — so the
// commit must not decide that itself.
const REPAIR_PHASES = new Set(['review-fix', 'coverage-fix', 'security', 'ship']);

const COMMIT_RULES = {
  red:      { prefix: (id) => `test(${id})`, allow: ['api-test', 'web-test', 'e2e'], deny: ['api-main', 'web-src'] },
  green:    { prefix: (id) => `feat(${id})`, allow: ['api-main', 'web-src', 'migration', 'other'], deny: ['api-test', 'web-test'] },
  refactor: { prefix: (id) => `refactor(${id})`, allow: ['api-main', 'web-src', 'other'], deny: ['api-test', 'web-test'] },
  fix:      { prefix: (id) => `fix(${id})`, allow: ['api-main', 'web-src', 'api-test', 'web-test', 'migration', 'other'], deny: [] },
  // Production files are allowed through the bucket check so the delete-only rule below
  // can inspect the diff: they may lose unreachable lines but never gain any.
  coverage: { prefix: () => 'test(coverage)', allow: ['api-test', 'web-test', 'api-main', 'web-src'], deny: [], deleteOnlyProd: true, noId: true },
  contract: { prefix: (id) => `contract(${id})`, allow: ['contract', 'other'], deny: ['api-test', 'web-test'] },
  e2e:      { prefix: (id) => `e2e(${id})`, allow: ['e2e'], deny: ['api-main', 'web-src', 'api-test', 'web-test'] },
  smoke:    { prefix: () => 'test(smoke)', allow: ['smoke', 'other'], deny: ['api-main', 'web-src'], noId: true },
  trivial:  { prefix: (id) => `refactor(${id})`, allow: ['api-main', 'web-src', 'other'], deny: [], trivial: true },
  docs:     { prefix: (id) => `docs(${id})`, allow: ['specs', 'other'], deny: ['api-main', 'web-src'] },
  // `loops.commit_style: single` — one commit carrying this criterion's test and its code. It
  // keeps the `feat(` prefix deliberately: `keel trace` finds each AC by `feat(AC-n)`/`fix(AC-n)`,
  // so reusing it means trace needs no change. `keel audit` is the one thing that has to learn
  // about this mode, because it otherwise flags a `feat(` commit that carries tests.
  ac:       { prefix: (id) => `feat(${id})`, allow: ['api-main', 'web-src', 'api-test', 'web-test', 'migration', 'other'], deny: [] },
  // The knowledge base is regenerated after the reviewers have seen the code diff, so it
  // cannot ride inside a reviewed commit and needs a type of its own.
  memory:   { prefix: () => 'docs(memory)', allow: ['other'], deny: ['api-main', 'web-src', 'api-test', 'web-test', 'contract', 'migration'], memoryOnly: true, noId: true },
  // What an init produces: the config the ladder reads, the runbook it writes, the knowledge base
  // and the CLAUDE.md block. None of it belongs to an acceptance criterion, so before this type
  // existed an init either went uncommitted or was committed by hand around keel entirely.
  setup:    { prefix: () => 'chore(setup)', allow: ['other'], deny: ['api-main', 'web-src', 'api-test', 'web-test', 'contract', 'migration'], setupOnly: true, noId: true },
};

// A setup commit carries the files an init writes and nothing else. Production code, tests, the
// contract and migrations are already refused by the bucket rule above; this narrows the `other`
// bucket, which would otherwise wave through anything unclassified.
const SETUP_PATHS = [/^\.keel\//, /^docs\/RUNNING\.md$/, /^docs\/knowledge\//, /^CLAUDE\.md$/, /^\.gitignore$/];

function commit(args) {
  const cfg = config.load();
  const state = st.read(cfg);
  const type = args[0];
  const rule = COMMIT_RULES[type];
  if (!rule) return fail(`unknown commit type "${type}". Types: ${Object.keys(COMMIT_RULES).join(', ')}`);

  // A type whose prefix ignores the ID takes `keel commit <type> "<message>"` as well as the
  // three-argument form. A smoke run, a coverage pass and an init have no acceptance criterion,
  // and demanding one only ever got a placeholder invented to satisfy the parser.
  const withId = !rule.noId || args.length > 2;
  const id = withId ? args[1] : '';
  const message = (withId ? args.slice(2) : args.slice(1)).join(' ').replace(/^["']|["']$/g, '');
  if (!message || (withId && !id)) {
    return fail(rule.noId ? `usage: keel commit ${type} "<message>"`
                          : `usage: keel commit ${type} <ID> "<message>"`);
  }

  git('add -A', cfg.root);
  const staged = git('diff --cached --name-only', cfg.root).out.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!staged.length) return fail('nothing to commit.');

  // The edit-time scan runs in postTool, so the file is already on disk, and it never sees a
  // shell write at all. The staged diff is the last place a secret can be stopped before it is
  // in history, which is a much worse conversation.
  const secrets = require('./secrets');
  const diff = git('diff --cached -U0', cfg.root).out;
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const found = [];
  for (const line of added) {
    const hits = secrets.scan(line.slice(1));
    if (hits && hits.length) found.push(...hits.map((h) => (h && h.why) || String(h)));
  }
  if (found.length) {
    git('reset', cfg.root);
    return fail([`this commit stages what looks like a secret: ${[...new Set(found)].join(', ')}`,
      '', 'Remove it and use an environment variable — `keel env` lists the names this project',
      'expects. If it is a false positive, the value still does not belong in a diff; move it',
      'behind a variable anyway rather than arguing with the scanner.'].join('\n'), 3);
  }

  // The shell guard refuses `npm install <pkg>`, and for Kotlin that is not how a dependency is
  // added at all — you edit build.gradle.kts, which is `api-main` and writable in GREEN, then run
  // a bare `./gradlew build` that names no package. So the rule was strongest against the path
  // nobody uses. Caught here instead, on what was actually staged.
  if (state.flow && state.phase !== 'none') {
    const addsDeps = guards.manifestAdditions(git('diff --cached -U0', cfg.root).out)
      .filter((d) => !guards.manifestNames(d.line).some((n) => guards.dependencyApproved(state, n)));
    if (addsDeps.length) {
      git('reset', cfg.root);
      return fail([`this commit adds ${addsDeps.length === 1 ? 'a dependency' : 'dependencies'} to a manifest:`,
        ...addsDeps.map((d) => `  ${d.file}: ${d.line}`),
        '',
        'A new dependency outlives this branch: somebody maintains it, it carries a licence and a',
        'supply chain, and it ships to everyone. That is a criterion the spec should name and a',
        'human should approve — not a line added to get one test to compile.',
        '',
        'Through the spec and the gate, then record it:  keel state dep <name> --by user',
        'If the spec is already frozen, that is an amendment: `keel state phase spec`.'].join('\n'), 3);
    }
  }

  const buckets = staged.map((f) => [f, guards.classify(cfg, f)]);
  const bad = buckets.filter(([, b]) => rule.deny.includes(b));
  if (bad.length) {
    git('reset', cfg.root);
    return fail([`a ${type} commit may not contain these files:`,
      ...bad.map(([f, b]) => `  ${f}  (${b})`),
      type === 'red' ? 'Move the production code to the green commit.' :
      type === 'green' ? 'Test files belong to the red commit. If a test is wrong, reject the AC at the gate.' :
      'Remove them from this commit.'].join('\n'), 3);
  }
  if (rule.trivial) {
    const editedTests = buckets.filter(([f, b]) => ['api-test', 'web-test', 'e2e'].includes(b) &&
      git(`cat-file -e HEAD:${f}`, cfg.root).code === 0);
    if (editedTests.length) {
      git('reset', cfg.root);
      return fail([`this is not a trivial change: it edits existing tests:`,
        ...editedTests.map(([f]) => '  ' + f),
        'Run `keel state start change --size small` and drive it through the AC loop instead.'].join('\n'), 3);
    }
    const risky = buckets.filter(([, b]) => ['contract', 'migration'].includes(b));
    if (risky.length) {
      git('reset', cfg.root);
      return fail([`this is not a trivial change: it touches ${risky.map(([f, b]) => `${f} (${b})`).join(', ')}.`,
        'Escalate with `keel escalate`.'].join('\n'), 3);
    }
  }

  // A memory commit may only touch the knowledge base and its verdict. Without this, the
  // `other` bucket would let it carry anything unclassified.
  if (rule.memoryOnly) {
    // keel's own files under .keel/ are allowed through: they are usually gitignored, but
    // a project that tracks them should not be unable to make this commit.
    const stray = staged.filter((f) => !/^docs\/knowledge\//.test(f) && !/^\.keel\//.test(f));
    if (stray.length) {
      git('reset', cfg.root);
      return fail([`a memory commit may only touch docs/knowledge/ and .keel/memory.json:`,
        ...stray.map((f) => '  ' + f)].join('\n'), 3);
    }
  }

  if (rule.setupOnly) {
    const stray = staged.filter((f) => !SETUP_PATHS.some((re) => re.test(f)));
    if (stray.length) {
      git('reset', cfg.root);
      return fail([`a setup commit may only touch what an init writes `
        + `(.keel/, docs/RUNNING.md, docs/knowledge/, CLAUDE.md, .gitignore):`,
        ...stray.map((f) => '  ' + f),
        'Anything else belongs to an acceptance criterion — commit it through that flow.'].join('\n'), 3);
    }
  }

  // A coverage commit adds tests. Production code may only lose unreachable lines, so any
  // added line in a production file is refused — a removal-plus-addition would otherwise
  // slip through a size check. And a coverage commit may never move the thresholds it is
  // being measured against.
  if (type === 'coverage') {
    const prod = buckets.filter(([, b]) => ['api-main', 'web-src'].includes(b)).map(([f]) => f);
    const added = prod.filter((f) => {
      const d = git(`diff --cached --numstat -- ${JSON.stringify(f)}`, cfg.root).out.trim().split('\t');
      return Number(d[0] || 0) > 0;
    });
    if (added.length) {
      git('reset', cfg.root);
      return fail([`a coverage commit may only delete unreachable production lines, not add any:`,
        ...added.map((f) => '  ' + f),
        'If the code needs to change to be testable, that is an AC, not a coverage fix.'].join('\n'), 3);
    }
    const movedGoalposts = staged.filter((f) => f === '.keel/config.yml');
    if (movedGoalposts.length) {
      git('reset', cfg.root);
      return fail('a coverage commit may not edit .keel/config.yml: raising coverage cannot include lowering the threshold.', 3);
    }
  }

  // Escalation triggers for change flows.
  if (state.flow === 'change') {
    const trig = triggers(cfg, staged);
    const must = trig.filter((t) => t.must);
    if (must.length && !(state.gates.log || []).some((l) => l.startsWith('escalation-override'))) {
      git('reset', cfg.root);
      return fail([`escalation trigger: ${must.map((t) => t.why).join('; ')}.`,
        'Run `keel escalate` to turn this into a spec flow, or `keel escalate --override "<reason>"` to stay small.'].join('\n'), 3);
    }
  }

  // No ID, no anchor: an ID-less commit would otherwise trail `Spec: <path>#` pointing nowhere.
  const spec = state.spec && id ? `\n\nSpec: ${state.spec}#${id}` : '';
  const subject = `${rule.prefix(id)}: ${message}`;
  // The message goes to git through a file, not `-m`. JSON.stringify quotes for JSON, not for a
  // shell: it turns a real newline into a literal backslash-n, so a message with a body or a
  // trailer used to arrive as one long subject line with `\n` printed in the middle of it.
  // The file lives outside the repo so a crash between write and unlink cannot dirty the tree.
  const msgFile = path.join(require('os').tmpdir(), `keel-commit-${process.pid}.txt`);
  fs.writeFileSync(msgFile, subject + spec + '\n');
  const r = run(`git commit -q --cleanup=whitespace -F ${JSON.stringify(msgFile)}`, { cwd: cfg.root });
  try { fs.unlinkSync(msgFile); } catch (e) { /* best effort: it is in the temp dir */ }
  if (r.code !== 0) { return fail('git commit failed:\n' + trim(r.out)); }
  const sha = git('rev-parse --short HEAD', cfg.root).out.trim();

  st.update(cfg, (s) => {
    if (type === 'red' && s.acs[id]) s.acs[id].red = sha;
    if (type === 'green' && s.acs[id]) { s.acs[id].green = sha; s.acs[id].status = 'done'; }
    // A single-mode commit is this criterion's whole implementation, so it fills the same slot
    // the green sha fills — which is what keeps `keel trace` and `keel:ac-reviewer` working
    // without either learning that the mode exists.
    if (type === 'ac' && s.acs[id]) { s.acs[id].green = sha; s.acs[id].status = 'done'; }
    // A fix is not a green. It happens *after* one — usually during ship — and writing it to
    // `green` loses the commit the trace table points at, so an AC's own implementation
    // becomes unfindable the first time a reviewer asks for a change. Recorded alongside.
    if (type === 'fix' && s.acs[id]) {
      s.acs[id].fixes = (s.acs[id].fixes || []).concat(sha);
      // Unless there was no green to begin with — a bug flow fixes without a preceding GREEN.
      if (!s.acs[id].green) { s.acs[id].green = sha; s.acs[id].status = 'done'; }
    }
    if (type === 'green' || type === 'ac') s.phase = 'gate';
    // A fix inside a repair phase goes back where its route says, not to the AC gate. Forcing
    // `gate` from ship put an approval on the path to `integration` and silently rewound the
    // flow past E2E, smoke and the final review.
    if (type === 'fix' && !REPAIR_PHASES.has(state.phase)) s.phase = 'gate';
    if (type === 'red') s.phase = 'green';
  });
  out(`${sha} ${subject}`);
  // A docs commit is the spec commit, and the approval gate is right after it — so this is
  // the moment the gaps should be in front of the human, not later.
  if (type === 'docs' && state.spec) {
    const r = require('./spec').check(cfg, state.spec);
    if (r && !r.ok && r.warnings) {
      out(['', 'spec check — worth a look before approval:',
        ...r.warnings.map((w) => `  · ${w}`)].join('\n'));
    }
  }
  if (type === 'fix' && REPAIR_PHASES.has(state.phase)) {
    // Pointing at the AC gate from here is how a ship repair used to rewind the flow: the gate
    // approves and moves on to `integration`, past E2E, smoke and the final review.
    out(`still in "${state.phase}" — return by the route that sent you here `
      + '(`keel state phase ship`, then the step that found it).');
  } else if (type === 'green' || type === 'ac' || type === 'fix') {
    const state2 = st.read(cfg);
    const mode = state2.gates.mode;
    const skipped = state2.gates.skipped[state2.lane];
    if (mode !== 'every-ac' || skipped) out('gates are skipped for this lane; run `keel gate ac approve --auto` to continue.');
    else out('gate: run `keel gate ac approve|review|reject|skip`');
  }
}

function triggers(cfg, files) {
  const t = [];
  const b = files.map((f) => guards.classify(cfg, f));
  if (b.includes('contract')) t.push({ must: true, why: 'the API contract changed' });
  if (b.includes('migration')) t.push({ must: true, why: 'a migration was added or changed' });
  if (files.some((f) => require('./util').matchGlob(f, cfg.change.auth_paths))) t.push({ must: true, why: 'auth or security code changed' });
  const apps = new Set(b.filter((x) => ['api-main', 'api-test'].includes(x) ? 'api' : null).map(() => 'api'));
  if (b.some((x) => x.startsWith('api')) && b.some((x) => x.startsWith('web'))) t.push({ must: false, why: 'both apps changed' });
  if (files.length > cfg.change.size_limits_files) t.push({ must: false, why: `${files.length} files changed (limit ${cfg.change.size_limits_files})` });
  return t;
}

/* ---------------------------------------------------------------- gates */

function gate(args) {
  const cfg = config.load();
  const kind = (args[0] || '').toLowerCase();
  const decision = (args[1] || '').toLowerCase();
  const opts = parseOpts(args.slice(2));
  const state = st.read(cfg);

  if (!['ac', 'r', 'f', 'final'].includes(kind)) return fail('usage: keel gate <ac|R|F|final> <decision> [--scope lane|flow] [--note "..."]');
  // Design §9 prints the board at every gate, so the decision is made with the whole
  // picture rather than one AC in isolation.
  if (kind === 'ac' && state.flow) out(st.board(state) + '\n');
  if (kind === 'ac') {
    const ac = state.current;
    // `tests.module_suite_at: gate` is the default and used to run nothing at all — only
    // `every-ac` was implemented — so on the default setting a cross-AC regression first
    // surfaced at phase 6, several criteria later, with nothing pointing at which one caused it.
    if (decision === 'approve' && cfg.tests.module_suite_at === 'gate') {
      const lane = currentLane(state);
      const mod = verify.withFlakeCheck(cfg, () => verify.moduleTests(cfg, lane), `${lane} module suite`);
      if (!mod.ok) {
        return fail(`the ${lane} module suite broke — ${ac} passes on its own:\n\n${mod.report}\n\n`
          + 'Something earlier in this lane regressed. Fix it before approving.', 3);
      }
      out(`${lane} module suite green.`);
    }
    if (decision === 'approve') {
      st.update(cfg, (s) => {
        if (s.acs[ac]) s.acs[ac].status = 'done';
        s.gates.log.push(`ac ${ac} approved`);
        const next = st.acList(s).find((id) => ['todo', 'red'].includes(s.acs[id].status));
        s.current = next || null;
        // An AC handed to a lane is not ours to pick up, and it is not done either. Hold at the
        // gate rather than call the flow ready for integration while a lane is still running.
        const waiting = st.acList(s).filter((id) => s.acs[id].status === 'lane');
        s.phase = next ? 'red' : waiting.length ? 'gate' : 'integration';
      });
      const s2 = st.read(cfg);
      if (s2.current) return out(`approved. Next AC: ${s2.current} (phase red)`);
      const waiting = st.acList(s2).filter((id) => s2.acs[id].status === 'lane');
      if (waiting.length) {
        const lanes = st.openLanes(s2).map(([k]) => k);
        return out([`approved. Every AC in this lane is done, but ${waiting.join(', ')} ${waiting.length === 1 ? 'is' : 'are'} still with the ${lanes.join(' and ') || 'other'} lane.`,
          `Bring it back with \`keel lane merge ${lanes[0] || '<lane>'}\` before integration.`].join('\n'));
      }
      return out('approved. All ACs done; phase integration.');
    }
    if (decision === 'reject') {
      st.update(cfg, (s) => { if (s.acs[ac]) s.acs[ac].status = 'todo'; s.phase = 'red'; s.gates.log.push(`ac ${ac} rejected: ${opts.note || ''}`); });
      return out(`rejected ${ac}; back to RED.`);
    }
    if (decision === 'skip') {
      const scope = opts.scope === 'flow' ? 'flow' : 'lane';
      st.update(cfg, (s) => {
        if (scope === 'flow') s.gates.mode = 'end';
        s.gates.skipped[s.lane] = scope === 'flow' ? 'flow' : 'rest-of-lane';
        s.gates.log.push(`gates skipped for ${scope}`);
      });
      return out(`gates skipped for the ${scope}. Automatic checks still run; the final review will list this.`);
    }
    if (decision === 'review') return out('run the keel:ac-reviewer subagent on this AC\'s two commits, then come back to the gate.');
    return fail('decisions: approve | review | reject | skip');
  }
  if (kind === 'r' || kind === 'f') {
    const G = kind.toUpperCase();
    // No decision used to be recorded as one: `gate R` with nothing after it logged
    // "gate R : " and moved the phase backwards. Either the waiver applies, and this is an
    // automatic approval that says so in the log, or a decision is required.
    if (!decision) {
      const waived = (state.gates || {}).bug_gates === false || cfg.gates.bug_gates === false;
      if (!waived) {
        return fail(`gate ${G} needs a decision: keel gate ${G} approve|reject|stop [--note "..."].\n`
          + 'Start the flow with --no-gates, or set gates.bug_gates: false, to have it approved automatically.');
      }
      st.update(cfg, (s) => {
        s.gates.log.push(`gate ${G} approved automatically (bug gates waived)`);
        s.phase = kind === 'r' ? 'bug-investigate' : 'bug-fix';
      });
      return out(`gate ${G} approved automatically — bug gates are waived for this flow, and the PR body will say so.\n`
        + (kind === 'r' ? 'phase bug-investigate (code still locked).' : 'phase bug-fix (production code unlocked).'));
    }
    if (decision !== 'approve') {
      st.update(cfg, (s) => { s.gates.log.push(`gate ${kind.toUpperCase()} ${decision}: ${opts.note || ''}`); s.phase = kind === 'r' ? 'bug-repro' : 'bug-investigate'; });
      return out(`gate ${kind.toUpperCase()}: ${decision} recorded.`);
    }
    st.update(cfg, (s) => {
      s.gates.log.push(`gate ${kind.toUpperCase()} approved`);
      s.phase = kind === 'r' ? 'bug-investigate' : 'bug-fix';
    });
    return out(kind === 'r' ? 'Gate R approved; phase bug-investigate (code still locked).'
      : 'Gate F approved; phase bug-fix (production code unlocked).');
  }
  if (kind === 'final') {
    if (decision === 'approve') { st.update(cfg, (s) => { s.gates.log.push('final review approved'); }); return out('final review approved; `keel pr` may run.'); }
    st.update(cfg, (s) => { s.gates.log.push(`final review: ${decision} ${opts.note || ''}`); });
    return out('recorded.');
  }
}

function escalate(args) {
  const cfg = config.load();
  const opts = parseOpts(args);
  if (opts.override) {
    st.update(cfg, (s) => { s.gates.log.push(`escalation-override: ${opts.override}`); });
    return out(`staying small; reason recorded for the final review: "${opts.override}"`);
  }
  const state = st.read(cfg);
  const specDir = path.join(cfg.root, cfg.specs.dir);
  fs.mkdirSync(specDir, { recursive: true });
  const n = String(fs.readdirSync(specDir).filter((f) => /^\d+/.test(f)).length + 1).padStart(3, '0');
  const slug = (state.branch || 'change').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const file = path.join(cfg.specs.dir, `${n}-${slug}.md`);
  const acs = st.acList(state).map((id) => `- ${id} [${state.acs[id].layer}] ${state.acs[id].status === 'done' ? '(done)' : ''}`).join('\n');
  // Mirrors templates/spec.md, including the two drawing sections: an escalated spec that
  // lacked them would be flagged by `keel spec check` for a gap keel itself created.
  const layers = st.acList(state).map((id) => state.acs[id].layer);
  fs.writeFileSync(path.join(cfg.root, file), [
    `# ${n} ${slug}`, '', '## Context', '', 'Escalated from a change flow.', '',
    '## Acceptance criteria', '', acs || '- AC-001 [API] …', '',
    '## UI mockup', '',
    layers.includes('WEB')
      ? '<Four states — default, empty, loading, error. See keel:spec-authoring.>'
      : '<No [WEB] criteria; remove this section or add one if the scope grew.>', '',
    '## Request path', '',
    layers.includes('API')
      ? '<The path this spec touches, marked + new and ~ changed. See keel:spec-authoring.>'
      : '<No [API] criteria; remove this section or add one if the scope grew.>', '',
    '## Data and migrations', '', '## Validation and security rules', '',
    '## Out of scope', '', '## Contract changes', '', '## Smoke checks', '',
  ].join('\n'));
  st.update(cfg, (s) => { s.flow = 'feature'; s.size = 'full'; s.spec = file; s.phase = 'spec'; s.gates.log.push('escalated to spec flow'); });
  out([`escalated: wrote ${file} with ${st.acList(state).length} existing AC(s); commits kept.`,
    'Phase is now spec: add the missing ACs and get them approved.'].join('\n'));
}

/* -------------------------------------------------- trace, audit, status */

function traceCmd(args) {
  const cfg = config.load();
  const state = st.read(cfg);
  const rows = verify.trace(cfg, state);
  if (!rows.length) return out('no ACs recorded.');
  out(['AC       layer  status      tests  red      green',
    ...rows.map((r) => `${r.id.padEnd(8)} ${String(r.layer).padEnd(6)} ${String(r.status).padEnd(11)} ${String(r.tests.length).padEnd(6)} ${String(r.red || '-').padEnd(8)} ${r.green || '-'}`)].join('\n'));
  const missing = rows.filter((r) => !r.complete);
  if (args.includes('--strict') && missing.length) {
    fail(`incomplete: ${missing.map((m) => m.id).join(', ')} (each AC needs at least one test referencing its ID and an implementation commit).`, 3);
  }
}

function auditCmd(args) {
  const cfg = config.load();
  const problems = verify.audit(cfg, st.read(cfg), parseOpts(args).base || 'main');
  if (!problems.length) return out('audit clean.');
  fail(['audit found problems:', ...problems.map((p) => '  ' + p)].join('\n'), 3);
}

// `keel board [--watch] [--for <seconds>] [--reap]`. One renderer; `keel status` is an alias,
// because two views of the same state drift — which is why `status` was consolidated onto
// state.board() before this, and onto the full board now.
function boardCmd(args = []) {
  const cfg = config.load();
  const board = require('./board');
  const opts = parseOpts(args);

  if (opts.reap) {
    const n = st.reapAgents(cfg);
    out(n ? `cleared ${n} stale agent record(s).` : 'no stale agent records.');
    if (!opts.watch) return;
  }

  const once = () => out(board.render(cfg, st.read(cfg)));
  if (!opts.watch) return once();

  // Append on change, never repaint: there is no ANSI anywhere in keel, the simulator has no
  // TTY, and the model reads this output as text — a cleared screen would destroy the record.
  const seconds = Number(opts.for || 0);
  const deadline = seconds > 0 ? Date.now() + seconds * 1000 : null;
  let last = null;
  const tick = () => {
    const fp = board.fingerprint(cfg);
    if (fp !== last) {
      last = fp;
      out((last === null ? '' : '\n') + new Date().toISOString().slice(11, 19) + '\n' + board.render(cfg, st.read(cfg)));
    }
    const state = st.read(cfg);
    if (!st.active(state)) { out('\nflow closed; stopping.'); return; }
    if (deadline && Date.now() >= deadline) { out('\n--for elapsed; stopping.'); return; }
    setTimeout(tick, 1000);
  };
  tick();
}

function status() { return boardCmd([]); }

function verifyCmd(args) {
  const cfg = config.load();
  const tier = args[0] || 'fast';
  const state = st.read(cfg);
  if (tier === 'fast') {
    const r = verify.fast(cfg);
    // A pass that compared nothing says so. "fast checks pass." over an empty file set outside a
    // repository is the very sentence a real pass produces, which is how a project with no git
    // sailed through every diff-scoped tier.
    if (r.ok && r.vacuous) return out(r.report);
    return r.ok ? out('fast checks pass.') : fail(r.report, 3);
  }
  if (tier === 'ac') {
    const ac = args[1] || state.current;
    const r = verify.acTests(cfg, ac, currentLane(state));
    return r.ok ? out(`${ac}: tests pass.`) : fail(r.report, 3);
  }
  if (tier === 'module') {
    const r = verify.moduleTests(cfg, args[1] || currentLane(state));
    return r.ok ? out('module suite passes.') : fail(r.report, 3);
  }
  if (tier === 'deps') {
    const deps = require('./deps');
    const v = deps.run(cfg, { base: parseOpts(args.slice(1)).base, force: args.includes('--force') });
    if (v.skipped) return out(`deps: skipped — ${v.skipped}`);
    const lines = v.findings.slice(0, 20).map((f) =>
      `  ${f.severity.padEnd(8)} ${f.app}/${f.name}${f.via.length ? '  ' + f.via.join('; ') : ''}  fix: ${f.fix}`);
    const tail = [...(v.notes || []).map((n) => `  note: ${n}`),
      v.suppressed ? `  ${v.suppressed} finding(s) suppressed by an unexpired allowlist entry` : null].filter(Boolean);
    if (!v.pass) return fail([`dependency vulnerabilities at or above ${v.threshold}:`, ...lines, ...tail].join('\n'), 3);
    return out([v.summary, ...lines, ...tail].join('\n'));
  }
  if (tier === 'arch') {
    const archFiles = args[1] === '--branch' ? verify.branchFiles(cfg) : null;
    const bad = verify.archViolations(cfg, archFiles);
    const mode = (cfg.boundaries || {}).enforce || 'off';
    if (mode === 'off') return out('boundaries.enforce is off; no architecture rules checked.');
    // Say the denominator. A pass over zero files used to print exactly what a real pass
    // prints, which makes it the single most trustworthy-looking wrong answer keel can give.
    const seen = verify.archInspected(cfg, archFiles);
    const ruleCount = (((cfg.boundaries || {}).rules) || []).length;
    if (!seen) {
      return out([`architecture: inspected 0 files against ${ruleCount} rule(s) — nothing was checked.`,
        verify.hasGit(cfg)
          ? '  no changed files; use `keel verify arch --branch` to check the whole branch.'
          : '  this directory is not a git repository, so keel cannot tell which files changed.'].join('\n'));
    }
    if (!bad.length) return out(`architecture boundaries hold (${seen} file(s) against ${ruleCount} rule(s)).`);
    const lines = bad.map((v) => `  ${v.file}:${v.line} imports ${v.target} (${v.rule})`);
    if (mode === 'warn') return out(['architecture boundaries crossed (enforce: warn):', ...lines].join('\n'));
    return fail(['architecture boundaries crossed:', ...lines].join('\n'), 3);
  }
  if (tier === 'contract') {
    const steps = [['contract lint', verify.cmdFor(cfg, 'contract_lint'), '.', { key: 'contract_lint', required: false }],
      ['codegen', (cfg.commands || {}).codegen, '.', { key: 'codegen', required: true }],
      ['api compile', verify.cmdFor(cfg, 'api_compile'), cfg.backend.dir, { key: 'api_compile', required: true }],
      ['web typecheck', verify.cmdFor(cfg, 'web_typecheck'), cfg.frontend.dir, { key: 'web_typecheck', required: true }]];
    const r = verify.runSteps(cfg, steps);
    return r.ok ? out(['contract checks pass.'].concat(r.notes).join('\n')) : fail(r.report, 3);
  }
  if (tier === 'full') {
    const steps = [['api module suite', verify.cmdFor(cfg, 'api_test_module'), cfg.backend.dir, { key: 'api_test_module', required: true }],
      ['web module suite', verify.cmdFor(cfg, 'web_test_module'), cfg.frontend.dir, { key: 'web_test_module', required: true }],
      ['static checks', (cfg.commands || {}).static_checks, '.', { key: 'static_checks', required: true }]];
    const r = verify.runSteps(cfg, steps);
    return r.ok ? out(['full suite passes.'].concat(r.notes).join('\n')) : fail(r.report, 3);
  }
  if (tier === 'e2e') {
    const drift = ops.migrationDrift(cfg);
    if (drift.drift) out(`note: ${drift.missing.length} migration(s) not applied to the dev database; run \`keel stack migrate\` if E2E fails.`);
    const cmd = (cfg.commands || {}).e2e;
    if (!cmd) return fail('no e2e command configured (commands.e2e).', 3);
    const spec = args[1] ? cmd.replace('{AC}', args[1]) : cmd.replace(/\s*--grep\s*\{AC\}/, '').replace('{AC}', '');
    // In e2e.dir, not the repo root: that is where `keel scaffold playwright` writes
    // playwright.config.ts, and `npx playwright test` at the root cannot find it.
    const r = verify.runSteps(cfg, [['e2e', spec, cfg.e2e.dir]]);
    return r.ok ? out('e2e passes.') : fail(r.report, 3);
  }
  if (tier === 'release') {
    const o = parseOpts(args.slice(1));
    const head = gitOut('rev-parse HEAD', cfg.root);
    const record = (pass, summary, skipped) => {
      writeJson(path.join(cfg.root, '.keel', 'release.json'),
        { sha: head, at: new Date().toISOString(), pass, summary, skipped: skipped || null });
      return pass;
    };
    const full = verify.runSteps(cfg, [['api module suite', verify.cmdFor(cfg, 'api_test_module'), cfg.backend.dir, { key: 'api_test_module', required: true }],
      ['web module suite', verify.cmdFor(cfg, 'web_test_module'), cfg.frontend.dir, { key: 'web_test_module', required: true }]]);
    if (!full.ok) { record(false, 'module suites failed'); return fail(full.report, 3); }
    const e2eCmd = (cfg.commands || {}).e2e;
    // A project with no browser has no e2e command, and hard-failing here would stop it
    // shipping at all. `--skip "<why>"` is recorded like an unlock: the verdict carries the
    // reason, and the PR body prints it, so the gap is visible rather than assumed away.
    const skipReason = o.skip && o.skip !== true ? String(o.skip) : null;
    if (!e2eCmd && !skipReason) {
      record(false, 'no e2e command');
      return fail('release requires an e2e command (commands.e2e is not set).\n'
        + 'If this project has none, say so once and it is recorded:\n'
        + '  keel verify release --skip "backend only, no browser surface"', 3);
    }
    if (e2eCmd) {
      const r = verify.runSteps(cfg, [['e2e', e2eCmd.replace(/\s*--grep\s*\{AC\}/, ''), cfg.e2e.dir, { key: 'e2e', required: true }]]);
      if (!r.ok) { record(false, 'e2e failed'); return fail(r.report, 3); }
    }
    const sm = ops.smoke(cfg);
    if (!sm.ok) { record(false, 'smoke failed'); return fail(sm.out, 3); }
    record(true, skipReason ? 'module suites and smoke pass; e2e skipped' : 'release checks pass', skipReason);
    return out((skipReason ? `release checks pass (e2e skipped: ${skipReason}).\n` : 'release checks pass.\n') + sm.out);
  }
  if (tier === 'coverage') {
    const opts = parseOpts(args.slice(1));
    // Each report command runs in its own app directory: `./gradlew` and `npx vitest`
    // only resolve there, not at the repo root.
    const covCmds = [['coverage_api', (cfg.commands || {}).coverage_api, cfg.backend.dir],
      ['coverage_web', (cfg.commands || {}).coverage_web, cfg.frontend.dir]];
    // A blank command is allowed: the report may already exist (generated by CI, or by
    // a build the caller ran). coverage.run() reports per app when a report is missing,
    // which is the failure that actually matters.
    for (const [key, cmd, dir] of covCmds) {
      if (!String(cmd || '').trim()) { out(`skipped: commands.${key} is not set`); continue; }
      const cwd = path.join(cfg.root, dir || '');
      const r = run(cmd, { cwd: fs.existsSync(cwd) ? cwd : cfg.root, timeout: 900000 });
      if (r.code !== 0) return fail(`coverage run failed (${key}):\n` + trim(r.out, 15), 3);
    }
    const v = coverage.run(cfg, { base: opts.base || 'main', updateBaseline: !!opts['update-baseline'] });
    const lines = v.apps.map((a) => a.error ? `  ${a.app}: ${a.error}`
      : `  ${a.app}: changed ${a.changed_covered}/${a.changed_executable} = ${a.changed_pct === null ? 'n/a' : a.changed_pct + '%'}` +
        `, branches ${a.branch_pct === null ? 'n/a' : a.branch_pct + '%'}, global ${a.global_pct === null ? 'n/a' : a.global_pct + '%'}`);
    const uncovered = v.apps.flatMap((a) => a.uncovered || []);
    if (v.pass) return out(['coverage verdict: pass', ...lines].join('\n'));
    return fail(['coverage verdict: fail', ...lines, ...(v.problems || []).map((p) => '  ' + p),
      uncovered.length ? '\nuncovered changed lines:' : '', ...uncovered.map((u) => '  ' + u)].filter(Boolean).join('\n'), 3);
  }
  return fail(`unknown tier "${tier}". Tiers: fast, ac, module, contract, full, e2e, release, coverage`);
}

// Async because the ladder runs independent rungs concurrently now. The output is still
// emitted in level order, so it reads the same as it always did.
async function ladderCmd(args) {
  const cfg = config.load();
  const opts = parseOpts(args);
  // A rung that raised a blocking question must not be re-run past it — that is the whole point
  // of raising one, and the ladder is where most of them come from.
  askBlocked(cfg);
  const res = await setup.ladder(cfg, { from: opts.from, resume: !!opts.resume, plan: !!opts.plan, fast: !!opts.fast });
  const rows = res.results.map((r) => `${pad(r.status)} ${r.label}${r.cmd ? '  (' + r.cmd + ')' : ''}${r.out && r.status !== 'pass' ? '\n      ' + String(r.out).split('\n').join('\n      ') : ''}`);
  out(rows.join('\n'));
  if (opts['write-runbook'] || (!res.stopped && !opts.plan)) {
    const file = setup.runbook(cfg, res);
    out(`runbook: ${file}`);
  }
  // Several rungs in one level can fail together, so this names all of them rather than
  // making you fix one and rediscover the next.
  if (res.stopped) fail(`stopped at "${res.stopped}". Ask keel:setup-doctor to diagnose ${res.stopped.includes(',') ? 'them' : 'it'}, then rerun with --resume.`, 3);
}
// 11, because `not-checked` is the longest verdict; at 9 the ladder's columns tore.
function pad(s) { return String(s).toUpperCase().padEnd(11); }

function discoverCmd() {
  const cfg = config.load();
  const d = setup.discover(cfg);
  out([
    `backend: ${d.detect.backendDir || '-'}   frontend: ${d.detect.frontendDir || '-'}   build: ${d.detect.build || '-'}`,
    `contract: ${d.detect.contract || '-'}   e2e: ${d.detect.e2e || '-'}   package manager: ${d.detect.pm}`,
    `compose: ${d.detect.compose || 'none'}${d.detect.compose ? '  (recommended: use it)' : ''}`,
    d.services.length ? `services: ${d.services.join(', ')}` : 'services: none found',
    `ci: ${d.ci.join(', ') || 'none'}`,
    d.ciCommands.length ? 'ci commands:\n' + d.ciCommands.map((c) => '  ' + c).join('\n') : '',
    d.envNames.length ? `env variables required: ${d.envNames.join(', ')}` : 'env variables: none found',
    `tooling: java ${d.tooling.java || '-'}, node ${d.tooling.node || '-'}, docker ${d.tooling.docker ? 'running' : 'no'}, compose ${d.tooling.dockerCompose || 'no'}, gh ${d.tooling.gh ? 'yes' : 'no'}`,
  ].filter(Boolean).join('\n'));
}

function scaffoldCmd(args) {
  const cfg = config.load();
  const what = args[0] || 'all';
  out(setup.scaffold(cfg, what).join('\n'));
}

function stackCmd(args) {
  const cfg = config.load();
  const r = ops.stack(cfg, args);
  if (args[0] === 'migrate' && r.ok) ops.markMigrationsApplied(cfg);
  return r.ok ? out(r.out) : fail(r.out, 3);
}
function laneCmd(args) {
  const cfg = config.load();
  const r = ops.lane(cfg, args);
  return r.ok ? out(r.out) : fail(r.out, 3);
}

// The hunt's enforcement surface. Two subcommands move the phase — `start`, because it is the
// flow entry, and `lenses --confirm`, because it is the gate. Everything else reads or records,
// the way `verify` and `cover` do.
// Questions keel must not proceed past. See lib/ask.js for why this cannot prove a human answered.
function askCmd(args = []) {
  const cfg = config.load();
  const ask = require('./ask');
  const sub = args[0] || 'list';
  const rest = args.slice(1);
  const opts = parseOpts(args);

  if (sub === 'list') return out(orFail(ask.render(cfg, opts)));
  if (sub === 'pending') return out(orFail(ask.render(cfg, { pending: true })));
  if (sub === 'clear') {
    const r = ask.clear(cfg, positionals(rest)[0]);
    return r.ok ? out(r.out) : fail(r.out, r.usage ? 1 : 3);
  }
  // `keel ask <id> --question …` raises; `keel ask <id> --answer …` answers.
  const id = sub;
  const r = opts.answer ? ask.answer(cfg, id, opts) : ask.raise(cfg, id, opts);
  return r.ok ? out(r.out) : fail(r.out, r.usage ? 1 : 3);
}

// Every gated command refuses the same way, so a blocked ladder and a blocked memory update read
// alike and name the same way out.
function askBlocked(cfg) {
  const why = require('./ask').refusal(cfg);
  if (why) fail(why, 3);
}

function huntCmd(args = []) {
  const cfg = config.load();
  const hunt = require('./hunt');
  const sub = args[0] || 'status';
  const rest = args.slice(1);
  const positional = positionals(rest);
  const opts = parseOpts(rest);
  const state = st.read(cfg);

  // A phase check that names the command to get there beats one that only says no.
  const inPhase = (want, what) => {
    if (state.phase === want) return null;
    return `${what} belongs to the ${want} phase; the flow is in "${state.phase}".\n`
      + `Move there with \`keel state phase ${want}\` once the previous step is done.`;
  };

  if (sub === 'start') {
    // `hunt start` is the flow entry: one writer for one fact. Having the skill run
    // `keel state start hunt` as well would make two.
    if (state.flow && state.flow !== 'hunt' && st.active(state)) {
      return fail(`a ${state.flow} flow is open in phase "${state.phase}". Finish or abort it before hunting.`, 3);
    }
    // Repair the ignore block before writing anything: an untracked backlog would leave the
    // tree dirty, and `keel preflight` refuses that — blocking the fix flow the hunt exists
    // to feed. `init --write` cannot be re-run to pick the lines up; it overwrites the config.
    const added = ensureGitignore(cfg.root);
    const r = hunt.start(cfg, opts);
    if (!r.ok) return fail(r.out, 3);
    st.update(cfg, (s) => {
      if (s.flow !== 'hunt') Object.assign(s, st.EMPTY, { flow: 'hunt', size: 'full', lane: s.lane || 'api' });
      s.flow = 'hunt';
      s.phase = 'hunt-scope';
      s.branch = gitOut('rev-parse --abbrev-ref HEAD', cfg.root, null);
    });
    return out(r.out + (added.length ? `\n\nadded ${added.length} line(s) to .gitignore so the backlog stays out of git status` : ''));
  }

  if (sub === 'lenses') {
    // Confirmable from the scope phase and from the sweep, not only the former. Requiring
    // hunt-scope made a dead end: anyone who reached the sweep by hand could no longer confirm,
    // and so could never ingest anything. The gate's teeth are `add` refusing while the set is
    // unconfirmed, which is unaffected by where the phase happens to be.
    if (opts.confirm && !['hunt-scope', 'hunt-sweep'].includes(state.phase)) {
      return fail(`confirming the lens set belongs to the hunt; the flow is in "${state.phase}".\n`
        + 'Start one with `keel hunt start`.', 3);
    }
    const r = hunt.lenses(cfg, opts);
    if (!r.ok) return fail(r.out, 3);
    if (opts.confirm) st.update(cfg, (s) => { s.phase = 'hunt-sweep'; });
    return out(r.out);
  }

  if (sub === 'add') {
    const bad = inPhase('hunt-sweep', 'ingesting candidates');
    if (bad) return fail(bad, 3);
    const r = hunt.add(cfg, opts);
    return r.ok ? out(r.out) : fail(r.out, /usage:/.test(r.out) ? 1 : 3);
  }

  if (sub === 'prove') {
    const bad = inPhase('hunt-prove', 'recording a verdict');
    if (bad) return fail(bad, 3);
    const r = hunt.prove(cfg, positional[0], opts);
    return r.ok ? out(r.out) : fail(r.out, r.usage ? 1 : 3);
  }

  if (sub === 'group') {
    const r = hunt.group(cfg, positional, opts);
    return r.ok ? out(r.out) : fail(r.out, r.usage ? 1 : 3);
  }

  if (sub === 'report') {
    const r = hunt.report(cfg, opts);
    return r.ok ? out(r.out) : fail(r.out, 3);
  }

  if (sub === 'next') {
    const r = hunt.next(cfg, opts);
    return r.ok ? out(r.out) : fail(r.out, 3);
  }

  if (sub === 'close') {
    const r = hunt.close(cfg, positional[0], opts);
    return r.ok ? out(r.out) : fail(r.out, r.usage ? 1 : 3);
  }

  if (sub === 'gate') {
    const r = hunt.gate(cfg, positional[0], positional[1], opts);
    return r.ok ? out(r.out) : fail(r.out, r.usage ? 1 : 3);
  }
  if (sub === 'candidates') return out(orFail(hunt.candidates(cfg, opts)));
  if (sub === 'resume') return out(orFail(hunt.resume(cfg)));
  if (sub === 'list') return out(orFail(hunt.list(cfg, opts)));
  if (sub === 'status') return out(orFail(hunt.status(cfg)));

  return fail(`unknown hunt command "${sub}". Use start, lenses, add, candidates, prove, group, gate, report, next, close, resume, list or status.`);
}
// Every hunt reader refuses the same way: exit 3, because "no hunt open" is a check that
// failed rather than a command typed wrongly.
function orFail(r) { if (!r.ok) fail(r.out, 3); return r.out; }
function smokeCmd() {
  const cfg = config.load();
  const r = ops.smoke(cfg);
  return r.ok ? out(r.out) : fail(r.out, 3);
}
function prCmd(args) {
  const cfg = config.load();
  const r = ops.pr(cfg, args);
  return r.ok ? out(r.out) : fail(r.out, 3);
}
function triageCmd(args) {
  const cfg = config.load();
  out(ops.triage(cfg, args.join(' ')));
}
function checkSizeCmd(args) {
  const cfg = config.load();
  const r = ops.checkSize(cfg, args);
  const must = r.triggers.filter((t) => t.must);
  out([`${r.files.length} files, ${r.lines} changed lines`,
    r.triggers.length ? 'triggers:' : 'no escalation triggers',
    ...r.triggers.map((t) => `  ${t.must ? 'MUST escalate' : 'suggest'}: ${t.why}`)].join('\n'));
  if (must.length) process.exit(3);
}

function unlock(args) {
  const cfg = config.load();
  const opts = parseOpts(args.slice(1));
  const p = args[0];
  if (!p || !opts.reason) return fail('usage: keel unlock <path> --reason "<why>"');
  const state = st.read(cfg);
  st.update(cfg, (s) => { s.unlocks.push({ path: p, phase: state.phase, reason: opts.reason, at: new Date().toISOString() }); });
  out(`unlocked ${p} for phase ${state.phase}; this appears in the final review.`);
}

function env() {
  const cfg = config.load();
  const files = ['.env.example', '.env.local', '.env'].map((f) => path.join(cfg.root, f));
  const names = new Set();
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m) names.add(m[1]);
    }
  }
  if (!names.size) return out('no environment variables found in .env.example, .env.local or .env');
  const localSet = new Set();
  for (const f of files.slice(1)) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)$/);
      if (m && m[2].trim() !== '') localSet.add(m[1]);
    }
  }
  out(Array.from(names).sort().map((n) => `${n}: ${localSet.has(n) || process.env[n] ? 'set' : 'MISSING'}`).join('\n'));
}

// The model an agent runs on lives in its own frontmatter. `${user_config.model_*}` only
// resolves once the user has written pluginConfigs into settings.json — the `default`
// declared in plugin.json is NOT used as a fallback — so an unset value reached the API
// verbatim and every agent died with model_not_found (HTTP 404) on first use.
const AGENT_DEFAULTS = { reviewer: 'opus', 'ac-reviewer': 'opus', 'code-reviewer': 'opus', explorer: 'opus', investigator: 'opus',
  'e2e-author': 'sonnet', implementer: 'opus', 'bulk-reader': 'haiku',
  'test-author': 'opus', 'setup-doctor': 'sonnet', 'lane-runner': 'sonnet',
  'arch-surveyor': 'sonnet', 'security-auditor': 'opus', 'dependency-triager': 'sonnet',
  // hunter is sonnet because six run at once and every one of their outputs is, by
  // construction, unproven — opus times six is the most expensive turn keel could issue, spent
  // on guesses. prover is opus because its verdict is what a fix flow is launched on.
  reproducer: 'sonnet', hunter: 'sonnet', prover: 'opus',
  // Five run at once, each reading a different slice of the tree and writing one file.
  librarian: 'opus' };
const MODEL_NAMES = ['opus', 'sonnet', 'haiku', 'inherit'];
// Effort was write-once frontmatter: `keel models` only ever rewrote the model line, and a grep
// for `effort` outside agents/ found nothing at all — so "put the hunters on sonnet at high
// effort" was a hand-edit and a /reload-plugins, with no way to check what was set.
const AGENT_EFFORTS = { reviewer: 'high', 'ac-reviewer': 'medium', 'code-reviewer': 'high', explorer: 'low', investigator: 'high',
  'e2e-author': 'medium', implementer: 'high', 'bulk-reader': 'low',
  'test-author': 'high', 'setup-doctor': 'medium', 'lane-runner': 'high',
  'arch-surveyor': 'medium', 'security-auditor': 'high', 'dependency-triager': 'medium',
  reproducer: 'medium', hunter: 'high', prover: 'high', librarian: 'medium' };
const EFFORT_NAMES = ['low', 'medium', 'high'];

// Overridable so the scenarios can rewrite a throwaway copy instead of the real agents.
function agentDir() {
  return process.env.KEEL_AGENT_DIR || path.join(__dirname, '..', 'agents');
}
function agentFile(agent) { return path.join(agentDir(), `${agent}.md`); }
const MODEL_LINE = /^model:[ \t]*(.+)$/m;
const EFFORT_LINE = /^effort:[ \t]*(.+)$/m;

function readAgentField(agent, re) {
  const f = agentFile(agent);
  if (!fs.existsSync(f)) return null;
  const m = fs.readFileSync(f, 'utf8').match(re);
  return m ? m[1].trim() : null;
}
const readAgentModel = (a) => readAgentField(a, MODEL_LINE);
const readAgentEffort = (a) => readAgentField(a, EFFORT_LINE);

function writeAgentField(agent, re, label, value) {
  const f = agentFile(agent);
  if (!fs.existsSync(f)) return false;
  const s = fs.readFileSync(f, 'utf8');
  if (!re.test(s)) return false;
  fs.writeFileSync(f, s.replace(re, `${label}: ${value}`));
  return true;
}
const writeAgentModel = (a, v) => writeAgentField(a, MODEL_LINE, 'model', v);
const writeAgentEffort = (a, v) => writeAgentField(a, EFFORT_LINE, 'effort', v);

function models(args) {
  const sub = args[0] || 'show';
  const agents = Object.keys(AGENT_DEFAULTS).sort();
  if (sub === 'show') {
    return out(agents.map((a) => {
      const cur = readAgentModel(a);
      const eff = readAgentEffort(a);
      const def = AGENT_DEFAULTS[a];
      const effDef = AGENT_EFFORTS[a];
      const model = cur === null ? `${def} (no model line)` : cur;
      const effort = eff === null ? `${effDef} (no effort line)` : eff;
      const isDefault = cur === def && eff === effDef;
      return `${a.padEnd(20)} ${`${model}/${effort}`.padEnd(18)}${isDefault ? ' (default)' : ''}`;
    }).join('\n') + `\n\nagent files: ${agentDir()}`);
  }
  if (sub === 'set-all' || sub === 'set') {
    const opts = parseOpts(args);
    const positional = positionals(args.slice(1));
    const model = positional[0];
    const only = sub === 'set' ? positional[1] : null;
    const effort = opts.effort && opts.effort !== true ? String(opts.effort) : null;
    if (!model && !effort) return fail('usage: keel models set-all <opus|sonnet|haiku|inherit> [--effort low|medium|high] [--yes]  |  keel models set <model> <agent> [--effort …] [--yes]');
    if (model && !MODEL_NAMES.includes(model)) return fail(`unknown model "${model}". One of: ${MODEL_NAMES.join(', ')}`);
    if (effort && !EFFORT_NAMES.includes(effort)) return fail(`unknown effort "${effort}". One of: ${EFFORT_NAMES.join(', ')}`);
    if (only && !AGENT_DEFAULTS[only]) return fail(`unknown agent "${only}". Agents: ${agents.join(', ')}`);
    const targets = only ? [only] : agents;
    const what = [model ? `model ${model}` : null, effort ? `effort ${effort}` : null].filter(Boolean).join(' and ');
    if (!args.includes('--yes')) {
      return out([`this would set ${what} in ${targets.length} agent file(s) under ${agentDir()}:`,
        ...targets.map((a) => `  ${a} -> ${model || readAgentModel(a)}/${effort || readAgentEffort(a)}`),
        '', 'Rerun with --yes to apply, then run /reload-plugins in Claude Code.'].join('\n'));
    }
    let done = 0;
    for (const a of targets) {
      let touched = false;
      if (model && writeAgentModel(a, model)) touched = true;
      if (effort && writeAgentEffort(a, effort)) touched = true;
      if (touched) done++;
    }
    return out(`set ${what} on ${done} agent(s). Run /reload-plugins in Claude Code.`);
  }
  if (sub === 'reset') {
    if (!args.includes('--yes')) return out(`this would restore each agent's default model under ${agentDir()}. Rerun with --yes.`);
    const done = agents.filter((a) => {
      const m = writeAgentModel(a, AGENT_DEFAULTS[a]);
      const e = writeAgentEffort(a, AGENT_EFFORTS[a]);
      return m || e;
    });
    return out(`restored ${done.length} agent(s) to their default model and effort. Run /reload-plugins in Claude Code.`);
  }
  return fail('usage: keel models show|set-all <model> [--effort low|medium|high] [--yes]|set <model> <agent> [--effort …] [--yes]|reset [--yes]');
}

function stall(args) {
  const cfg = config.load();
  if (args[0] === 'reset') { st.clearStall(cfg); return out('stall counter reset.'); }
  const s = st.read(cfg);
  if (!s.stall.count) return out('no repeated failure.');
  out([`same failure ${s.stall.count}x (fingerprint ${s.stall.fingerprint})`,
    `ladder step used: ${s.stall.step}/4`,
    ...st.LADDER.map((l, i) => `${i < s.stall.step ? ' done ' : '      '}${l}`)].join('\n'));
}

function parseOpts(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) { o[key] = next.replace(/^["']|["']$/g, ''); i++; }
    else o[key] = true;
  }
  return o;
}

// The arguments parseOpts did NOT consume. Filtering on `!startsWith('--')` is not the same
// thing and is wrong the moment a command takes both ids and flags: in
// `hunt group F-001 F-002 --cause "..." --lead F-001` the cause text and the lead id are values,
// not ids, and a naive filter reads them as two more findings.
function positionals(args) {
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const next = args[i + 1];
    if (next && !next.startsWith('--')) i++;
  }
  return rest;
}

// `keel spec check|show` — what the spec is missing, and its drawings.
function specCmd(args = []) {
  const cfg = config.load();
  const spec = require('./spec');
  const state = st.read(cfg);
  const opts = parseOpts(args.slice(1));
  const file = opts.spec || state.spec;
  if (!file) return fail('no spec in state. Pass --spec specs/NNN-slug.md.', 3);

  if (args[0] === 'show') {
    const which = opts.path ? 'path' : 'mockup';
    const d = spec.drawing(cfg, file, which);
    if (!d) return fail(`${file} has no ${which === 'path' ? 'request path' : 'UI mockup'} section.`, 3);
    return out(d);
  }

  const r = spec.check(cfg, file);
  if (r.fatal) return fail(r.fatal, 3);
  const counts = ['API', 'WEB', 'E2E', 'SMOKE']
    .map((l) => [l, r.acs.filter((a) => a.layer === l).length]).filter(([, n]) => n);
  out(`${file}: ${r.acs.length} criterion(s)` + (counts.length ? ` — ${counts.map(([l, n]) => `${n} ${l}`).join(', ')}` : ''));
  if (r.ok) return out('spec check: nothing missing.');
  // Warn, never block: the human at the gate decides whether a gap matters.
  out(['', 'spec check — worth a look before approval:',
    ...r.warnings.map((w) => `  · ${w}`)].join('\n'));
}

// `keel todos [--json]` — the flow's steps as a checklist. Derived from state, so it cannot
// disagree with the board; the post-tool hook emits the same thing after each transition.
function todosCmd(args = []) {
  const cfg = config.load();
  const state = st.read(cfg);
  const todos = require('./todos');
  if (!st.active(state)) return out('no active flow, so there are no steps yet.');
  if (parseOpts(args).json) return out(JSON.stringify(todos.build(state), null, 2));
  return out(todos.render(state) || 'no steps for this flow.');
}

// `keel cover [decide <key> <verdict>]` — the coverage-fix loop.
function coverCmd(args = []) {
  const cfg = config.load();
  const cover = require('./cover');
  const opts = parseOpts(args);

  if (args[0] === 'decide') {
    const r = cover.decide(cfg, args[1], args[2], opts.reason);
    return r.ok ? out(r.out) : fail(r.out, 3);
  }
  if (args[0] === 'status') {
    const s = cover.load(cfg);
    const rows = Object.entries(s.decisions).map(([k, d]) => `  ${k}: ${d.verdict}${d.reason ? ' — ' + d.reason : ''}`);
    return out(rows.length ? ['decisions so far:', ...rows].join('\n') : 'no decisions recorded yet.');
  }

  const r = cover.report(cfg, { base: opts.base });
  out(r.out);
  if (r.done) return;
  // A round that does not move the uncovered set is a stall, and it reuses the existing
  // ladder rather than a counter invented for coverage.
  if (r.fingerprint) {
    st.recordFailure(cfg, 'coverage-fix round', r.fingerprint);
    const s = st.read(cfg);
    if (st.stalled(cfg, s)) {
      const next = st.nextLadderStep(cfg);
      out(`\nStalled: the same lines are still uncovered after ${s.stall.count} rounds.\nStall ladder ${next.step}/4 — ${next.advice}`);
    }
  }
}

// The knowledge gate's question, in one place so the refusal and the menu cannot drift apart.
function sectionMenu(mem, cfg) {
  const onDisk = mem.built(cfg);
  return [
    ...mem.SECTIONS.map((n) => `  ${n.padEnd(13)} ${onDisk.includes(n) ? 'built  ' : '       '} ${mem.SECTION_BLURB[n]}`),
    '',
    '  keel memory sections --confirm architecture,conventions   build these now',
    '  keel memory sections --all                                build all five',
    '  keel memory sections --none                               none for now',
    '',
    'One keel:librarian per chosen section, in parallel — this is the most expensive thing init',
    'does. Re-run /keel:init later and confirm more: what you already have is kept, not rebuilt.',
  ];
}

// `keel memory show|reload|update` — the project knowledge base.
function memoryCmd(args = []) {
  const cfg = config.load();
  const sub = args[0] || 'show';
  const opts = parseOpts(args.slice(1));
  const dir = path.join(cfg.root, 'docs', 'knowledge');
  const verdictFile = path.join(cfg.root, '.keel', 'memory.json');
  const SECTIONS = require('./memory').SECTIONS;
  const head = gitOut('rev-parse HEAD', cfg.root);
  const verdict = readJson(verdictFile, null);

  const mem = require('./memory');
  const staleness = () => {
    if (!verdict) return 'never generated';
    // Content, not just commit identity. `sha === HEAD` alone meant a `memory update` that
    // regenerated nothing re-stamped an unread knowledge base as current on every commit.
    const sameContent = verdict.content === mem.contentHash(cfg);
    if (verdict.sha === head) return sameContent ? 'current' : 'current commit, but the sections changed since the verdict';
    const since = gitOut(`rev-list --count ${verdict.sha}..HEAD`, cfg.root, '').trim();
    return sameContent
      ? `stale: ${since || 'some'} commit(s) since ${String(verdict.sha).slice(0, 7)}, and the sections have not changed`
      : `stale: generated at ${String(verdict.sha).slice(0, 7)}, ${since || 'some'} commit(s) ago`;
  };

  if (sub === 'show') {
    if (!fs.existsSync(dir)) return out('no knowledge base yet. Run `/keel:init`, or `keel memory update` to generate one.');
    const rows = SECTIONS.map((s) => {
      const f = path.join(dir, `${s}.md`);
      if (!fs.existsSync(f)) {
        const sel0 = mem.selection(cfg);
        // `null` is "nobody has been asked", which is not the same as "chosen and absent".
        // Calling it missing reported a defect for a question that was never put.
        if (sel0 === null) return `  ${s.padEnd(13)} not chosen yet`;
        return `  ${s.padEnd(13)} ${!sel0.includes(s) ? 'not selected' : 'missing'}`;
      }
      const lines = fs.readFileSync(f, 'utf8').split('\n').length;
      return `  ${s.padEnd(13)} ${lines} lines`;
    });
    const sel = mem.selection(cfg);
    const selLine = sel === null ? 'sections not chosen yet — run `keel memory sections`'
      : sel.length === mem.SECTIONS.length ? 'all five sections selected'
      : `selected: ${sel.join(', ') || 'none'}${sel.length < mem.SECTIONS.length ? '  (re-run /keel:init to add more)' : ''}`;
    return out([`knowledge base: docs/knowledge/  (${staleness()})`, ...rows, '', selLine, '',
      'Load one section with `keel memory reload --section <name>`; --all is opt-in.'].join('\n'));
  }

  // The human gate on the knowledge build, modelled on `keel hunt lenses --confirm`: a menu that
  // records an answer, and a refusal elsewhere (`memory update`) that gives it teeth.
  if (sub === 'sections') {
    const sel = mem.selection(cfg);
    const onDisk = mem.built(cfg);
    const asked = opts.confirm !== undefined || opts.all || opts.none;

    if (!asked) {
      const state_line = sel === null
        ? 'not chosen yet — `keel memory update` is refused until this is answered.'
        : (sel.length ? `chosen: ${sel.join(', ')}` : 'chosen: none for now.');
      return out(['which parts of the knowledge base do you want built?', '',
        ...sectionMenu(mem, cfg), '', state_line].join('\n'));
    }

    let wanted;
    if (opts.all) wanted = mem.SECTIONS.slice();
    else if (opts.none) wanted = [];
    else wanted = String(opts.confirm).split(',').map((x) => x.trim()).filter(Boolean);

    const bad = wanted.filter((n) => !mem.SECTIONS.includes(n));
    if (bad.length) return fail(`unknown section(s): ${bad.join(', ')}. Known: ${mem.SECTIONS.join(', ')}`, 3);
    if (opts.none && onDisk.length) {
      return fail([`--none, but ${onDisk.length} section(s) already exist: ${onDisk.join(', ')}.`,
        'A section that exists is read back as project authority whether or not it is selected,',
        'so it stays in the check. Delete the files first if you really mean none.'].join('\n'), 3);
    }

    // A built section cannot be un-chosen — its file is still read back — so confirming is a
    // union. That is also what makes "re-run init to finish it" work: the second answer adds.
    const final = Array.from(new Set(wanted.concat(onDisk)));
    const added = final.filter((n) => !(sel || []).includes(n));
    const v = readJson(verdictFile, null) || {};
    v.selected = final;
    v.selected_by = opts.by || 'model';
    v.selected_at = new Date().toISOString();
    writeJson(verdictFile, v);

    const self = (opts.by || 'model') === 'model' ? '  (recorded as a self-answer)' : '';
    if (!final.length) {
      return out(['knowledge sections: none for now.' + self,
        'The other four read `not selected`, which is a fact and not a problem, so this does not',
        'block a push. Re-run `keel memory sections --confirm <names>` when you want some.'].join('\n'));
    }
    const todo = final.filter((n) => !onDisk.includes(n));
    return out([`knowledge sections: ${final.join(', ')}` + self,
      added.length ? `  added this time: ${added.join(', ')}` : '  nothing new added',
      onDisk.length ? `  already built:   ${onDisk.join(', ')}` : '  already built:   none',
      '',
      todo.length
        ? `Send one keel:librarian per section still to write: ${todo.join(', ')} — in parallel, each with the explorer map.`
        : 'Every chosen section is already written. `keel memory check`, then `keel memory update`.',
      mem.SECTIONS.filter((n) => !final.includes(n)).length
        ? `Not selected: ${mem.SECTIONS.filter((n) => !final.includes(n)).join(', ')} — re-run /keel:init to add them.`
        : ''].filter(Boolean).join('\n'));
  }

  if (sub === 'reload') {
    if (!fs.existsSync(dir)) return fail('no knowledge base to reload. Run `/keel:init` first.', 3);
    const wanted = opts.all ? SECTIONS : (opts.section ? [opts.section] : []);
    if (!wanted.length) {
      return fail(`name a section (${SECTIONS.join(', ')}) or pass --all.\nSelective is the default on purpose: this is the largest thing keel writes.`, 3);
    }
    const bad = wanted.filter((s) => !SECTIONS.includes(s));
    if (bad.length) return fail(`unknown section(s): ${bad.join(', ')}. Known: ${SECTIONS.join(', ')}`, 3);
    const parts = [];
    let total = 0;
    for (const s of wanted) {
      const f = path.join(dir, `${s}.md`);
      if (!fs.existsSync(f)) { parts.push(`## ${s}\n(missing)`); continue; }
      const text = fs.readFileSync(f, 'utf8');
      total += text.split('\n').length;
      parts.push(text);
    }
    // Staleness is reported, never hidden: a reload must not pass stale architecture off
    // as current.
    const warn = verdict && verdict.sha !== head
      ? `NOTE: this knowledge base is ${staleness()}. Treat it as a description of ${String(verdict.sha).slice(0, 7)}, not of HEAD.\n`
      : '';
    const budget = opts.all && total > 600 ? `NOTE: ${total} lines loaded — that is a lot of context for one turn.\n` : '';
    return out(warn + budget + parts.join('\n\n'));
  }

  if (sub === 'check') {
    const r = mem.check(cfg);
    const stats = r.sections.map((x) => `  ${x.name.padEnd(13)} ${x.unanswered ? 'not chosen yet'
      : x.notSelected ? 'not selected'
      : x.missing ? 'missing'
      : `${x.citations} citation(s), ${x.proofs} proof(s)${x.unverified ? `, ${x.unverified} marked unverified` : ''}`}`);
    if (r.pass) {
      const head = r.unanswered
        ? 'knowledge base: not chosen yet — nothing is wrong, the question has not been asked.'
        : 'knowledge base: every citation resolves.';
      const tail = r.unanswered
        ? ['', 'Pick sections with `keel memory sections`, or record that you want none for now:',
          '  keel memory sections --none --by user']
        : [];
      return out([head, ...stats, ...tail].join('\n'));
    }
    return fail([`knowledge base: ${r.problems.length} problem(s).`, ...stats, '',
      ...r.problems.map((p) => `  · ${p}`), '',
      'A claim nobody can check is worse than a missing one: it is read back as project authority.'].join('\n'), 3);
  }

  if (sub === 'update') {
    askBlocked(cfg);
    // The gate. Nothing else refuses on an unanswered selection, so this is what stops a build
    // of five librarians happening because nobody was asked.
    const chosen = mem.selection(cfg);
    if (chosen === null) {
      return fail(['which parts of the knowledge base do you want built?', '',
        ...sectionMenu(mem, cfg), '',
        'Answer first — this is the one decision that costs five agents.'].join('\n'), 3);
    }
    // Bootstrap instead of refusing. This used to point at /keel:init, which pointed back
    // here — so the knowledge base, and the verdict file that records its freshness, could
    // never come into existence at all.
    let scaffolded = [];
    if (!fs.existsSync(dir)) scaffolded = setup.scaffold(cfg, 'knowledge');
    // Fill the placeholders keel can fill. The scaffold is a raw byte copy, so before 0.9 every
    // {{TOKEN}} landed in the file literally and stayed there.
    const filled = mem.substitute(cfg);
    // Missing means chosen-but-absent. An unchosen section is not missing, it is not selected —
    // the distinction is the whole point, because `missing` used to block every push.
    const missing = chosen.filter((s) => !fs.existsSync(path.join(dir, `${s}.md`)));
    const notSelected = SECTIONS.filter((s) => !chosen.includes(s));
    const r = mem.check(cfg, chosen);
    const verdict = { sha: head, content: mem.contentHash(cfg), at: new Date().toISOString(),
      pass: r.pass, selected: chosen, selected_by: (readJson(verdictFile, null) || {}).selected_by || 'model',
      sections: chosen.filter((s) => !missing.includes(s)), missing, not_selected: notSelected,
      problems: r.problems };
    writeJson(verdictFile, verdict);
    const head_lines = [
      ...(scaffolded.length ? ['scaffolded docs/knowledge/ from templates:', ...scaffolded.map((l) => `  ${l}`)] : []),
      ...(filled.length ? [`filled template values in: ${filled.join(', ')}`] : []),
    ];
    // A failing verdict is written, not hidden — but it is written as failing, and the push gate
    // reads it. "Regenerates the affected sections" used to be the docs' claim for a command that
    // only touched a timestamp.
    if (!r.pass) {
      return fail([...head_lines, `knowledge verdict for ${head.slice(0, 7)}: FAIL — ${r.problems.length} problem(s).`,
        ...r.problems.map((p) => `  · ${p}`), '',
        'Run `keel memory check` after fixing them. `keel pr` is refused while this fails.'].join('\n'), 3);
    }
    return out([...head_lines,
      `knowledge verdict written for ${head.slice(0, 7)}: pass.`,
      missing.length ? `still to write: ${missing.join(', ')}` : `all chosen sections present: ${chosen.join(', ') || 'none'}`,
      notSelected.length ? `not selected: ${notSelected.join(', ')} — re-run /keel:init to add them` : '',
      'Commit the regenerated files with `keel commit memory <ID> "<what changed>"`.'].filter(Boolean).join('\n'));
  }
  return fail(`unknown memory command "${sub}". Use show, sections, reload, check or update.`);
}

// `keel skills for <phase> [--layer API|WEB|E2E]` — what to load, and which reference.
function skillsCmd(args = []) {
  const cfg = config.load();
  const skills = require('./skills');
  const sub = args[0] || 'for';
  const opts = parseOpts(args.slice(1));

  if (sub === 'packs') {
    return out(skills.listPacks().map((n) => {
      const p = skills.loadPack(n) || {};
      return `${n}   lane ${p.lane || '?'}   ${(p.layers || []).length} layer(s)   ${(p.skills || {}).testing || '-'}`;
    }).join('\n') || 'no stack packs found.');
  }
  if (sub === 'for') {
    const state = st.read(cfg);
    const phase = args[1] && !args[1].startsWith('--') ? args[1] : state.phase;
    const layer = opts.layer || (state.current && state.acs[state.current] && state.acs[state.current].layer) || 'API';
    return out([`phase ${phase}, layer ${String(layer).toUpperCase()} — load:`, skills.format(cfg, phase, layer)].join('\n'));
  }
  return fail(`unknown skills command "${sub}". Use for or packs.`);
}

// `keel arch detect|show|set <style>` — deterministic detection, and the config it writes.
function archCmd(args = []) {
  const cfg = config.load();
  const arch = require('./arch');
  const sub = args[0] || 'detect';
  const opts = parseOpts(args.slice(1));

  if (sub === 'show') {
    const a = cfg.architecture || {};
    if (!a.style || a.style === 'unknown') return out('architecture: not determined. Run `keel arch detect`.');
    return out([`architecture: ${a.style} (${a.confidence || '?'}, ${a.source || '?'})`,
      a.hybrid_with ? `hybrid with: ${a.hybrid_with}` : null,
      ...Object.entries(a.modules || {}).map(([d, m]) => `  ${d}: ${m.style} (${m.confidence})${m.hybrid_with ? ' + ' + m.hybrid_with : ''}`),
      ...(a.evidence || []).slice(0, 8).map((e) => `  · ${e}`)].filter(Boolean).join('\n'));
  }

  if (sub === 'detect') {
    const r = arch.detect(cfg);
    if (opts.json) return out(JSON.stringify(r, null, 2));
    const lines = [`detected: ${r.style} (confidence ${r.confidence})`];
    if (r.hybrid_with) lines.push(`hybrid with: ${r.hybrid_with} — recorded, not collapsed`);
    for (const [d, m] of Object.entries(r.modules || {})) {
      lines.push(`  ${d}: ${m.style} (${m.confidence})${m.hybrid_with ? ' + ' + m.hybrid_with : ''}`);
    }
    for (const e of (r.evidence || []).slice(0, 8)) lines.push(`  · ${e}`);
    if (r.confidence === 'low') {
      lines.push('', 'Confidence is low: ask keel:arch-surveyor to adjudicate, or confirm with the user,');
      lines.push('then record the answer with `keel arch set <style> --source user`.');
    } else {
      lines.push('', `Record it with: keel arch set ${r.style}`);
    }
    return out(lines.join('\n'));
  }

  if (sub === 'set') {
    const style = args[1];
    if (!arch.STYLES.includes(style) && style !== 'unknown') {
      return fail(`unknown style "${style}". Known: ${arch.STYLES.join(', ')}, unknown`);
    }
    const detected = style === 'unknown' ? null : arch.detect(cfg);
    const block = {
      style,
      confidence: opts.confidence || (detected ? detected.confidence : 'low'),
      source: opts.source || 'user',
      detected_at: `${new Date().toISOString().slice(0, 10)}@${gitOut('rev-parse --short HEAD', cfg.root, 'no-git')}`,
      modules: detected ? detected.modules : {},
      evidence: detected ? detected.evidence : [],
    };
    // Stack packs own the per-style rules where they have an opinion, so a stack's
    // boundaries live with the stack; arch.js is the fallback for styles no pack covers.
    const fromPacks = require('./skills').packBoundaries(cfg, style);
    const boundaries = {
      enforce: opts.enforce || (style === 'unknown' ? 'off' : 'warn'),
      rules: fromPacks.length ? fromPacks : arch.defaultBoundaries(style, cfg),
    };
    // Dry-run the rules against the tree they were just written for. A rule templated from
    // the style name can be wrong in two ways at once — matching a package that merely shares
    // a layer's name, and denying an import the codebase already depends on — and a rule that
    // is violated on the day it is generated is noise from its first run.
    const probe = Object.assign({}, cfg, { boundaries });
    let existing = [];
    try { existing = verify.archViolations(probe, verify.listFiles(cfg)); } catch (e) { existing = []; }
    const byRule = new Map();
    for (const v of existing) byRule.set(v.rule, (byRule.get(v.rule) || 0) + 1);
    if (existing.length && !opts.enforce) {
      boundaries.enforce = 'off';
    }
    writeJson(path.join(cfg.root, '.keel', 'architecture.json'), { architecture: block, boundaries });
    const notes = existing.length
      ? [`${existing.length} existing violation(s) of the rules just written:`,
        ...Array.from(byRule.entries()).map(([rule, n]) => `  ${rule}: ${n} file(s)`),
        opts.enforce
          ? `  enforce kept at ${boundaries.enforce} because you asked for it.`
          : '  enforce set to off — fix these, or set it yourself once the codebase agrees.']
      : [];
    return out([`architecture: ${style} (${block.source})`,
      `boundaries: ${boundaries.rules.length} rule(s), enforce: ${boundaries.enforce}`,
      ...notes,
      'Written to .keel/architecture.json; `keel verify arch` reads it.'].join('\n'));
  }

  if (sub === 'recommend') {
    const r = arch.recommend(opts);
    return out([`recommended: ${r.style}`, `because: ${r.why}`, r.ddd_not_recommended || null,
      '', `Accept with: keel arch set ${r.style} --source recommended`].filter(Boolean).join('\n'));
  }
  return fail(`unknown arch command "${sub}". Use detect, show, set or recommend.`);
}

// Phase 0 of the spec and bug flows: prove the machine is ready before any work starts,
// so a flow does not fail three phases in because Docker was never running.
function preflight(args = []) {
  const cfg = config.load();
  askBlocked(cfg);
  const opts = parseOpts(args.slice(1));
  const slug = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const lines = [];
  const problems = [];

  // The ladder must have passed on this machine: design §6 makes it a precondition.
  const setupState = readJson(path.join(cfg.root, '.keel', 'setup.json'), null);
  if (!setupState) problems.push('the run ladder has not passed here yet — run `/keel:init`');
  else {
    // `not-checked` is 0.9's verdict for a rung with no command — it means nobody looked, not that
    // something broke, so it must not read as a failure here the way `skipped` never did.
    const ok = ['pass', 'needs-you', 'skipped', 'not-checked'];
    const failed = Object.values(setupState.rungs || {}).filter((r) => !ok.includes(r.status));
    if (failed.length) problems.push(`run ladder rungs still failing: ${failed.map((r) => r.id).join(', ')}`);
    else lines.push(`ladder: passed ${String(setupState.at || '').slice(0, 10)}`);
  }

  // `git()` folds stderr into `out`, so outside a repository `status --porcelain` returned
  // "fatal: not a git repository…" — truthy and one line — and preflight blamed a dirty tree for
  // a missing repository. Ask the real question first, and read through gitOut so the fatal text
  // can never become a value.
  if (!verify.hasGit(cfg)) {
    problems.push('this directory is not a git repository, so keel cannot branch, diff or pin a commit');
  } else {
    const dirty = gitOut('status --porcelain', cfg.root, '').trim();
    if (dirty) problems.push(`the tree is not clean (${dirty.split('\n').length} file(s)) — commit or stash first`);
    else lines.push('tree: clean');
  }

  const gaps = config.commandGaps(cfg);
  if (gaps.required.length) problems.push(`commands not configured: ${gaps.required.map((g) => g.key).join(', ')}`);

  if ((cfg.runtime || {}).services === 'docker') {
    if (run('docker info', { timeout: 15000 }).code !== 0) problems.push('Docker is not running, and runtime.services is "docker"');
    else lines.push('docker: running');
  }

  const branch = gitOut('rev-parse --abbrev-ref HEAD', cfg.root, null);
  if (slug && !opts['no-branch']) {
    const target = `${opts.prefix || 'feat'}/${slug}`;
    if (branch === target) lines.push(`branch: ${target} (already on it)`);
    else if (problems.length) lines.push(`branch: would create ${target} once the problems below are fixed`);
    else {
      const r = git(`checkout -b ${target}`, cfg.root);
      if (r.code !== 0) problems.push(`could not create ${target}: ${trim(r.out, 3)}`);
      else lines.push(`branch: created ${target}`);
    }
  } else {
    lines.push(`branch: ${branch}`);
  }

  if (problems.length) return fail([...lines, '', 'not ready:', ...problems.map((p) => '  ' + p)].join('\n'), 3);
  return out([...lines, 'ready.'].join('\n'));
}

// Which commands keel will run, and which are missing. An unconfigured required
// command used to make its tier pass without running the check; this makes it visible.
// An agent whose `model:` still holds `${user_config.…}` cannot run: that placeholder is
// interpolated only from pluginConfigs in settings.json, and plugin.json no longer declares
// any — so it reaches the API verbatim and returns model_not_found (HTTP 404), an error that
// names nothing near the cause. Cheap to detect, and invisible without this check.
function agentModelProblems() {
  const dir = agentDir();
  const bad = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch (e) { return bad; }
  for (const n of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch (e) { continue; }
    const m = text.match(/^model:[ \t]*(.*)$/m);
    if (m && /\$\{/.test(m[1])) bad.push({ file: n, value: m[1].trim() });
  }
  return bad;
}

// The copy keel is running from is not necessarily the copy the harness loads. A cached
// install of an older version shadows it silently, and every symptom then points at the
// wrong source — including agents that were fixed releases ago.
function shadowingInstalls() {
  const here = path.join(__dirname, '..');
  let mine = 'unknown';
  try { mine = JSON.parse(fs.readFileSync(path.join(here, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch (e) { /* not a plugin checkout */ }
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude');
  const root = path.join(home, 'plugins', 'cache');
  const found = [];
  let markets = [];
  try { markets = fs.readdirSync(root); } catch (e) { return { mine, found }; }
  for (const m of markets) {
    let versions = [];
    const base = path.join(root, m, 'keel');
    try { versions = fs.readdirSync(base); } catch (e) { continue; }
    for (const v of versions) {
      const dir = path.join(base, v);
      if (path.resolve(dir) === path.resolve(here)) continue;
      let placeholders = 0;
      try {
        for (const f of fs.readdirSync(path.join(dir, 'agents'))) {
          if (!f.endsWith('.md')) continue;
          const t = fs.readFileSync(path.join(dir, 'agents', f), 'utf8');
          if (/^model:.*\$\{/m.test(t)) placeholders++;
        }
      } catch (e) { /* no agents dir */ }
      if (v !== mine) found.push({ path: dir, version: v, placeholders });
    }
  }
  return { mine, found };
}

function doctorCmd(args = []) {
  const cfg = config.load(process.cwd());
  const gaps = config.commandGaps(cfg);
  const keys = Object.keys(config.COMMAND_KEYS);
  const setCount = keys.length - gaps.required.length - gaps.optional.length;
  const provenKeys = Object.keys(cfg.proven || {});
  const lines = [cfg.configured ? 'config: .keel/config.yml' : 'config: none found, using defaults — run `keel init --write`',
    `commands: ${setCount}/${keys.length} set`];
  if (provenKeys.length) lines.push(`  ${provenKeys.length} proven by the run ladder: ${provenKeys.join(', ')}`);
  if ((cfg.from_packs || []).length) lines.push(`  ${cfg.from_packs.length} from stack packs: ${cfg.from_packs.join(', ')}`);
  if (gaps.required.length) {
    lines.push('', 'required, not set:');
    for (const g of gaps.required) lines.push(`  commands.${g.key} — needed by ${g.tiers.join(', ')}`);
  }
  if (gaps.optional.length) {
    lines.push('', 'optional, not set:');
    for (const g of gaps.optional) lines.push(`  commands.${g.key} — used by ${g.tiers.join(', ')}`);
  }
  const reports = (cfg.coverage && cfg.coverage.reports) || {};
  if (Object.keys(reports).length) {
    lines.push('', 'coverage reports:');
    for (const [app, rel] of Object.entries(reports)) {
      lines.push(`  ${app}: ${rel}${fs.existsSync(path.join(cfg.root, rel)) ? '' : '  (not generated yet — run `keel verify coverage`)'}`);
    }
  }
  const badAgents = agentModelProblems();
  if (badAgents.length) {
    lines.push('', `agents: ${badAgents.length} of them name a model that cannot resolve:`);
    for (const b of badAgents) lines.push(`  ${b.file} — model: ${b.value}`);
    lines.push('  These fail with model_not_found (HTTP 404) naming the placeholder itself.',
      '  Fix: `keel models set-all sonnet --yes`, then /reload-plugins.');
  }
  const shadow = shadowingInstalls();
  if (shadow.found.length) {
    lines.push('', `install: this copy is ${shadow.mine}, but another cached copy exists:`);
    for (const f of shadow.found) {
      lines.push(`  ${f.version} at ${f.path}` + (f.placeholders ? ` — ${f.placeholders} agent(s) with an unresolvable model` : ''));
    }
    lines.push('  Claude Code may load the cached copy rather than this one; reinstall the plugin',
      '  or delete the stale directory, then /reload-plugins.');
  }
  out(lines.join('\n'));
  if (gaps.required.length || badAgents.length) process.exit(3);
}

module.exports = { init, renderConfig, upgrade, stateCmd, commit, gate, escalate, traceCmd, auditCmd, status, verifyCmd, unlock, env,
  parseOpts, positionals, triggers, ladderCmd, FLOW_START, huntCmd, askCmd, discoverCmd, scaffoldCmd, stackCmd, laneCmd, smokeCmd, prCmd, triageCmd, checkSizeCmd,
  models, stall, doctorCmd, preflight, archCmd, skillsCmd, coverCmd, memoryCmd, specCmd, boardCmd, todosCmd };
