'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

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
      frame.node[k].push(scalar(body.slice(2)));
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
function scalar(v) {
  const t = String(v).trim();
  if (/^\[.*\]$/.test(t)) {
    const inner = t.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((x) => scalar(x));
  }
  const s = t.replace(/^['"]|['"]$/g, '');
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

module.exports = { readJson, writeJson, readStdin, run, git, trim, fingerprint, parseYaml, findRepoRoot, matchGlob, negated, glob2re };
