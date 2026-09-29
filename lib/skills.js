'use strict';
// Which skills a phase should load, resolved by (phase x AC layer). Phase alone is not
// enough: RED on an [API] criterion needs Kotlin/Spring test patterns, RED on a [WEB] one
// needs frontend patterns, and loading both wastes the context the split exists to save.
const fs = require('fs');
const path = require('path');
const { parseYaml, moduleDir } = require('./util');

// The fallback when nothing in stacks/*.yml matches a lane's directory at all — an
// unconfigured or empty repo, not a repo keel has failed to recognise. A real stack always
// wins over this the moment its detect: block matches.
const DEFAULT_PACK_FOR_LANE = { api: 'kotlin-spring', web: 'ts-react' };

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
  // Only hunt-prove. A phase-wide list cannot be right for the sweep, where six lenses run at
  // once — telling the test-integrity lens to load keel:security is noise. Per-lens routing
  // lives in the hunt skill's references/lenses.md, where it can be precise.
  'hunt-prove': ['keel:debugging'],
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
//
// `pack` decides the suffix (kotlin-spring -> kotlin, symfony -> php, either React pack ->
// web) via the pack's own `arch_ref_suffix`, so a new backend stack gets its own reference
// files by declaring the suffix, rather than this function hardcoding one language per lane —
// which is exactly the bug that had a Symfony project reading `hexagonal-kotlin.md`.
function architectureReference(style, lane, pack) {
  if (!style || style === 'unknown') return null;
  const dir = path.join(__dirname, '..', 'skills', 'architecture', 'references');
  const suffix = (pack && pack.arch_ref_suffix) || (lane === 'web' ? 'web' : 'kotlin');
  const candidates = [`${style}-${suffix}.md`, `${style}.md`];
  for (const name of candidates) {
    if (fs.existsSync(path.join(dir, name))) return `references/${name}`;
  }
  return null;
}

// Every pack whose lane and detect: block actually match this lane's directory. This is the
// same probe packCommands/packBoundaries already use per-pack; here it decides which ONE pack
// a layer's testing/implementation skill comes from, so a new stacks/*.yml file is enough to
// add a stack — nothing here needs to name it.
function packsForLane(cfg, lane) {
  const dir = lane === 'web' ? (cfg.frontend || {}).dir : (cfg.backend || {}).dir;
  if (!dir) return [];
  return listPacks()
    .map((name) => loadPack(name))
    .filter((p) => p && p.lane === lane && packApplies(cfg, p, dir));
}

// Which pack a lane resolves to, and why — an explicit config override, the one pack that
// matched, several that matched (ambiguous — a real state once two stacks coexist on purpose,
// see stacks/README.md), or the old fixed default when nothing on disk matches at all.
function resolvePackForLane(cfg, lane) {
  const key = lane === 'web' ? 'frontend_stack' : 'backend_stack';
  const override = (cfg.architecture || {})[key];
  if (override) {
    const name = Array.isArray(override) ? override[0] : override;
    const pack = loadPack(name);
    if (pack) return { pack, why: `architecture.${key}: ${name}` };
  }
  const matches = packsForLane(cfg, lane);
  if (matches.length === 1) return { pack: matches[0] };
  if (matches.length > 1) {
    const names = matches.map((p) => p.name).join(', ');
    return { pack: null, ambiguous: names,
      why: `${names} all match the ${lane} lane — set architecture.${key} to pick one` };
  }
  const name = DEFAULT_PACK_FOR_LANE[lane];
  return { pack: loadPack(name), defaulted: true,
    why: `no stack detected for the ${lane} lane — defaulting to ${name}` };
}

// E2E and SMOKE criteria are not a stack's business; they are always Playwright.
function resolve(cfg, phase, layer) {
  const lyr = String(layer || 'API').toUpperCase();
  const lane = lyr === 'WEB' ? 'web' : 'api';
  const wanted = PHASE_SKILLS[phase] || [];
  const laneRes = (lyr === 'E2E' || lyr === 'SMOKE') ? { pack: null } : resolvePackForLane(cfg, lane);
  const pack = laneRes.pack;
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
      // Ambiguous is not "no skill" — say so, rather than silently teaching nothing.
      else if (laneRes.ambiguous) out.push({ skill: null, why: laneRes.why, skipped: true });
      continue;
    }
    if (want === 'implementation') {
      // Only some stacks have an implementation skill; a pack without one is not an error.
      const name = pack && pack.skills && pack.skills.implementation;
      if (name) out.push({ skill: name, why: `how ${pack.name} code is written` });
      else if (laneRes.ambiguous) out.push({ skill: null, why: laneRes.why, skipped: true });
      continue;
    }
    if (want === 'architecture') {
      if (!effectiveStyle || effectiveStyle === 'unknown') {
        out.push({ skill: null, why: 'architecture.style is not set — run `keel arch detect`', skipped: true });
        continue;
      }
      const ref = architectureReference(effectiveStyle, lane, pack);
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
// Does this pack's `detect:` block actually match the module directory it claims?
function packApplies(cfg, pack, dir) {
  const d = pack.detect;
  if (!d) return true; // a pack with no opinion keeps the old behaviour
  const base = moduleDir(dir) ? path.join(cfg.root, moduleDir(dir)) : cfg.root;
  // A negative signal, checked first: two packs can otherwise both want the same directory —
  // a plain-JS and a TypeScript React pack both see `react` in package.json. `exclude_files`
  // is how a pack says "not if this is also true", so react-js.yml can mean "React, and no
  // tsconfig.json" without ts-react and react-js becoming ambiguous on every TS project.
  for (const f of d.exclude_files || []) {
    if (fs.existsSync(path.join(base, f))) return false;
  }
  for (const f of d.files || []) {
    if (fs.existsSync(path.join(base, f))) return true;
  }
  // A dependency name in package.json — more reliable than sniffing file extensions for a
  // stack like plain-JS React, where the source files' extension alone (.js) is shared with
  // every other kind of JavaScript project and proves nothing on its own.
  if ((d.package_deps || []).length) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
      const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
      if (d.package_deps.some((name) => deps[name])) return true;
    } catch (e) { /* no package.json, or unparsable — fall through to extensions */ }
  }
  const exts = d.extensions || [];
  if (!exts.length) return false;
  const walk = (p, depth) => {
    if (depth > 3) return false;
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return false; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'build' || e.name === 'dist') continue;
      const full = path.join(p, e.name);
      if (e.isDirectory()) { if (walk(full, depth + 1)) return true; }
      else if (exts.some((x) => e.name.endsWith(x))) return true;
    }
    return false;
  };
  return walk(base, 0);
}

function packCommands(cfg) {
  const out = {};
  for (const name of listPacks()) {
    const pack = loadPack(name);
    if (!pack || !pack.commands) continue;
    const dir = pack.lane === 'web' ? (cfg.frontend || {}).dir : (cfg.backend || {}).dir;
    if (!dir) continue;
    // A pack declares how to recognise itself; gating only on `dir` ignored that, and since
    // backend.dir and frontend.dir always have defaults, EVERY pack always applied — so a
    // repo with no Kotlin was handed `detekt ktlintCheck` and `flywayMigrate`.
    if (!packApplies(cfg, pack, dir)) continue;
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
  packsForLane, resolvePackForLane, packApplies,
  PHASE_SKILLS, DEFAULT_PACK_FOR_LANE, architectureReference };
