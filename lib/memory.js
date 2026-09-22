'use strict';
// The knowledge base, and the one thing that was missing from it: a way to check a claim.
//
// `docs/knowledge/` is read back as project-specific authority. In GREEN and bug-fix it competes
// with the stack's own implementation skill and wins, because it is the local one — so a wrong
// entry does not merely fail to help, it instructs every future agent to copy a mistake. A repo
// was onboarded whose conventions.md recorded `@Valid @Min @Max` on a `@RequestParam` with no
// `@Validated` on the class as "the house pagination pattern". Spring ignores that silently. It
// was written down as a pattern to follow.
//
// Nothing here can tell whether a claim is *true*. What it can do is refuse the claims that are
// not even checkable: a citation that does not resolve, a template placeholder nobody replaced, a
// section written with no evidence at all, and a correctness-affecting rule with neither a proof
// nor an admission that it is unproven. Those are deterministic, and the deterministic parts are
// the parts that hold every time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { gitOut, readJson } = require('./util');

const SECTIONS = ['architecture', 'domain', 'conventions', 'data', 'integrations'];

// What each section is for, in the words the gate asks the question in. The menu is the gate:
// five librarians is the single most expensive thing init does, and choosing two of them was
// impossible before — `check` read the other three as *missing*, and a failing knowledge
// verdict blocks every push, so a partial base cost you the push gate.
const SECTION_BLURB = {
  architecture: 'the style the code follows, its layers and import boundaries',
  domain: 'the vocabulary, and which word means which table',
  conventions: 'the house patterns — how an endpoint, a test, a form is written here',
  data: 'the schema, the migrations, what is nullable and why',
  integrations: 'every outbound call, and what happens when it fails',
};

// A citation is a backticked path with a line number. Requiring the line is what keeps prose that
// merely mentions a file — or a URL, or a command — from being mistaken for evidence.
const CITATION = /`([A-Za-z0-9_@./-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?`/g;
const PLACEHOLDER = /\{\{[A-Z_]+\}\}/g;

function dir(cfg) { return path.join(cfg.root, 'docs', 'knowledge'); }
function sectionFile(cfg, name) { return path.join(dir(cfg), `${name}.md`); }
function verdictFile(cfg) { return path.join(cfg.root, '.keel', 'memory.json'); }

// A proof is a citation into a test, or a recipe a hunt's prover left behind. Both are things
// somebody ran; a citation into production code only proves the code says that.
function isProof(rel) {
  return /(^|\/)(test|tests)\//i.test(rel)
    || /(^|\/)src\/(test|integrationTest)\//.test(rel)
    || /Tests?\.(kt|java)$/.test(rel)
    || /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(rel)
    || /^\.keel\/hunt\/repro\//.test(rel);
}

function citationsIn(text) {
  const out = [];
  let m;
  CITATION.lastIndex = 0;
  while ((m = CITATION.exec(text)) !== null) {
    out.push({ raw: m[0], rel: m[1], line: Number(m[2]), end: m[3] ? Number(m[3]) : null });
  }
  return out;
}

function lineCount(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').length; } catch (e) { return null; }
}

// Which sections exist on disk right now.
function built(cfg) { return SECTIONS.filter((n) => fs.existsSync(sectionFile(cfg, n))); }

// Which sections this project has committed to maintaining. Three states that genuinely differ:
//   null  — never asked. `keel memory update` refuses, and that refusal is the gate.
//   []    — deliberately none for now (what a --fast init records).
//   [...] — a chosen subset; the rest read `not selected`, which is a fact and not a problem.
//
// A repository initialised before the gate existed has a knowledge base and no `selected` field.
// Treating that as "never asked" would fire the gate at somebody who already answered it by
// building the thing, so anything on disk counts as chosen.
function selection(cfg) {
  const v = readJson(verdictFile(cfg), null);
  if (v && Array.isArray(v.selected)) {
    // A section that exists is maintained whether or not it was chosen: it is read back as
    // project authority either way, so it cannot be dropped out of the check by a selection.
    return Array.from(new Set(v.selected.filter((n) => SECTIONS.includes(n)).concat(built(cfg))));
  }
  const onDisk = built(cfg);
  return onDisk.length ? onDisk : null;
}

// One section. Returns its problems and what it was able to count.
function checkSection(cfg, name) {
  const f = sectionFile(cfg, name);
  const problems = [];
  if (!fs.existsSync(f)) return { name, missing: true, problems: [`${name}.md is missing`], citations: 0, proofs: 0, unverified: 0 };
  const text = fs.readFileSync(f, 'utf8');
  const rel = path.join('docs', 'knowledge', `${name}.md`);

  // A placeholder that survived means the section was scaffolded and never written. The knowledge
  // scaffold is a raw byte copy — it substituted nothing before 0.9 — so this was the normal state
  // of a "complete" knowledge base.
  const left = text.match(PLACEHOLDER);
  if (left) {
    problems.push(`${rel}: ${left.length} template placeholder(s) never filled in: ${Array.from(new Set(left)).slice(0, 4).join(', ')}`);
  }

  const cites = citationsIn(text);
  for (const c of cites) {
    const target = path.join(cfg.root, c.rel);
    const lines = lineCount(target);
    if (lines === null) { problems.push(`${rel}: cites \`${c.rel}:${c.line}\`, which does not exist`); continue; }
    const last = c.end || c.line;
    if (last > lines) problems.push(`${rel}: cites \`${c.rel}:${last}\` but that file has ${lines} line(s)`);
  }

  // A section with no citations at all was written from memory. That is the failure, not a style.
  if (!cites.length) problems.push(`${rel}: no citations at all — every claim here is unsourced`);

  // Rules that decide whether code is correct need either a proof or an admission.
  const terms = ((cfg.memory || {}).proof_required_terms || []);
  let unverified = 0;
  if (terms.length) {
    text.split('\n').forEach((line, i) => {
      const hit = terms.find((t) => line.includes(t));
      if (!hit) return;
      if (/\bunverified:/i.test(line)) { unverified++; return; }
      const proven = citationsIn(line).some((c) => isProof(c.rel));
      if (!proven) {
        problems.push(`${rel}:${i + 1}: mentions ${hit} with no proof and no \`unverified:\` marker — `
          + 'cite a test or a .keel/hunt/repro/ recipe, or say it is unverified');
      }
    });
  }

  return { name, missing: false, problems,
    citations: cites.length, proofs: cites.filter((c) => isProof(c.rel)).length, unverified };
}

// `only` overrides the recorded selection; omit it and the recorded one is used. A section that
// is neither chosen nor present is reported `not selected` and contributes no problems — that is
// the whole of what makes a partial knowledge base legal. A section that is present is always
// checked, chosen or not.
function check(cfg, only) {
  const sel = only === undefined ? selection(cfg) : only;
  // Three states, and `null` is its own. Treating "nobody has answered the gate" as "all five
  // were chosen" made every absent section a problem, so a fast init — which legitimately has
  // no knowledge base yet — reported five defects for a question it had never been asked.
  // The gate keeps its teeth elsewhere: `keel memory update` still refuses while this is null.
  const unanswered = sel === null;
  const chosen = unanswered ? [] : sel;
  const sections = SECTIONS.map((n) => {
    if (chosen.includes(n) || fs.existsSync(sectionFile(cfg, n))) {
      return Object.assign(checkSection(cfg, n), { selected: chosen.includes(n) });
    }
    return { name: n, selected: false, notSelected: true, unanswered, missing: true,
      problems: [], citations: 0, proofs: 0, unverified: 0 };
  });
  const problems = sections.flatMap((s) => s.problems);
  return { pass: problems.length === 0, sections, problems, selected: chosen, unanswered };
}

// What the knowledge base currently says, as one hash. Freshness used to be `verdict.sha === HEAD`
// and nothing else, so `keel memory update` — which regenerates nothing — re-stamped an unread
// knowledge base as current on every commit.
function contentHash(cfg) {
  const h = crypto.createHash('sha1');
  for (const n of SECTIONS) {
    h.update(n);
    try { h.update(fs.readFileSync(sectionFile(cfg, n))); } catch (e) { h.update('<missing>'); }
  }
  return h.digest('hex').slice(0, 12);
}

// The placeholders keel can fill itself. The rest are the writer's job, and `check` refuses any
// that survive. Before 0.9 the scaffold substituted none of them, unlike every other template
// path in setup.js.
function substitute(cfg) {
  const arch = cfg.architecture || {};
  const stack = (cfg.backend && /gradle|kts?$/.test(String(cfg.backend.build || '')) ? 'kotlin-spring-testing' : 'web-testing');
  const values = {
    '{{ARCH_STYLE}}': arch.style || 'unknown',
    '{{ARCH_CONFIDENCE}}': arch.confidence || 'low',
    '{{ARCH_SOURCE}}': arch.source || 'detected',
    '{{COMMIT}}': gitOut('rev-parse --short HEAD', cfg.root, 'no commit — not a git repository'),
    '{{DATE}}': new Date().toISOString().slice(0, 10),
    '{{SECTIONS}}': SECTIONS.join(', '),
    '{{BACKEND}}': (cfg.backend || {}).dir || '.',
    '{{FRONTEND}}': (cfg.frontend || {}).dir || '.',
    '{{CONTRACT}}': (cfg.contract || {}).file || '—',
    '{{TESTING_SKILL}}': stack,
  };
  const filled = [];
  for (const n of SECTIONS.concat(['index'])) {
    const f = sectionFile(cfg, n);
    if (!fs.existsSync(f)) continue;
    const before = fs.readFileSync(f, 'utf8');
    let after = before;
    for (const [k, v] of Object.entries(values)) after = after.split(k).join(v);
    if (after !== before) { fs.writeFileSync(f, after); filled.push(n); }
  }
  return filled;
}

module.exports = { SECTIONS, SECTION_BLURB, built, selection, check, checkSection, citationsIn, isProof, contentHash, substitute,
  dir, sectionFile, verdictFile, CITATION, PLACEHOLDER };
