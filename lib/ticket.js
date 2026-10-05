'use strict';
// Review someone's code against a ticket and the team's definition of done.
//
// Everything that needs no judgement happens here, without a model: fetching the diff (a GitHub
// PR through `gh`, or a local branch through git), pulling the checklist out of the team's
// .keel/dod.md and out of the ticket's own "Definition of done" / "Acceptance" section, and
// splitting a large diff into chunks. The agent then only judges — one checklist item and one
// hunk at a time — and its answer comes back through `verdict`, which validates and merges it.
//
// The index lives at .keel/reviews.json — a top-level file under .keel/, because that is the
// directory the dashboard watches — and the working files under .keel/reviews/<id>/.
const fs = require('fs');
const path = require('path');
const { run, git, gitOut, readJson, writeJson } = require('./util');

const INDEX = path.join('.keel', 'reviews.json');
const DOD = path.join('.keel', 'dod.md');
const CHUNK_LINES = 1500;     // above this, the diff is split so agents can review in parallel
const KEEP = 20;              // reviews kept in the index; older working dirs are left on disk

function indexFile(cfg) { return path.join(cfg.root, INDEX); }
function dirOf(cfg, id) { return path.join(cfg.root, '.keel', 'reviews', id); }
function readIndex(cfg) { return readJson(indexFile(cfg), { reviews: [] }); }
function writeIndex(cfg, idx) {
  idx.reviews = idx.reviews.slice(0, KEEP);
  fs.mkdirSync(path.dirname(indexFile(cfg)), { recursive: true });
  writeJson(indexFile(cfg), idx);
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
// heading. A ticket with no such heading contributes nothing — and the report says so, rather
// than inventing criteria from the description.
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
  const tpl = path.join(__dirname, '..', 'templates', 'dod.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.copyFileSync(tpl, f);
  return true;
}

/* --------------------------------------------------------------------- diff */

function prDiff(cfg, pr) {
  const meta = run(`gh pr view ${pr} --json title,url,headRefName,baseRefName,author`, { cwd: cfg.root, timeout: 60000 });
  if (meta.code !== 0) return { error: `gh could not read PR ${pr}: ${String(meta.out).trim().split('\n')[0]}` };
  let m = {};
  try { m = JSON.parse(meta.out); } catch (e) { m = {}; }
  const d = run(`gh pr diff ${pr} --color=never`, { cwd: cfg.root, timeout: 120000 });
  if (d.code !== 0) return { error: `gh could not fetch the diff of PR ${pr}: ${String(d.out).trim().split('\n')[0]}` };
  // The PR's code under a private ref, so the agent can read whole files as the PR has them
  // (`git show <ref>:<path>`) without a checkout. Best effort: without it, the patch is all it sees.
  const local = `refs/keel/pr-${Number(pr)}`;
  const f = git(`fetch -q origin pull/${Number(pr)}/head:${local}`, cfg.root);
  return { patch: d.out, source: { pr: Number(pr), ref: f.code === 0 ? local : null, url: m.url || null, title: m.title || null,
    head: m.headRefName || null, base: m.baseRefName || null, author: (m.author || {}).login || null } };
}

function branchDiff(cfg, branch, base) {
  const b = base || cfg.base_branch || 'main';
  // Never a checkout: the user's working tree stays as it is. A branch that is only on the remote
  // is fetched first and reviewed as origin/<branch>.
  let ref = branch;
  if (!gitOut(`rev-parse --verify --quiet ${ref}`, cfg.root, null)) {
    git(`fetch -q origin ${branch}`, cfg.root);
    ref = `origin/${branch}`;
    if (!gitOut(`rev-parse --verify --quiet ${ref}`, cfg.root, null)) {
      return { error: `no branch "${branch}" here or on origin` };
    }
  }
  const d = git(`diff --no-color ${b}...${ref}`, cfg.root);
  if (d.code !== 0) return { error: `git diff ${b}...${ref} failed: ${String(d.out).trim().split('\n')[0]}` };
  return { patch: d.out, source: { branch, ref, base: b, head: gitOut(`rev-parse --short ${ref}`, cfg.root, null) } };
}

// Per-file sections of a unified diff.
function splitFiles(patch) {
  const parts = String(patch).split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '));
  return parts.map((p) => {
    const m = p.match(/^diff --git a\/(\S+) b\/(\S+)/);
    const lines = p.split('\n');
    return { file: m ? m[2] : '?', text: p,
      added: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
      removed: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
      lines: lines.length };
  });
}

// Whole files into chunks of about CHUNK_LINES, so one agent never needs the whole diff and
// several can run at once on a large one.
function chunk(files) {
  const out = [];
  let cur = [];
  let n = 0;
  for (const f of files) {
    if (cur.length && n + f.lines > CHUNK_LINES) { out.push(cur); cur = []; n = 0; }
    cur.push(f); n += f.lines;
  }
  if (cur.length) out.push(cur);
  return out;
}

/* -------------------------------------------------------------------- start */

function nextId(idx) {
  const nums = idx.reviews.map((r) => Number(String(r.id).replace(/^TR-/, ''))).filter((n) => !isNaN(n));
  return 'TR-' + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0');
}

function start(cfg, opts) {
  if (!opts.ticket) return { ok: false, out: 'usage: keel ticket start --ticket <file> (--pr <n> | --branch <name>) [--base <ref>]' };
  if (!!opts.pr === !!opts.branch) return { ok: false, out: 'give exactly one of --pr <n> or --branch <name>.' };
  const ticketPath = path.resolve(cfg.root, String(opts.ticket));
  if (!fs.existsSync(ticketPath)) return { ok: false, out: `no ticket file at ${opts.ticket}` };
  const ticket = fs.readFileSync(ticketPath, 'utf8');

  const created = starterDod(cfg);
  const team = teamItems(cfg) || [];
  const fromTicket = ticketItems(ticket);
  const items = [
    ...fromTicket.map((text, i) => ({ id: `T${i + 1}`, from: 'ticket', text })),
    ...team.map((text, i) => ({ id: `D${i + 1}`, from: 'team', text })),
  ];

  const d = opts.pr ? prDiff(cfg, opts.pr) : branchDiff(cfg, String(opts.branch), opts.base);
  if (d.error) return { ok: false, out: d.error };
  const files = splitFiles(d.patch);
  if (!files.length) return { ok: false, out: 'the diff is empty — nothing to review.' };
  const chunks = chunk(files);

  const idx = readIndex(cfg);
  const id = nextId(idx);
  const dir = dirOf(cfg, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ticket.md'), ticket);
  fs.writeFileSync(path.join(dir, 'diff.patch'), d.patch);
  chunks.forEach((c, i) => fs.writeFileSync(path.join(dir, `chunk-${i + 1}.patch`), c.map((f) => f.text).join('')));
  // `ref` is where the agent reads whole files as the reviewed code has them — the working tree
  // may be another branch entirely.
  writeJson(path.join(dir, 'checklist.json'), { ref: d.source.ref || null, items });

  const title = (d.source.title) || (ticket.split('\n').find((l) => l.trim()) || id).replace(/^#+\s*/, '').slice(0, 100);
  const entry = {
    id, title, status: 'running', started: new Date().toISOString(), finished: null,
    source: d.source, ticket: path.relative(cfg.root, ticketPath),
    files: files.length, added: files.reduce((a, f) => a + f.added, 0), removed: files.reduce((a, f) => a + f.removed, 0),
    chunks: chunks.length, verdict: null, summary: null,
    items: items.map((it) => Object.assign({ verdict: null, evidence: null }, it)), findings: [],
  };
  idx.reviews.unshift(entry);
  writeIndex(cfg, idx);
  return { ok: true, id, entry, created, fromTicket: fromTicket.length, team: team.length, chunks };
}

/* ------------------------------------------------------------------ verdict */

const ITEM_VERDICTS = ['met', 'not-met', 'unclear'];
const SEVERITIES = ['blocking', 'minor'];

// Several chunk agents may judge the same checklist item. Evidence anywhere that it is met wins;
// otherwise a "not met" with evidence wins over "unclear".
function mergeItem(a, b) {
  if (!a) return b;
  const rank = { met: 3, 'not-met': 2, unclear: 1 };
  return (rank[b.verdict] || 0) > (rank[a.verdict] || 0) ? b : a;
}

function verdict(cfg, id) {
  const idx = readIndex(cfg);
  const entry = idx.reviews.find((r) => r.id === id);
  if (!entry) return { ok: false, out: `no review ${id}. \`keel ticket list\` shows them.` };
  const dir = dirOf(cfg, id);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^result(-\d+)?\.json$/.test(f)).sort() : [];
  if (!files.length) return { ok: false, out: `no result file yet in ${path.relative(cfg.root, dir)}/ (result.json, or result-<n>.json per chunk).` };
  if (files.length < entry.chunks && !files.includes('result.json')) {
    return { ok: false, out: `${files.length} of ${entry.chunks} chunk results so far — wait for the rest.` };
  }

  const problems = [];
  const byItem = {};
  const findings = [];
  const summaries = [];
  for (const f of files) {
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { problems.push(`${f} is not valid JSON`); continue; }
    for (const it of r.items || []) {
      if (!entry.items.some((x) => x.id === it.id)) { problems.push(`${f}: unknown item ${it.id}`); continue; }
      if (!ITEM_VERDICTS.includes(it.verdict)) { problems.push(`${f}: item ${it.id} has verdict "${it.verdict}"`); continue; }
      byItem[it.id] = mergeItem(byItem[it.id], { verdict: it.verdict, evidence: it.evidence ? String(it.evidence).slice(0, 400) : null });
    }
    for (const x of r.findings || []) {
      if (!SEVERITIES.includes(x.severity)) { problems.push(`${f}: a finding has severity "${x.severity}"`); continue; }
      findings.push({ severity: x.severity, file: x.file || null, line: x.line || null, text: String(x.text || '').slice(0, 400) });
    }
    if (r.summary) summaries.push(String(r.summary).slice(0, 300));
  }
  const missing = entry.items.filter((it) => !byItem[it.id]).map((it) => it.id);
  if (missing.length) problems.push(`no verdict for ${missing.join(', ')}`);
  if (problems.length) return { ok: false, out: ['the result is incomplete:', ...problems.map((p) => '  - ' + p)].join('\n') };

  entry.items = entry.items.map((it) => Object.assign({}, it, byItem[it.id]));
  entry.findings = findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const notMet = entry.items.filter((it) => it.verdict === 'not-met').length;
  const unclear = entry.items.filter((it) => it.verdict === 'unclear').length;
  const blocking = entry.findings.filter((x) => x.severity === 'blocking').length;
  entry.verdict = notMet || blocking ? 'not-done' : unclear ? 'unclear' : 'done';
  entry.summary = summaries.join(' ') || null;
  entry.status = 'finished';
  entry.finished = new Date().toISOString();
  entry.counts = { met: entry.items.length - notMet - unclear, notMet, unclear, blocking, minor: entry.findings.length - blocking };
  writeIndex(cfg, idx);
  try {
    require('./events').append(cfg, { kind: 'review', tool: `review:${id}`, ok: entry.verdict === 'done',
      arg: `${entry.verdict} — ${entry.counts.met}/${entry.items.length} met, ${blocking} blocking` });
  } catch (e) { /* the index is what matters */ }
  return { ok: true, entry };
}

function list(cfg) { return readIndex(cfg).reviews; }
function get(cfg, id) { return readIndex(cfg).reviews.find((r) => r.id === id) || null; }

module.exports = { INDEX, DOD, CHUNK_LINES, start, verdict, list, get, ticketItems, teamItems, splitFiles, chunk };
