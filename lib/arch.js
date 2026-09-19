'use strict';
const { moduleDir } = require('./util');
// Architecture detection. Deterministic on purpose: a model asked "is this hexagonal?"
// will confidently answer from a handful of filenames, where a score over weighted
// evidence is reproducible and can show its working.
const fs = require('fs');
const path = require('path');

const STYLES = ['hexagonal', 'ddd', 'layered', 'mvc', 'feature-sliced'];

function walk(root, dir, limit = 1500) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, d), { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (['node_modules', 'build', 'target', '.git', 'dist', 'generated'].includes(e.name)) continue;
      const rel = d === '' ? e.name : d + '/' + e.name;
      if (e.isDirectory()) stack.push(rel);
      else out.push(rel);
    }
  }
  return out;
}

const read = (root, rel) => {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (e) { return ''; }
};

/* --------------------------------------------------------------- evidence */

// Weight 3: something in the repo states the intent outright.
// `files` are paths relative to the repo root, already including `dir`.
function declaredEvidence(cfg, dir, files) {
  const hits = [];
  const builds = files.filter((f) => /build\.gradle(\.kts)?$/.test(f));
  for (const b of builds) {
    const text = read(cfg.root, b);
    if (!text) continue;
    const label = b.replace(dir.replace(/\/$/, '') + '/', '');
    if (/archunit|konsist/i.test(text)) hits.push({ w: 3, styles: ['hexagonal', 'ddd'], why: `${label} depends on an architecture test library` });
    if (/spring-modulith/i.test(text)) hits.push({ w: 3, styles: ['ddd'], why: `${label} uses spring-modulith` });
    // A *sub*module with no framework dependency is the strongest signal there is: domain
    // code that cannot see Spring was separated deliberately. The module's own root build
    // file says nothing, since it configures the whole app.
    const isSubmodule = label.includes('/');
    if (isSubmodule && !/org\.springframework|jakarta\.persistence|javax\.persistence/.test(text)) {
      hits.push({ w: 3, styles: ['hexagonal', 'ddd'], why: `${label} declares no framework dependency` });
    }
  }
  return hits;
}

// Weight 2: the shape of the package tree.
function structuralEvidence(dir, files) {
  const hits = [];
  const segs = new Set();
  for (const f of files) for (const s of f.split('/')) segs.add(s.toLowerCase());
  const has = (...names) => names.every((n) => segs.has(n));
  const any = (...names) => names.some((n) => segs.has(n));

  if (any('adapter', 'adapters') && segs.has('domain')) hits.push({ w: 2, styles: ['hexagonal'], why: 'domain/ beside adapter/' });
  if (segs.has('domain') && any('application', 'usecase', 'usecases')) hits.push({ w: 2, styles: ['hexagonal', 'ddd'], why: 'domain/ beside application/' });
  if (any('port', 'ports')) hits.push({ w: 2, styles: ['hexagonal'], why: 'an explicit ports/ package' });
  if (has('controller', 'service', 'repository')) hits.push({ w: 2, styles: ['layered'], why: 'role-first roots: controller/ service/ repository/' });
  if (segs.has('controller') && !segs.has('service')) hits.push({ w: 2, styles: ['mvc'], why: 'controllers with no service layer' });
  if (files.some((f) => /Aggregate|AggregateRoot/.test(f))) hits.push({ w: 2, styles: ['ddd'], why: 'aggregate types by name' });
  if (any('features') && any('entities', 'shared', 'widgets')) hits.push({ w: 2, styles: ['feature-sliced'], why: 'features/ beside entities/ or shared/' });
  if (any('components') && any('hooks') && !segs.has('features')) hits.push({ w: 2, styles: ['layered'], why: 'components/ and hooks/ with no features/' });
  return hits;
}

// Weight 2: measurements rather than names. Domain purity is the discriminator that
// separates a real hexagon from a directory tree that merely looks like one.
function statisticalEvidence(cfg, dir, files) {
  const hits = [];
  const source = files.filter((f) => /\.(kt|java)$/.test(f));
  const domain = source.filter((f) => /(^|\/)(domain|model)\//i.test(f));
  if (domain.length >= 3) {
    let pure = 0;
    let annotatedEntities = 0;
    for (const f of domain) {
      const text = read(cfg.root, f);
      const imports = text.split('\n').filter((l) => /^\s*import\s/.test(l));
      const touchesFramework = imports.some((l) => /org\.springframework|jakarta\.|javax\.persistence/.test(l));
      if (!touchesFramework) pure++;
      if (/@Entity|@Table|@Service|@Component/.test(text)) annotatedEntities++;
    }
    const ratio = pure / domain.length;
    if (ratio > 0.9) hits.push({ w: 2, styles: ['hexagonal', 'ddd'], why: `${Math.round(ratio * 100)}% of domain files are framework-free` });
    else if (ratio < 0.5 && annotatedEntities > 0) hits.push({ w: 2, styles: ['layered'], why: `only ${Math.round(ratio * 100)}% of domain files are framework-free, and they carry Spring or JPA annotations` });
  }
  // Interfaces declared in domain/application whose implementations live in adapters.
  const ports = source.filter((f) => /(^|\/)(domain|application)\//i.test(f) &&
    /\binterface\s+\w+/.test(read(cfg.root, f)));
  const impls = source.filter((f) => /(^|\/)(adapter|adapters|infrastructure)\//i.test(f));
  if (ports.length >= 2 && impls.length >= 2) {
    hits.push({ w: 2, styles: ['hexagonal'], why: `${ports.length} interfaces in domain/application with implementations under adapter/` });
  }
  // Where the persistence annotation sits says which side owns the mapping.
  const annotated = source.filter((f) => /@Entity\b/.test(read(cfg.root, f)));
  if (annotated.length) {
    const inAdapters = annotated.filter((f) => /(adapter|adapters|infrastructure|persistence)\//i.test(f)).length;
    if (inAdapters / annotated.length > 0.7) hits.push({ w: 2, styles: ['hexagonal'], why: '@Entity sits under adapter/persistence, not on domain types' });
    else if (annotated.some((f) => /(^|\/)(domain|model)\//i.test(f))) hits.push({ w: 2, styles: ['layered'], why: '@Entity sits directly on domain types' });
  }
  return hits;
}

/* ------------------------------------------------------------------ score */

function scoreModule(cfg, dir) {
  const files = walk(cfg.root, moduleDir(dir));
  if (!files.length) return null;
  const hits = [...declaredEvidence(cfg, dir, files), ...structuralEvidence(dir, files), ...statisticalEvidence(cfg, dir, files)];
  const scores = {};
  for (const s of STYLES) scores[s] = 0;
  for (const h of hits) for (const s of h.styles) scores[s] = (scores[s] || 0) + h.w;

  const ranked = STYLES.map((s) => [s, scores[s]]).sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const [runnerUp, runnerScore] = ranked[1];

  if (!topScore) {
    return { style: 'unknown', confidence: 'low', scores, evidence: [], hybrid_with: null,
      why: 'no architectural signal found' };
  }
  const declaredAgrees = hits.some((h) => h.w === 3 && h.styles.includes(top));
  const close = runnerScore > 0 && (topScore - runnerScore) / topScore < 0.2;
  const confidence = close ? 'low' : declaredAgrees ? 'high' : 'medium';

  return {
    style: top,
    confidence,
    // A hybrid is the normal case in a real codebase; recording it beats pretending.
    hybrid_with: close ? runnerUp : null,
    scores,
    evidence: hits.map((h) => `${h.why} (w${h.w})`),
  };
}

// Detect per module, because a monorepo's backend and frontend rarely share a style.
function detect(cfg) {
  const modules = {};
  for (const dir of [cfg.backend && cfg.backend.dir, cfg.frontend && cfg.frontend.dir].filter(Boolean)) {
    const r = scoreModule(cfg, dir);
    if (r) modules[dir] = r;
  }
  const keys = Object.keys(modules);
  if (!keys.length) {
    return { style: 'unknown', confidence: 'low', source: 'detected', modules: {}, evidence: ['no source directories found'] };
  }
  // The top level reports the backend's style when there is one: it is where the
  // architecture question actually bites.
  const lead = modules[(cfg.backend && cfg.backend.dir)] || modules[keys[0]];
  return {
    style: lead.style,
    confidence: lead.confidence,
    source: 'detected',
    hybrid_with: lead.hybrid_with || undefined,
    modules,
    evidence: Object.entries(modules).flatMap(([d, m]) => m.evidence.map((e) => `${d}: ${e}`)).slice(0, 12),
  };
}

/* -------------------------------------------------------- recommendation */

// Greenfield. The default is layered and it takes a real reason to leave it: most
// projects that adopt DDD do not have the contexts to justify it.
function recommend(answers = {}) {
  const multiYear = /multi|year|long/i.test(String(answers.lifespan || ''));
  const logicHeavy = /rule|logic|complex/i.test(String(answers.nature || ''));
  const contexts = Number(answers.contexts || 0);
  const team = Number(answers.team || 1);
  const integrations = Number(answers.integrations || 0);
  const testableWithoutFramework = !!answers.testable_without_framework;

  if (answers.spike) return { style: 'mvc', why: 'a spike: the simplest thing that runs' };
  if (contexts >= 2 && logicHeavy && team >= 3 && multiYear) {
    return { style: 'ddd', why: `${contexts} named bounded contexts, logic-heavy, team of ${team}, multi-year` };
  }
  if (multiYear && (integrations >= 2 || testableWithoutFramework)) {
    return { style: 'hexagonal', why: integrations >= 2
      ? `multi-year with ${integrations} external integrations` : 'multi-year, and the rules must be testable without the framework' };
  }
  const notes = [];
  if (contexts < 2) notes.push('fewer than two bounded contexts you can name');
  if (!logicHeavy) notes.push('more data-moving than rules-heavy');
  if (team < 3) notes.push(`a team of ${team}`);
  return { style: 'layered', why: 'nothing argues for more structure than this',
    ddd_not_recommended: notes.length ? `DDD not recommended: ${notes.join(', ')}` : undefined };
}

/* ---------------------------------------------------------- boundary rules */

// Default import boundaries per style, written into config so `keel verify arch` and the
// generated ArchUnit/eslint configs all read one source.
function defaultBoundaries(style, cfg) {
  const api = (cfg.backend && cfg.backend.dir) || 'apps/api';
  const web = (cfg.frontend && cfg.frontend.dir) || 'apps/web';
  if (style === 'hexagonal' || style === 'ddd') {
    return [{ name: 'domain-framework-free', from: `${api}/**/domain/**`,
      deny_imports: ['org.springframework.**', 'jakarta.persistence.**', 'javax.persistence.**'] }];
  }
  if (style === 'feature-sliced') {
    return [{ name: 'feature-isolation', from: `${web}/src/features/*/**`,
      deny_imports: ['@/features/**'], allow_imports: ['@/shared/**', '@/entities/**'] }];
  }
  if (style === 'layered') {
    return [{ name: 'no-controller-in-repository', from: `${api}/**/repository/**`,
      deny_imports: ['**.controller.**'] }];
  }
  return [];
}

module.exports = { detect, scoreModule, recommend, defaultBoundaries, STYLES };
