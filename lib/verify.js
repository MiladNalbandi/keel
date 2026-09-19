'use strict';
const fs = require('fs');
const path = require('path');
const { run, git, trim, fingerprint, matchGlob } = require('./util');
const state = require('./state');

function changedFiles(cfg, ref) {
  const staged = git('diff --cached --name-only', cfg.root).out.trim();
  const unstaged = git('diff --name-only', cfg.root).out.trim();
  const untracked = git('ls-files --others --exclude-standard', cfg.root).out.trim();
  const list = [staged, unstaged, untracked].join('\n').split('\n').map((x) => x.trim()).filter(Boolean);
  return Array.from(new Set(list));
}
function branchFiles(cfg, base) {
  const b = base || cfg.base_branch || 'main';
  const r = git(`diff --name-only ${b}...HEAD`, cfg.root);
  if (r.code !== 0) return changedFiles(cfg);
  return r.out.split('\n').map((x) => x.trim()).filter(Boolean);
}
function touched(cfg, files, dir) {
  return files.some((f) => dir && (f === dir || f.startsWith(dir.replace(/\/$/, '') + '/')));
}

// Classify a failing run: is this a real RED, or a broken test setup?
function classifyFailure(cfg, output) {
  const low = String(output).toLowerCase();
  // An assertion signal wins: a real RED can also print scary words.
  for (const pat of (cfg.loops.red_accept || [])) {
    if (low.includes(String(pat).toLowerCase())) return { kind: 'assertion', matched: String(pat) };
  }
  for (const pat of (cfg.loops.red_reject || [])) {
    if (low.includes(String(pat).toLowerCase())) return { kind: 'setup', matched: String(pat) };
  }
  return { kind: 'assertion' };
}

function cmdFor(cfg, key, ac) {
  const raw = (cfg.commands || {})[key] || '';
  return raw.replace(/\{AC\}/g, ac || '');
}

// Fast tier: compile / typecheck what changed.
function fast(cfg) {
  const files = changedFiles(cfg);
  const steps = [];
  if (touched(cfg, files, cfg.backend.dir) || files.some((f) => f === cfg.contract.file)) {
    steps.push(['api compile', cmdFor(cfg, 'api_compile'), cfg.backend.dir]);
  }
  if (touched(cfg, files, cfg.frontend.dir)) {
    steps.push(['web typecheck', cmdFor(cfg, 'web_typecheck'), cfg.frontend.dir]);
  }
  if (files.some((f) => f === cfg.contract.file) && cmdFor(cfg, 'contract_lint')) {
    steps.push(['contract lint', cmdFor(cfg, 'contract_lint'), '.']);
  }
  return runSteps(cfg, steps);
}

function acTests(cfg, ac, lane) {
  const isWeb = lane === 'web';
  const key = isWeb ? 'web_test_ac' : 'api_test_ac';
  const dir = isWeb ? cfg.frontend.dir : cfg.backend.dir;
  const steps = [[`${lane} tests for ${ac}`, cmdFor(cfg, key, ac), dir]];
  if ((cfg.tests || {}).per_ac_scope === 'changed-packages') {
    for (const [label, cmd] of packageSteps(cfg, lane)) steps.push([label, cmd, dir]);
  }
  return runSteps(cfg, steps);
}

// Tests in the packages this change touched, so a neighbour does not break unnoticed.
function packageSteps(cfg, lane) {
  const isWeb = lane === 'web';
  const dir = isWeb ? cfg.frontend.dir : cfg.backend.dir;
  const files = changedFiles(cfg).filter((f) => f.startsWith(dir.replace(/\/$/, '') + '/'));
  const out = [];
  if (isWeb) {
    const tpl = (cfg.commands || {}).web_test_paths;
    if (!tpl || !files.length) return out;
    const dirs = Array.from(new Set(files.map((f) => path.posix.dirname(f.slice(dir.length + 1))))).slice(0, 3);
    if (!dirs.length) return out;
    out.push([`web tests in ${dirs.join(', ')}`, tpl.replace('{PATHS}', dirs.join(' '))]);
    return out;
  }
  const tpl = (cfg.commands || {}).api_test_pkg;
  if (!tpl) return out;
  const pkgs = new Set();
  for (const f of files) {
    const m = f.match(/src\/(?:main|test|integrationTest)\/(?:kotlin|java)\/(.+)\/[^/]+\.(kt|java)$/);
    if (m) pkgs.add(m[1].split('/').join('.'));
  }
  for (const p of Array.from(pkgs).slice(0, 3)) out.push([`api tests in ${p}`, tpl.replace('{PKG}', p)]);
  return out;
}
function moduleTests(cfg, lane) {
  const isWeb = lane === 'web';
  const key = isWeb ? 'web_test_module' : 'api_test_module';
  const dir = isWeb ? cfg.frontend.dir : cfg.backend.dir;
  return runSteps(cfg, [[`${lane} module suite`, cmdFor(cfg, key), dir]]);
}

function runSteps(cfg, steps) {
  const results = [];
  let ok = true;
  for (const [label, cmd, dir] of steps) {
    if (!cmd) continue;
    const cwd = path.join(cfg.root, dir === '.' ? '' : dir);
    const r = run(cmd, { cwd: fs.existsSync(cwd) ? cwd : cfg.root });
    results.push({ label, cmd, code: r.code, out: r.out });
    if (r.code !== 0) { ok = false; break; }
  }
  const failed = results.find((r) => r.code !== 0);
  return {
    ok,
    steps: results,
    report: failed ? `${failed.label} failed:\n${trim(failed.out)}` : '',
    fingerprint: failed ? fingerprint(failed.out) : null,
    raw: failed ? failed.out : '',
  };
}

// Rerun a failing step once: a pass means flaky, not a real failure.
function withFlakeCheck(cfg, fn, label) {
  const first = fn();
  if (first.ok || !(cfg.loops.flaky_reruns > 0)) return first;
  const second = fn();
  if (second.ok) {
    state.update(cfg, (s) => {
      s.flaky.push({ label: label || 'unknown', at: new Date().toISOString(), fingerprint: first.fingerprint });
    });
    return Object.assign({}, second, { flaky: true, flakyReport: first.report });
  }
  return second;
}

// AC -> tests -> commits
function trace(cfg, st) {
  const rows = [];
  const testFiles = listFiles(cfg, [cfg.backend.dir, cfg.frontend.dir, cfg.e2e.dir])
    .filter((f) => /Test\.(kt|java)$|\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f));
  const log = git('log --format=%H%x09%s --max-count=200', cfg.root).out.split('\n').filter(Boolean);
  for (const id of state.acList(st)) {
    const ac = st.acs[id];
    const tests = testFiles.filter((f) => {
      try { return fs.readFileSync(path.join(cfg.root, f), 'utf8').includes(id); } catch (e) { return false; }
    });
    const red = log.find((l) => l.includes(`test(${id})`));
    const green = log.find((l) => l.includes(`feat(${id})`) || l.includes(`fix(${id})`));
    rows.push({
      id, layer: ac.layer || '?', status: ac.status || 'todo', tests,
      red: red ? red.slice(0, 7) : null, green: green ? green.slice(0, 7) : null,
      complete: tests.length > 0 && (!!green || ac.status === 'already-met'),
    });
  }
  return rows;
}

function listFiles(cfg, dirs) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(cfg.root, dir), { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (['node_modules', 'build', 'target', '.git', 'dist'].includes(e.name)) continue;
      const rel = dir === '' ? e.name : dir + '/' + e.name;
      if (e.isDirectory()) walk(rel); else out.push(rel);
    }
  };
  for (const d of dirs) if (d) walk(d);
  return out;
}

// Commit composition and test-integrity audit for the whole branch.
function audit(cfg, st, base) {
  const problems = [];
  const b = base || 'main';
  const log = git(`log ${b}..HEAD --format=%H%x09%s`, cfg.root).out.split('\n').filter(Boolean);
  const guards = require('./guards');
  for (const line of log) {
    const [sha, subject] = line.split('\t');
    const files = git(`show --name-only --format= ${sha}`, cfg.root).out.split('\n').map((x) => x.trim()).filter(Boolean);
    const buckets = files.map((f) => guards.classify(cfg, f));
    const isTestCommit = /^test\(/.test(subject);
    const isCodeCommit = /^(feat|fix)\(/.test(subject);
    if (isTestCommit && buckets.some((b2) => ['api-main', 'web-src'].includes(b2))) {
      problems.push(`${sha.slice(0, 7)} ${subject}: a test commit contains production code`);
    }
    if (isCodeCommit && buckets.some((b2) => ['api-test', 'web-test'].includes(b2))) {
      problems.push(`${sha.slice(0, 7)} ${subject}: an implementation commit contains test files`);
    }
    const diff = git(`show --format= ${sha}`, cfg.root).out;
    const markers = findDisabledMarkers(diff);
    if (markers.length) problems.push(`${sha.slice(0, 7)} ${subject}: adds ${markers.join(', ')}`);
  }
  for (const u of st.unlocks || []) if (!u.reason) problems.push(`unlock of ${u.path} has no reason`);
  const branch = git('rev-parse --abbrev-ref HEAD', cfg.root).out.trim();
  if (/^spike\//.test(branch)) problems.push('spike branches cannot be shipped');
  return problems;
}

function findDisabledMarkers(diff) {
  const out = [];
  const rules = [[/^\+.*@Disabled/m, '@Disabled'], [/^\+.*@Ignore/m, '@Ignore'],
    [/^\+.*\.skip\(/m, '.skip('], [/^\+.*\.only\(/m, '.only('], [/^\+.*\bxit\(/m, 'xit('],
    [/^\+.*test\.fixme/m, 'test.fixme'], [/^\+.*assumeTrue\(false\)/m, 'assumeTrue(false)']];
  for (const [re, name] of rules) if (re.test(diff)) out.push(name);
  return out;
}

module.exports = { fast, acTests, moduleTests, packageSteps, runSteps, classifyFailure, withFlakeCheck, trace, audit,
  changedFiles, branchFiles, findDisabledMarkers, cmdFor, listFiles };
