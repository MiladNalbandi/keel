'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}

// Everything keel writes under .keel/ that belongs to one machine and one checkout rather than
// to the project. Anything here that is NOT ignored sits in `git status --porcelain` forever,
// and `keel preflight` refuses a tree that is not clean — so a verdict file keel writes by
// itself could permanently block the branch it was meant to inform. security.json and
// architecture.json did exactly that before 0.8.
const PER_MACHINE_IGNORES = ['.keel/state.json', '.keel/coverage.json', '.keel/coverage-baseline.json',
  '.keel/setup.json', '.keel/questions.json',
  '.keel/security.json', '.keel/architecture.json', '.keel/memory.json', '.keel/cover.json',
  '.keel/migrations-applied.json', '.keel/hunt.json', '.keel/hunt/', '.keel/archive/',
  '.keel/logs/', '.keel/format-queue.txt', '.keel/last-fast-check', '.keel/flaky.json',
  '.keel/pr-body.md', '.env.local'];

// Idempotent: appends only the lines that are missing, matching whole lines so a longer path is
// never mistaken for a shorter one already present. `keel init --write` cannot be re-run to pick
// up new entries — it overwrites a hand-edited .keel/config.yml — so every command that starts
// writing a new artifact repairs the block itself instead of telling the user to re-init.
function ensureGitignore(root, lines = PER_MACHINE_IGNORES) {
  const gi = path.join(root, '.gitignore');
  let current = '';
  try { current = fs.readFileSync(gi, 'utf8'); } catch (e) { current = ''; }
  const have = new Set(current.split('\n').map((l) => l.trim()));
  const added = lines.filter((l) => !have.has(l));
  if (!added.length) return [];
  let next = current;
  for (const l of added) next += (next.endsWith('\n') || next === '' ? '' : '\n') + l + '\n';
  fs.writeFileSync(gi, next);
  return added;
}

function run(cmd, opts = {}) {
  const r = spawnSync(cmd, {
    shell: true,
    cwd: opts.cwd || process.cwd(),
    encoding: 'utf8',
    env: Object.assign({}, process.env, opts.env || {}),
    timeout: opts.timeout || 600000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: r.status === null ? 1 : r.status,
    out: (r.stdout || '') + (r.stderr || ''),
  };
}
// The async twin of run(), for the one place that needs concurrency: the run ladder, where
// Gradle, npm and a Docker pull are independent and used to queue behind each other. Same
// return shape as run(), so callers can be switched over without changing how they read it.
function runAsync(cmd, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      cwd: opts.cwd || process.cwd(),
      env: Object.assign({}, process.env, opts.env || {}),
    });
    let out = '';
    const cap = 32 * 1024 * 1024;
    const add = (chunk) => { if (out.length < cap) out += String(chunk); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let done = false;
    const finish = (code) => { if (done) return; done = true; resolve({ code, out }); };
    const timer = setTimeout(() => {
      // Match run()'s behaviour: a timeout is a failure, not a hang.
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      finish(1);
    }, opts.timeout || 600000);
    child.on('error', () => { clearTimeout(timer); finish(1); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === null ? 1 : code); });
  });
}

function git(args, cwd) { return run('git ' + args, { cwd }); }

// Keep only the lines that explain a failure, capped.
function trim(output, max = 25) {
  const lines = String(output).split('\n');
  const interesting = lines.filter((l) =>
    /error|ERROR|FAIL|failed|expected|Exception|AssertionError|✗|×/.test(l) && l.trim() !== ''
  );
  const chosen = (interesting.length ? interesting : lines.filter((l) => l.trim() !== '')).slice(-max);
  return chosen.join('\n');
}

// A stable fingerprint of a failure, so repeats are detectable.
function fingerprint(output) {
  const norm = trim(output, 8)
    .replace(/\d+/g, 'N')
    .replace(/\/[^\s:]+/g, 'P')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 10);
}

// Minimal YAML reader: nested maps, scalars, inline and block lists. Enough for .keel/config.yml.
// `run()` folds stderr into `out`, so an unchecked git read outside a repository returns
// "fatal: not a git repository..." — which then got written verbatim into docs/RUNNING.md and
// .keel/architecture.json. Anything destined for an artifact must come through here.
// A module directory as a path PREFIX. A single-module project sets backend.dir to '.',
// and joining or comparing that literally yields './' prefixes which match nothing a git
// path list ever contains — so every caller normalises the root to '' through here.
function moduleDir(dir) {
  const d = String(dir === undefined || dir === null ? '' : dir).trim();
  return (d === '' || d === '.' || d === './') ? '' : d.replace(/\/+$/, '');
}

// The same directory as something you can join onto cfg.root.
function modulePath(root, dir) {
  const d = moduleDir(dir);
  return d ? require('path').join(root, d) : root;
}

function gitOut(args, cwd, fallback = '') {
  const r = git(args, cwd);
  return r.code === 0 ? r.out.trim() : fallback;
}

function parseYaml(text) {
  const lines = String(text).split('\n')
    .filter((l) => l.trim() !== '' && !/^\s*#/.test(l))
    .map((l) => l.replace(/\t/g, '  '));
  const root = {};
  const stack = [{ indent: -1, node: root, lastKey: null }];
  for (const raw of lines) {
    const indent = raw.match(/^ */)[0].length;
    const body = raw.trim().replace(/\s+#\s.*$/, '');
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    let frame = stack[stack.length - 1];

    if (body.startsWith('- ')) {
      if (frame.lastKey === null && stack.length > 1) { stack.pop(); frame = stack[stack.length - 1]; }
      const k = frame.lastKey;
      if (k === null) continue;
      if (!Array.isArray(frame.node[k])) frame.node[k] = [];
      const item = body.slice(2).trim();
      // A list of maps — `- name: x` with deeper lines belonging to the same item. Without
      // this, boundaries.rules and a stack pack's layers were flattened into strings, and
      // keys from one item leaked into the parent.
      // A colon only opens a mapping in YAML when followed by whitespace or end of line, and
      // a quoted item is always a scalar. Without both rules `- 'cache:/root/.gradle'` parsed
      // as a map and `- RUN curl https://x` became [object Object].
      const pair = (item.startsWith('{') || /^['"]/.test(item))
        ? null
        : item.match(/^([^:{[\s]+):(?:\s+(.*)|$)/);
      if (!pair) { frame.node[k].push(scalar(item)); continue; }
      const obj = {};
      const ik = pair[1].trim();
      obj[ik] = (pair[2] === undefined || pair[2] === '') ? {} : scalar(pair[2]);
      frame.node[k].push(obj);
      stack.push({ indent, node: obj, lastKey: ik });
      continue;
    }

    const m = body.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2];
    if (value === '') {
      frame.node[key] = {};
      frame.lastKey = key;
      stack.push({ indent, node: frame.node[key], lastKey: null });
    } else {
      frame.node[key] = scalar(value);
      frame.lastKey = key;
    }
  }
  return root;
}
// Split on commas that are not inside brackets, braces or quotes, so a nested list or map
// survives. The old naive split(',') broke on both.
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of String(s)) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function scalar(v) {
  const t = String(v).trim();
  if (/^\{.*\}$/.test(t)) {
    // Flow map: { name: x, deny_imports: ['a'] }
    const obj = {};
    for (const part of splitTopLevel(t.slice(1, -1))) {
      const m = part.match(/^\s*([^:]+):\s*(.*)$/);
      if (m) obj[m[1].trim().replace(/^['"]|['"]$/g, '')] = scalar(m[2]);
    }
    return obj;
  }
  if (/^\[.*\]$/.test(t)) {
    const inner = t.slice(1, -1).trim();
    return inner === '' ? [] : splitTopLevel(inner).map((x) => scalar(x));
  }
  // Strip quotes only when they are a matching pair. The old
  // `t.replace(/^['"]|['"]$/g, '')` stripped a leading or a trailing quote
  // independently, so a value merely ending in a quote — `--tests '*{AC}*'` —
  // silently lost it, corrupting api_test_ac and api_test_pkg.
  const quoted = t.length > 1 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0];
  const s = quoted ? t.slice(1, -1) : t;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s !== '' && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function findRepoRoot(start) {
  let dir = start || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  dir = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.keel', 'config.yml')) || fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return process.cwd();
    dir = up;
  }
}

function glob2re(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
function matchGlob(file, patterns) {
  const f = String(file).replace(/^\.\//, '');
  return (patterns || []).some((p) => {
    const neg = String(p).startsWith('!');
    const pat = neg ? String(p).slice(1) : String(p);
    const hit = glob2re(pat).test(f) || glob2re(pat).test('/' + f);
    return neg ? false : hit;
  });
}
function negated(file, patterns) {
  const f = String(file).replace(/^\.\//, '');
  return (patterns || []).some((p) => String(p).startsWith('!') && glob2re(String(p).slice(1)).test(f));
}

module.exports = { readJson, writeJson, readStdin, run, runAsync, git, gitOut, moduleDir, modulePath, trim, fingerprint, parseYaml, findRepoRoot, matchGlob, negated, glob2re, PER_MACHINE_IGNORES, ensureGitignore };
