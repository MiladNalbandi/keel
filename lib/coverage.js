'use strict';
const fs = require('fs');
const path = require('path');
const { git, gitOut, readJson, writeJson } = require('./util');

/* ---------------------------------------------------------- report parsing */

// Kover / JaCoCo XML: <sourcefile name="Foo.kt"><line nr="12" mi="0" ci="3" mb="0" cb="2"/>
function parseJacoco(xml) {
  const files = {};
  const packageRe = /<package[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g;
  let pkg;
  while ((pkg = packageRe.exec(xml))) {
    const pkgName = pkg[1].replace(/\./g, '/');
    const sfRe = /<sourcefile[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/sourcefile>/g;
    let sf;
    while ((sf = sfRe.exec(pkg[2]))) {
      const key = (pkgName ? pkgName + '/' : '') + sf[1];
      const lines = {};
      const lineRe = /<line[^>]*nr="(\d+)"[^>]*mi="(\d+)"[^>]*ci="(\d+)"(?:[^>]*mb="(\d+)")?(?:[^>]*cb="(\d+)")?[^>]*\/>/g;
      let l;
      while ((l = lineRe.exec(sf[2]))) {
        lines[Number(l[1])] = {
          covered: Number(l[3]) > 0,
          branches: Number(l[4] || 0) + Number(l[5] || 0),
          branchesCovered: Number(l[5] || 0),
        };
      }
      files[key] = lines;
    }
  }
  return files;
}

// LCOV: SF:path / DA:line,hits / BRDA:line,block,branch,taken
function parseLcov(text) {
  const files = {};
  let current = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) { current = line.slice(3).replace(/\\/g, '/'); files[current] = files[current] || {}; }
    else if (line.startsWith('DA:') && current) {
      const [nr, hits] = line.slice(3).split(',');
      files[current][Number(nr)] = files[current][Number(nr)] || { covered: false, branches: 0, branchesCovered: 0 };
      files[current][Number(nr)].covered = Number(hits) > 0;
    } else if (line.startsWith('BRDA:') && current) {
      const [nr, , , taken] = line.slice(5).split(',');
      const e = files[current][Number(nr)] = files[current][Number(nr)] || { covered: false, branches: 0, branchesCovered: 0 };
      e.branches += 1;
      if (taken !== '-' && Number(taken) > 0) e.branchesCovered += 1;
    } else if (line === 'end_of_record') current = null;
  }
  return files;
}

// Coverage keys are partial paths; match them to repo paths by suffix.
function lookup(coverage, repoFile) {
  const norm = repoFile.replace(/\\/g, '/');
  if (coverage[norm]) return coverage[norm];
  for (const key of Object.keys(coverage)) {
    if (norm.endsWith('/' + key) || key.endsWith('/' + norm) || norm.endsWith(key)) return coverage[key];
  }
  return null;
}

/* ------------------------------------------------------------- changed lines */

function changedLines(cfg, base) {
  const r = git(`diff -U0 ${base}...HEAD`, cfg.root);
  const diff = r.code === 0 ? r.out : git('diff -U0 HEAD', cfg.root).out;
  const byFile = {};
  let file = null;
  for (const line of diff.split('\n')) {
    const f = line.match(/^\+\+\+ b\/(.+)$/);
    if (f) { file = f[1]; byFile[file] = byFile[file] || []; continue; }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      for (let i = 0; i < count; i++) byFile[file].push(start + i);
    }
  }
  return byFile;
}

/* ------------------------------------------------------------------ measure */

function measure(cfg, appKey, coverage, changed, excludes) {
  let executable = 0, covered = 0, branches = 0, branchesCovered = 0;
  const uncovered = [];
  // Paths where the bar is 100% rather than the global threshold: an authorization branch
  // should not count the same as a getter.
  const critical = ((cfg.security || {}).coverage_paths) || [];
  let criticalExecutable = 0, criticalCovered = 0;
  const criticalUncovered = [];
  for (const [file, lines] of Object.entries(changed)) {
    if (excludes && excludes.some((p) => require('./util').matchGlob(file, [p]))) continue;
    const fileCov = lookup(coverage, file);
    if (!fileCov) continue;
    const isCritical = critical.length && require('./util').matchGlob(file, critical);
    for (const nr of lines) {
      const entry = fileCov[nr];
      if (!entry) continue; // not an executable line (blank, comment, import)
      executable++;
      if (entry.covered) covered++; else uncovered.push(`${file}:${nr}`);
      if (isCritical) {
        criticalExecutable++;
        if (entry.covered) criticalCovered++; else criticalUncovered.push(`${file}:${nr}`);
      }
      branches += entry.branches;
      branchesCovered += entry.branchesCovered;
    }
  }
  const totals = globalTotals(coverage);
  return {
    app: appKey,
    changed_executable: executable,
    changed_covered: covered,
    changed_pct: executable ? round(covered / executable * 100) : null,
    branch_pct: branches ? round(branchesCovered / branches * 100) : null,
    global_pct: totals.lines ? round(totals.covered / totals.lines * 100) : null,
    uncovered: uncovered.slice(0, 25),
    uncovered_total: uncovered.length,
    critical_executable: criticalExecutable,
    critical_covered: criticalCovered,
    critical_uncovered: criticalUncovered.slice(0, 25),
  };
}
function globalTotals(coverage) {
  let lines = 0, covered = 0;
  for (const f of Object.values(coverage)) {
    for (const e of Object.values(f)) { lines++; if (e.covered) covered++; }
  }
  return { lines, covered };
}
function round(n) { return Math.round(n * 10) / 10; }

function loadReport(cfg, file) {
  const p = path.join(cfg.root, file);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  return /^\s*</.test(text) ? parseJacoco(text) : parseLcov(text);
}

/* -------------------------------------------------------------------- verdict */

function run(cfg, opts = {}) {
  const base = opts.base || cfg.base_branch || 'main';
  const cov = cfg.coverage || {};
  const reports = cov.reports || {};
  const results = [];
  const changed = changedLines(cfg, base);
  const head = gitOut('rev-parse HEAD', cfg.root);

  for (const [appKey, dirKey, reportKey, excludeKey] of [
    ['api', 'backend', 'api', 'api'],
    ['web', 'frontend', 'web', 'web'],
  ]) {
    const reportFile = reports[reportKey];
    if (!reportFile) continue;
    const dir = cfg[dirKey] && cfg[dirKey].dir;
    const scoped = {};
    for (const [f, lines] of Object.entries(changed)) {
      if (!dir || f === dir || f.startsWith(dir.replace(/\/$/, '') + '/')) scoped[f] = lines;
    }
    if (!Object.keys(scoped).length) continue;
    const data = loadReport(cfg, reportFile);
    if (!data) { results.push({ app: appKey, error: `coverage report not found: ${reportFile}` }); continue; }
    const excludes = (cov.exclude && cov.exclude[excludeKey]) || [];
    results.push(measure(cfg, appKey, data, scoped, excludes));
  }

  const baselineFile = path.join(cfg.root, '.keel', 'coverage-baseline.json');
  const baseline = readJson(baselineFile, {});
  const problems = [];
  for (const r of results) {
    if (r.error) { problems.push(r.error); continue; }
    if (r.changed_pct !== null && r.changed_pct < cov.changed_lines) {
      problems.push(`${r.app}: changed lines ${r.changed_pct}% < ${cov.changed_lines}%`);
    }
    // Security-critical paths carry a 100% bar, so one uncovered line there is a problem
    // even when the app as a whole clears the threshold.
    if (r.critical_executable && r.critical_covered < r.critical_executable) {
      problems.push(`${r.app}: ${r.critical_executable - r.critical_covered} uncovered line(s) on a security-critical path `
        + `(security.coverage_paths requires 100%): ${(r.critical_uncovered || []).slice(0, 5).join(', ')}`);
    }
    if (r.branch_pct !== null && cov.changed_branches && r.branch_pct < cov.changed_branches) {
      problems.push(`${r.app}: changed branches ${r.branch_pct}% < ${cov.changed_branches}%`);
    }
    const target = cov.global;
    if (target !== undefined && r.global_pct !== null) {
      if (target === 'ratchet') {
        const b = baseline[r.app];
        if (b !== undefined && r.global_pct < b - 0.1) problems.push(`${r.app}: global coverage dropped ${b}% -> ${r.global_pct}%`);
      } else if (typeof target === 'number' && r.global_pct < target) {
        problems.push(`${r.app}: global coverage ${r.global_pct}% < ${target}%`);
      }
    }
  }

  if (opts.updateBaseline) {
    for (const r of results) if (r.global_pct !== null) baseline[r.app] = r.global_pct;
    writeJson(baselineFile, baseline);
  }

  const verdict = {
    sha: head,
    base,
    pass: problems.length === 0 && results.length > 0,
    apps: results,
    problems,
    summary: results.filter((r) => !r.error).map((r) => `${r.app} changed ${r.changed_pct === null ? 'n/a' : r.changed_pct + '%'}, global ${r.global_pct === null ? 'n/a' : r.global_pct + '%'}`).join('; '),
    at: new Date().toISOString(),
  };
  // An empty `results` has two very different causes and used to report only one of them.
  // With no changed lines against the base there is nothing coverage could regress, so the
  // verdict passes — otherwise the gate is unsatisfiable on the base branch itself, and it
  // blamed `coverage.reports` for a configuration that was correct all along.
  if (!results.length) {
    const configured = Object.values(reports).filter(Boolean).length > 0;
    const nothingChanged = Object.keys(changed).length === 0;
    if (!configured) {
      verdict.pass = false;
      verdict.problems = ['no coverage reports configured (coverage.reports in .keel/config.yml)'];
    } else if (nothingChanged) {
      verdict.pass = true;
      verdict.problems = [];
      verdict.summary = 'no changed lines against ' + base + ' — nothing to measure';
    } else {
      verdict.pass = true;
      verdict.problems = [];
      verdict.summary = 'no changed lines inside a measured app';
    }
  }
  writeJson(path.join(cfg.root, '.keel', 'coverage.json'), verdict);
  return verdict;
}

module.exports = { run, parseJacoco, parseLcov, changedLines, measure, lookup };
