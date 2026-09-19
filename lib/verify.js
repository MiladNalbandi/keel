'use strict';
const fs = require('fs');
const path = require('path');
const { run, git, trim, fingerprint, matchGlob, gitOut, moduleDir, modulePath } = require('./util');
const state = require('./state');

// `git()` folds stderr into `out`, so outside a repository these returned
// "fatal: not a git repository..." as if it were a filename. The extension test downstream
// then dropped them, leaving every caller to conclude — silently — that nothing had changed.
function changedFiles(cfg, ref) {
  const staged = gitOut('diff --cached --name-only', cfg.root);
  const unstaged = gitOut('diff --name-only', cfg.root);
  const untracked = gitOut('ls-files --others --exclude-standard', cfg.root);
  const list = [staged, unstaged, untracked].join('\n').split('\n').map((x) => x.trim()).filter(Boolean);
  return Array.from(new Set(list));
}

// Whether this project is a git repository at all. A check that inspected nothing must not
// report the same thing as a check that inspected everything and found it clean.
function hasGit(cfg) {
  return git('rev-parse --git-dir', cfg.root).code === 0;
}

// How many files a boundary run actually looked at — the denominator behind its verdict.
function archInspected(cfg, files) {
  const list = files || changedFiles(cfg);
  return list.filter((rel) => /\.(kt|java|ts|tsx|js|jsx)$/.test(rel)).length;
}
function branchFiles(cfg, base) {
  const b = base || cfg.base_branch || 'main';
  const r = git(`diff --name-only ${b}...HEAD`, cfg.root);
  if (r.code !== 0) return changedFiles(cfg);
  return r.out.split('\n').map((x) => x.trim()).filter(Boolean);
}
function touched(cfg, files, dir) {
  const d = moduleDir(dir);
  // A module rooted at the repository owns every changed file. The old prefix test built
  // './' and matched nothing, so a single-module project silently skipped its own compile
  // and typecheck while reporting a clean `verify fast`.
  if (d === '') return files.length > 0;
  return files.some((f) => f === d || f.startsWith(d + '/'));
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
    steps.push(['api compile', cmdFor(cfg, 'api_compile'), cfg.backend.dir, { key: 'api_compile', required: true }]);
  }
  if (touched(cfg, files, cfg.frontend.dir)) {
    steps.push(['web typecheck', cmdFor(cfg, 'web_typecheck'), cfg.frontend.dir, { key: 'web_typecheck', required: true }]);
  }
  if (files.some((f) => f === cfg.contract.file)) {
    steps.push(['contract lint', cmdFor(cfg, 'contract_lint'), '.', { key: 'contract_lint', required: false }]);
  }
  const r = runSteps(cfg, steps);
  // Architecture boundaries ride along with fast, because a crossed boundary is cheapest
  // to fix in the turn that introduced it. `warn` reports, `block` fails the tier.
  const mode = (cfg.boundaries || {}).enforce || 'off';
  if (mode !== 'off') {
    const bad = archViolations(cfg, files);
    if (bad.length) {
      const lines = bad.map((v) => `  ${v.file}:${v.line} imports ${v.target} (${v.rule})`);
      if (mode === 'block') {
        return Object.assign({}, r, { ok: false,
          report: [r.report, `architecture boundaries crossed:`, ...lines].filter(Boolean).join('\n') });
      }
      r.notes = (r.notes || []).concat([`warning: architecture boundaries crossed:`, ...lines]);
    }
  }
  return r;
}

function acTests(cfg, ac, lane) {
  const isWeb = lane === 'web';
  const key = isWeb ? 'web_test_ac' : 'api_test_ac';
  const dir = isWeb ? cfg.frontend.dir : cfg.backend.dir;
  const steps = [[`${lane} tests for ${ac}`, cmdFor(cfg, key, ac), dir, { key, required: true }]];
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
  return runSteps(cfg, [[`${lane} module suite`, cmdFor(cfg, key), dir, { key, required: true }]]);
}

// A step is [label, command, dir] or [label, command, dir, { key, required }].
// An unconfigured command is recorded as skipped, never dropped: a check that silently
// does not run is worse than one that fails, because the tier still reports success.
function runSteps(cfg, steps) {
  const results = [];
  const skipped = [];
  let ok = true;
  for (const [label, cmd, dir, meta] of steps) {
    if (!cmd) {
      const key = (meta && meta.key) || label;
      const required = !!(meta && meta.required);
      skipped.push({ label, key, required });
      if (required) ok = false;
      continue;
    }
    const cwd = modulePath(cfg.root, dir);
    // A typo'd backend.dir used to make every command run at the repo root instead, where
    // `./gradlew` and `npx vitest` do not resolve — reported as a command failure with no
    // hint that the directory was the problem.
    const missing = !fs.existsSync(cwd);
    const r = run(cmd, { cwd: missing ? cfg.root : cwd });
    const note = missing ? `keel: ${dir} does not exist; ran at the repo root instead.\n` : '';
    results.push({ label, cmd, code: r.code, out: note + r.out });
    if (r.code !== 0) { ok = false; break; }
  }
  const failed = results.find((r) => r.code !== 0);
  const missing = skipped.filter((s) => s.required);
  const notes = skipped.map((s) => `${s.required ? 'MISSING' : 'skipped'}: ${s.label} (commands.${s.key} is not set)`);
  let report = '';
  if (failed) report = `${failed.label} failed:\n${trim(failed.out)}`;
  else if (missing.length) report = `required commands are not configured:\n${notes.join('\n')}`;
  return {
    ok,
    steps: results,
    skipped,
    notes,
    report,
    fingerprint: failed ? fingerprint(failed.out) : null,
    raw: failed ? failed.out : '',
  };
}

// Import-boundary check. Deliberately a grep over the import lines of changed files
// only: it has to be cheap enough to sit inside `verify fast`, which runs at every turn
// end, so a compiler or dependency graph is out of the question.
function archViolations(cfg, files) {
  const rules = ((cfg.boundaries || {}).rules) || [];
  if (!rules.length) return [];
  const list = files || changedFiles(cfg);
  const out = [];
  for (const rel of list) {
    if (!/\.(kt|java|ts|tsx|js|jsx)$/.test(rel)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(cfg.root, rel), 'utf8'); } catch (e) { continue; }
    const imports = text.split('\n')
      .map((l, i) => [l, i + 1])
      .filter(([l]) => /^\s*import\s|^\s*from\s+['"]/.test(l));
    if (!imports.length) continue;

    for (const rule of rules) {
      if (!matchGlob(rel, [rule.from])) continue;
      for (const [line, no] of imports) {
        const target = importTarget(line);
        if (!target) continue;
        const denied = matchGlob(target, rule.deny_imports || []);
        // allow_imports, when present, is a whitelist for anything the rule denies.
        const allowed = (rule.allow_imports || []).length ? matchGlob(target, rule.allow_imports) : false;
        if (denied && !allowed) {
          out.push({ file: rel, line: no, rule: rule.name || 'boundary', target });
        }
      }
    }
  }
  return out;
}

// What an import line refers to. Kotlin and Java keep their dotted package form, because
// that is how the rules are written (`org.springframework.**`); TypeScript keeps its
// module path (`@/features/**`). Converting one to the other made every rule silently
// fail to match.
function importTarget(line) {
  const ts = line.match(/from\s+['"]([^'"]+)['"]/) || line.match(/^\s*import\s+['"]([^'"]+)['"]/);
  if (ts) return ts[1];
  const kt = line.match(/^\s*import\s+([\w.*]+)/);
  return kt ? kt[1] : null;
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
  changedFiles, branchFiles, findDisabledMarkers, cmdFor, listFiles, archViolations, importTarget, hasGit, archInspected, touched };
