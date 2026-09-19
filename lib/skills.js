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
  spec: ['keel:ac-authoring'],
  red: ['testing'],
  green: ['architecture'],
  'bug-repro': ['testing', 'keel:debugging'],
  'bug-investigate': ['keel:debugging', 'architecture'],
  'bug-fix': ['architecture'],
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

// The reference file inside the architecture skill for a given style and lane.
function architectureReference(style, lane) {
  if (!style || style === 'unknown') return null;
  const suffix = lane === 'web' ? 'web' : 'kotlin';
  return `references/${style}-${suffix}.md`;
}

// E2E and SMOKE criteria are not a stack's business; they are always Playwright.
function resolve(cfg, phase, layer) {
  const lyr = String(layer || 'API').toUpperCase();
  const lane = lyr === 'WEB' ? 'web' : 'api';
  const wanted = PHASE_SKILLS[phase] || [];
  const pack = loadPack(PACK_FOR_LAYER[lyr]);
  const style = ((cfg.architecture || {}).modules || {})[lane === 'web' ? (cfg.frontend || {}).dir : (cfg.backend || {}).dir];
  const effectiveStyle = (style && style.style) || (cfg.architecture || {}).style;

  const out = [];
  for (const want of wanted) {
    if (want === 'testing') {
      const name = pack && pack.skills && pack.skills.testing;
      if (name) out.push({ skill: name, why: `${lyr} tests for the ${pack.name} stack` });
      else if (lyr === 'E2E' || lyr === 'SMOKE') out.push({ skill: 'keel:playwright', why: 'end-to-end tests' });
      continue;
    }
    if (want === 'architecture') {
      if (!effectiveStyle || effectiveStyle === 'unknown') {
        out.push({ skill: null, why: 'architecture.style is not set — run `keel arch detect`', skipped: true });
        continue;
      }
      out.push({ skill: 'keel:architecture', reference: architectureReference(effectiveStyle, lane),
        why: `placement for ${effectiveStyle}` });
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

module.exports = { resolve, format, loadPack, listPacks, PHASE_SKILLS, PACK_FOR_LAYER, architectureReference };
