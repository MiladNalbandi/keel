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

// Where packs come from, most specific first. A pack installed for this project beats one
// installed on the machine, which beats the ones that ship with keel — so a project can pin or
// override a stack without touching anything global, and keel still works with nothing
// installed at all. `KEEL_STACKS_DIR` overrides the built-in root the same way
// `KEEL_AGENT_DIR` overrides the agents directory, so the scenarios can point at a throwaway copy.
function builtinDir() { return process.env.KEEL_STACKS_DIR || path.join(__dirname, '..', 'stacks'); }

function packRoots(cfg) {
  const roots = [];
  if (cfg && cfg.root) roots.push({ dir: path.join(cfg.root, '.keel', 'stacks'), source: 'project' });
  try { roots.push({ dir: path.join(require('./projects').home(), 'stacks'), source: 'home' }); } catch (e) { /* no home */ }
  roots.push({ dir: builtinDir(), source: 'builtin' });
  return roots;
}

// A pack file inside one root, in any of the three shapes a root may hold: a flat `<name>.yml`
// (how the built-ins ship), a directory `<name>/stack.yml` (one pack with its own skills and
// templates beside it), or a cloned multi-stack repo `<repo>/stacks/<name>.yml` with sibling
// `skills/` and `templates/`. The pack's directory is what everything pack-relative resolves
// against, so it is returned with the file rather than re-derived by each caller.
function packFilesIn(root) {
  const found = [];
  let entries = [];
  try { entries = fs.readdirSync(root.dir, { withFileTypes: true }); } catch (e) { return found; }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.yml') && e.name !== 'stack.yml') {
      found.push({ name: e.name.replace(/\.yml$/, ''), file: path.join(root.dir, e.name), dir: root.dir, source: root.source });
      continue;
    }
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const sub = path.join(root.dir, e.name);
    const single = path.join(sub, 'stack.yml');
    if (fs.existsSync(single)) { found.push({ name: e.name, file: single, dir: sub, source: root.source }); continue; }
    let inner = [];
    try { inner = fs.readdirSync(path.join(sub, 'stacks')); } catch (err) { inner = []; }
    for (const f of inner) {
      if (!f.endsWith('.yml')) continue;
      found.push({ name: f.replace(/\.yml$/, ''), file: path.join(sub, 'stacks', f), dir: sub, source: root.source });
    }
  }
  return found;
}

// A pack keel did not ship cannot be trusted to be well formed: `parseYaml` never throws and
// never returns null — it skips lines it cannot read — so a truncated or half-cloned file
// parses to `{}`, and `packApplies` treats a pack with no `detect:` as matching everything.
// A broken install would then claim every directory and contribute its commands. Shape-check
// anything from outside, and say which file was wrong rather than half-loading it.
function packProblem(pack, entry) {
  if (!pack || typeof pack !== 'object') return 'could not be read';
  if (!pack.name) return 'declares no name:';
  if (pack.lane !== 'api' && pack.lane !== 'web') return `declares lane: ${pack.lane || '(none)'} — must be api or web`;
  const d = pack.detect || {};
  if (!(d.files || []).length && !(d.extensions || []).length && !(d.package_deps || []).length) {
    return 'declares no detect: signals, so it would match every project';
  }
  return null;
}

// Every pack keel can see, resolved by name with the first root that has it winning.
function packEntries(cfg) {
  const byName = new Map();
  for (const root of packRoots(cfg)) {
    for (const entry of packFilesIn(root)) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
  }
  return byName;
}

function readPackFile(entry) {
  let pack = null;
  try { pack = parseYaml(fs.readFileSync(entry.file, 'utf8')); } catch (e) { return null; }
  if (!pack) return null;
  if (entry.source !== 'builtin') {
    const problem = packProblem(pack, entry);
    if (problem) { packWarnings.push(`${entry.name} (${entry.file}) ${problem}`); return null; }
  }
  // `dir` and `source` travel with the pack: skill files, architecture references and starter
  // templates are all resolved against the directory the pack was installed into.
  return Object.assign({}, pack, { dir: entry.dir, file: entry.file, source: entry.source });
}

// Packs that were skipped, for the commands that should say so. Reset per resolution pass so a
// long-running process does not accumulate the same warning forever.
let packWarnings = [];
function takePackWarnings() { const w = packWarnings; packWarnings = []; return w; }

function loadPack(name, cfg) {
  if (!name) return null;
  const entry = packEntries(cfg).get(name);
  return entry ? readPackFile(entry) : null;
}

function listPacks(cfg) { return Array.from(packEntries(cfg).keys()); }

// The full entry (name, file, dir, source) for every pack, for `keel packs list`.
function listPackEntries(cfg) { return Array.from(packEntries(cfg).values()); }

// The reference file inside the architecture skill for a given style and lane. Checked
// against disk: naming one by convention alone pointed at references/layered-web.md, which
// does not exist, and a skill told to read a missing file is worse than one told nothing.
//
// `pack` decides the suffix (kotlin-spring -> kotlin, symfony -> php, either React pack ->
// web) via the pack's own `arch_ref_suffix`, so a new backend stack gets its own reference
// files by declaring the suffix, rather than this function hardcoding one language per lane —
// which is exactly the bug that had a Symfony project reading `hexagonal-kotlin.md`.
// An installed pack may ship its own references (`arch_refs: references` in its yaml), which are
// checked before keel's own — that is what lets a Symfony pack carry `hexagonal-php.md` without
// keel having to hold a file for a language it does not ship. A pack-shipped reference is
// returned as an absolute path, because it is outside the architecture skill's own directory;
// keel's own are returned relative to that skill, as they always were.
function architectureReference(style, lane, pack) {
  if (!style || style === 'unknown') return null;
  const suffix = (pack && pack.arch_ref_suffix) || (lane === 'web' ? 'web' : 'kotlin');
  const candidates = [`${style}-${suffix}.md`, `${style}.md`];
  if (pack && pack.dir && pack.arch_refs) {
    const packRefs = path.join(pack.dir, pack.arch_refs);
    for (const name of candidates) {
      const p = path.join(packRefs, name);
      if (fs.existsSync(p)) return p;
    }
  }
  const dir = path.join(__dirname, '..', 'skills', 'architecture', 'references');
  for (const name of candidates) {
    if (fs.existsSync(path.join(dir, name))) return `references/${name}`;
  }
  return null;
}

// What to tell the agent to load for a pack's testing or implementation guidance.
//
// A pack that ships with keel names a `keel:` skill, which Claude Code resolves. An installed
// pack names a FILE, because there is no way for keel to reach into another plugin's install
// directory — that path is versioned and Claude Code rejects component paths outside a plugin's
// own root. So the file is what always works, in any harness; `skills:` on an installed pack is
// advisory, for someone who also installed its plugin half and wants the native invocation.
function packSkill(pack, kind) {
  if (!pack) return null;
  const declaredFile = (pack.skill_files || {})[kind];
  if (declaredFile && pack.dir) {
    const p = path.join(pack.dir, declaredFile);
    if (fs.existsSync(p)) return { skill: p, file: true };
  }
  const name = (pack.skills || {})[kind];
  return name ? { skill: name, file: false } : null;
}

// Every pack whose lane and detect: block actually match this lane's directory. This is the
// same probe packCommands/packBoundaries already use per-pack; here it decides which ONE pack
// a layer's testing/implementation skill comes from, so a new stacks/*.yml file is enough to
// add a stack — nothing here needs to name it.
// The web lane is optional, so a blank frontend.dir means there is no frontend — the reading
// verify.js and guards.js already use. The backend lane is not optional, and a blank backend.dir
// means the module IS the repository root: a single-module project, which is exactly what a Django
// project, or a Symfony one that is not in a subdirectory, looks like. Reading that as "absent"
// meant no pack could ever be detected there, so every single-module project silently fell back to
// kotlin-spring and got none of its own commands, tools or schema snapshot.
function laneDir(cfg, lane) {
  const dir = lane === 'web' ? (cfg.frontend || {}).dir : (cfg.backend || {}).dir;
  if (lane === 'web' && !String(dir || '').trim()) return null;
  return String(dir || '');
}

function packsForLane(cfg, lane) {
  const dir = laneDir(cfg, lane);
  if (dir === null) return [];
  return listPacks(cfg)
    .map((name) => loadPack(name, cfg))
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
    const pack = loadPack(name, cfg);
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
  return { pack: loadPack(name, cfg), defaulted: true,
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
      const hit = packSkill(pack, 'testing');
      if (hit) out.push({ skill: hit.skill, file: hit.file, why: `${lyr} tests for the ${pack.name} stack` });
      else if (lyr === 'E2E' || lyr === 'SMOKE') out.push({ skill: 'keel:playwright', why: 'end-to-end tests' });
      // Ambiguous is not "no skill" — say so, rather than silently teaching nothing.
      else if (laneRes.ambiguous) out.push({ skill: null, why: laneRes.why, skipped: true });
      continue;
    }
    if (want === 'implementation') {
      // Only some stacks have an implementation skill; a pack without one is not an error.
      const hit = packSkill(pack, 'implementation');
      if (hit) out.push({ skill: hit.skill, file: hit.file, why: `how ${pack.name} code is written` });
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
  for (const name of listPacks(cfg)) {
    const pack = loadPack(name, cfg);
    if (!pack || !pack.commands) continue;
    const dir = laneDir(cfg, pack.lane);
    if (dir === null) continue;
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

// Tools a pack contributes, with {BUILD} and {DIR} resolved the same way commands are. Unlike
// `static_checks` — the one command key that concatenates so neither lane's lint is dropped — a
// tool is named, so two packs offering the same name is first-wins. Concatenating two formatters
// into `a && b` would run both over the same files, which is not what either meant.
function packTools(cfg) {
  const out = {};
  for (const name of listPacks(cfg)) {
    const pack = loadPack(name, cfg);
    if (!pack || !pack.tools) continue;
    const dir = laneDir(cfg, pack.lane);
    if (dir === null) continue;
    if (!packApplies(cfg, pack, dir)) continue;
    const build = (cfg.backend || {}).build || './gradlew';
    for (const [key, raw] of Object.entries(pack.tools)) {
      if (out[key]) continue;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      // {FILES} and {FILE} are deliberately left alone: they are filled at run time with the
      // paths keel matched, which this function cannot know.
      const def = Object.assign({}, raw);
      def.run = String(raw.run || '').replace(/\{BUILD\}/g, build).replace(/\{DIR\}/g, dir);
      // A pack's tool runs in its own lane's directory unless it said otherwise, so a web pack's
      // formatter does not run at the repository root and format the backend too.
      if (def.dir === undefined) def.dir = dir;
      out[key] = def;
    }
  }
  return out;
}

// Boundary rules a style implies, per pack, with {DIR} resolved.
function packBoundaries(cfg, style) {
  const rules = [];
  for (const name of listPacks(cfg)) {
    const pack = loadPack(name, cfg);
    const set = pack && pack.boundary_defaults && pack.boundary_defaults[style];
    if (!set) continue;
    const dir = laneDir(cfg, pack.lane);
    if (dir === null) continue;
    for (const rule of set) {
      rules.push(Object.assign({}, rule, { from: String(rule.from).replace(/\{DIR\}/g, dir) }));
    }
  }
  return rules;
}

module.exports = { resolve, format, loadPack, listPacks, listPackEntries, packCommands, packTools, packBoundaries,
  packsForLane, resolvePackForLane, packApplies, packSkill, packRoots, takePackWarnings,
  PHASE_SKILLS, DEFAULT_PACK_FOR_LANE, architectureReference };
