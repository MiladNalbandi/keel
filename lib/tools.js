'use strict';
// Other people's programs, declared rather than hardcoded.
//
// keel already ran two of them — prettier and ktlint, named in lib/hooks.js and selected by file
// extension. A Kotlin project standing on spotless got ktlint anyway, and a PHP project got nothing
// at all, because there was nowhere to say otherwise. This is that somewhere.
//
// The other half is token cost. An agent that wants CI status runs `gh run list`, pulls pages of
// output into its context and reasons over it; every poll is paid for twice, once in tokens and
// once in a window that now holds a wall of text nobody will read again. A tool runs the command
// and keel keeps the verdict — exit code, duration, a trimmed head — so the agent is handed one
// line and the full output goes to the dashboard, where a human reads it for free.
const fs = require('fs');
const path = require('path');

const { run, trim, readJson, writeJson, moduleDir, gitOut } = require('./util');
const events = require('./events');

const FILE = path.join('.keel', 'tools.json');
const WHEN = ['manual', 'edit', 'batch', 'pre-commit', 'pre-push'];
const FAIL = ['fix', 'block', 'warn'];
// A tool's command reaches a shell. `{FILES}` and `{FILE}` are the only values keel itself puts
// there, and both are repo-relative paths it produced — never anything a page or a model typed.
// mcp/console.js refuses any command carrying one of these for exactly that reason.
const PLACEHOLDER = /\{(FILES?|BUILD|DIR)\}/;

function file(cfg) { return path.join(cfg.root, FILE); }

/* ------------------------------------------------------------------ resolve */

// A tool is `false` when a project turns one off. That is the same escape hatch `''` gives a
// command: the entry has to survive the merge to override the layer beneath it, so it cannot
// simply be dropped at read time.
function isOff(def) { return def === false || def === null; }

function problem(name, def) {
  if (isOff(def)) return null;
  if (!def || typeof def !== 'object' || Array.isArray(def)) return 'is not a block of settings';
  if (!String(def.run || '').trim()) return 'has no `run:` command';
  const when = String(def.on || 'manual');
  if (!WHEN.includes(when)) return `has on: ${when}, which is not one of ${WHEN.join(', ')}`;
  if (def.fail !== undefined && !FAIL.includes(String(def.fail))) {
    return `has fail: ${def.fail}, which is not one of ${FAIL.join(', ')}`;
  }
  if (def.match !== undefined) {
    try { new RegExp(String(def.match)); } catch (e) { return `has an unreadable match: ${e.message}`; }
  }
  // A file-scoped tool that never runs on files would silently pass the empty string to its
  // command and format the whole repo, or nothing at all.
  if (when === 'manual' && /\{FILES?\}/.test(String(def.run))) {
    return 'takes {FILE} or {FILES} but runs on: manual, so it would never be given any';
  }
  return null;
}

// Every declared tool, normalised, with where it came from. Order is the merge order, so a later
// source has already overwritten an earlier one by the time this runs — `source` records which.
function list(cfg) {
  const out = [];
  const seen = (cfg && cfg.tools) || {};
  const from = (cfg && cfg.tools_from) || {};
  for (const name of Object.keys(seen).sort()) {
    const def = seen[name];
    if (isOff(def)) continue;
    const bad = problem(name, def);
    out.push({
      name,
      run: String((def && def.run) || ''),
      on: String((def && def.on) || 'manual'),
      match: def && def.match ? String(def.match) : null,
      fail: String((def && def.fail) || 'warn'),
      kind: String((def && def.kind) || 'check'),
      timeout: Number((def && def.timeout) || 0) || 0,
      description: (def && def.description) ? String(def.description) : null,
      lane: (def && def.lane) ? String(def.lane) : null,
      dir: (def && def.dir) ? String(def.dir) : '',
      source: from[name] || 'project',
      problem: bad,
    });
  }
  return out;
}

function get(cfg, name) { return list(cfg).find((t) => t.name === name) || null; }

// Which tools want to run at this point, for these files. A tool with a `match` is only offered
// the paths that match it; one without takes them all.
function forWhen(cfg, when, files) {
  const paths = (files || []).map(String).filter(Boolean);
  const picked = [];
  for (const t of list(cfg)) {
    if (t.on !== when || t.problem) continue;
    if (!t.match) { picked.push({ tool: t, files: paths }); continue; }
    const re = new RegExp(t.match);
    const hit = paths.filter((p) => re.test(p));
    // A file-scoped tool with nothing to do is not run. A repo-scoped one still is.
    if (hit.length || !/\{FILES?\}/.test(t.run)) picked.push({ tool: t, files: hit });
  }
  return picked;
}

/* ---------------------------------------------------------------- resolve + run */

function resolve(cfg, tool, files) {
  const build = (cfg.backend || {}).build || './gradlew';
  const dir = tool.dir || (tool.lane === 'web' ? (cfg.frontend || {}).dir : tool.lane === 'api' ? (cfg.backend || {}).dir : '') || '';
  const quoted = (files || []).map((f) => JSON.stringify(f)).join(' ');
  return String(tool.run)
    .replace(/\{BUILD\}/g, build)
    .replace(/\{DIR\}/g, dir)
    .replace(/\{FILES\}/g, quoted)
    .replace(/\{FILE\}/g, (files && files[0]) ? JSON.stringify(files[0]) : '');
}

// Where a tool runs. `dir:` is explicit; `lane:` derives it, which is what a formatter usually
// wants — `npx --no-install prettier` only finds the binary from inside the directory holding the
// node_modules it was installed into, so running it at the repository root silently does nothing
// in any project whose frontend is a subdirectory.
function cwdFor(cfg, tool) {
  let dir = tool.dir;
  if (!dir && tool.lane) dir = tool.lane === 'web' ? (cfg.frontend || {}).dir : (cfg.backend || {}).dir;
  return dir ? path.join(cfg.root, moduleDir(dir)) : cfg.root;
}

// One run. Never throws: a tool that cannot start is a verdict, not a crash, because the callers
// are a post-tool hook and a commit — neither of which may die because a formatter is missing.
function runOne(cfg, tool, files) {
  const cmd = resolve(cfg, tool, files);
  const cwd = cwdFor(cfg, tool);
  const at = Date.now();
  const r = run(cmd, {
    cwd: fs.existsSync(cwd) ? cwd : cfg.root,
    timeout: (tool.timeout || 120) * 1000,
  });
  const ms = Date.now() - at;
  const out = String(r.out || '');
  const verdict = {
    name: tool.name,
    cmd,
    code: r.code,
    ok: r.code === 0,
    ms,
    files: (files || []).length,
    // The compact half. The full text is never stored: it belongs on the dashboard, which reads
    // it live, or in the caller's terminal — not in a JSON file that grows forever.
    head: trim(out, 12).trim(),
  };
  record(cfg, verdict);
  return verdict;
}

/* -------------------------------------------------------------------- record */

// Modelled on .keel/proven.json: accumulative, written only when something changed, and outside
// the hand-edited YAML so a record of what ran never rewrites a file full of comments.
function record(cfg, verdict) {
  try {
    const f = file(cfg);
    const prev = readJson(f, { runs: {} });
    const runs = Object.assign({}, prev.runs);
    runs[verdict.name] = {
      at: new Date().toISOString(),
      ms: verdict.ms,
      code: verdict.code,
      ok: verdict.ok,
      files: verdict.files,
      head: verdict.head.slice(0, 600),
    };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    writeJson(f, { at: new Date().toISOString(), runs });
  } catch (e) { /* a record that cannot be written must not fail the tool */ }
  try {
    events.append(cfg, {
      kind: 'tool',
      tool: `tool:${verdict.name}`,
      arg: events.short(verdict.files ? `${verdict.files} file(s)` : verdict.cmd),
      ok: verdict.ok,
      ms: verdict.ms,
    });
  } catch (e) { /* bookkeeping never changes the verdict */ }
}

function runs(cfg) { return readJson(file(cfg), { runs: {} }).runs || {}; }

/* ----------------------------------------------------------------- lifecycle */

// The edit and batch hooks. Returns the verdicts so a caller can report; hooks ignore them, because
// a formatter's opinion must never block an edit that the guards already allowed.
function runFor(cfg, when, files) {
  const out = [];
  for (const { tool, files: hit } of forWhen(cfg, when, files)) out.push(runOne(cfg, tool, hit));
  return out;
}

// The commit hook. `fail:` decides what a nonzero exit means, which is the whole reason it is
// declared per tool: cs-fix reformatting and carrying on, and phpstan refusing, are both correct
// and neither is a sensible default for the other.
function preCommit(cfg, staged, restage) {
  const problems = [];
  const warnings = [];
  const ran = [];
  let fixed = false;
  for (const { tool, files } of forWhen(cfg, 'pre-commit', staged)) {
    const v = runOne(cfg, tool, files);
    ran.push(v);
    // A fixer rewrites files and then exits 0, so "did it change anything" cannot be read from the
    // exit code. Re-stage whenever one ran at all.
    if (tool.fail === 'fix') fixed = true;
    if (v.ok) continue;
    if (tool.fail === 'block') problems.push(`${tool.name} failed:\n${v.head}`);
    else warnings.push(`${tool.name}: ${(v.head.split('\n')[0] || 'failed').trim()}`);
  }
  // Stage again before anything reads the diff — including the secrets scan, which must see the
  // bytes that will actually be committed rather than the ones the fixer replaced.
  if (fixed && typeof restage === 'function') restage();
  return { ok: !problems.length, problems, warnings, ran };
}

/* ------------------------------------------------------------------- pre-push */

// The lint a stack bundle binds to the push. Unlike pre-commit it is not run automatically: a
// whole-project lint takes long enough that the user decides, once per commit, whether to run it
// now or skip it. Either answer is a verdict for HEAD in .keel/lint.json, and the push gate
// (gates.pushBlockers) waits for one.
const LINT_FILE = path.join('.keel', 'lint.json');

function pushTools(cfg) { return list(cfg).filter((t) => t.on === 'pre-push' && !t.problem); }

function lintVerdict(cfg) { return readJson(path.join(cfg.root, LINT_FILE), null); }

function writeLint(cfg, v) {
  const f = path.join(cfg.root, LINT_FILE);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  writeJson(f, Object.assign({ sha: gitOut('rev-parse HEAD', cfg.root, null), at: new Date().toISOString() }, v));
}

// Run every pre-push tool. `fail:` means what it means at pre-commit, except that a fixer cannot
// re-stage here — the commit is already made — so a fixer that changed files fails the verdict
// until those changes are committed.
function prePush(cfg) {
  const problems = [];
  const warnings = [];
  const ran = [];
  for (const tool of pushTools(cfg)) {
    const v = runOne(cfg, tool, []);
    ran.push({ name: v.name, ok: v.ok, ms: v.ms });
    if (tool.fail === 'fix') {
      const dirty = String(gitOut('status --porcelain', cfg.root, '') || '').trim();
      if (dirty) problems.push(`${tool.name} changed files: commit them, then run the lint again`);
      continue;
    }
    if (v.ok) continue;
    if (tool.fail === 'block') problems.push(`${tool.name} failed:\n${v.head}`);
    else warnings.push(`${tool.name}: ${(v.head.split('\n')[0] || 'failed').trim()}`);
  }
  const verdict = { pass: !problems.length, ran, warnings,
    summary: problems.length ? problems.map((p) => p.split('\n')[0]).join('; ') : `${ran.length} lint tool(s) passed` };
  writeLint(cfg, verdict);
  return Object.assign({ problems }, verdict);
}

function skipPush(cfg, reason) {
  writeLint(cfg, { pass: true, skipped: String(reason), ran: [], summary: `skipped: ${reason}` });
}

module.exports = {
  FILE, WHEN, FAIL, PLACEHOLDER, LINT_FILE,
  list, get, problem, forWhen, resolve, cwdFor, runOne, runFor, preCommit, runs, file, isOff,
  pushTools, lintVerdict, prePush, skipPush,
};
