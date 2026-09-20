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

// Everything a run owns lives under its own directory, named for the day it ran and its number
// that day: .keel/hunt/2026-09-20-01/. Before 0.9.1 `repro/` and `incoming/` were shared across
// runs while finding ids restarted at F-001 every time — so a second hunt silently overwrote the
// first hunt's proof recipes, and a stored proof quietly became a different run's proof.
function huntDir(cfg) { return path.join(cfg.root, '.keel', 'hunt'); }
function runDir(cfg, id) { return path.join(huntDir(cfg), id); }
function reproDir(cfg, id) { return path.join(runDir(cfg, id), 'repro'); }
function incomingDir(cfg, id) { return path.join(runDir(cfg, id), 'incoming'); }
function pointerFile(cfg) { return path.join(cfg.root, '.keel', 'hunt.json'); }
function runFile(cfg, id) { return path.join(runDir(cfg, id), 'run.json'); }

// The report keeps the same name, as a directory: docs/hunts/2026-09-20-01/report.md, with the
// recipes copied in beside it. The backlog is gitignored, so a committed report that pointed at
// .keel/hunt/repro/ referenced files the reader did not have.
function reportDir(cfg, id) { return path.join(cfg.root, cfg.hunt.report_dir, id); }

// The next number for today. Two hunts on one day are `-01` and `-02`; the sha moves into a field
// where it belongs, because an id is for people and a sha is for freshness.
function nextRunId(cfg, day) {
  let taken = [];
  try {
    taken = fs.readdirSync(huntDir(cfg))
      .filter((n) => n.startsWith(`${day}-`))
      .map((n) => Number(n.slice(day.length + 1)))
      .filter((n) => Number.isFinite(n));
  } catch (e) { taken = []; }
  const n = taken.length ? Math.max(...taken) + 1 : 1;
  return `${day}-${String(n).padStart(2, '0')}`;
}

// The lanes a lens reads, and every lens×lane pair a sweep owes.
function lanesFor(cfg, lens) { return ((cfg.hunt.lens_lanes || {})[lens]) || ['both']; }
function sweepPairs(cfg, lenses) {
  return (lenses || []).flatMap((l) => lanesFor(cfg, l).map((lane) => `${l}:${lane}`));
}

// Which lane a cited path belongs to, through the same classifier the guards use — so "in scope"
// means exactly what it means everywhere else in keel.
function laneOfPath(cfg, rel) {
  const guards = require('./guards');
  return guards.LANE_OF[guards.classify(cfg, String(rel).split(':')[0])] || null;
}

// Two hunters reaching the same place is corroboration, not two bugs. Same file and a line within
// the window is the same finding; the second lens is recorded on it instead of re-filing it.
function duplicateOf(cfg, run_, cand) {
  const win = Number(cfg.hunt.dedup_line_window || 10);
  const spots = (cand.where || cand.at || []).map(String).map((w) => {
    const m = w.match(/^(.*?):(\d+)/);
    return m ? { file: m[1], line: Number(m[2]) } : { file: w, line: null };
  });
  return run_.findings.find((f) => (f.where || []).some((w) => {
    const m = String(w).match(/^(.*?):(\d+)/);
    const have = m ? { file: m[1], line: Number(m[2]) } : { file: String(w), line: null };
    return spots.some((sp) => sp.file === have.file
      && (sp.line === null || have.line === null || Math.abs(sp.line - have.line) <= win));
  })) || null;
}

function readPointer(cfg) { return readJson(pointerFile(cfg), null); }

// The active run, or null. Deliberately strict where `readJson` is lenient: a pointer that
// names a file which is not there is a broken hunt, not an empty one.
function readRun(cfg) {
  const ptr = readPointer(cfg);
  if (!ptr || !ptr.run) return null;
  const f = runFile(cfg, ptr.run);
  if (fs.existsSync(f)) return readJson(f, null);
  // A 0.9 run lived at .keel/hunt/<id>.json with no directory of its own. A hunt open at the
  // moment of upgrade must not become unreadable, so the flat path is still honoured on read —
  // writes always go to the new layout.
  const legacy = path.join(huntDir(cfg), `${ptr.run}.json`);
  if (fs.existsSync(legacy)) return readJson(legacy, null);
  return null;
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
    file: path.join('.keel', 'hunt', run.id, 'run.json'),
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
  const day = new Date().toISOString().slice(0, 10);
  const id = nextRunId(cfg, day);
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
    lenses: { configured, proposed, confirmed: null, confirmed_at: null, swept: {} },
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
  fs.mkdirSync(reproDir(cfg, id), { recursive: true });
  fs.mkdirSync(incomingDir(cfg, id), { recursive: true });
  writeRun(cfg, run_);

  const lines = [`hunt ${id} started — scope ${run_.scope.mode}${run_.scope.paths.length ? ` (${run_.scope.paths.join(', ')})` : ''}, ${String(sha).slice(0, 7)} on ${branch}`,
    `stack: services ${run_.stack.services} · api ${run_.stack.api} · web ${run_.stack.web}`,
    '',
    'proposed lenses, none confirmed yet:'];
  for (const l of proposed) lines.push(`  ${l}`);
  lines.push('', `working directory: .keel/hunt/${id}/  ·  report will be ${path.join(cfg.hunt.report_dir, id, 'report.md')}`);
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
  const pairs = sweepPairs(cfg, list);
  return { ok: true, out: [`confirmed ${list.length} lens(es): ${list.join(', ')}`,
    '',
    `${pairs.length} hunter(s) to send, one per lens and lane, in parallel:`,
    ...pairs.map((x) => `  ${x}`),
    '',
    'A lane means half the tree: give each hunter only its own brief and its own lane.',
    '`contract-drift:both` is one agent on purpose — its subject is the disagreement between the two sides.',
    '',
    `Write each result to .keel/hunt/${run_.id}/incoming/<lens>.<lane>.json, then:`,
    '  keel hunt add --lens <lens> --lane <lane> --json <file>'].join('\n') };
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
  // Which half of the tree this hunter was given. Required when the lens has more than one lane,
  // because the scope check below is the only thing that actually holds a hunter to its half — a
  // hook cannot, since the subagent payload carries no instance id.
  const lanes = lanesFor(cfg, opts.lens);
  const lane = opts.lane && opts.lane !== true ? String(opts.lane) : (lanes.length === 1 ? lanes[0] : null);
  if (!lane) {
    return { ok: false, out: `the ${opts.lens} lens is swept per lane, so say which: --lane ${lanes.join('|')}.`, usage: true };
  }
  if (!lanes.includes(lane)) {
    return { ok: false, out: `the ${opts.lens} lens does not read the "${lane}" lane; it reads ${lanes.join(', ')}.` };
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
    return { ok: false, out: `${list.length} candidates from one lens and lane, over the cap of ${cap} (hunt.max_candidates_per_lens).\n`
      + 'A lens returning more than that has stopped judging. Ask it for the strongest ones.' };
  }
  for (let i = 0; i < list.length; i++) {
    const bad = validateCandidate(list[i], i);
    if (bad) return { ok: false, out: `${opts.json}: ${bad}` };
  }

  // Scope is forced here, at the write, because this is the only place keel can force it. A
  // hunter given the api lane that reports a file in apps/web is refused by path, not reminded.
  if (lane !== 'both') {
    for (let i = 0; i < list.length; i++) {
      const out = (list[i].where || list[i].at || []).map(String)
        .filter((w) => { const l = laneOfPath(cfg, w); return l && l !== lane; });
      if (out.length) {
        return { ok: false, out: `candidate[${i}] is outside the "${lane}" lane: ${out.join(', ')}.\n`
          + `The ${opts.lens} lens was swept per lane; report a ${out[0].split(':')[0].startsWith('apps/web') ? 'web' : 'other-lane'} finding under that lane instead.` };
      }
    }
  }

  const added = [];
  const merged = [];
  let droppedSeverity = 0;
  for (const c of list) {
    // Same place, already known: record the corroboration and move on.
    const dup = duplicateOf(cfg, run_, c);
    if (dup) {
      const tag = `${opts.lens}:${lane}`;
      dup.also_found_by = Array.from(new Set((dup.also_found_by || []).concat([tag])));
      merged.push(`${dup.id} (${tag})`);
      continue;
    }
    const id = `F-${String(run_.next_id++).padStart(3, '0')}`;
    // Severity is dropped rather than ignored, and the drop is reported. A hunter will offer
    // one; storing it would leak the two-stage bar on the first run, because a severity is a
    // measurement and nothing has measured anything yet.
    if (c.severity) droppedSeverity++;
    run_.findings.push({
      id,
      lens: opts.lens,
      lane,
      also_found_by: [],
      title: String(c.title).trim(),
      where: (c.where || c.at).map(String),
      symptom: String(c.symptom).trim(),
      impact: c.impact ? String(c.impact).trim() : null,
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
  run_.lenses.swept[`${opts.lens}:${lane}`] = { at: new Date().toISOString(), count: list.length };
  writeRun(cfg, run_);
  const lines = [added.length
    ? `ingested ${added.length} candidate(s) from ${opts.lens}:${lane} as ${added[0]}..${added[added.length - 1]}`
    : `no new candidates from ${opts.lens}:${lane}`];
  if (merged.length) lines.push(`merged into existing finding(s): ${merged.join(', ')} — two lenses reaching the same place is corroboration, not two bugs`);
  if (droppedSeverity) {
    lines.push(`dropped a lens-supplied severity on ${droppedSeverity} of them: only \`keel hunt prove\` sets one.`);
  }
  const still = run_.findings.filter((x) => x.status === 'candidate').length;
  lines.push('', `${still} candidate(s) now await a verdict. Next: \`keel state phase hunt-prove\`, then one keel:prover each.`);
  return { ok: true, out: lines.join('\n') };
}

/* ------------------------------------------------------------------ prove */

function find(run_, id) { return run_.findings.find((f) => f.id === String(id).toUpperCase()); }

function prove(cfg, id, opts = {}) {
  const run_ = readRun(cfg);
  if (!run_) return { ok: false, out: 'no hunt open. Start one with `keel hunt start`.' };
  if (!id) return { ok: false, out: 'usage: keel hunt prove <id> --verdict proven|unproven|false --evidence "..." [--repro <file>] [--severity <s>]', usage: true };
  const f = find(run_, id);
  if (!f) return { ok: false, out: `no finding "${id}" in hunt ${run_.id}. \`keel hunt list\` shows them.` };
  if (f.status !== 'candidate') return { ok: false, out: `${f.id} is already ${f.status}; a verdict is recorded once.` };

  const verdict = String(opts.verdict || '').toLowerCase();
  if (!['proven', 'unproven', 'false'].includes(verdict)) {
    return { ok: false, out: 'usage: keel hunt prove <id> --verdict proven|unproven|false --evidence "..."', usage: true };
  }
  if (!opts.evidence || opts.evidence === true) {
    return { ok: false, out: 'every verdict needs --evidence: what was run, and what came back.', usage: true };
  }

  if (verdict === 'proven') {
    // A recipe file, not an evidence paragraph. Free prose is the "plausible prose" failure
    // this whole two-stage flow exists to prevent, and what travels into keel:reproducer has
    // to be something runnable rather than a summary a model re-renders from memory.
    if (!opts.repro || opts.repro === true) {
      return { ok: false, out: `a proven verdict needs --repro <file>: the command that makes ${f.id} fail on demand.\n`
        + `Store it under .keel/hunt/${run_.id}/repro/ as ${f.id}${RECIPE_EXTS.join(` or ${f.id}`)}.\n`
        + 'Without a recipe this is a claim, not a proof — record it as unproven instead.' };
    }
    const rel = String(opts.repro).replace(/^\.\//, '');
    const abs = path.isAbsolute(rel) ? rel : path.join(cfg.root, rel);
    const inside = path.relative(reproDir(cfg, run_.id), abs);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      return { ok: false, out: `the recipe must live under .keel/hunt/${run_.id}/repro/ so it travels with this run; got ${rel}.` };
    }
    if (!fs.existsSync(abs)) return { ok: false, out: `no such recipe: ${rel}` };
    if (!fs.readFileSync(abs, 'utf8').trim()) return { ok: false, out: `${rel} is empty. A recipe nobody can run is not a proof.` };
    const severity = String(opts.severity || '').toLowerCase();
    if (!SEVERITIES.includes(severity)) {
      return { ok: false, out: [`a proven verdict needs --severity ${SEVERITIES.join('|')}.`,
        'Judge it by impact and reachability, never by how bad the code looks:',
        ...SEVERITIES.slice().reverse().map((k) => `  ${k.padEnd(9)} ${(cfg.hunt.severity_rubric || {})[k] || ''}`)].join('\n') };
    }
    // The one rubric clause a program can check. A 5xx in the evidence or the recipe means the
    // rubric's `high` row applies, and a severity below it contradicts the rubric it was judged
    // against — which is how a 500 came back `moderate`.
    const floor = String(cfg.hunt.severity_floor_5xx || 'high').toLowerCase();
    const proofText = `${opts.evidence || ''}\n${fs.readFileSync(abs, 'utf8')}`;
    const shows5xx = /\b5\d\d\b/.test(proofText) || /internal server error/i.test(proofText);
    if (shows5xx && rank(severity) < rank(floor)) {
      return { ok: false, out: [`${f.id} shows a 5xx, so it cannot be filed as ${severity}.`,
        `The rubric puts that at ${floor}: "${(cfg.hunt.severity_rubric || {})[floor] || ''}".`,
        `Record it as ${floor} or above, or say in --evidence why the 5xx is not on a documented path.`].join('\n') };
    }
    f.severity = severity;
    f.repro = path.join('.keel', 'hunt', run_.id, 'repro', path.basename(abs));
  } else if (opts.repro && opts.repro !== true) {
    return { ok: false, out: `--repro belongs to a proven verdict; ${verdict} means there is no recipe to store.` };
  } else if (opts.severity && opts.severity !== true) {
    return { ok: false, out: `--severity belongs to a proven verdict: nothing has measured ${f.id}.` };
  }

  f.status = verdict;
  f.evidence = String(opts.evidence);
  f.verdict_note = opts.note && opts.note !== true ? String(opts.note) : null;
  f.proved_at = new Date().toISOString();
  f.proved_sha = gitOut('rev-parse HEAD', cfg.root, 'unknown');
  writeRun(cfg, run_);

  const left = run_.findings.filter((x) => x.status === 'candidate').length;
  const lines = [`${f.id}: ${verdict}${f.severity ? ` (${f.severity})` : ''}`];
  if (verdict === 'proven') lines.push(`recipe: ${f.repro}`);
  lines.push(left ? `${left} candidate(s) still have no verdict.`
    : 'every candidate has a verdict. Next: `keel state phase hunt-report`, group the causes, then `keel hunt report`.');
  return { ok: true, out: lines.join('\n') };
}

/* ------------------------------------------------------------------ group */

// One cause, many symptoms. Grouping deliberately happens at the report and not at ingest: a
// lens agent cannot see the other lenses' findings, so it cannot know it is looking at a
// symptom rather than a cause. One reader, with every verdict in, can.
function group(cfg, ids, opts = {}) {
  const run_ = readRun(cfg);
  if (!run_) return { ok: false, out: 'no hunt open. Start one with `keel hunt start`.' };
  if (!ids.length) return { ok: false, out: 'usage: keel hunt group <id...> --cause "<one sentence>" [--lead <id>]', usage: true };
  if (!opts.cause || opts.cause === true) return { ok: false, out: 'a group needs --cause "<one sentence>": what the single defect actually is.', usage: true };

  const members = [];
  for (const raw of ids) {
    const f = find(run_, raw);
    if (!f) return { ok: false, out: `no finding "${raw}" in hunt ${run_.id}.` };
    if (f.status !== 'proven') return { ok: false, out: `${f.id} is ${f.status}, not proven. Only proven findings can share a cause — grouping an unproven one would smuggle it into a fix.` };
    if (f.group) return { ok: false, out: `${f.id} already belongs to ${f.group}. A finding has one cause.` };
    members.push(f);
  }
  const lead = opts.lead && opts.lead !== true ? find(run_, opts.lead) : members[0];
  if (!lead) return { ok: false, out: `no finding "${opts.lead}" to lead the group.` };
  if (!members.includes(lead)) return { ok: false, out: `the lead ${lead.id} must be one of the grouped findings.` };

  const g = `G-${String(run_.next_group++).padStart(2, '0')}`;
  run_.groups[g] = { cause: String(opts.cause), lead: lead.id, at: new Date().toISOString() };
  for (const f of members) { f.group = g; f.group_role = f === lead ? 'cause' : 'symptom'; }
  writeRun(cfg, run_);
  return { ok: true, out: [`${g}: 1 cause, ${members.length - 1} symptom(s) — ${opts.cause}`,
    `lead ${lead.id}${lead.repro ? ` (${lead.repro})` : ''}`,
    `symptoms: ${members.filter((f) => f !== lead).map((f) => f.id).join(', ') || 'none'}`,
    '',
    '`keel hunt next` will hand this over as one fix, with the symptoms as extra regression criteria.'].join('\n') };
}

/* ------------------------------------------------------------------- next */

function reportCommitted(cfg, run_) {
  if (!run_.report) return { ok: false, why: 'the report has not been rendered yet' };
  const st_ = gitOut(`status --porcelain -- ${run_.report}`, cfg.root, '');
  if (st_.trim()) return { ok: false, why: `${run_.report} is uncommitted` };
  return { ok: true };
}

function next(cfg, opts = {}) {
  const run_ = readRun(cfg);
  if (!run_) return { ok: false, out: 'no hunt open. Start one with `keel hunt start`.' };
  const c = counts(run_);
  if (c.candidate && !c.proven) {
    return { ok: false, out: `${c.candidate} candidate(s) have no verdict and nothing is proven yet.\n`
      + 'Prove them first: one keel:prover each, then `keel hunt prove <id> --verdict ...`.' };
  }
  const open = openFindings(run_);
  if (!open.length) return { ok: true, out: 'nothing open. Every proven finding is dispatched or closed.' };

  // Rendered and committed, because `keel preflight` — step 0 of the fix flow this hands off
  // to — refuses a tree that is not clean.
  const committed = reportCommitted(cfg, run_);
  if (!committed.ok) {
    return { ok: false, out: `${committed.why}, and the fix flow starts with \`keel preflight\`, which refuses a dirty tree.\n`
      + (run_.report ? `  keel commit docs HUNT-${run_.id} "bug hunt: ${c.proven} proven, ${c.unproven} suspected"`
        : '  keel hunt report') };
  }

  // Highest severity first; a group is ranked by its worst member and taken as one unit.
  const ranked = open.slice().sort((a, b) => (rank(b.severity) - rank(a.severity)) || a.id.localeCompare(b.id));
  const top = ranked[0];
  const g = top.group;
  const members = g ? run_.findings.filter((f) => f.group === g) : [top];
  const meta = g ? run_.groups[g] : null;
  const lead = g ? find(run_, meta.lead) : top;
  const symptoms = members.filter((f) => f !== lead);

  const flow = lead.kind === 'unspecified' ? 'feature' : 'fix';
  const slug = `hunt-${lead.id.toLowerCase()}`;
  const lines = [];
  lines.push(g ? `${g} — ${meta.cause}` : `${top.id} — ${top.title}`);
  lines.push(`severity ${lead.severity} · lens ${lead.lens} · ${lead.where.join(', ')}`);
  lines.push('');
  lines.push(`lead ${lead.id}: ${lead.symptom}`);
  if (lead.repro) lines.push(`recipe: ${lead.repro}   <- give keel:reproducer THIS, not the claim`);
  if (lead.needs_e2e) {
    lines.push('', 'no end-to-end spec references this finding, so phase 4 of the fix flow is NOT optional here:',
      '  keel:e2e-author writes the regression spec and runs it (E2E-RESULT: pass|fail)');
  }
  if (symptoms.length) {
    lines.push('', 'symptoms of the same cause — carry these as extra regression criteria in the Gate F plan:');
    for (const s of symptoms) lines.push(`  ${s.id} ${s.severity.padEnd(8)} ${s.where.join(', ')}  ${s.title}`);
  }
  lines.push('', lead.kind === 'unspecified'
    ? 'This was never specified, so it is a feature rather than a defect:'
    : 'Start the fix flow:');
  lines.push(`  keel preflight ${slug} --prefix ${flow === 'fix' ? 'fix' : 'feat'}`);
  lines.push(`  keel state start ${flow}${flow === 'fix' ? ' --phase bug-report' : ''}`);
  lines.push(`  /keel:${flow} ${lead.symptom}`);
  if (!opts.take) lines.push('', 'Re-run with --take to record the dispatch, so the next `keel hunt next` moves on.');

  if (opts.take) {
    run_.dispatched.push({ group: g || null, finding: lead.id, flow, at: new Date().toISOString(), branch: `${flow === 'fix' ? 'fix' : 'feat'}/${slug}` });
    for (const f of members) f.dispatch = { flow, at: new Date().toISOString() };
    writeRun(cfg, run_);
    lines.push('', `recorded: ${g || lead.id} dispatched to the ${flow} flow. \`keel hunt close\` it when the fix merges.`);
  }
  return { ok: true, out: lines.join('\n') };
}

/* ------------------------------------------------------------------ close */

function close(cfg, id, opts = {}) {
  const run_ = readRun(cfg);
  if (!run_) return { ok: false, out: 'no hunt open. Start one with `keel hunt start`.' };
  const as = String(opts.as || '').toLowerCase();
  if (!id) return { ok: false, out: 'usage: keel hunt close <id|G-nn> --as fixed|accepted|wontfix --note "..."', usage: true };
  if (!['fixed', 'accepted', 'wontfix'].includes(as)) return { ok: false, out: 'usage: keel hunt close <id> --as fixed|accepted|wontfix --note "..."', usage: true };
  if (!opts.note || opts.note === true) return { ok: false, out: 'closing a finding needs --note "<why>": the record is the point.', usage: true };

  const key = String(id).toUpperCase();
  const members = /^G-/.test(key) ? run_.findings.filter((f) => f.group === key) : [find(run_, key)].filter(Boolean);
  if (!members.length) return { ok: false, out: `no finding or group "${id}" in hunt ${run_.id}.` };
  const already = members.filter((f) => f.close);
  if (already.length === members.length) return { ok: false, out: `${key} is already closed as ${members[0].close.as}.` };

  const at = new Date().toISOString();
  const sha = gitOut('rev-parse HEAD', cfg.root, 'unknown');
  // Never deleted, only marked. A hunt that forgets what it decided is a report again.
  for (const f of members) if (!f.close) f.close = { as, note: String(opts.note), at, sha };
  writeRun(cfg, run_);
  return { ok: true, out: `closed ${key} as ${as} (${members.length} finding(s)). ${openFindings(run_).length} still open.` };
}

/* ------------------------------------------------------------- candidates */

// `hunt.prove_concurrency` shipped in 0.8 as a number in the config that no code read — the skill
// asked the model to respect it, which is a wish, not a limit. This hands out at most that many
// candidate ids at a time, so the batch size is a thing the CLI decides.
function candidates(cfg, opts = {}) {
  const run_ = readRun(cfg);
  if (!run_) return { ok: false, out: 'no hunt open. Start one with `keel hunt start`.' };
  const waiting = run_.findings.filter((f) => f.status === 'candidate');
  if (!waiting.length) return { ok: true, out: 'no candidates waiting for a verdict.' };
  const limit = Math.max(1, Number(opts.batch === true ? cfg.hunt.prove_concurrency : (opts.batch || cfg.hunt.prove_concurrency)) || 4);
  const batch = waiting.slice(0, limit);
  return { ok: true, out: [`${batch.length} of ${waiting.length} candidate(s) — one keel:prover each, in parallel:`,
    ...batch.map((f) => `  ${f.id}  ${f.lens.padEnd(14)} ${f.where[0]}\n      ${f.symptom}`),
    '',
    waiting.length > batch.length
      ? `Prove these, then run \`keel hunt candidates --batch\` again for the next ${waiting.length - batch.length}.`
      : 'That is all of them.'].join('\n') };
}

/* -------------------------------------------------------------------- e2e */

function e2eFiles(cfg) {
  const root = path.join(cfg.root, (cfg.e2e || {}).dir || 'e2e');
  const out = [];
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const n of names) {
      const f = path.join(d, n.name);
      if (n.isDirectory()) { if (n.name !== 'node_modules') walk(f); continue; }
      if (/\.(spec|test)\.[tj]sx?$/.test(n.name)) out.push(f);
    }
  };
  walk(root);
  return out;
}

// Does any end-to-end spec mention this finding, or the files it cites? This answers "no spec
// references this", which is the honest question — not "this is untested", which nothing here can
// know. Crude on purpose: a wrong yes would be worse than a wrong no, so it looks for the finding
// id first and only then for the source basenames it names.
function e2eCoverage(cfg, finding) {
  const specs = e2eFiles(cfg);
  if (!specs.length) return { covered: false, by: null, none: true };
  const names = (finding.where || []).map((w) => path.basename(String(w).split(':')[0]).replace(/\.[^.]+$/, ''))
    .filter((n) => n.length > 3);
  for (const f of specs) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    if (text.includes(finding.id)) return { covered: true, by: path.relative(cfg.root, f), none: false };
    if (names.some((n) => text.includes(n))) return { covered: true, by: path.relative(cfg.root, f), none: false };
  }
  return { covered: false, by: null, none: false };
}

/* ----------------------------------------------------------------- report */

const sev = (f) => f.severity || '—';
// The committed report cites the copy beside it, not `.keel/hunt/…` — that directory is
// gitignored, so a reader handed the report could not run the proof it pointed at.
const reproCite = (f) => (f.repro ? path.join('repro', path.basename(f.repro)) : null);
const where = (f) => f.where.map((w) => `\`${w}\``).join(', ');

// One shape for every finding, in both reports: same labels, same order, same edges. A reader
// comparing eight findings should be scanning columns, not parsing eight paragraphs.
function findingBlock(run_, f, role) {
  const pad = (k) => `\`${k.padEnd(9)}\``;
  const L = [];
  L.push(`${pad('Where')} ${where(f)}`);
  L.push(`${pad('What')} ${f.symptom}`);
  if (f.impact) L.push(`${pad('Impact')} ${f.impact}`);
  if (f.repro) L.push(`${pad('Proof')} \`${reproCite(f)}\` — proved at \`${String(f.proved_sha).slice(0, 7)}\``);
  else if (f.status === 'candidate') L.push(`${pad('Proof')} none yet — nobody has tried to reproduce this`);
  if (f.evidence) L.push(`${pad('Evidence')} ${f.evidence}`);
  if (f.severity) L.push(`${pad('Severity')} ${f.severity}`);
  if (f.claim) L.push(`${pad('Claim')} ${f.claim} _(the lens agent's theory, not a verdict)_`);
  if ((f.also_found_by || []).length) L.push(`${pad('Also by')} ${f.also_found_by.join(', ')}`);
  if (role) L.push(`${pad('Role')} ${role} of its group`);
  if (f.needs_e2e) L.push(`${pad('E2E')} no spec references this finding`);
  if (f.close) L.push(`${pad('Closed')} ${f.close.as} — ${f.close.note}`);
  return L.map((l) => `- ${l}`);
}

// A finding's heading carries everything you sort by: id, severity, which lens and lane found it.
function findingHead(f) {
  const bits = [f.id, f.severity || (f.status === 'candidate' ? 'unmeasured' : '—'),
    `${f.lens}${f.lane && f.lane !== 'both' ? ':' + f.lane : ''}`, f.title];
  return `### ${bits.join(' · ')}`;
}

// Rendered from the backlog, never written by a model — which is what makes it reproducible and
// checkable. The only timestamp printed is the run's own `at`, so a second render of an
// unchanged backlog is byte-identical; a scenario asserts exactly that.
function render(cfg, run_) {
  const c = counts(run_);
  const open = openFindings(run_);
  const byId = (a, b) => a.id.localeCompare(b.id);
  const bySeverity = (a, b) => (rank(b.severity) - rank(a.severity)) || byId(a, b);

  const proven = run_.findings.filter((f) => f.status === 'proven' || (f.close && f.severity));
  const grouped = Object.keys(run_.groups || {}).sort();
  const ungrouped = proven.filter((f) => !f.group).sort(bySeverity);
  const suspected = run_.findings.filter((f) => f.status === 'unproven').sort(byId);
  const rejected = run_.findings.filter((f) => f.status === 'false').sort(byId);
  const closed = run_.findings.filter((f) => f.close).sort(byId);

  const L = [];
  L.push(`# Bug hunt — ${run_.at.slice(0, 10)}`, '');
  L.push(`Run \`${run_.id}\` · scope \`${run_.scope.mode}\`${run_.scope.paths.length ? ` (${run_.scope.paths.join(', ')})` : ''}`
    + ` · \`${String(run_.sha).slice(0, 7)}\` on \`${run_.branch}\` · started ${run_.at}`);
  L.push('');
  L.push(`Lenses confirmed by the user: ${(run_.lenses.confirmed || []).join(', ') || 'none'}`);
  L.push('');
  L.push(`Stack at the start of the hunt: services ${run_.stack.services} · api ${run_.stack.api} · web ${run_.stack.web}`);
  L.push('', '| status | count |', '|---|---|');
  L.push(`| proven | ${c.proven} |`);
  L.push(`| suspected — not reproduced | ${c.unproven} |`);
  L.push(`| rejected — not a bug | ${c.false} |`);
  L.push(`| closed | ${closed.length} |`);
  L.push(`| **open, proven, not yet dispatched** | **${open.length}** |`);
  L.push('');
  L.push('Only proven findings carry a severity. A suspected finding has none, because nothing');
  L.push('measured it — not because it is harmless.');

  if (grouped.length || ungrouped.length) {
    L.push('', '## Proven');
    for (const g of grouped) {
      const meta = run_.groups[g];
      const members = run_.findings.filter((f) => f.group === g);
      const lead = members.find((f) => f.group_role === 'cause') || members[0];
      const symptoms = members.filter((f) => f !== lead).sort(bySeverity);
      const worst = members.slice().sort(bySeverity)[0];
      L.push('', `### ${g} · ${sev(worst)} · ${meta.cause}`, '');
      L.push(`${members.length} findings, one cause. Fix the cause; carry the symptoms as regression criteria.`, '');
      L.push('', findingHead(lead), '');
      L.push(...findingBlock(run_, lead, 'cause'));
      if (symptoms.length) {
        L.push('', '| symptom | lens | severity | where | proved by |', '|---|---|---|---|---|');
        for (const s of symptoms) L.push(`| ${s.id} | ${s.lens} | ${sev(s)} | ${where(s)} | ${s.repro ? `\`${reproCite(s)}\`` : '—'} |`);
      }
    }
    for (const f of ungrouped) {
      L.push('', findingHead(f), '');
      L.push(...findingBlock(run_, f, null));
    }
  }

  if (suspected.length) {
    L.push('', '## Suspected — proposed, not reproduced', '');
    L.push('A verifier tried and could not make these fail. They are kept because an unproven');
    L.push('finding is not a disproven one. They carry no severity and are not dispatched.');
    for (const f of suspected) {
      L.push('', findingHead(f), '');
      L.push(...findingBlock(run_, f, null));
    }
  }

  if (rejected.length) {
    L.push('', '## Rejected — not a bug', '');
    for (const f of rejected) {
      L.push(`**${f.id}** · ${f.lens} · ${where(f)} — ${f.evidence}`, '');
    }
  }

  if (closed.length) {
    L.push('', '## Closed', '', '| id | as | note | at |', '|---|---|---|---|');
    for (const f of closed) L.push(`| ${f.id} | ${f.close.as} | ${f.close.note} | ${f.close.at.slice(0, 10)} |`);
  }

  L.push('', '---', '');
  // No `rev` here: it increments on every write, and report() writes — so printing it made a
  // second render of an unchanged backlog differ, which the determinism scenario caught.
  L.push(`Generated by \`keel hunt report\` from \`${path.join('.keel', 'hunt', run_.id, 'run.json')}\`.`);
  L.push('Do not hand-edit — rerun the command. Next: `keel hunt next`.');
  return L.join('\n') + '\n';
}

// What the lenses proposed, before anything has been measured. This renders *while* candidates
// exist, which the real report refuses to do — so the two can never be mistaken for one another,
// and every line here says so.
function renderCandidates(cfg, run_) {
  const byId = (a, b) => a.id.localeCompare(b.id);
  const cands = run_.findings.filter((f) => f.status === 'candidate').sort(byId);
  const done = run_.findings.filter((f) => f.status !== 'candidate');
  const pairs = sweepPairs(cfg, run_.lenses.confirmed || []);
  const swept = Object.keys(run_.lenses.swept || {});

  const L = [];
  L.push(`# Candidates — hunt ${run_.id}`, '');
  L.push('> **UNVERIFIED — proposed, not reproduced.** Nothing on this page has been run against');
  L.push('> anything. No severity here has been measured, because measuring is the next step.');
  L.push('> This is the page you read to decide what is worth proving.', '');
  L.push(`Run \`${run_.id}\` · \`${String(run_.sha).slice(0, 7)}\` on \`${run_.branch}\` · started ${run_.at}`, '');
  L.push(`Swept ${swept.length} of ${pairs.length} lens/lane pair(s).`);
  const missing = pairs.filter((x) => !swept.includes(x));
  if (missing.length) L.push(`Not swept yet: ${missing.join(', ')} — this page is incomplete.`);
  L.push('', `| | count |`, `|---|---|`);
  L.push(`| awaiting a verdict | ${cands.length} |`);
  L.push(`| already decided | ${done.length} |`);
  L.push('');

  if (!cands.length) {
    L.push('No candidates are awaiting a verdict.');
  } else {
    const byLens = {};
    for (const f of cands) (byLens[`${f.lens}:${f.lane || 'both'}`] ||= []).push(f);
    for (const key of Object.keys(byLens).sort()) {
      L.push('', `## ${key}`, '');
      for (const f of byLens[key]) {
        L.push(findingHead(f), '');
        L.push(...findingBlock(run_, f, null));
        L.push('');
      }
    }
  }
  L.push('', '---', '');
  L.push('Prove these with `keel hunt candidates --batch`, one `keel:prover` per candidate.');
  L.push('`keel hunt report` will refuse to render until every one of them has a verdict.');
  return L.join('\n') + '\n';
}

function report(cfg, opts = {}) {
  const run_ = readRun(cfg);
  if (!run_) return { ok: false, out: 'no hunt open. Start one with `keel hunt start`.' };
  // The refusal that makes the two-stage bar mechanical rather than advisory. `unproven` renders
  // in the suspected section — a verifier looked and failed. `candidate` means nobody looked,
  // and a report that mixes the two is the "plausible prose" this flow exists to prevent.
  if (opts.candidates) {
    const dir_ = reportDir(cfg, run_.id);
    fs.mkdirSync(dir_, { recursive: true });
    const rel = path.relative(cfg.root, path.join(dir_, 'candidates.md'));
    fs.writeFileSync(path.join(dir_, 'candidates.md'), renderCandidates(cfg, run_));
    const n = run_.findings.filter((f) => f.status === 'candidate').length;
    return { ok: true, out: [`wrote ${rel} — ${n} candidate(s), none of them verified.`,
      'Read it to decide what to prove. `keel hunt report` still refuses until every candidate has a verdict.'].join('\n') };
  }

  const unverdicted = run_.findings.filter((f) => f.status === 'candidate');
  if (unverdicted.length) {
    return { ok: false, out: `${unverdicted.length} finding(s) still have no verdict: ${unverdicted.map((f) => f.id).join(', ')}.\n`
      + 'A report is not a list of guesses. Send one keel:prover each, then:\n'
      + `  keel hunt prove ${unverdicted[0].id} --verdict proven|unproven|false --evidence "..."` };
  }
  if (!run_.findings.length) {
    // A hunt that found nothing still gets a report. That is a result.
    run_.report = null;
  }
  const dir_ = opts.out && opts.out !== true ? path.join(cfg.root, String(opts.out)) : reportDir(cfg, run_.id);
  // Which proven findings no spec mentions. Recorded on the finding so `hunt next` can carry it
  // into the fix flow, where writing a test is legal.
  let uncovered = 0;
  for (const f of run_.findings.filter((x) => x.status === 'proven')) {
    const cov = e2eCoverage(cfg, f);
    f.needs_e2e = !cov.covered;
    f.e2e_spec = cov.by || null;
    if (f.needs_e2e) uncovered++;
  }
  if (uncovered) {
    try {
      require('./ask').raise(cfg, 'e2e-cover', {
        question: `${uncovered} proven finding(s) have no end-to-end spec. Commission one each when they are fixed?`,
        because: 'a bug with no regression test is a bug that can come back unnoticed; `keel:e2e-author` writes and runs one in the fix flow',
        blocking: true, by: 'hunt:report',
      });
    } catch (e) { /* the report still stands */ }
  }

  const rel = path.relative(cfg.root, path.join(dir_, 'report.md'));
  fs.mkdirSync(dir_, { recursive: true });
  fs.writeFileSync(path.join(dir_, 'report.md'), render(cfg, run_));

  // Copy every proven finding's recipe in beside the report, so the committed artifact stands on
  // its own. "Proved by execution" is only worth printing if the reader can run it.
  const copied = [];
  for (const f of run_.findings.filter((x) => x.repro)) {
    const from = path.join(cfg.root, f.repro);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dir_, 'repro', path.basename(f.repro));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied.push(path.basename(f.repro));
  }
  run_.report = rel;
  writeRun(cfg, run_);
  const c = counts(run_);
  return { ok: true, out: [`wrote ${rel}` + (copied.length ? ` and ${copied.length} recipe(s) beside it` : ''),
    `${c.proven} proven · ${c.unproven} suspected · ${c.false} rejected · ${openFindings(run_).length} open`,
    '',
    'Commit it — `keel preflight` refuses a dirty tree, so an uncommitted report blocks the first fix:',
    `  keel commit docs HUNT-${run_.id} "bug hunt: ${c.proven} proven, ${c.unproven} suspected"`].join('\n') };
}

/* ----------------------------------------------------------------- resume */

// Where was I. Every step of a hunt records enough to answer that, and this is the one command
// that reads it all back and names the next thing to run.
function resume(cfg) {
  const run_ = readRun(cfg);
  if (!run_) return { ok: false, out: 'no hunt open. Start one with `keel hunt start`.' };
  const L = [`hunt ${run_.id} — ${String(run_.sha).slice(0, 7)} on ${run_.branch}, started ${run_.at}`, ''];

  if (!run_.lenses.confirmed) {
    L.push('The lens set is not confirmed, so nothing can be ingested yet.', '',
      `  keel hunt lenses --confirm ${run_.lenses.proposed.join(',')}`);
    return { ok: true, out: L.join('\n') };
  }

  const pairs = sweepPairs(cfg, run_.lenses.confirmed);
  const swept = Object.keys(run_.lenses.swept || {});
  const left = pairs.filter((x) => !swept.includes(x));
  L.push(`sweep    ${swept.length}/${pairs.length} lens\u00d7lane pair(s) ingested`);
  if (left.length) for (const x of left) L.push(`         still to send: keel:hunter ${x}`);

  const c = counts(run_);
  L.push(`prove    ${c.candidate} candidate(s) with no verdict, ${c.proven} proven, ${c.unproven} suspected, ${c.false} rejected`);
  L.push(`report   ${run_.report ? run_.report : 'not rendered'}`);
  const committed = run_.report ? reportCommitted(cfg, run_) : { ok: false };
  L.push(`open     ${openFindings(run_).length} proven finding(s) not yet dispatched or closed`);
  L.push('', 'next:');
  if (left.length) {
    L.push(`  send the ${left.length} remaining hunter(s), then: keel hunt add --lens <lens> --lane <lane> --json <file>`);
  } else if (c.candidate) {
    L.push('  keel hunt candidates --batch        # then one keel:prover each');
  } else if (!run_.report) {
    L.push('  keel hunt report');
  } else if (!committed.ok) {
    L.push(`  keel commit docs HUNT-${run_.id} "bug hunt: ${c.proven} proven, ${c.unproven} suspected"`);
  } else if (openFindings(run_).length) {
    L.push('  keel hunt next --take');
  } else {
    L.push('  nothing outstanding — every proven finding is dispatched or closed.');
  }
  return { ok: true, out: L.join('\n') };
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

module.exports = { start, lenses, add, prove, group, next, close, report, render, renderCandidates, list, status, candidates, resume, e2eCoverage,
  lanesFor, sweepPairs, laneOfPath, duplicateOf,
  readRun, readPointer, writeRun, counts, openFindings, reportCommitted, find,
  huntDir, reproDir, runFile, pointerFile, stripFence, validateCandidate,
  SEVERITIES, STATUSES, KINDS, RECIPE_EXTS };
