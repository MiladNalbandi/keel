'use strict';
// The bug hunt's backlog. A hunt finds candidates, proves them, and leaves an inventory that
// outlives the flow that produced it — which is why this is a file rather than a field in
// state.json: the handoff into /keel:fix is `keel state start fix`, and that resets state.
//
// Two files. `.keel/hunt/<run>.json` is the run: scope, the confirmed lens set, and every
// finding with its verdict. `.keel/hunt.json` is a pointer with the counts, cheap enough for
// `keel board` to read on every render. Both are per-machine and gitignored; the *report* is
// what gets committed.
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, gitOut, run } = require('./util');
// One severity ladder in the codebase. `keel hunt` and `keel verify deps` must not be able to
// disagree about what "high" means.
const { ORDER: SEVERITIES, rank } = require('./deps');

const STATUSES = ['candidate', 'proven', 'unproven', 'false', 'fixed', 'accepted', 'wontfix'];
const KINDS = ['defect', 'unspecified'];
// A prover stores its recipe as a runnable artifact, never as a test. `.spec.ts`/`.test.ts` are
// excluded on purpose — the guard classifies those as test files and refuses them in
// hunt-prove, and a recipe that is really a regression test belongs to keel:reproducer.
const RECIPE_EXTS = ['.sh', '.http', '.sql', '.md', '.probe.ts'];

function huntDir(cfg) { return path.join(cfg.root, '.keel', 'hunt'); }
function reproDir(cfg) { return path.join(huntDir(cfg), 'repro'); }
function pointerFile(cfg) { return path.join(cfg.root, '.keel', 'hunt.json'); }
function runFile(cfg, id) { return path.join(huntDir(cfg), `${id}.json`); }

function readPointer(cfg) { return readJson(pointerFile(cfg), null); }

// The active run, or null. Deliberately strict where `readJson` is lenient: a pointer that
// names a file which is not there is a broken hunt, not an empty one.
function readRun(cfg) {
  const ptr = readPointer(cfg);
  if (!ptr || !ptr.run) return null;
  const f = runFile(cfg, ptr.run);
  if (!fs.existsSync(f)) return null;
  return readJson(f, null);
}

function counts(run) {
  const c = {};
  for (const s of STATUSES) c[s] = 0;
  for (const f of run.findings) c[f.status] = (c[f.status] || 0) + 1;
  return c;
}

// Proven, not grouped away into someone else's dispatch, not closed, not yet dispatched.
function openFindings(run) {
  const dispatchedGroups = new Set((run.dispatched || []).map((d) => d.group).filter(Boolean));
  return run.findings.filter((f) => f.status === 'proven' && !f.close && !f.dispatch
    && !(f.group && dispatchedGroups.has(f.group)));
}

function writeRun(cfg, run) {
  run.rev = (run.rev || 0) + 1;
  writeJson(runFile(cfg, run.id), run);
  const c = counts(run);
  writeJson(pointerFile(cfg), {
    run: run.id,
    file: path.join('.keel', 'hunt', `${run.id}.json`),
    // The sha the hunt started at. Informational: a hunt is an inventory, not a branch gate,
    // so this must never reach gates.pushBlockers — a repo with an open finding would then be
    // unable to push anything, on a branch where the findings were deliberately not fixed.
    sha: run.sha,
    rev: run.rev,
    counts: c,
    open: openFindings(run).length,
    report: run.report || null,
    at: new Date().toISOString(),
  });
  return run;
}

/* ------------------------------------------------------------------ start */

function healthOf(cfg, key) {
  const cmd = (cfg.commands || {})[key];
  if (!cmd) return 'unknown';
  return run(cmd, { cwd: cfg.root, timeout: 15000 }).code === 0 ? 'ok' : 'down';
}

function start(cfg, opts = {}) {
  const existing = readRun(cfg);
  if (existing && !opts.new) {
    const c = counts(existing);
    const unclosed = c.candidate + c.proven;
    if (unclosed) {
      return { ok: false, out: `hunt ${existing.id} is still open with ${unclosed} finding(s) that are neither closed nor dispatched.\n`
        + 'Finish it (`keel hunt status`), or start a fresh one with `keel hunt start --new`.' };
    }
  }

  const scope = opts.scope || cfg.hunt.default_scope;
  if (!['all', 'diff'].includes(scope) && !scope.trim()) return { ok: false, out: 'usage: keel hunt start [--scope all|diff|<paths>]' };
  const configured = cfg.hunt.lenses || [];
  let proposed = configured;
  if (opts.lenses) {
    proposed = String(opts.lenses).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = proposed.filter((l) => !configured.includes(l));
    if (unknown.length) {
      return { ok: false, out: `unknown lens(es): ${unknown.join(', ')}.\nConfigured lenses: ${configured.join(', ')}.\n`
        + 'Add a lens to `hunt.lenses` in .keel/config.yml and give it a brief in the hunt skill.' };
    }
  }

  const sha = gitOut('rev-parse HEAD', cfg.root, 'unknown');
  const branch = gitOut('rev-parse --abbrev-ref HEAD', cfg.root, 'unknown');
  const id = `${new Date().toISOString().slice(0, 10)}-${String(sha).slice(0, 6)}`;
  const run_ = {
    id,
    at: new Date().toISOString(),
    sha,
    branch,
    scope: {
      mode: ['all', 'diff'].includes(scope) ? scope : 'paths',
      paths: ['all', 'diff'].includes(scope) ? [] : scope.split(',').map((s) => s.trim()).filter(Boolean),
      base: opts.base || cfg.base_branch,
      map: null,
    },
    // confirmed stays null until the user says so, and `hunt add` refuses while it is null.
    // That is the whole enforcement of "the lens set is confirmed before anything fans out".
    lenses: { configured, proposed, confirmed: null, confirmed_at: null },
    stack: {
      services: (cfg.runtime || {}).services || 'unknown',
      api: healthOf(cfg, 'api_health_check'),
      web: healthOf(cfg, 'web_health_check'),
      checked_at: new Date().toISOString(),
    },
    rev: 0,
    next_id: 1,
    next_group: 1,
    groups: {},
    findings: [],
    dispatched: [],
    report: null,
  };
  fs.mkdirSync(reproDir(cfg), { recursive: true });
  writeRun(cfg, run_);

  const lines = [`hunt ${id} started — scope ${run_.scope.mode}${run_.scope.paths.length ? ` (${run_.scope.paths.join(', ')})` : ''}, ${String(sha).slice(0, 7)} on ${branch}`,
    `stack: services ${run_.stack.services} · api ${run_.stack.api} · web ${run_.stack.web}`,
    '',
    'proposed lenses, none confirmed yet:'];
  for (const l of proposed) lines.push(`  ${l}`);
  lines.push('', 'Show these to the user and let them drop or add any. Then:',
    `  keel hunt lenses --confirm ${proposed.join(',')}`,
    'Nothing can be ingested until that runs.');
  return { ok: true, out: lines.join('\n') };
}

/* ----------------------------------------------------------------- lenses */

function lenses(cfg, opts = {}) {
  const run_ = readRun(cfg);
  if (!run_) return { ok: false, out: 'no hunt open. Start one with `keel hunt start`.' };
  if (!opts.confirm) {
    return { ok: true, out: [`hunt ${run_.id}`,
      `configured: ${run_.lenses.configured.join(', ')}`,
      `proposed:   ${run_.lenses.proposed.join(', ')}`,
      run_.lenses.confirmed
        ? `confirmed:  ${run_.lenses.confirmed.join(', ')}  (${run_.lenses.confirmed_at})`
        : 'confirmed:  none yet — `keel hunt add` will refuse every candidate until it is'].join('\n') };
  }
  const list = String(opts.confirm).split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return { ok: false, out: 'usage: keel hunt lenses --confirm <a,b,c>' };
  const unknown = list.filter((l) => !run_.lenses.configured.includes(l));
  if (unknown.length) return { ok: false, out: `unknown lens(es): ${unknown.join(', ')}.\nConfigured: ${run_.lenses.configured.join(', ')}.` };
  run_.lenses.confirmed = list;
  run_.lenses.confirmed_at = new Date().toISOString();
  writeRun(cfg, run_);
  return { ok: true, out: [`confirmed ${list.length} lens(es): ${list.join(', ')}`,
    'Now send one keel:hunter per lens, in parallel, each with only its own brief.',
    'Write each result to .keel/hunt/incoming/<lens>.json, then `keel hunt add --lens <lens> --json <file>`.'].join('\n') };
}

/* -------------------------------------------------------------------- add */

// A model returns a fenced block far more often than bare JSON, and `readJson` would answer a
// fence with its fallback — silently turning twelve findings into zero.
// Three shapes, because all three turn up: bare JSON, a fenced block, and a fenced block with a
// sentence before or after it. Line-based rather than one regex over the whole text — an
// unterminated fence is common enough that a pattern requiring both ends silently fails on it,
// and the cost of being wrong here is a lens's entire result set read as zero findings.
function stripFence(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  while (lines.length && (lines[0].trim() === '' || /^```[a-zA-Z]*$/.test(lines[0].trim()))) lines.shift();
  while (lines.length && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '```')) lines.pop();
  const inner = lines.join('\n').trim();
  try { JSON.parse(inner); return inner; } catch (e) { /* fall through to the salvage below */ }
  // Prose either side of the payload. Take the outermost array, or failing that the outermost
  // object, and let the caller's parse report anything still wrong.
  const a = inner.indexOf('[');
  const z = inner.lastIndexOf(']');
  if (a !== -1 && z > a) {
    const slice = inner.slice(a, z + 1);
    try { JSON.parse(slice); return slice; } catch (e) { /* not salvageable */ }
  }
  return inner;
}

// keel validates nothing else it reads from disk, because nothing else it reads from disk was
// written by a model. This is, so the errors name the field and the index.
function validateCandidate(c, i) {
  const at = `candidate[${i}]`;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return `${at} is not an object`;
  if (!c.title || typeof c.title !== 'string') return `${at}.title is required`;
  if (String(c.title).length > 120) return `${at}.title is longer than 120 characters`;
  const where = c.where || c.at;
  if (!Array.isArray(where) || !where.length) return `${at}.where must be a non-empty array of "path:line"`;
  if (where.some((w) => typeof w !== 'string' || !w.trim())) return `${at}.where holds an empty entry`;
  if (!c.symptom || typeof c.symptom !== 'string') return `${at}.symptom is required — what a user or caller observes`;
  if (c.kind && !KINDS.includes(c.kind)) return `${at}.kind must be one of ${KINDS.join(', ')}`;
  return null;
}

function add(cfg, opts = {}) {
  const run_ = readRun(cfg);
  if (!run_) return { ok: false, out: 'no hunt open. Start one with `keel hunt start`.' };
  if (!opts.lens || opts.lens === true) return { ok: false, out: 'usage: keel hunt add --lens <lens> --json <file>' };
  if (!opts.json || opts.json === true) return { ok: false, out: 'usage: keel hunt add --lens <lens> --json <file>' };
  if (!run_.lenses.confirmed) {
    return { ok: false, out: 'the lens set has not been confirmed, so there is nothing to ingest into.\n'
      + 'Show the proposed lenses to the user, then `keel hunt lenses --confirm <a,b,c>`.' };
  }
  if (!run_.lenses.confirmed.includes(opts.lens)) {
    return { ok: false, out: `"${opts.lens}" is not one of the confirmed lenses (${run_.lenses.confirmed.join(', ')}).` };
  }
  const f = path.isAbsolute(opts.json) ? opts.json : path.join(cfg.root, opts.json);
  if (!fs.existsSync(f)) return { ok: false, out: `no such file: ${opts.json}` };

  let parsed;
  try { parsed = JSON.parse(stripFence(fs.readFileSync(f, 'utf8'))); } catch (e) {
    return { ok: false, out: `${opts.json} is not JSON: ${e.message}\nA hunter returns a JSON array; a code fence around it is fine.` };
  }
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.findings) ? parsed.findings : null);
  if (!list) return { ok: false, out: `${opts.json} must hold a JSON array of candidates (or an object with a "findings" array).` };
  const cap = cfg.hunt.max_candidates_per_lens;
  if (list.length > cap) {
    return { ok: false, out: `${list.length} candidates from one lens, over the cap of ${cap} (hunt.max_candidates_per_lens).\n`
      + 'A lens returning more than that has stopped judging. Ask it for the strongest ones.' };
  }
  for (let i = 0; i < list.length; i++) {
    const bad = validateCandidate(list[i], i);
    if (bad) return { ok: false, out: `${opts.json}: ${bad}` };
  }

  const added = [];
  let droppedSeverity = 0;
  for (const c of list) {
    const id = `F-${String(run_.next_id++).padStart(3, '0')}`;
    // Severity is dropped rather than ignored, and the drop is reported. A hunter will offer
    // one; storing it would leak the two-stage bar on the first run, because a severity is a
    // measurement and nothing has measured anything yet.
    if (c.severity) droppedSeverity++;
    run_.findings.push({
      id,
      lens: opts.lens,
      title: String(c.title).trim(),
      where: (c.where || c.at).map(String),
      symptom: String(c.symptom).trim(),
      // Kept, and never carried downstream: keel:reproducer must see the symptom, not a theory.
      claim: c.claim ? String(c.claim) : null,
      repro_hint: c.repro_hint ? String(c.repro_hint) : null,
      kind: KINDS.includes(c.kind) ? c.kind : 'defect',
      status: 'candidate',
      severity: null,
      group: null,
      group_role: null,
      evidence: null,
      repro: null,
      proved_at: null,
      proved_sha: null,
      verdict_note: null,
      dispatch: null,
      close: null,
    });
    added.push(id);
  }
  writeRun(cfg, run_);
  const lines = [`ingested ${added.length} candidate(s) from the ${opts.lens} lens as ${added[0]}..${added[added.length - 1]}`];
  if (droppedSeverity) {
    lines.push(`dropped a lens-supplied severity on ${droppedSeverity} of them: only \`keel hunt prove\` sets one.`);
  }
  const still = run_.findings.filter((x) => x.status === 'candidate').length;
  lines.push('', `${still} candidate(s) now await a verdict. Next: \`keel state phase hunt-prove\`, then one keel:prover each.`);
  return { ok: true, out: lines.join('\n') };
}

/* ------------------------------------------------------------ list/status */

function severityLabel(f) { return f.severity || (f.status === 'proven' ? '?' : '—'); }

function list(cfg, opts = {}) {
  const run_ = readRun(cfg);
  if (!run_) return { ok: false, out: 'no hunt open. Start one with `keel hunt start`.' };
  const head = gitOut('rev-parse HEAD', cfg.root, 'unknown');
  let rows = run_.findings;
  if (opts.open) rows = openFindings(run_);
  if (opts.lens && opts.lens !== true) rows = rows.filter((f) => f.lens === opts.lens);
  if (opts.group && opts.group !== true) rows = rows.filter((f) => f.group === opts.group);
  if (!rows.length) return { ok: true, out: opts.open ? 'nothing open.' : 'no findings recorded yet.' };
  const order = { proven: 0, candidate: 1, unproven: 2, false: 3, fixed: 4, accepted: 5, wontfix: 6 };
  rows = rows.slice().sort((a, b) => (order[a.status] - order[b.status])
    || (rank(b.severity) - rank(a.severity)) || a.id.localeCompare(b.id));
  const lines = rows.map((f) => {
    const bits = [f.id, f.status.padEnd(9), severityLabel(f).padEnd(8), (f.group || '—').padEnd(5), f.lens.padEnd(14), f.title];
    let line = '  ' + bits.join(' ');
    // A verdict is only as good as the tree it was taken on. Say so rather than implying the
    // finding still reproduces.
    if (f.proved_sha && f.proved_sha !== head) line += `\n      proved at ${String(f.proved_sha).slice(0, 7)} ≠ HEAD — reprove before acting on it`;
    if (f.close) line += `\n      closed as ${f.close.as}: ${f.close.note}`;
    return line;
  });
  return { ok: true, out: [`hunt ${run_.id} — ${rows.length} finding(s)`, '', ...lines].join('\n') };
}

function status(cfg) {
  const run_ = readRun(cfg);
  if (!run_) return { ok: false, out: 'no hunt open. Start one with `keel hunt start`.' };
  const c = counts(run_);
  const open = openFindings(run_);
  const lines = [`hunt ${run_.id} — scope ${run_.scope.mode}, ${String(run_.sha).slice(0, 7)} on ${run_.branch}, started ${run_.at}`,
    `lenses: ${run_.lenses.confirmed ? run_.lenses.confirmed.join(', ') : 'NOT CONFIRMED — `keel hunt lenses --confirm <a,b,c>`'}`,
    `stack at start: services ${run_.stack.services} · api ${run_.stack.api} · web ${run_.stack.web}`,
    '',
    `candidate ${c.candidate} · proven ${c.proven} · unproven ${c.unproven} · false ${c.false}`
    + ` · fixed ${c.fixed} · accepted ${c.accepted} · wontfix ${c.wontfix}`,
    `open (proven, not dispatched, not closed): ${open.length}`];
  const groups = Object.entries(run_.groups || {});
  if (groups.length) {
    lines.push('', 'groups');
    for (const [g, meta] of groups) {
      const members = run_.findings.filter((f) => f.group === g);
      lines.push(`  ${g}  lead ${meta.lead}  ${members.length} finding(s)  ${meta.cause}`);
    }
  }
  lines.push('', run_.report ? `report: ${run_.report}` : 'report: not rendered yet — `keel hunt report`');
  if (c.candidate) lines.push(`${c.candidate} candidate(s) have no verdict, so the report will refuse to render.`);
  return { ok: true, out: lines.join('\n') };
}

module.exports = { start, lenses, add, list, status, readRun, readPointer, writeRun, counts,
  openFindings, huntDir, reproDir, runFile, pointerFile, stripFence, validateCandidate,
  SEVERITIES, STATUSES, KINDS, RECIPE_EXTS };
