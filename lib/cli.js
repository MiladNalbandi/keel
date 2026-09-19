'use strict';
const fs = require('fs');
const path = require('path');
const { run, git, trim, fingerprint, readJson, writeJson } = require('./util');
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

function init(args) {
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
    const res = setup.ladder(cfg, { resume: false });
    lines.push(...res.results.map((r) => `${r.status.toUpperCase().padEnd(9)} ${r.label}`));
    if (!res.stopped) lines.push(`runbook: ${setup.runbook(cfg, res)}`);
  }
  if (args.includes('--write')) {
    const file = path.join(root, '.keel', 'config.yml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', 'config.yml'), 'utf8')
      .replace('{{BACKEND_DIR}}', d.backendDir || 'apps/api')
      .replace('{{FRONTEND_DIR}}', d.frontendDir || 'apps/web')
      .replace('{{BUILD}}', d.build || './gradlew')
      .replace('{{PM}}', d.pm)
      .replace('{{CONTRACT}}', d.contract || 'contracts/openapi.yaml')
      .replace('{{E2E_DIR}}', d.e2e || 'e2e')
      .replace('{{SERVICES}}', d.compose ? 'docker' : (dockerOk ? 'docker' : 'none'))
      .replace('{{COMPOSE}}', d.compose || '');
    fs.writeFileSync(file, tpl);
    const gi = path.join(root, '.gitignore');
    const ignore = ['.keel/state.json', '.keel/coverage.json', '.keel/logs/', '.keel/format-queue.txt',
      '.keel/last-fast-check', '.keel/flaky.json', '.env.local'];
    let current = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    for (const l of ignore) if (!current.includes(l)) current += (current.endsWith('\n') || current === '' ? '' : '\n') + l + '\n';
    fs.writeFileSync(gi, current);
    lines.push(`wrote ${path.relative(root, file)} and updated .gitignore`);
  } else {
    lines.push('run `keel init --write` to write .keel/config.yml');
  }
  out(lines.join('\n'));
}

/* --------------------------------------------------------------- state */

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
    const branch = git('rev-parse --abbrev-ref HEAD', cfg.root).out.trim();
    st.update(cfg, (s) => {
      Object.assign(s, st.EMPTY, {
        flow, size: opts.size || (flow === 'change' ? 'small' : 'full'),
        phase: opts.phase || (flow === 'feature' ? 'spec' : flow === 'fix' ? 'bug-report' : 'spec'),
        spec: opts.spec || null, branch, lane: opts.lane || 'api',
        gates: { mode: opts.gates || cfg.gates.mode, skipped: {}, log: [] },
      });
    });
    return out(`started ${flow} flow, phase ${st.read(cfg).phase}`);
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

function currentLane(state) { return state.lane === 'web' ? 'web' : 'api'; }

// Does the spec tag this acceptance criterion with [gate: skip]?
function specSaysSkipGate(cfg, spec, id) {
  if (!spec || !id) return false;
  try {
    const text = fs.readFileSync(path.join(cfg.root, spec), 'utf8');
    const line = text.split('\n').find((l) => l.includes(id));
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

function greenDone(cfg) {
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
    s.phase = 'green';
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
      ? `no human gate here (${due.why}), so run keel:reviewer on this AC's diff first;\n`
        + `if it reports BLOCKING: yes the gate applies after all, otherwise: keel state phase red`
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

const COMMIT_RULES = {
  red:      { prefix: (id) => `test(${id})`, allow: ['api-test', 'web-test', 'e2e'], deny: ['api-main', 'web-src'] },
  green:    { prefix: (id) => `feat(${id})`, allow: ['api-main', 'web-src', 'migration', 'other'], deny: ['api-test', 'web-test'] },
  refactor: { prefix: (id) => `refactor(${id})`, allow: ['api-main', 'web-src', 'other'], deny: ['api-test', 'web-test'] },
  fix:      { prefix: (id) => `fix(${id})`, allow: ['api-main', 'web-src', 'api-test', 'web-test', 'migration', 'other'], deny: [] },
  // Production files are allowed through the bucket check so the delete-only rule below
  // can inspect the diff: they may lose unreachable lines but never gain any.
  coverage: { prefix: () => 'test(coverage)', allow: ['api-test', 'web-test', 'api-main', 'web-src'], deny: [], deleteOnlyProd: true },
  contract: { prefix: (id) => `contract(${id})`, allow: ['contract', 'other'], deny: ['api-test', 'web-test'] },
  e2e:      { prefix: (id) => `e2e(${id})`, allow: ['e2e'], deny: ['api-main', 'web-src', 'api-test', 'web-test'] },
  smoke:    { prefix: () => 'test(smoke)', allow: ['smoke', 'other'], deny: ['api-main', 'web-src'] },
  trivial:  { prefix: (id) => `refactor(${id})`, allow: ['api-main', 'web-src', 'other'], deny: [], trivial: true },
  docs:     { prefix: (id) => `docs(${id})`, allow: ['specs', 'other'], deny: ['api-main', 'web-src'] },
};

function commit(args) {
  const cfg = config.load();
  const state = st.read(cfg);
  const type = args[0];
  const id = args[1];
  const message = args.slice(2).join(' ').replace(/^["']|["']$/g, '');
  const rule = COMMIT_RULES[type];
  if (!rule) return fail(`unknown commit type "${type}". Types: ${Object.keys(COMMIT_RULES).join(', ')}`);
  if (!id || !message) return fail(`usage: keel commit ${type} <ID> "<message>"`);

  git('add -A', cfg.root);
  const staged = git('diff --cached --name-only', cfg.root).out.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!staged.length) return fail('nothing to commit.');

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

  const spec = state.spec ? `\n\nSpec: ${state.spec}#${id}` : '';
  const subject = `${rule.prefix(id)}: ${message}`;
  const r = run(`git commit -q -m ${JSON.stringify(subject)}${spec ? ' -m ' + JSON.stringify(spec.trim()) : ''}`, { cwd: cfg.root });
  if (r.code !== 0) { return fail('git commit failed:\n' + trim(r.out)); }
  const sha = git('rev-parse --short HEAD', cfg.root).out.trim();

  st.update(cfg, (s) => {
    if (type === 'red' && s.acs[id]) s.acs[id].red = sha;
    if ((type === 'green' || type === 'fix') && s.acs[id]) { s.acs[id].green = sha; s.acs[id].status = 'done'; }
    if (type === 'green' || type === 'fix') s.phase = 'gate';
    if (type === 'red') s.phase = 'green';
  });
  out(`${sha} ${subject}`);
  if (type === 'green' || type === 'fix') {
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
    if (decision === 'approve') {
      st.update(cfg, (s) => {
        if (s.acs[ac]) s.acs[ac].status = 'done';
        s.gates.log.push(`ac ${ac} approved`);
        const next = st.acList(s).find((id) => ['todo', 'red'].includes(s.acs[id].status));
        s.current = next || null;
        s.phase = next ? 'red' : 'integration';
      });
      const s2 = st.read(cfg);
      return out(s2.current ? `approved. Next AC: ${s2.current} (phase red)` : 'approved. All ACs done; phase integration.');
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
    if (decision === 'review') return out('run the keel:reviewer subagent on this AC diff, then come back to the gate.');
    return fail('decisions: approve | review | reject | skip');
  }
  if (kind === 'r' || kind === 'f') {
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
  fs.writeFileSync(path.join(cfg.root, file), [
    `# ${n} ${slug}`, '', '## Context', '', 'Escalated from a change flow.', '',
    '## Acceptance criteria', '', acs || '- AC-001 [API] …', '',
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

function status() {
  const cfg = config.load();
  const state = st.read(cfg);
  if (!st.active(state)) return out(`no active flow. Config: ${cfg.configured ? '.keel/config.yml' : 'missing (run keel init --write)'}`);
  // One board format, shared with every gate, so the two cannot drift apart.
  out([`${state.flow} (${state.size}) phase ${state.phase}`,
    st.board(state),
    state.last_failure ? `last failure: ${state.last_failure}` : null].filter(Boolean).join('\n'));
}

function verifyCmd(args) {
  const cfg = config.load();
  const tier = args[0] || 'fast';
  const state = st.read(cfg);
  if (tier === 'fast') {
    const r = verify.fast(cfg);
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
  if (tier === 'arch') {
    const bad = verify.archViolations(cfg, args[1] === '--branch' ? verify.branchFiles(cfg) : null);
    const mode = (cfg.boundaries || {}).enforce || 'off';
    if (mode === 'off') return out('boundaries.enforce is off; no architecture rules checked.');
    if (!bad.length) return out('architecture boundaries hold.');
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
    const r = verify.runSteps(cfg, [['e2e', spec, '.']]);
    return r.ok ? out('e2e passes.') : fail(r.report, 3);
  }
  if (tier === 'release') {
    const full = verify.runSteps(cfg, [['api module suite', verify.cmdFor(cfg, 'api_test_module'), cfg.backend.dir, { key: 'api_test_module', required: true }],
      ['web module suite', verify.cmdFor(cfg, 'web_test_module'), cfg.frontend.dir, { key: 'web_test_module', required: true }]]);
    if (!full.ok) return fail(full.report, 3);
    const e2eCmd = (cfg.commands || {}).e2e;
    if (!e2eCmd) return fail('release requires an e2e command (commands.e2e is not set).', 3);
    const r = verify.runSteps(cfg, [['e2e', e2eCmd.replace(/\s*--grep\s*\{AC\}/, ''), '.', { key: 'e2e', required: true }]]);
    if (!r.ok) return fail(r.report, 3);
    const sm = ops.smoke(cfg);
    return sm.ok ? out('release checks pass.\n' + sm.out) : fail(sm.out, 3);
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

function ladderCmd(args) {
  const cfg = config.load();
  const opts = parseOpts(args);
  const res = setup.ladder(cfg, { from: opts.from, resume: !!opts.resume, plan: !!opts.plan });
  const rows = res.results.map((r) => `${pad(r.status)} ${r.label}${r.cmd ? '  (' + r.cmd + ')' : ''}${r.out && r.status !== 'pass' ? '\n      ' + String(r.out).split('\n').join('\n      ') : ''}`);
  out(rows.join('\n'));
  if (opts['write-runbook'] || (!res.stopped && !opts.plan)) {
    const file = setup.runbook(cfg, res);
    out(`runbook: ${file}`);
  }
  if (res.stopped) fail(`stopped at "${res.stopped}". Ask keel:setup-doctor to diagnose it, then rerun with --resume.`, 3);
}
function pad(s) { return String(s).toUpperCase().padEnd(9); }

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

const AGENT_SETTINGS = {
  reviewer: 'model_reviewer', explorer: 'model_explorer', investigator: 'model_investigator',
  'e2e-author': 'model_e2e_author', implementer: 'model_implementer', 'bulk-reader': 'model_bulk_reader',
  'test-author': 'model_test_author', 'setup-doctor': 'model_setup_doctor',
};
const AGENT_DEFAULTS = { reviewer: 'opus', explorer: 'sonnet', investigator: 'opus',
  'e2e-author': 'sonnet', implementer: 'sonnet', 'bulk-reader': 'haiku',
  'test-author': 'sonnet', 'setup-doctor': 'sonnet' };

function settingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude');
  return path.join(dir, 'settings.json');
}
function models(args) {
  const sub = args[0] || 'show';
  const file = settingsPath();
  const settings = readJson(file, {});
  settings.pluginConfigs = settings.pluginConfigs || {};
  const current = settings.pluginConfigs.keel || {};
  if (sub === 'show') {
    return out(Object.entries(AGENT_SETTINGS).map(([agent, key]) =>
      `${agent.padEnd(12)} ${current[key] || AGENT_DEFAULTS[agent] + ' (default)'}`).join('\n') +
      `\n\nsettings file: ${file}`);
  }
  if (sub === 'set-all' || sub === 'set') {
    const model = args[1];
    const only = sub === 'set' ? args[2] : null;
    if (!model) return fail('usage: keel models set-all <opus|sonnet|haiku|inherit> [--yes]  |  keel models set <model> <agent>');
    if (!args.includes('--yes')) {
      return out([`this would write to ${file}:`,
        ...(only ? [`  ${AGENT_SETTINGS[only]} = ${model}`] : Object.values(AGENT_SETTINGS).map((k) => `  ${k} = ${model}`)),
        '', 'Rerun with --yes to apply, then run /reload-plugins in Claude Code.'].join('\n'));
    }
    if (only && !AGENT_SETTINGS[only]) return fail(`unknown agent "${only}". Agents: ${Object.keys(AGENT_SETTINGS).join(', ')}`);
    const keys = only ? [AGENT_SETTINGS[only]] : Object.values(AGENT_SETTINGS);
    for (const k of keys) current[k] = model;
    settings.pluginConfigs.keel = current;
    writeJson(file, settings);
    return out(`set ${keys.length} agent model setting(s) to ${model} in ${file}. Run /reload-plugins in Claude Code.`);
  }
  if (sub === 'reset') {
    if (!args.includes('--yes')) return out(`this would remove keel's model settings from ${file}. Rerun with --yes.`);
    delete settings.pluginConfigs.keel;
    writeJson(file, settings);
    return out('model settings reset to the per-agent defaults. Run /reload-plugins.');
  }
  return fail('usage: keel models show|set-all <model> [--yes]|set <model> <agent> [--yes]|reset [--yes]');
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
      detected_at: `${new Date().toISOString().slice(0, 10)}@${git('rev-parse --short HEAD', cfg.root).out.trim()}`,
      modules: detected ? detected.modules : {},
      evidence: detected ? detected.evidence : [],
    };
    const boundaries = { enforce: opts.enforce || (style === 'unknown' ? 'off' : 'warn'), rules: arch.defaultBoundaries(style, cfg) };
    writeJson(path.join(cfg.root, '.keel', 'architecture.json'), { architecture: block, boundaries });
    return out([`architecture: ${style} (${block.source})`,
      `boundaries: ${boundaries.rules.length} rule(s), enforce: ${boundaries.enforce}`,
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
  const opts = parseOpts(args.slice(1));
  const slug = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const lines = [];
  const problems = [];

  // The ladder must have passed on this machine: design §6 makes it a precondition.
  const setupState = readJson(path.join(cfg.root, '.keel', 'setup.json'), null);
  if (!setupState) problems.push('the run ladder has not passed here yet — run `/keel:init`');
  else {
    const failed = Object.values(setupState.rungs || {})
      .filter((r) => r.status !== 'pass' && r.status !== 'needs-you' && r.status !== 'skipped');
    if (failed.length) problems.push(`run ladder rungs still failing: ${failed.map((r) => r.id).join(', ')}`);
    else lines.push(`ladder: passed ${String(setupState.at || '').slice(0, 10)}`);
  }

  const dirty = git('status --porcelain', cfg.root).out.trim();
  if (dirty) problems.push(`the tree is not clean (${dirty.split('\n').length} file(s)) — commit or stash first`);
  else lines.push('tree: clean');

  const gaps = config.commandGaps(cfg);
  if (gaps.required.length) problems.push(`commands not configured: ${gaps.required.map((g) => g.key).join(', ')}`);

  if ((cfg.runtime || {}).services === 'docker') {
    if (run('docker info', { timeout: 15000 }).code !== 0) problems.push('Docker is not running, and runtime.services is "docker"');
    else lines.push('docker: running');
  }

  const branch = git('rev-parse --abbrev-ref HEAD', cfg.root).out.trim();
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
function doctorCmd(args = []) {
  const cfg = config.load(process.cwd());
  const gaps = config.commandGaps(cfg);
  const keys = Object.keys(config.COMMAND_KEYS);
  const setCount = keys.length - gaps.required.length - gaps.optional.length;
  const provenKeys = Object.keys(cfg.proven || {});
  const lines = [cfg.configured ? 'config: .keel/config.yml' : 'config: none found, using defaults — run `keel init --write`',
    `commands: ${setCount}/${keys.length} set`];
  if (provenKeys.length) lines.push(`  ${provenKeys.length} proven by the run ladder: ${provenKeys.join(', ')}`);
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
  out(lines.join('\n'));
  if (gaps.required.length) process.exit(3);
}

module.exports = { init, stateCmd, commit, gate, escalate, traceCmd, auditCmd, status, verifyCmd, unlock, env,
  parseOpts, triggers, ladderCmd, discoverCmd, scaffoldCmd, stackCmd, laneCmd, smokeCmd, prCmd, triageCmd, checkSizeCmd,
  models, stall, doctorCmd, preflight, archCmd };
