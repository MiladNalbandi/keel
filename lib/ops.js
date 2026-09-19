'use strict';
const fs = require('fs');
const path = require('path');
const { run, git, gitOut, trim, readJson, matchGlob } = require('./util');
const st = require('./state');
const guards = require('./guards');
const verify = require('./verify');

/* -------------------------------------------------------------- the stack */

function composeCmd(cfg) {
  const which = run('docker compose version').code === 0 ? 'docker compose'
    : run('docker-compose version').code === 0 ? 'docker-compose' : null;
  return which;
}
function project(cfg, lane) {
  const base = path.basename(cfg.root).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'keel';
  return lane && lane !== 'api' ? `${base}_${lane}` : base;
}
function portOffset(cfg, lane) {
  if (!(cfg.stack && cfg.stack.per_lane_isolation)) return 0;
  return lane === 'web' ? 100 : lane && lane !== 'api' ? 200 : 0;
}

// Compose interpolation cannot do arithmetic, so resolve each port here. Interpolating
// the offset itself concatenated instead of adding: offset 100 produced host port
// 1005432 rather than 5532.
const BASE_PORTS = { db: 5432 };
function portEnv(cfg, lane) {
  const off = portOffset(cfg, lane);
  const env = { KEEL_PORT_OFFSET: String(off) };
  for (const [name, base] of Object.entries(BASE_PORTS)) {
    env[`KEEL_${name.toUpperCase()}_PORT`] = String(base + off);
  }
  return env;
}

function stack(cfg, args) {
  const sub = args[0] || 'status';
  const lane = (args.includes('--lane') ? args[args.indexOf('--lane') + 1] : null) || st.read(cfg).lane || 'api';
  const compose = (cfg.stack && cfg.stack.compose) || '';
  const cc = composeCmd(cfg);
  if (!compose || !cc) {
    return { ok: false, out: `no Compose file configured (stack.compose) or Docker Compose is not installed.` };
  }
  const env = Object.assign({ COMPOSE_PROJECT_NAME: project(cfg, lane) }, portEnv(cfg, lane));
  const base = `${cc} -p ${project(cfg, lane)} -f ${compose}`;
  const call = (suffix, timeout) => run(`${base} ${suffix}`, { cwd: cfg.root, env, timeout: timeout || 300000 });

  if (sub === 'up') {
    const r = call('up -d --wait');
    return { ok: r.code === 0, out: r.code === 0 ? `stack up (project ${project(cfg, lane)}, port offset ${portOffset(cfg, lane)})` : trim(r.out, 20) };
  }
  if (sub === 'down') { const r = call('down'); return { ok: r.code === 0, out: r.code === 0 ? 'stack down (volumes kept)' : trim(r.out, 10) }; }
  if (sub === 'reset') { const r = call('down -v'); return { ok: r.code === 0, out: r.code === 0 ? 'stack reset (volumes dropped)' : trim(r.out, 10) }; }
  if (sub === 'status') { const r = call('ps'); return { ok: r.code === 0, out: trim(r.out, 20) }; }
  if (sub === 'logs') {
    const svc = args[1] && !args[1].startsWith('--') ? args[1] : '';
    const r = call(`logs --tail 40 ${svc}`);
    return { ok: r.code === 0, out: trim(r.out, 40) };
  }
  if (sub === 'migrate') {
    const cmd = (cfg.commands || {}).migrate;
    if (!cmd) return { ok: false, out: 'no migrate command configured (commands.migrate).' };
    const r = run(cmd, { cwd: path.join(cfg.root, cfg.backend.dir), env, timeout: 600000 });
    return { ok: r.code === 0, out: r.code === 0 ? 'dev database migrated' : trim(r.out, 20) };
  }
  return { ok: false, out: `unknown stack command "${sub}". Use up, down, reset, status, logs, migrate.` };
}

// Are there migrations the dev database has not seen? Cheap heuristic: file count vs recorded count.
function migrationDrift(cfg) {
  const dir = path.join(cfg.root, cfg.backend.dir, cfg.backend.migrations);
  if (!fs.existsSync(dir)) return { drift: false };
  const files = fs.readdirSync(dir).filter((f) => /\.sql$/.test(f)).sort();
  const marker = path.join(cfg.root, '.keel', 'migrations-applied.json');
  const applied = readJson(marker, { files: [] });
  const missing = files.filter((f) => !applied.files.includes(f));
  return { drift: missing.length > 0, missing, files, marker };
}
function markMigrationsApplied(cfg) {
  const d = migrationDrift(cfg);
  require('./util').writeJson(d.marker || path.join(cfg.root, '.keel', 'migrations-applied.json'), { files: d.files || [], at: new Date().toISOString() });
}

/* ----------------------------------------------------------------- lanes */

function lane(cfg, args) {
  const sub = args[0] || 'status';
  const name = args[1] && !args[1].startsWith('--') ? args[1] : 'web';
  const branch = `lane/${name}-${path.basename(cfg.root)}`;
  const dir = path.join(path.dirname(cfg.root), `${path.basename(cfg.root)}-${name}`);
  if (sub === 'start') {
    if (fs.existsSync(dir)) return { ok: false, out: `worktree already exists at ${dir}` };
    const r = git(`worktree add -b ${branch} ${JSON.stringify(dir)}`, cfg.root);
    if (r.code !== 0) return { ok: false, out: trim(r.out, 10) };
    st.update(cfg, (s) => { s.lanes = s.lanes || {}; s.lanes[name] = { branch, dir, mode: args.includes('--background') ? 'background' : 'interactive', status: 'open' }; });
    return { ok: true, out: [`lane ${name} started`, `  worktree: ${dir}`, `  branch:   ${branch}`,
      `  stack:    project ${project(cfg, name)}, port offset ${portOffset(cfg, name)}`,
      args.includes('--background') ? '  gates are skipped in this lane; automatic checks still run' : '  open a second terminal there and run /keel:feature --lane ' + name].join('\n') };
  }
  if (sub === 'merge') {
    const s = st.read(cfg);
    const info = (s.lanes || {})[name];
    if (!info) return { ok: false, out: `no lane "${name}" recorded` };
    const r = git(`merge --no-ff ${info.branch} -m ${JSON.stringify(`merge lane ${name}`)}`, cfg.root);
    if (r.code !== 0) return { ok: false, out: `merge stopped:\n${trim(r.out, 20)}` };
    git(`worktree remove ${JSON.stringify(info.dir)} --force`, cfg.root);
    st.update(cfg, (s2) => { if (s2.lanes && s2.lanes[name]) s2.lanes[name].status = 'merged'; });
    return { ok: true, out: `lane ${name} merged and its worktree removed` };
  }
  const s = st.read(cfg);
  const lanes = s.lanes || {};
  return { ok: true, out: Object.keys(lanes).length
    ? Object.entries(lanes).map(([k, v]) => `${k}: ${v.status} (${v.mode}) ${v.branch}`).join('\n')
    : 'no lanes' };
}

/* ----------------------------------------------------------------- smoke */

function smoke(cfg) {
  const dir = path.join(cfg.root, cfg.smoke.dir);
  const lines = [];
  let ok = true;
  const env = {
    BASE_URL: (cfg.e2e && cfg.e2e.web_url) || 'http://localhost:5173',
    API_URL: (cfg.e2e && cfg.e2e.api_url) || 'http://localhost:8080',
  };
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sh')).sort()) {
      const r = run(`bash ${JSON.stringify(path.join(dir, f))}`, { cwd: cfg.root, env, timeout: 120000 });
      lines.push(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${f}${r.code === 0 ? '' : ': ' + trim(r.out, 3)}`);
      if (r.code !== 0) { ok = false; break; }
    }
  }
  const pw = (cfg.commands || {}).smoke_e2e;
  if (ok && pw) {
    const r = run(pw, { cwd: cfg.root, env, timeout: 300000 });
    lines.push(`${r.code === 0 ? 'ok  ' : 'FAIL'} @smoke playwright${r.code === 0 ? '' : ': ' + trim(r.out, 5)}`);
    if (r.code !== 0) ok = false;
  }
  if (!lines.length) lines.push('no smoke checks found');
  return { ok, out: lines.join('\n') };
}

/* -------------------------------------------------------------------- PR */

function prBody(cfg, state) {
  const rows = verify.trace(cfg, state);
  const cov = readJson(path.join(cfg.root, '.keel', 'coverage.json'), null);
  const skipped = Object.entries((state.gates && state.gates.skipped) || {});
  const spec = state.spec ? fs.existsSync(path.join(cfg.root, state.spec)) ? fs.readFileSync(path.join(cfg.root, state.spec), 'utf8').split('\n').slice(0, 12).join('\n') : '' : '';
  return [
    state.spec ? `Spec: \`${state.spec}\`` : 'No spec (change flow).',
    '',
    spec ? '<details><summary>Spec extract</summary>\n\n```markdown\n' + spec + '\n```\n</details>\n' : '',
    '## Acceptance criteria',
    '',
    '| AC | layer | status | tests | red | green |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.layer} | ${r.status} | ${r.tests.length} | ${r.red || '—'} | ${r.green || '—'} |`),
    '',
    '## Coverage',
    '',
    cov ? (cov.pass ? `Pass — ${cov.summary}` : `FAIL — ${(cov.problems || []).join('; ')}`) : 'No coverage verdict.',
    '',
    skipped.length ? '## Skipped gates\n\n' + skipped.map(([k, v]) => `- ${k}: ${v}`).join('\n') + '\n' : '',
    (state.unlocks || []).length ? '## Unlocks\n\n' + state.unlocks.map((u) => `- \`${u.path}\` in ${u.phase}: ${u.reason}`).join('\n') + '\n' : '',
    (state.flaky || []).length ? '## Flaky tests seen\n\n' + state.flaky.map((f) => `- ${f.label}`).join('\n') + '\n' : '',
    '---',
    '_Prepared by keel._',
  ].filter((l) => l !== '').join('\n');
}

function pr(cfg, args) {
  const state = st.read(cfg);
  const problems = [];
  const head = gitOut('rev-parse HEAD', cfg.root);
  const cov = readJson(path.join(cfg.root, '.keel', 'coverage.json'), null);
  if (!cov) problems.push('no coverage verdict: run `keel verify coverage`');
  else if (cov.sha !== head) problems.push('the coverage verdict is for an older commit: run `keel verify coverage`');
  else if (!cov.pass) problems.push(`coverage is below the threshold: ${(cov.problems || []).join('; ')}`);
  const auditProblems = verify.audit(cfg, state, 'main');
  if (auditProblems.length) problems.push('audit: ' + auditProblems.join('; '));
  const rows = verify.trace(cfg, state);
  const incomplete = rows.filter((r) => !r.complete).map((r) => r.id);
  if (incomplete.length) problems.push('ACs without a test or an implementation commit: ' + incomplete.join(', '));
  const finalApproved = (state.gates.log || []).some((l) => l.startsWith('final review approved'));
  if (!finalApproved) problems.push('the final human review has not been approved (`keel gate final approve`)');
  if (problems.length && !args.includes('--force')) {
    return { ok: false, out: ['cannot open the PR yet:', ...problems.map((p) => '  - ' + p)].join('\n') };
  }

  const body = prBody(cfg, state);
  const bodyFile = path.join(cfg.root, '.keel', 'pr-body.md');
  require('./util').writeJson; fs.mkdirSync(path.dirname(bodyFile), { recursive: true }); fs.writeFileSync(bodyFile, body);
  if (args.includes('--dry-run')) return { ok: true, out: body };

  const branch = git('rev-parse --abbrev-ref HEAD', cfg.root).out.trim();
  const push = git(`push -u origin ${branch}`, cfg.root);
  if (push.code !== 0) return { ok: false, out: 'push failed:\n' + trim(push.out, 10) };
  const title = state.spec ? `feat: ${path.basename(state.spec, '.md')}` : `feat: ${branch}`;
  const r = run(`gh pr create --title ${JSON.stringify(title)} --body-file ${JSON.stringify(bodyFile)}`, { cwd: cfg.root });
  if (r.code !== 0) return { ok: false, out: 'gh pr create failed:\n' + trim(r.out, 10) };
  return { ok: true, out: r.out.trim() };
}

/* ------------------------------------------------------- change-flow size */

function checkSize(cfg, args) {
  const state = st.read(cfg);
  const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'main';
  let files = verify.branchFiles(cfg, base);
  if (!files.length) files = verify.changedFiles(cfg);
  const buckets = files.map((f) => [f, guards.classify(cfg, f)]);
  const triggers = [];
  const has = (b) => buckets.some(([, x]) => x === b);
  if (has('contract')) triggers.push({ must: true, why: 'the API contract changed' });
  if (has('migration')) triggers.push({ must: true, why: 'a migration was added or changed' });
  if (files.some((f) => matchGlob(f, cfg.change.auth_paths))) triggers.push({ must: true, why: 'auth or security code changed' });
  if (buckets.some(([, b]) => b.startsWith('api')) && buckets.some(([, b]) => b.startsWith('web'))) {
    triggers.push({ must: false, why: 'both apps changed' });
  }
  if (files.length > cfg.change.size_limits_files) triggers.push({ must: false, why: `${files.length} files changed (limit ${cfg.change.size_limits_files})` });
  const diffstat = git(`diff --shortstat ${base}...HEAD`, cfg.root).out.trim();
  const lines = Number((diffstat.match(/(\d+) insertion/) || [])[1] || 0) + Number((diffstat.match(/(\d+) deletion/) || [])[1] || 0);
  if (lines > cfg.change.size_limits_lines) triggers.push({ must: false, why: `${lines} changed lines (limit ${cfg.change.size_limits_lines})` });
  const acs = st.acList(state).length;
  if (acs > cfg.change.max_inline_acs) triggers.push({ must: false, why: `${acs} ACs (limit ${cfg.change.max_inline_acs} for a small change)` });
  return { files, triggers, lines };
}

function triage(cfg, description) {
  const text = String(description || '').toLowerCase();
  const signals = [];
  if (/endpoint|api|route|contract|schema|response|payload/.test(text)) signals.push('mentions the API surface, so the contract may change');
  if (/migration|column|table|index|database/.test(text)) signals.push('mentions data, so a migration is likely');
  if (/auth|permission|role|token|login|security/.test(text)) signals.push('mentions auth or security');
  if (/rename|extract|move|format|typo|comment|docs|dependency|bump/.test(text)) signals.push('sounds like a refactor or a docs change');
  if (/validation|error message|default|sort|empty state|field/.test(text)) signals.push('sounds like a small behaviour change');
  const size = checkSize(cfg, []);
  const must = size.triggers.filter((t) => t.must);
  const suggestion = must.length ? 'spec flow'
    : /rename|extract|move|format|typo|comment|docs|dependency|bump/.test(text) ? 'trivial'
      : 'small';
  return [
    `description signals: ${signals.length ? signals.join('; ') : 'none detected'}`,
    `current diff: ${size.files.length} files, ${size.lines} lines`,
    size.triggers.length ? `triggers: ${size.triggers.map((t) => (t.must ? 'MUST ' : 'suggest ') + t.why).join('; ')}` : 'triggers: none',
    '',
    `proposed size: ${suggestion}`,
    '',
    'Confirm with the user: could a test notice a difference? Does it touch the contract, a migration or auth? Does it need more than 3 ACs?',
  ].join('\n');
}

module.exports = { stack, lane, smoke, pr, prBody, checkSize, triage, migrationDrift, markMigrationsApplied, project, portOffset, portEnv };
