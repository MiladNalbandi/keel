'use strict';
const fs = require('fs');
const path = require('path');
const { parseYaml, readJson, ensureGitignore, PER_MACHINE_IGNORES } = require('./util');
const config = require('./config');
const st = require('./state');

const TARGET = config.DEFAULTS.version;

/* -------------------------------------------------------------- registry */

// One entry per config version. A future upgrade is one entry here, plus the key in
// templates/config.yml and config.DEFAULTS, plus a bump of DEFAULTS.version.
//   keys  - paths this version introduces. The text comes from the rendered template, which
//           carries the explanatory comments for free; `line` is the fallback if it drops them.
//   state - mutate state.json in place. Return a note when it changed, null when already
//           current. Only needed for renames, semantic changes and *nested* additions: a new
//           top-level field self-heals through st.read's shallow merge over EMPTY.
const MIGRATIONS = [
  {
    to: 2,
    note: 'the RED loop author is configurable, and lanes are tracked in state',
    keys: [{ path: 'loops.red_author', line: 'red_author: main            # main | subagent' }],
    state: (s) => {
      if (s.lanes && typeof s.lanes === 'object' && !Array.isArray(s.lanes)) return null;
      s.lanes = {};
      return 'lanes: {}';
    },
  },
];

/* --------------------------------------------------------- yaml as lines */

// parseYaml drops every comment and there is no serializer, so a round trip would throw the
// user's file away. Everything below edits lines and leaves the rest byte for byte.

// Every "key:" line, mapped to a dotted path and the line span it owns.
function outline(text) {
  const lines = String(text).replace(/\n+$/, '').split('\n');
  const items = [];
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i]) || lines[i].trim() === '') continue;
    const m = lines[i].match(/^(\s*)([A-Za-z0-9_.-]+):(\s.*|)$/);
    if (!m) continue;                       // "- item" lines belong to their parent's span
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const it = { key: m[2], indent, start: i, end: i + 1,
      path: stack.map((s) => s.key).concat(m[2]).join('.') };
    items.push(it);
    stack.push(it);
  }
  for (let n = 0; n < items.length; n++) {
    let end = lines.length;
    for (let j = n + 1; j < items.length; j++) if (items[j].indent <= items[n].indent) { end = items[j].start; break; }
    while (end > items[n].start + 1 && lines[end - 1].trim() === '') end--;   // leave the blank separator
    items[n].end = end;
  }
  const by = {};
  for (const it of items) if (!by[it.path]) by[it.path] = it;
  return { lines, items, by };
}

function flatten(obj, prefix, into) {
  for (const k of Object.keys(obj || {})) {
    const p = prefix ? prefix + '.' + k : k;
    into[p] = true;
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, p, into);
  }
  return into;
}
function childIndent(doc, parent) {
  const kid = doc.items.find((x) => x.start > parent.start && x.start < parent.end && x.indent > parent.indent);
  return kid ? kid.indent : parent.indent + 2;
}
function reindent(snippet, shift) {
  if (!shift) return snippet.slice();
  return snippet.map((l) => {
    if (l.trim() === '') return l;
    if (shift > 0) return ' '.repeat(shift) + l;
    return l.slice(Math.min(-shift, l.match(/^ */)[0].length));
  });
}
// The user commented a key out deliberately: leave it be rather than add a duplicate.
function commentedOut(lines, key) {
  const re = new RegExp('^\\s*#\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:');
  return lines.some((l) => re.test(l));
}
function applyAdds(lines, adds) {
  const byAt = new Map();
  for (const a of adds) byAt.set(a.at, (byAt.get(a.at) || []).concat(a.lines));   // template order kept
  for (const at of Array.from(byAt.keys()).sort((x, y) => y - x)) lines.splice(at, 0, ...byAt.get(at));
  return lines;
}
function bumpVersion(lines, to) {
  const i = lines.findIndex((l) => /^version\s*:/.test(l));
  if (i >= 0) lines[i] = lines[i].replace(/^(version\s*:\s*)(\S+)/, '$1' + to);
  else lines.unshift('version: ' + to);
  return lines;
}
// Keep template order: land after the nearest preceding top-level key that exists here.
function topInsertAt(doc, tpl, p) {
  const tops = tpl.items.filter((i) => i.indent === 0).map((i) => i.path);
  for (let i = tops.indexOf(p) - 1; i >= 0; i--) if (doc.by[tops[i]]) return doc.by[tops[i]].end;
  return doc.lines.length;
}

/* ------------------------------------------------------------- the plan */

function planConfig(cfg) {
  const file = path.join(cfg.root, '.keel', 'config.yml');
  const text = fs.readFileSync(file, 'utf8');
  let user;
  try { user = parseYaml(text); } catch (e) { return { file, error: 'could not parse .keel/config.yml: ' + e.message }; }
  if (!user || !Object.keys(user).length) return { file, error: '.keel/config.yml has no readable keys' };
  const from = user.version === undefined ? 1 : Number(user.version);
  if (!Number.isFinite(from)) return { file, error: `.keel/config.yml has version: ${user.version}, which is not a number` };

  const have = flatten(user, '', {});
  const tpl = outline(require('./cli').renderConfig(config.detect(cfg.root), true));
  const doc = outline(text);

  // The template is the set of keys keel offers to write down; DEFAULTS is the wider set it
  // honours. Splicing in every DEFAULTS key would hand the user pages of internals to own.
  const wanted = tpl.items.map((it) => ({ path: it.path, key: it.key, indent: it.indent,
    snippet: tpl.lines.slice(it.start, it.end) }));
  for (const m of MIGRATIONS) {
    for (const k of m.keys || []) {
      if (tpl.by[k.path] || !k.line) continue;
      const depth = k.path.split('.').length - 1;
      wanted.push({ path: k.path, key: k.path.split('.').pop(), indent: depth * 2,
        snippet: [' '.repeat(depth * 2) + k.line] });
    }
  }

  const adds = [];
  const covered = [];
  let present = 0;
  for (const w of wanted) {
    if (have[w.path]) { present++; continue; }
    if (covered.some((c) => w.path.startsWith(c + '.'))) continue;      // arrives inside its ancestor
    const parentPath = w.path.split('.').slice(0, -1).join('.');
    if (!parentPath) {
      covered.push(w.path);
      adds.push({ path: w.path, why: 'new block', at: topInsertAt(doc, tpl, w.path), lines: [''].concat(w.snippet) });
      continue;
    }
    const parent = doc.by[parentPath];
    if (!parent) continue;                                             // arrives with its parent block
    if (commentedOut(doc.lines.slice(parent.start, parent.end), w.key)) { present++; continue; }
    covered.push(w.path);
    adds.push({ path: w.path, why: parentPath, at: parent.end,
      lines: reindent(w.snippet, childIndent(doc, parent) - w.indent) });
  }
  return { file, text, from, adds, present, user };
}

function planState(cfg, from) {
  const file = st.file(cfg);
  // Never create a state file in a repo that has not started a flow.
  if (!fs.existsSync(file)) return { file, changes: [], skip: 'not written yet' };
  const s = readJson(file, null);
  if (!s) return { file, error: 'could not parse .keel/state.json' };
  const next = JSON.parse(JSON.stringify(s));
  const changes = [];
  for (const m of MIGRATIONS) {
    if (m.to <= from || !m.state) continue;
    const note = m.state(next);
    if (note) changes.push(note);
  }
  return { file, changes, next };
}

function planGitignore(root) {
  const file = path.join(root, '.gitignore');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const seen = text.split('\n').map((l) => l.trim());
  return { file, missing: PER_MACHINE_IGNORES.filter((l) => !seen.includes(l)) };
}

function plan(cfg) {
  const c = planConfig(cfg);
  if (c.error) return { error: c.error };
  if (c.from > TARGET) return { from: c.from, target: TARGET, newer: true };
  const s = planState(cfg, c.from);
  if (s.error) return { error: s.error };
  const g = planGitignore(cfg.root);
  const applied = MIGRATIONS.filter((m) => m.to > c.from && m.to <= TARGET);
  const p = { from: c.from, target: TARGET, config: c, state: s, gitignore: g, applied };
  p.changed = !!(c.adds.length || s.changes.length || g.missing.length || c.from < TARGET);
  return p;
}

/* ------------------------------------------------------------ the writes */

function apply(cfg, p) {
  if (p.config.adds.length || p.from < p.target) {
    let lines = outline(p.config.text).lines;
    lines = applyAdds(lines, p.config.adds);
    lines = bumpVersion(lines, p.target);
    fs.writeFileSync(p.config.file, lines.join('\n') + '\n');
  }
  if (p.state.changes.length) fs.writeFileSync(p.state.file, JSON.stringify(p.state.next, null, 2) + '\n');
  if (p.gitignore.missing.length) ensureGitignore(cfg.root);
}

module.exports = { MIGRATIONS, TARGET, plan, apply, outline };
