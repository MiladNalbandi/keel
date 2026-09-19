'use strict';
// Which skills a phase should load, resolved by (phase x AC layer). Phase alone is not
// enough: RED on an [API] criterion needs Kotlin/Spring test patterns, RED on a [WEB] one
// needs frontend patterns, and loading both wastes the context the split exists to save.
const fs = require('fs');
const path = require('path');
const { parseYaml } = require('./util');

// Layer -> which stack pack covers it.
const PACK_FOR_LAYER = { API: 'kotlin-spring', WEB: 'ts-react', E2E: null, SMOKE: null };

// Phase -> what to load, before the stack pack fills in the concrete skill names.
// 'testing' and 'architecture' are resolved against the pack; a literal is taken as-is.
const PHASE_SKILLS = {
  spec: ['keel:spec-authoring'],
  red: ['testing'],
  // GREEN needs both: where the code goes (architecture) and how it is written for this
  // stack (implementation). Architecture alone left the frontend with placement rules and
  // no construction guidance at all.
  green: ['architecture', 'implementation'],
  'bug-repro': ['testing', 'keel:debugging'],
  'bug-investigate': ['keel:debugging', 'architecture'],
  'bug-fix': ['architecture', 'implementation'],
  'coverage-fix': ['testing'],
  security: ['keel:security'],
  e2e: ['keel:playwright'],
  smoke: ['keel:playwright'],
  ship: ['architecture'],
};

function packDir() { return path.join(__dirname, '..', 'stacks'); }

function loadPack(name) {
  if (!name) return null;
  try { return parseYaml(fs.readFileSync(path.join(packDir(), `${name}.yml`), 'utf8')); } catch (e) { return null; }
}

function listPacks() {
  try {
    return fs.readdirSync(packDir()).filter((f) => f.endsWith('.yml')).map((f) => f.replace(/\.yml$/, ''));
  } catch (e) { return []; }
}

// The reference file inside the architecture skill for a given style and lane. Checked
// against disk: naming one by convention alone pointed at references/layered-web.md, which
// does not exist, and a skill told to read a missing file is worse than one told nothing.
function architectureReference(style, lane) {
  if (!style || style === 'unknown') return null;
  const dir = path.join(__dirname, '..', 'skills', 'architecture', 'references');
  const candidates = lane === 'web'
    ? [`${style}-web.md`, `${style}.md`]
    : [`${style}-kotlin.md`, `${style}.md`];
  for (const name of candidates) {
    if (fs.existsSync(path.join(dir, name))) return `references/${name}`;
  }
  return null;
}

// E2E and SMOKE criteria are not a stack's business; they are always Playwright.
function resolve(cfg, phase, layer) {
  const lyr = String(layer || 'API').toUpperCase();
  const lane = lyr === 'WEB' ? 'web' : 'api';
  const wanted = PHASE_SKILLS[phase] || [];
  const pack = loadPack(PACK_FOR_LAYER[lyr]);
  // A module's own detected style wins — but only when it is a real one. A module that
  // scored 'unknown' must not override a style the user set for the whole project.
  const mod = ((cfg.architecture || {}).modules || {})[lane === 'web' ? (cfg.frontend || {}).dir : (cfg.backend || {}).dir];
  const modStyle = mod && mod.style !== 'unknown' ? mod.style : null;
  const effectiveStyle = modStyle || (cfg.architecture || {}).style;

  const out = [];
  for (const want of wanted) {
    if (want === 'testing') {
      const name = pack && pack.skills && pack.skills.testing;
      if (name) out.push({ skill: name, why: `${lyr} tests for the ${pack.name} stack` });
      else if (lyr === 'E2E' || lyr === 'SMOKE') out.push({ skill: 'keel:playwright', why: 'end-to-end tests' });
      continue;
    }
    if (want === 'implementation') {
      // Only some stacks have an implementation skill; a pack without one is not an error.
      const name = pack && pack.skills && pack.skills.implementation;
      if (name) out.push({ skill: name, why: `how ${pack.name} code is written` });
      continue;
    }
    if (want === 'architecture') {
      if (!effectiveStyle || effectiveStyle === 'unknown') {
        out.push({ skill: null, why: 'architecture.style is not set — run `keel arch detect`', skipped: true });
        continue;
      }
      const ref = architectureReference(effectiveStyle, lane);
      out.push({ skill: 'keel:architecture', reference: ref,
        why: ref ? `placement for ${effectiveStyle}`
          : `placement — no ${effectiveStyle} reference for the ${lane} lane; the skill routes on style` });
      continue;
    }
    out.push({ skill: want, why: `phase ${phase}` });
  }

  // A project override always wins: phases: { red: { API: [...] } }
  const override = ((cfg.phases || {})[phase] || {});
  const explicit = override[lyr] || override['*'];
  if (explicit && explicit.length) {
    return explicit.map((s) => ({ skill: s, why: `phases.${phase} override` }));
  }
  return out;
}

function format(cfg, phase, layer) {
  const items = resolve(cfg, phase, layer);
  if (!items.length) return `no skills declared for phase "${phase}".`;
  return items.map((i) => {
    if (i.skipped) return `  (none) — ${i.why}`;
    return `  ${i.skill}${i.reference ? ' → ' + i.reference : ''}   ${i.why}`;
  }).join('\n');
}

// Command defaults from the stack packs, with the pack's placeholders filled in. Without
// this the packs declared commands that nothing read, and `static_checks` — which
// `verify full` requires — shipped empty, so lint never ran on a fresh project.
function packCommands(cfg) {
  const out = {};
  for (const name of listPacks()) {
    const pack = loadPack(name);
    if (!pack || !pack.commands) continue;
    const dir = pack.lane === 'web' ? (cfg.frontend || {}).dir : (cfg.backend || {}).dir;
    if (!dir) continue;
    const build = (cfg.backend || {}).build || './gradlew';
    for (const [key, raw] of Object.entries(pack.commands)) {
      const value = String(raw).replace(/\{BUILD\}/g, build).replace(/\{DIR\}/g, dir);
      // Two packs both offer static_checks; join them so neither app's lint is dropped.
      if (out[key] && key === 'static_checks' && out[key] !== value) out[key] = `${out[key]} && ${value}`;
      else if (!out[key]) out[key] = value;
    }
  }
  return out;
}

// Boundary rules a style implies, per pack, with {DIR} resolved.
function packBoundaries(cfg, style) {
  const rules = [];
  for (const name of listPacks()) {
    const pack = loadPack(name);
    const set = pack && pack.boundary_defaults && pack.boundary_defaults[style];
    if (!set) continue;
    const dir = pack.lane === 'web' ? (cfg.frontend || {}).dir : (cfg.backend || {}).dir;
    if (!dir) continue;
    for (const rule of set) {
      rules.push(Object.assign({}, rule, { from: String(rule.from).replace(/\{DIR\}/g, dir) }));
    }
  }
  return rules;
}

module.exports = { resolve, format, loadPack, listPacks, packCommands, packBoundaries,
  PHASE_SKILLS, PACK_FOR_LAYER, architectureReference };
