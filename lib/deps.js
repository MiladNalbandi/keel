'use strict';
// Dependency vulnerabilities. Collected and thresholded by the CLI, never by a model:
// `npm audit --json` and a Gradle dependency report are machine output, and asking a model
// to read them wastes tokens and invites invented CVE ids. The only judgment worth
// delegating is reachability, which is keel:dependency-triager's job.
const fs = require('fs');
const path = require('path');
const { run, git, gitOut, readJson, writeJson, matchGlob } = require('./util');

const ORDER = ['low', 'moderate', 'high', 'critical'];
const rank = (s) => Math.max(0, ORDER.indexOf(String(s || 'low').toLowerCase()));

// Manifests and lockfiles: if none changed on the branch, there is nothing new to say.
const MANIFESTS = ['**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
  '**/bun.lock', '**/build.gradle', '**/build.gradle.kts', '**/gradle.lockfile',
  '**/settings.gradle', '**/settings.gradle.kts', '**/pom.xml', '**/gradle/libs.versions.toml'];

function manifestsChanged(cfg, base) {
  const b = base || cfg.base_branch || 'main';
  const r = git(`diff --name-only ${b}...HEAD`, cfg.root);
  let files = (r.code === 0 ? r.out : '').split('\n').map((x) => x.trim()).filter(Boolean);
  // The branch diff is the right scope, but it is empty when HEAD *is* the base branch —
  // and then "nothing changed" would be a false negative rather than a fact. Fall back to
  // the working tree, which is also what a pre-flow check sees.
  if (!files.length) {
    const wt = git('status --porcelain', cfg.root).out.replace(/^.{2,3}\s*/gm, '');
    const last = git('show --name-only --format= HEAD', cfg.root).out;
    files = (wt + '\n' + last).split('\n').map((x) => x.trim()).filter(Boolean);
  }
  return Array.from(new Set(files.filter((f) => matchGlob(f, MANIFESTS))));
}

// npm audit --json, in whichever shape the installed npm emits.
function auditNpm(cfg, dir) {
  const cwd = path.join(cfg.root, dir || '');
  if (!fs.existsSync(path.join(cwd, 'package.json'))) return null;
  const r = run('npm audit --json', { cwd, timeout: 300000 });
  let data = null;
  try { data = JSON.parse(r.out); } catch (e) { return { error: 'npm audit did not return JSON' }; }
  const out = [];
  // npm 7+ shape.
  for (const [name, v] of Object.entries((data && data.vulnerabilities) || {})) {
    if (!v || !v.severity) continue;
    out.push({ ecosystem: 'npm', name, severity: String(v.severity).toLowerCase(),
      via: (v.via || []).map((x) => (typeof x === 'string' ? x : x.title)).filter(Boolean).slice(0, 3),
      fix: v.fixAvailable ? (typeof v.fixAvailable === 'object' ? `${v.fixAvailable.name}@${v.fixAvailable.version}` : 'available') : 'none',
      dev: !!v.isDirect === false && !!v.dev });
  }
  return { findings: out };
}

// A Gradle dependency-check or OSV report, when the project produces one. keel does not
// install a scanner: it reads what the build already writes.
function auditGradle(cfg, dir) {
  const candidates = [
    'build/reports/dependency-check-report.json',
    'build/reports/osv/report.json',
    'build/reports/dependency-vulnerabilities.json',
  ];
  for (const rel of candidates) {
    const abs = path.join(cfg.root, dir || '', rel);
    if (!fs.existsSync(abs)) continue;
    const data = readJson(abs, null);
    if (!data) continue;
    const out = [];
    for (const d of (data.dependencies || data.results || [])) {
      for (const v of (d.vulnerabilities || d.vulns || [])) {
        out.push({ ecosystem: 'gradle', name: d.fileName || d.package || d.name || 'unknown',
          severity: String(v.severity || v.cvssv3_baseSeverity || 'moderate').toLowerCase(),
          via: [v.name || v.id].filter(Boolean), fix: v.fixedVersion || 'none', dev: false });
      }
    }
    return { findings: out, from: rel };
  }
  return null;
}

function allowed(cfg, finding) {
  const list = ((cfg.security || {}).deps || {}).allowlist || [];
  const today = new Date().toISOString().slice(0, 10);
  return list.some((entry) => {
    const id = typeof entry === 'string' ? entry : entry.id;
    if (!id) return false;
    const matchesId = finding.via.some((v) => String(v).includes(id)) || finding.name === id;
    if (!matchesId) return false;
    // An allowlist entry without an expiry is a permanent exception by accident, so an
    // expired or missing date does not suppress the finding.
    const expires = typeof entry === 'object' ? entry.expires : null;
    return !!expires && String(expires) >= today;
  });
}

function run_(cfg, opts = {}) {
  const base = opts.base || cfg.base_branch || 'main';
  const changed = manifestsChanged(cfg, base);
  const head = gitOut('rev-parse HEAD', cfg.root);
  const threshold = ((cfg.security || {}).deps || {}).fail_on || 'high';

  // Nothing about dependencies changed: there is no verdict to make, and saying so beats
  // running a network scan on every ship.
  if (!changed.length && !opts.force) {
    const verdict = { sha: head, pass: true, skipped: 'no manifest or lockfile changed on this branch', findings: [] };
    writeJson(path.join(cfg.root, '.keel', 'security.json'), verdict);
    return verdict;
  }

  const findings = [];
  const notes = [];
  for (const [key, dir] of [['web', (cfg.frontend || {}).dir], ['api', (cfg.backend || {}).dir]]) {
    const res = key === 'web' ? auditNpm(cfg, dir) : auditGradle(cfg, dir);
    if (!res) { notes.push(`${key}: no scanner output found`); continue; }
    if (res.error) { notes.push(`${key}: ${res.error}`); continue; }
    for (const f of res.findings) findings.push(Object.assign({ app: key }, f));
  }

  const suppressed = findings.filter((f) => allowed(cfg, f));
  const live = findings.filter((f) => !allowed(cfg, f));
  const blocking = live.filter((f) => rank(f.severity) >= rank(threshold));

  const verdict = {
    sha: head, pass: blocking.length === 0, threshold,
    manifests_changed: changed, findings: live, suppressed: suppressed.length, notes,
    summary: live.length ? `${live.length} vulnerability(ies), ${blocking.length} at or above ${threshold}` : 'no vulnerabilities found',
  };
  writeJson(path.join(cfg.root, '.keel', 'security.json'), verdict);
  return verdict;
}

module.exports = { run: run_, manifestsChanged, MANIFESTS, rank, ORDER };
