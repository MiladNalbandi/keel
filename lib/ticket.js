'use strict';
// Review someone's code against a ticket and the team's definition of done.
//
// Everything that needs no judgement happens here, without a model, in one call (`prep`): the
// diff, the checklist (the ticket's own "Definition of done" / "Acceptance" list plus
// .keel/dod.md), dropping noise (lockfiles, generated and vendored files), ranking files by risk,
// deciding the items a script can decide (a secret, a disabled test, debug output, no database
// change), routing each remaining item to the files that bear on it, and planning how many agents
// to start. It prints all of that as one compact pack and writes no working files: agents read the
// code with git, and their answer comes back on stdin through `record`.
//
// The only thing on disk is the index, .keel/reviews.jsonl — append-only, one line per state change,
// the newest line per id wins. It sits at the top of .keel/ because that is where the dashboard
// watches. Reviews made before 0.74.0 live in .keel/reviews.json and are still read.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run, git, gitOut, readJson, modulePath, ensureGitignore } = require('./util');

const LOG = path.join('.keel', 'reviews.jsonl');
const LEGACY = path.join('.keel', 'reviews.json');
const DOD = path.join('.keel', 'dod.md');
const KEEP = 20;              // reviews the index keeps when it compacts itself
const ONE_AGENT_LINES = 400;  // at or under this many changed lines, one agent does every job
const BUG_GROUP_LINES = 800;  // a larger diff splits the bug job into groups of about this size
const MAX_BUG_AGENTS = 2;

/* -------------------------------------------------------------------- index */

function logFile(cfg) { return path.join(cfg.root, LOG); }

function readLog(cfg) {
  let raw = '';
  try { raw = fs.readFileSync(logFile(cfg), 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch (e) { /* a torn line is skipped, not fatal */ }
  }
  return out;
}

// Newest first, one entry per id: the last line written for an id is its current state.
function list(cfg) {
  const byId = new Map();
  for (const r of (readJson(path.join(cfg.root, LEGACY), { reviews: [] }).reviews || []).slice().reverse()) byId.set(r.id, r);
  for (const r of readLog(cfg)) { byId.delete(r.id); byId.set(r.id, r); }
  return Array.from(byId.values()).reverse();
}
function get(cfg, id) { return list(cfg).find((r) => r.id === id) || null; }

function append(cfg, entry) {
  const f = logFile(cfg);
  // The review is the reviewer's, not the author's: keep it out of the repository.
  try { ensureGitignore(cfg.root); } catch (e) { /* not fatal */ }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(entry) + '\n');
  // Compact now and then, so an index nobody prunes stays small.
  try {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    if (lines.length > KEEP * 4) {
      const keep = list(cfg).filter((r) => readLog(cfg).some((x) => x.id === r.id)).slice(0, KEEP).reverse();
      fs.writeFileSync(f + '.tmp', keep.map((r) => JSON.stringify(r)).join('\n') + '\n');
      fs.renameSync(f + '.tmp', f);
    }
  } catch (e) { /* compaction is housekeeping */ }
}

function nextId(cfg) {
  const nums = list(cfg).map((r) => Number(String(r.id).replace(/^TR-/, ''))).filter((n) => !isNaN(n));
  return 'TR-' + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0');
}

/* ---------------------------------------------------------------- checklist */

// A checklist line: `- [ ] text`, `- [x] text`, `* text`, `1. text`.
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;
// Headings that introduce the ticket's own done criteria.
const DONE_HEADING = /^\s*(?:#{1,6}\s*|\*\*)?\s*(definition of done|dod|acceptance criteria|acceptance|done when|done criteria)\b/i;

function itemsIn(lines) {
  return lines.map((l) => (l.match(ITEM) || [])[1]).filter(Boolean)
    .map((t) => t.replace(/\*\*/g, '').trim()).filter((t) => t.length > 2);
}

// Bullets under the first "Definition of done" / "Acceptance criteria" heading, up to the next
// heading. A ticket with no such heading contributes nothing — and the pack says so, rather than
// inventing criteria from the description.
function ticketItems(text) {
  const lines = String(text).split('\n');
  const at = lines.findIndex((l) => DONE_HEADING.test(l));
  if (at === -1) return [];
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^\s*#{1,6}\s/.test(lines[i]) || /^\s*\*\*[^*]+\*\*\s*:?\s*$/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return itemsIn(out);
}

function teamItems(cfg) {
  const f = path.join(cfg.root, DOD);
  if (!fs.existsSync(f)) return null;
  return itemsIn(fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*</.test(l)));
}

function starterDod(cfg) {
  const f = path.join(cfg.root, DOD);
  if (fs.existsSync(f)) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'templates', 'dod.md'), f);
  return true;
}

/* --------------------------------------------------------------------- diff */

// One `gh` call for the metadata, one fetch for the head, and the diff from local git — the agents
// then read the same ref, so nothing is fetched twice. `gh pr diff` is only the fallback for a
// head that cannot be fetched (a fork the remote does not mirror).
function prDiff(cfg, pr) {
  const n = Number(pr);
  const meta = run(`gh pr view ${n} --json title,url,headRefName,baseRefName,author,state,isDraft`, { cwd: cfg.root, timeout: 60000 });
  if (meta.code !== 0) return { error: `gh could not read PR ${n}: ${String(meta.out).trim().split('\n')[0]}` };
  let m = {};
  try { m = JSON.parse(meta.out); } catch (e) { m = {}; }
  const source = { pr: n, url: m.url || null, title: m.title || null, head: m.headRefName || null,
    base: m.baseRefName || null, author: (m.author || {}).login || null, state: m.state || null, draft: !!m.isDraft };
  const local = `refs/keel/pr-${n}`;
  const f = git(`fetch -q origin pull/${n}/head:${local} ${source.base ? `${source.base}:refs/keel/pr-${n}-base` : ''}`.trim(), cfg.root);
  if (f.code === 0 && source.base) {
    const d = git(`diff --no-color refs/keel/pr-${n}-base...${local}`, cfg.root);
    if (d.code === 0) return { patch: d.out, source: Object.assign(source, { ref: local, baseRef: `refs/keel/pr-${n}-base` }) };
  }
  const d = run(`gh pr diff ${n} --color=never`, { cwd: cfg.root, timeout: 120000 });
  if (d.code !== 0) return { error: `gh could not fetch the diff of PR ${n}: ${String(d.out).trim().split('\n')[0]}` };
  return { patch: d.out, source: Object.assign(source, { ref: null, baseRef: null }) };
}

function branchDiff(cfg, branch, base) {
  const b = base || cfg.base_branch || 'main';
  // Never a checkout: the user's working tree stays as it is. A branch that is only on the remote
  // is fetched first and reviewed as origin/<branch>.
  let ref = branch;
  if (!gitOut(`rev-parse --verify --quiet ${ref}`, cfg.root, null)) {
    git(`fetch -q origin ${branch}`, cfg.root);
    ref = `origin/${branch}`;
    if (!gitOut(`rev-parse --verify --quiet ${ref}`, cfg.root, null)) return { error: `no branch "${branch}" here or on origin` };
  }
  const d = git(`diff --no-color ${b}...${ref}`, cfg.root);
  if (d.code !== 0) return { error: `git diff ${b}...${ref} failed: ${String(d.out).trim().split('\n')[0]}` };
  return { patch: d.out, source: { branch, ref, base: b, baseRef: b, head: gitOut(`rev-parse --short ${ref}`, cfg.root, null) } };
}

// Per-file sections of a unified diff, with the added lines and their new line numbers kept, so
// the checks below can cite file:line without re-reading anything.
function splitFiles(patch) {
  const parts = String(patch).split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '));
  return parts.map((p) => {
    const m = p.match(/^diff --git a\/(\S+) b\/(\S+)/);
    const lines = p.split('\n');
    const addedLines = [];
    let at = 0;
    for (const l of lines) {
      const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (h) { at = Number(h[1]); continue; }
      if (l.startsWith('+++') || l.startsWith('---')) continue;
      if (l.startsWith('+')) { addedLines.push({ n: at, text: l.slice(1) }); at++; } else if (!l.startsWith('-')) at++;
    }
    return { file: m ? m[2] : '?', text: p, addedLines,
      added: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
      removed: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
      lines: lines.length };
  });
}

/* ------------------------------------------------------------ noise and risk */

const NOISE = [
  [/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|go\.sum|gradle\.lockfile|[^/]+\.lockfile)$/, 'lockfile'],
  [/\.min\.(js|css)$|\.map$/, 'minified'],
  [/(^|\/)__snapshots__\/|\.snap$/, 'snapshot'],
  [/(^|\/)(vendor|node_modules|dist|build|out|target|\.gradle)\//, 'vendored or built'],
];

function noiseOf(cfg, file) {
  for (const [re, why] of NOISE) if (re.test(file)) return why;
  try { if (require('./guards').classify(cfg, file) === 'generated') return 'generated'; } catch (e) { /* unclassified */ }
  return null;
}

const AUTH = /(auth|security|permission|access|login|session|token|password|role|acl|guard|policy)/i;
const DOC = /\.(md|mdx|txt|rst|adoc)$|(^|\/)docs?\//i;

// Lower ranks first. A migration or the contract is where a mistake is hardest to take back.
function riskOf(cfg, file) {
  let bucket = 'other';
  try { bucket = require('./guards').classify(cfg, file); } catch (e) { bucket = 'other'; }
  if (DOC.test(file)) return { bucket: 'docs', rank: 7 };
  if (bucket === 'protected-env') return { bucket, rank: 0 };
  if (bucket === 'migration') return { bucket, rank: 1 };
  if (bucket === 'contract') return { bucket, rank: 2 };
  const test = /-test$/.test(bucket) || ['e2e', 'smoke'].includes(bucket);
  if (!test && AUTH.test(file)) return { bucket: bucket === 'other' ? 'auth' : `${bucket}, auth`, rank: 2 };
  if (['api-main', 'web-src'].includes(bucket)) return { bucket, rank: 3 };
  if (bucket === 'other') return { bucket, rank: 4 };
  if (test) return { bucket, rank: 5 };
  return { bucket, rank: 6 };
}

/* --------------------------------------------------------------- auto-checks */

const DEBUG = /\b(console\.(log|debug)\(|System\.out\.print|println\(|printStackTrace\(\)|var_dump\(|\bdd\(|debugger\b|pdb\.set_trace\(|breakpoint\(\))|\b(TODO|FIXME|XXX)\b/;
const SCHEMA_CODE = /(entity|entities|model|models|schema|repository|dao|table)/i;

// What a script can see in the added lines, with file:line evidence. It only ever proves a
// problem — "no secret found" is not "no secret", so a clean check hands the item to the model
// with a hint rather than marking it met. The one exception is a database item when the diff has
// no database change at all: there is nothing to judge.
function autoChecks(cfg, files) {
  const secrets = [];
  const disabled = [];
  const debug = [];
  for (const f of files) {
    const isTest = riskOf(cfg, f.file).rank === 5;
    for (const hit of require('./secrets').scan(f.addedLines.map((l) => l.text).join('\n'))) {
      const l = f.addedLines[hit.line - 1];
      secrets.push(`${f.file}:${l ? l.n : '?'} ${hit.why}`);
    }
    for (const marker of require('./verify').findDisabledMarkers(f.addedLines.map((l) => '+' + l.text).join('\n'))) {
      const l = f.addedLines.find((x) => x.text.includes(marker.replace(/\($/, '')));
      disabled.push(`${f.file}:${l ? l.n : '?'} ${marker}`);
    }
    if (!isTest) for (const l of f.addedLines) if (DEBUG.test(l.text)) debug.push(`${f.file}:${l.n} ${l.text.trim().slice(0, 60)}`);
  }
  const migrations = files.filter((f) => riskOf(cfg, f.file).bucket === 'migration').map((f) => f.file);
  const schemaish = files.filter((f) => SCHEMA_CODE.test(f.file) && riskOf(cfg, f.file).rank <= 4).map((f) => f.file);
  return { secrets, disabled, debug, migrations, dbChange: migrations.length > 0 || schemaish.length > 0 };
}

const CHECK_FOR = [
  [/secret|credential|password|api key|token/i, 'secrets', 'no secret pattern in the added lines'],
  [/(disabled|skipped|weakened|ignored).*test|test.*(disabled|skipped|weakened|ignored)/i, 'disabled', 'no disable or skip marker in the added lines'],
  [/dead code|commented-out|debug|todo/i, 'debug', 'no debug output or TODO in the added lines'],
];
// What the author should do about a problem the script proved — the review is a to-do list, not
// only a verdict.
const TODO_FOR = {
  secrets: 'remove it from the code, rotate it (it is now in git history), and read it from the environment or the secret store',
  disabled: 'turn the test back on, or delete it and say why in the PR',
  debug: 'remove the debug output, and finish or delete the TODO',
};

function applyChecks(items, auto) {
  for (const it of items) {
    for (const [re, key, clean] of CHECK_FOR) {
      if (!re.test(it.text)) continue;
      if (auto[key].length) {
        it.verdict = 'not-met';
        it.evidence = auto[key].slice(0, 3).join('; ') + (auto[key].length > 3 ? ` (+${auto[key].length - 3} more)` : '');
        it.todo = TODO_FOR[key];
        it.auto = true;
      } else it.hint = clean;
    }
    if (!it.auto && /migration|database|schema/i.test(it.text) && !auto.dbChange) {
      it.verdict = 'met'; it.evidence = 'no database change in the diff'; it.auto = true;
    }
  }
}

/* ------------------------------------------------------------------ routing */

const STOP = new Set(['the', 'and', 'with', 'that', 'this', 'from', 'when', 'have', 'has', 'are', 'not', 'for', 'every',
  'each', 'any', 'all', 'new', 'changed', 'code', 'should', 'must', 'into', 'than', 'only', 'where', 'there', 'their', 'them', 'they']);

function words(s) {
  return String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w))
    .map((w) => w.replace(/(ies|es|s)$/, ''));
}

// The files most likely to bear on an item: path words that match the item's words, plus the
// obvious kinds (tests for a test item, migrations for a database item, auth paths for an auth
// item). Nothing matching means the riskiest files, never nothing.
function route(item, ranked) {
  const iw = new Set(words(item.text));
  const scored = ranked.map((f, i) => {
    let s = words(f.file).filter((w) => iw.has(w)).length * 3;
    if (/test/i.test(item.text) && f.rank === 5) s += 2;
    if (/migration|database|schema/i.test(item.text) && f.bucket === 'migration') s += 3;
    if (/auth|permission|access/i.test(item.text) && /auth/.test(f.bucket)) s += 3;
    if (/doc|readme|text/i.test(item.text) && f.bucket === 'docs') s += 2;
    return { i, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 6).map((x) => x.i + 1);
  return scored.length ? scored : ranked.slice(0, 4).map((_, i) => i + 1);
}

/* -------------------------------------------------------------- language */

// The rules for each language in the change, from keel:sonar's per-language pages — only the bold
// headline of each bullet, so the pack carries a checklist and not the page.
const STANDARDS = ['CONTRIBUTING.md', 'CODING_STANDARDS.md', 'STYLEGUIDE.md', 'STYLE_GUIDE.md', 'docs/CONTRIBUTING.md',
  'docs/coding-standards.md', 'docs/STYLEGUIDE.md', '.github/CONTRIBUTING.md', 'docs/knowledge/conventions.md'];
const LANG = [[/\.(kt|kts|java)$/, 'kotlin'], [/\.(ts|tsx|js|jsx|mjs|cjs)$/, 'typescript'], [/\.php$/, 'php'], [/\.py$/, 'python']];
function languageRules(ranked) {
  const langs = new Set();
  for (const f of ranked) for (const [re, l] of LANG) if (re.test(f.file)) langs.add(l);
  const out = {};
  for (const l of langs) {
    try {
      const text = fs.readFileSync(path.join(__dirname, '..', 'skills', 'sonar', 'references', `${l}.md`), 'utf8');
      out[l] = text.split('\n').map((x) => (x.match(/^- \*\*(.+?)\*\*/) || [])[1]).filter(Boolean).slice(0, 12);
    } catch (e) { /* no page for it */ }
  }
  return out;
}

/* --------------------------------------------------------------------- plan */

function plan(ranked, items) {
  const lines = ranked.reduce((a, f) => a + f.added + f.removed, 0);
  const open = items.filter((it) => !it.auto);
  if (lines <= ONE_AGENT_LINES) {
    return [{ job: 'all', items: open.map((it) => it.id), files: ranked.map((_, i) => i + 1) }];
  }
  const jobs = [];
  const t = open.filter((it) => it.from === 'ticket');
  const d = open.filter((it) => it.from === 'team');
  if (t.length) jobs.push({ job: 'ticket', items: t.map((it) => it.id), files: ranked.map((_, i) => i + 1) });
  if (d.length) jobs.push({ job: 'team', items: d.map((it) => it.id), files: ranked.map((_, i) => i + 1) });
  // Bugs: riskiest files first, in groups, so a large diff is read by two agents at once rather
  // than by one agent for twice as long. Docs carry no bugs worth an agent.
  const code = ranked.map((f, i) => ({ f, i: i + 1 })).filter((x) => x.f.bucket !== 'docs');
  const groups = [[]];
  let n = 0;
  for (const x of code) {
    if (groups[groups.length - 1].length && n + x.f.added + x.f.removed > BUG_GROUP_LINES && groups.length < MAX_BUG_AGENTS) { groups.push([]); n = 0; }
    groups[groups.length - 1].push(x.i);
    n += x.f.added + x.f.removed;
  }
  for (const g of groups) if (g.length) jobs.push({ job: 'bugs', items: [], files: g });
  // Quality: the riskiest code files, compared with their neighbours and the language rules.
  if (code.length) jobs.push({ job: 'quality', items: [], files: code.slice(0, 15).map((x) => x.i) });
  return jobs;
}

/* --------------------------------------------------------------------- prep */

function prep(cfg, opts) {
  const usage = 'usage: keel ticket prep --ticket <file | -> (--pr <n> | --branch <name>) [--base <ref>] [--force]';
  if (!opts.ticket) return { ok: false, out: usage };
  if (!!opts.pr === !!opts.branch) return { ok: false, out: 'give exactly one of --pr <n> or --branch <name>.' };
  let ticket;
  if (opts.ticket === '-' || opts.ticket === true) {
    ticket = opts.stdin != null ? String(opts.stdin) : '';
    if (!ticket.trim()) return { ok: false, out: 'the ticket on stdin is empty. Pipe it in: keel ticket prep --ticket - … <<\'EOF\'' };
  } else {
    const p = path.resolve(cfg.root, String(opts.ticket));
    if (!fs.existsSync(p)) return { ok: false, out: `no ticket file at ${opts.ticket}` };
    ticket = fs.readFileSync(p, 'utf8');
  }

  const d = opts.pr ? prDiff(cfg, opts.pr) : branchDiff(cfg, String(opts.branch), opts.base);
  if (d.error) return { ok: false, out: d.error };
  const src = d.source;

  // The gate: stop before a model is paid for anything.
  if (!opts.force && src.state && src.state !== 'OPEN') return { ok: false, out: `PR #${src.pr} is ${src.state.toLowerCase()} — nothing to review. --force reviews it anyway.` };
  if (!opts.force && src.draft) return { ok: false, out: `PR #${src.pr} is a draft — review it when it is ready. --force reviews it anyway.` };
  const all = splitFiles(d.patch);
  if (!all.length) return { ok: false, out: 'the diff is empty — nothing to review.' };
  const skipped = [];
  const kept = [];
  for (const f of all) {
    const why = noiseOf(cfg, f.file);
    if (why) skipped.push({ file: f.file, why, lines: f.added + f.removed }); else kept.push(f);
  }
  if (!kept.length) return { ok: false, out: `only ${skipped.map((s) => s.why).filter((v, i, a) => a.indexOf(v) === i).join(', ')} files changed — nothing to review.` };
  const ranked = kept.map((f) => Object.assign(f, riskOf(cfg, f.file)))
    .sort((a, b) => a.rank - b.rank || (b.added + b.removed) - (a.added + a.removed));
  if (!opts.force && ranked.every((f) => f.bucket === 'docs')) return { ok: false, out: 'only documentation changed — a code review has nothing to judge. --force reviews it anyway.' };

  const created = starterDod(cfg);
  const fromTicket = ticketItems(ticket);
  const team = teamItems(cfg) || [];
  const items = [
    ...fromTicket.map((text, i) => ({ id: `T${i + 1}`, from: 'ticket', text })),
    ...team.map((text, i) => ({ id: `D${i + 1}`, from: 'team', text })),
  ];
  const auto = autoChecks(cfg, ranked);
  applyChecks(items, auto);
  for (const it of items) if (!it.auto) it.files = route(it, ranked);
  const jobs = plan(ranked, items);
  // For the quality job: one existing sibling per changed code file, read at the base, so "the
  // patterns of this codebase" is a file to compare with rather than the model's idea of them.
  if (src.baseRef) {
    for (const f of ranked) {
      if (f.bucket === 'docs') continue;
      const dir = path.dirname(f.file);
      const ext = path.extname(f.file);
      const sib = (gitOut(`ls-tree --name-only ${src.baseRef} ${dir === '.' ? '' : dir + '/'}`, cfg.root, '') || '')
        .split('\n').map((x) => x.trim()).filter((x) => x && x !== f.file && path.extname(x) === ext && !ranked.some((r) => r.file === x));
      if (sib.length) f.like = sib[0];
    }
  }
  const rules = languageRules(ranked);
  // The repo's own written standards, read at the base: they override every baseline rule.
  const standards = src.baseRef ? STANDARDS.filter((f) => git(`cat-file -e ${src.baseRef}:${f}`, cfg.root).code === 0) : [];

  const id = nextId(cfg);
  const title = src.title || (ticket.split('\n').find((l) => l.trim()) || id).replace(/^#+\s*/, '').trim().slice(0, 100);
  const entry = {
    id, title, status: 'running', started: new Date().toISOString(), finished: null,
    source: { pr: src.pr || null, branch: src.branch || null, base: src.base || null, ref: src.ref || null,
      baseRef: src.baseRef || null, url: src.url || null, author: src.author || null, head: src.head || null },
    files: ranked.length, added: ranked.reduce((a, f) => a + f.added, 0), removed: ranked.reduce((a, f) => a + f.removed, 0),
    skipped: skipped.length, agents: jobs.length, verdict: null, summary: null,
    changed: ranked.map((f) => f.file),
    items: items.map((it) => ({ id: it.id, from: it.from, text: it.text, verdict: it.verdict || null, evidence: it.evidence || null, todo: it.todo || null, auto: !!it.auto })),
    findings: [],
  };
  append(cfg, entry);
  return { ok: true, id, entry, ranked, skipped, items, jobs, auto, created, fromTicket: fromTicket.length,
    team: team.length, ticket, rules, standards };
}

// The pack: everything an agent needs, once, in about a hundred lines. Agents get their slice of
// it in the prompt and read code with git, so nothing is written for them to read back.
function renderPack(r) {
  const e = r.entry;
  const s = e.source;
  const range = s.baseRef && s.ref ? `${s.baseRef}...${s.ref}` : null;
  const out = [];
  out.push(`${e.id}  ${e.title}`);
  out.push(`code     ${s.pr ? `PR #${s.pr}${s.author ? ` by ${s.author}` : ''}` : `${s.branch} vs ${s.base}`} — ${e.files} file(s) to review, +${e.added} −${e.removed}`);
  if (r.skipped.length) out.push(`skipped  ${r.skipped.length} file(s): ${r.skipped.slice(0, 4).map((x) => `${x.file} (${x.why})`).join(', ')}${r.skipped.length > 4 ? ', …' : ''}`);
  out.push(range ? `read     git diff ${range} -- <file>   ·   git show ${s.ref}:<file> | sed -n 'a,bp'`
    : 'read     the PR head could not be fetched: gh pr diff ' + s.pr + ' is the only source; judge from the patch');
  out.push(`checklist ${r.fromTicket} from the ticket, ${r.team} from .keel/dod.md${r.created ? ' (starter created — edit it once for your team)' : ''}`);
  if (!r.fromTicket) out.push('note     the ticket has no "Definition of done" / "Acceptance criteria" list — only the team items are judged');
  const tl = String(r.ticket).trim().split('\n');
  out.push('', `ticket${tl.length > 25 ? ` (first 25 of ${tl.length} lines)` : ''}`);
  for (const l of tl.slice(0, 25)) out.push('  ' + l.slice(0, 160));
  out.push('', 'files, riskiest first');
  r.ranked.forEach((f, i) => out.push(`  ${String(i + 1).padStart(2)} ${f.file}  [${f.bucket}] +${f.added} −${f.removed}${f.like ? `   like: ${f.like}` : ''}`));
  if ((r.standards || []).length) out.push('', `standards the repo documents (they win) — git show ${s.baseRef}:<file>: ${r.standards.join(', ')}`);
  const langs = Object.keys(r.rules || {});
  if (langs.length) {
    out.push('', 'quality rules (keel:sonar), with the `like:` file as the codebase\'s own pattern' + (s.baseRef ? ` — git show ${s.baseRef}:<like>` : ''));
    for (const l of langs) out.push(`  ${l}: ${r.rules[l].join(' · ')}`);
  }
  out.push('', 'items');
  for (const it of r.items) {
    const tag = it.auto ? `AUTO ${it.verdict}: ${it.evidence}` : `files ${it.files.join(',')}${it.hint ? `  (script: ${it.hint})` : ''}`;
    out.push(`  ${it.id.padEnd(3)} ${it.text.slice(0, 90)}`);
    out.push(`      ${tag}`);
  }
  out.push('', r.jobs.length === 1
    ? `plan     one agent, every job — ${e.added + e.removed} changed line(s)`
    : `plan     ${r.jobs.length} agents in parallel:`);
  if (r.jobs.length > 1) r.jobs.forEach((j, i) => out.push(`  ${i + 1}. ${j.job.padEnd(6)} ${j.items.length ? 'items ' + j.items.join(',') + '  ' : ''}files ${j.files.join(',')}`));
  out.push('', `build    keel ticket build ${e.id}   (no model: compile + lint in a throwaway worktree — start it now, in the background)`);
  out.push(`then     keel ticket record ${e.id} <<'EOF'   (one line per item and finding — see the skill)`);
  return out.join('\n');
}

/* -------------------------------------------------------------- build check */

// Syntax and lint, by running the project's own tools on the reviewed code — no model. The code
// is checked out into a throwaway git worktree, never into the user's tree, and the dependency
// folders already installed here (node_modules, vendor) are linked in so the tools can run.
// Only messages that name a changed file count: a linter run over a whole project also reports
// problems the change did not make, and blaming the author for those is the noise this avoids.
function issuesIn(output, files) {
  const out = [];
  const lines = String(output).split('\n');
  let current = null;   // eslint's "stylish" format: a file path line, then indented "12:5 error …" lines
  for (const raw of lines) {
    const l = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const hit = files.find((f) => l.includes(f) || (path.basename(f).length > 6 && l.includes('/' + path.basename(f))));
    if (hit && /^\s*\S+\s*$/.test(l)) { current = hit; continue; }
    if (hit) {
      const m = l.match(new RegExp(hit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\D{0,3}(\\d+)')) || l.match(/[:(](\d+)[,:)]/);
      out.push({ file: hit, line: m ? Number(m[1]) : null, text: l.trim().slice(0, 200) });
    } else if (current) {
      const m = l.match(/^\s+(\d+):\d+\s+(.*)$/);
      if (m) out.push({ file: current, line: Number(m[1]), text: m[2].trim().slice(0, 200) });
      else if (!l.trim()) current = null;
    }
    if (out.length >= 15) break;
  }
  return out;
}

function build(cfg, id, opts = {}) {
  const prev = get(cfg, id);
  if (!prev) return { ok: false, out: `no review ${id}.` };
  const s = prev.source || {};
  const result = { at: new Date().toISOString(), checks: [], note: null };
  const save = () => {
    const latest = get(cfg, id) || prev;
    const entry = Object.assign({}, latest, { quality: Object.assign({}, latest.quality || {}, { build: result }) });
    if (entry.status === 'finished') Object.assign(entry, verdictOf(entry));
    append(cfg, entry);
    return { ok: true, entry, result };
  };
  if (!s.ref) { result.note = 'the reviewed code is not available locally (the PR head could not be fetched) — no build check'; return save(); }

  const files = (prev.changed || []).filter(Boolean);
  const wt = path.join(os.tmpdir(), `keel-review-${id}-${process.pid}`);
  const add = git(`worktree add --detach -q ${JSON.stringify(wt)} ${s.ref}`, cfg.root);
  if (add.code !== 0) { result.note = `could not check the code out into a worktree: ${String(add.out).trim().split('\n')[0]}`; return save(); }
  try {
    for (const rel of ['node_modules', 'vendor', path.join(cfg.frontend.dir || '', 'node_modules'),
      path.join(cfg.backend.dir || '', 'vendor'), path.join(cfg.backend.dir || '', 'node_modules')]) {
      const from = path.join(cfg.root, rel);
      const to = path.join(wt, rel);
      try { if (fs.existsSync(from) && !fs.existsSync(to)) fs.symlinkSync(from, to, 'dir'); } catch (e) { /* best effort */ }
    }
    const steps = [];
    const touched = (dir) => dir && files.some((f) => f === dir || f.startsWith(String(dir).replace(/\/$/, '') + '/'));
    const cmd = (k) => String((cfg.commands || {})[k] || '').trim();
    if (cmd('api_compile') && (touched(cfg.backend.dir) || !cfg.backend.dir)) steps.push({ name: 'compile (api)', kind: 'compile', cmd: cmd('api_compile'), cwd: modulePath(wt, cfg.backend.dir || '.') });
    if (cmd('web_typecheck') && touched(cfg.frontend.dir)) steps.push({ name: 'typecheck (web)', kind: 'compile', cmd: cmd('web_typecheck'), cwd: modulePath(wt, cfg.frontend.dir) });
    const tools = require('./tools');
    const wcfg = Object.assign({}, cfg, { root: wt });
    for (const t of tools.pushTools(cfg)) {
      if (t.name === 'sonar' || t.kind === 'status') continue;   // a server scan is not a local check
      steps.push({ name: t.name, kind: 'lint', cmd: tools.resolve(wcfg, t, []), cwd: tools.cwdFor(wcfg, t), timeout: (t.timeout || 300) * 1000 });
    }
    if (!steps.length) result.note = 'no compile command and no lint tool is configured for this stack';
    for (const st of steps) {
      const t0 = Date.now();
      const r = run(st.cmd, { cwd: fs.existsSync(st.cwd) ? st.cwd : wt, timeout: st.timeout || 600000 });
      const issues = r.code === 0 ? [] : issuesIn(r.out, files);
      result.checks.push({ name: st.name, kind: st.kind, ok: r.code === 0, ms: Date.now() - t0, issues,
        // A failure that names no changed file is either an old problem or this machine (a missing
        // dependency). It is reported, never blamed on the change.
        note: r.code !== 0 && !issues.length ? `failed, but no message names a changed file — an existing problem or a missing dependency here: ${String(r.out).trim().split('\n').slice(-1)[0].slice(0, 160)}` : null });
    }
  } finally {
    git(`worktree remove --force ${JSON.stringify(wt)}`, cfg.root);
    git('worktree prune', cfg.root);
  }
  return save();
}

// The verdict from everything recorded so far. Quality notes and lint issues never change it; a
// compile or typecheck error in a changed file always does — code that does not build is not done.
function verdictOf(e) {
  const items = e.items || [];
  const findings = e.findings || [];
  const notMet = items.filter((it) => it.verdict === 'not-met').length;
  const unclear = items.filter((it) => it.verdict === 'unclear').length;
  const blocking = findings.filter((x) => x.severity === 'blocking').length;
  const checks = ((e.quality || {}).build || {}).checks || [];
  const broken = checks.filter((c) => c.kind === 'compile' && !c.ok && c.issues.length).length;
  const lint = checks.filter((c) => c.kind === 'lint').reduce((a, c) => a + c.issues.length, 0);
  const notes = ((e.quality || {}).notes || []).length;
  return {
    verdict: notMet || blocking || broken ? 'not-done' : unclear ? 'unclear' : 'done',
    counts: { met: items.length - notMet - unclear, notMet, unclear, blocking, minor: findings.length - blocking,
      buildErrors: broken, lint, quality: notes },
  };
}

/* ------------------------------------------------------------------- record */

const ITEM_VERDICTS = ['met', 'not-met', 'unclear'];
const SEVERITIES = ['blocking', 'minor'];

// `T1 | met | src/Order.kt:42 | rejects a negative quantity`
// `F | blocking | src/Order.kt:57 | total ignores the discount`
// `S | one sentence on the change`
function parseLines(text) {
  const items = [];
  const findings = [];
  const summary = [];
  const quality = [];
  const bad = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^\s*[-*]\s+/, '').trim();
    if (!line || !line.includes('|')) continue;
    const p = line.split('|').map((x) => x.trim());
    if (/^S$/i.test(p[0])) { summary.push(p.slice(1).join(' | ').slice(0, 300)); continue; }
    if (/^Q$/i.test(p[0])) {
      const m = String(p[1] || '').match(/^(.+?)(?::(\d+))?$/);
      quality.push({ file: m && m[1] !== '-' ? m[1] : null, line: m && m[2] ? Number(m[2]) : null,
        rule: String(p[2] || '').slice(0, 80), text: String(p[3] || '').slice(0, 300), todo: p.slice(4).join(' | ').slice(0, 300) || null });
      continue;
    }
    if (/^F$/i.test(p[0])) {
      const sev = (p[1] || '').toLowerCase();
      if (!SEVERITIES.includes(sev)) { bad.push(`finding with severity "${p[1]}"`); continue; }
      const m = String(p[2] || '').match(/^(.+?)(?::(\d+))?$/);
      findings.push({ severity: sev, file: m && m[1] !== '-' ? m[1] : null, line: m && m[2] ? Number(m[2]) : null,
        text: String(p[3] || '').slice(0, 400), todo: p.slice(4).join(' | ').slice(0, 300) || null });
      continue;
    }
    if (/^[TD]\d+$/i.test(p[0])) {
      const v = (p[1] || '').toLowerCase();
      if (!ITEM_VERDICTS.includes(v)) { bad.push(`${p[0]} has verdict "${p[1]}"`); continue; }
      const ev = [p[2], p[3]].filter((x) => x && x !== '-').join(' ');
      items.push({ id: p[0].toUpperCase(), verdict: v, evidence: ev ? ev.slice(0, 400) : null,
        todo: p.slice(4).join(' | ').slice(0, 300) || null });
    }
  }
  return { items, findings, quality: quality.slice(0, 12), summary: summary.join(' ') || null, bad };
}

// An item judged twice (two agents saw it): evidence that it is met wins, then a not-met with
// evidence over an unclear. A script's not-met is a fact about the added lines and is not
// overridden by a model reading.
function mergeItem(a, b) {
  if (!a) return b;
  const rank = { met: 3, 'not-met': 2, unclear: 1 };
  return (rank[b.verdict] || 0) > (rank[a.verdict] || 0) ? b : a;
}

function record(cfg, id, text, opts = {}) {
  const prev = get(cfg, id);
  if (!prev) return { ok: false, out: `no review ${id}. \`keel ticket list\` shows them.` };
  const r = parseLines(text);
  const problems = r.bad.slice();
  const byItem = {};
  for (const it of r.items) {
    if (!prev.items.some((x) => x.id === it.id)) { problems.push(`unknown item ${it.id}`); continue; }
    byItem[it.id] = mergeItem(byItem[it.id], it);
  }
  const items = prev.items.map((it) => {
    if (it.auto && it.verdict === 'not-met') return it;
    const got = byItem[it.id];
    if (got) return Object.assign({}, it, got, { auto: false });
    return it.auto ? it : Object.assign({}, it, { verdict: null });
  });
  const missing = items.filter((it) => !it.verdict).map((it) => it.id);
  if (missing.length && !opts.partial) problems.push(`no verdict for ${missing.join(', ')} (or pass --partial to mark them unclear)`);
  if (problems.length) return { ok: false, out: ['the result is incomplete:', ...problems.map((p) => '  - ' + p)].join('\n') };
  for (const it of items) if (!it.verdict) { it.verdict = 'unclear'; it.evidence = 'no verdict given'; }

  const findings = r.findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  // Read the newest state again: a build check may have finished while the agents were judging.
  const latest = get(cfg, id) || prev;
  const entry = Object.assign({}, latest, {
    items, findings, summary: r.summary,
    quality: Object.assign({}, latest.quality || {}, { notes: r.quality }),
    status: 'finished', finished: new Date().toISOString(),
  });
  Object.assign(entry, verdictOf(entry));
  const blocking = entry.counts.blocking;
  append(cfg, entry);
  try {
    require('./events').append(cfg, { kind: 'review', tool: `review:${id}`, ok: entry.verdict === 'done',
      arg: `${entry.verdict} — ${entry.counts.met}/${items.length} met, ${blocking} blocking` });
  } catch (e) { /* the index is what matters */ }
  return { ok: true, entry };
}

/* ------------------------------------------------------------------- report */

// The review as a to-do list, in plain words: what is missing, what must be fixed, what a person
// has to check by hand, what would be nice, what is done — and the next steps in order. The
// terminal, the PR comment and the dashboard all read this one shape, so they never disagree.
function report(e) {
  const at = (x) => (x.file ? `${x.file}${x.line ? ':' + x.line : ''}` : null);
  const items = e.items || [];
  const findings = e.findings || [];
  const q = e.quality || {};
  const checks = (q.build || {}).checks || [];
  const missing = items.filter((it) => it.verdict === 'not-met').map((it) => ({
    id: it.id, title: it.text, problem: it.evidence || 'not done', todo: it.todo || null, script: !!it.auto }));
  const compile = checks.filter((c) => c.kind === 'compile' && !c.ok).flatMap((c) => c.issues.map((x) => ({
    where: at(x), problem: `${c.name}: ${x.text}`, todo: 'make it build — nothing else can be checked until it does' })));
  const mustFix = compile.concat(findings.filter((x) => x.severity === 'blocking').map((x) => ({
    where: at(x), problem: x.text, todo: x.todo || null })));
  const check = items.filter((it) => it.verdict === 'unclear').map((it) => ({
    id: it.id, title: it.text, problem: it.evidence || 'the code does not show it', todo: it.todo || 'check it by hand, or ask the author' }));
  const nice = findings.filter((x) => x.severity === 'minor').map((x) => ({ where: at(x), problem: x.text, todo: x.todo || null, kind: 'bug' }))
    .concat(checks.filter((c) => c.kind === 'lint').flatMap((c) => c.issues.map((x) => ({ where: at(x), problem: `${c.name}: ${x.text}`, todo: null, kind: 'lint' }))))
    .concat((q.notes || []).map((x) => ({ where: at(x), problem: x.text, todo: x.todo || null, rule: x.rule || null, kind: 'quality' })));
  const done = items.filter((it) => it.verdict === 'met').map((it) => ({ id: it.id, title: it.text }));
  const notes = [];
  if ((q.build || {}).note) notes.push(`build check: ${q.build.note}`);
  for (const c of checks) if (c.note) notes.push(`${c.name}: ${c.note}`);
  const step = (x, prefix) => `${prefix}${x.where ? x.where + ' — ' : ''}${x.todo || x.problem}`;
  const next = [
    ...mustFix.map((x) => step(x, 'Fix: ')),
    ...missing.map((x) => `Add: ${x.id} "${x.title}" — ${x.todo || x.problem}`),
    ...check.map((x) => `Check: ${x.id} "${x.title}" — ${x.todo}`),
  ];
  if (nice.length) next.push(`Optional: the ${nice.length} nice-to-have note(s) above`);
  const word = { done: 'DONE', 'not-done': 'NOT DONE', unclear: 'NEEDS A CHECK' }[e.verdict] || String(e.verdict || 'running').toUpperCase();
  return { id: e.id, title: e.title, verdict: e.verdict, word, summary: e.summary || null,
    doneCount: done.length, total: items.length, missing, mustFix, check, nice, done, notes, next };
}

function reportText(e) {
  const r = report(e);
  const out = [`${r.id} — ${r.word} · ${r.doneCount} of ${r.total} done${r.summary ? `\n${r.summary}` : ''}`];
  const block = (title, rows, fmt) => { if (rows.length) out.push('', title, ...rows.flatMap(fmt)); };
  block(`❌ MISSING — from the ticket or the definition of done (${r.missing.length})`, r.missing, (x) => [
    `   ${x.id} ${x.title}`, `      problem: ${x.problem}${x.script ? ' (script)' : ''}`, ...(x.todo ? [`      to do:   ${x.todo}`] : [])]);
  block(`🔧 MUST FIX — bugs and build errors (${r.mustFix.length})`, r.mustFix, (x) => [
    `   ${x.where ? x.where + ' — ' : ''}${x.problem}`, ...(x.todo ? [`      to do:   ${x.todo}`] : [])]);
  block(`❓ CHECK BY HAND — the code cannot show it (${r.check.length})`, r.check, (x) => [
    `   ${x.id} ${x.title}`, `      why:     ${x.problem}`, `      to do:   ${x.todo}`]);
  block(`💡 NICE TO HAVE — minor, does not block (${r.nice.length})`, r.nice, (x) => [
    `   ${x.where ? x.where + ' — ' : ''}${x.rule ? `(${x.rule}) ` : ''}${x.problem}${x.todo ? ` → ${x.todo}` : ''}`]);
  if (r.done.length) out.push('', `✅ DONE (${r.done.length}) — ${r.done.map((x) => x.id).join(', ')}`);
  if (r.notes.length) out.push('', 'notes', ...r.notes.map((n) => `   · ${n}`));
  out.push('', r.next.length ? 'NEXT STEPS' : 'NEXT STEPS — nothing to do: ready to merge');
  r.next.forEach((n, i) => out.push(`   ${i + 1}. ${n}`));
  return out.join('\n');
}

/* ------------------------------------------------------------------ comment */

// The text for a PR comment, from only the sections the reviewer chose. Nothing is posted here:
// the reviewer decides what the author sees, and the default is the least — the verdict, what is
// missing and what must be fixed.
const SECTIONS = ['summary', 'notmet', 'blocking', 'unclear', 'minor', 'build', 'quality'];
function comment(cfg, id, include) {
  const e = get(cfg, id);
  if (!e) return { ok: false, out: `no review ${id}.` };
  if (e.status !== 'finished') return { ok: false, out: `${id} is still running.` };
  const want = new Set(include && include.length ? include : ['summary', 'notmet', 'blocking']);
  const bad = Array.from(want).filter((x) => !SECTIONS.includes(x));
  if (bad.length) return { ok: false, out: `unknown section(s): ${bad.join(', ')}. Sections: ${SECTIONS.join(', ')}.` };
  const r = report(e);
  const code = (w) => (w ? `\`${w}\` ` : '');
  const todo = (t) => (t ? `\n  - **To do:** ${t}` : '');
  const out = [];
  if (want.has('summary')) out.push(`**Review: ${r.word.toLowerCase()}** — ${r.doneCount} of ${r.total} checklist items done.${r.summary ? ' ' + r.summary : ''}`, '');
  const list = (title, rows) => { if (rows.length) out.push(`**${title}**`, ...rows, ''); };
  if (want.has('notmet')) list('Missing', r.missing.map((x) => `- ${x.title} — ${x.problem}${todo(x.todo)}`));
  const compileRows = r.mustFix.filter((x) => /^(compile|typecheck)/.test(x.problem));
  if (want.has('blocking')) list('Must fix', r.mustFix.filter((x) => !compileRows.includes(x)).map((x) => `- ${code(x.where)}${x.problem}${todo(x.todo)}`));
  if (want.has('build')) list('Build and lint', compileRows.concat(r.nice.filter((x) => x.kind === 'lint')).map((x) => `- ${code(x.where)}${x.problem}`));
  if (want.has('unclear')) list('Please confirm', r.check.map((x) => `- ${x.title} — ${x.problem}`));
  if (want.has('minor')) list('Minor', r.nice.filter((x) => x.kind === 'bug').map((x) => `- ${code(x.where)}${x.problem}${todo(x.todo)}`));
  if (want.has('quality')) list('Code quality', r.nice.filter((x) => x.kind === 'quality').map((x) => `- ${code(x.where)}${x.rule ? `(${x.rule}) ` : ''}${x.problem}${todo(x.todo)}`));
  const text = out.join('\n').trim();
  return { ok: true, text: text || '(nothing to share in the chosen sections)', sections: Array.from(want) };
}

module.exports = { LOG, DOD, ONE_AGENT_LINES, prep, renderPack, record, parseLines, list, get, build, verdictOf, comment, report, reportText, issuesIn, languageRules,
  ticketItems, teamItems, splitFiles, riskOf, noiseOf, autoChecks, route, plan };
