'use strict';
// The project map: one artefact, keyed to a commit, that the dashboard draws.
//
// Everything here is assembly. The reading is done by lib/contract.js, lib/schema.js and
// lib/symbols.js, each of which reports what it could not read; this module arranges what they
// found into levels, solves the geometry, and stamps the result with the sha and the content hash
// it was built from.
//
// Geometry is solved here, at build time, rather than per request. mcp/view.js:96 explains why the
// flow graph's geometry is server-side — "so the layout is deterministic and a scenario can assert
// it" — and a built artefact is more of both: deterministic, pinned to a sha, and readable by a
// scenario straight off disk with no state to reconstruct. It also matters that the input is the
// user's tree rather than a constant: re-solving five levels on every dashboard frame would re-walk
// the source on a page somebody leaves open all day.
//
// The flow graph's own router (mcp/view.js#edgePath) is not reused. It bows every off-spine edge
// into a left gutter and addresses nodes by phase/row/col, which is the right shape for a rail and
// the wrong one for swimlanes and a schema. Two routers, one renderer: the renderer is the part
// worth sharing, and mcp/ui.js#renderGraph does that job for both.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const contract = require('./contract');
const schema = require('./schema');
const symbols = require('./symbols');
const { gitOut, readJson, writeJson } = require('./util');

const MAP_FILE = '.keel/map.json';

// Box metrics. One row of text is 18 units, which is what keeps a node's height a function of what
// it says rather than a magic number per level.
const B = { HEAD: 30, SUB: 16, ROW: 18, PAD: 10 };

function boxH(n) {
  return B.HEAD + (n.sub ? B.SUB : 0) + ((n.rows || []).length * B.ROW) + B.PAD;
}

/* ------------------------------------------------------------------ router */

// An orthogonal elbow: out of one box, along a bend, into the next. `bend` is where on the run the
// turn happens, so two edges between the same two columns can be told apart.
function elbow(a, b, bend) {
  const ah = a.h;
  const bh = b.h;
  if (b.x > a.x + a.w) {
    const x1 = a.x + a.w;
    const y1 = a.y + ah / 2;
    const x2 = b.x;
    const y2 = b.y + bh / 2;
    const mx = round(x1 + (x2 - x1) * bend);
    return `M ${round(x1)} ${round(y1)} H ${mx} V ${round(y2)} H ${round(x2 - 7)}`;
  }
  if (b.y > a.y + ah) {
    const xa = round(a.x + a.w / 2);
    const ya = a.y + ah;
    const xb = round(b.x + b.w / 2);
    const my = round(ya + (b.y - ya) * bend);
    return `M ${xa} ${round(ya)} V ${my} H ${xb} V ${round(b.y - 7)}`;
  }
  // Right to left, wrapping under both boxes rather than cutting back through them.
  const rx = a.x + a.w;
  const ry = a.y + ah / 2;
  const tx = b.x + b.w;
  const ty = b.y + bh / 2;
  const my = round(Math.max(a.y + ah, b.y + bh) + 26);
  return `M ${round(rx)} ${round(ry)} H ${round(rx + 22)} V ${my} H ${round(tx + 22)} V ${round(ty + 7)}`;
}

function round(n) { return Math.round(Number(n) * 10) / 10; }

// A column of boxes at a fixed x, stacked top to bottom. Every level here is columns of boxes, so
// this is the only placement primitive the map needs.
function column(nodes, x, top, w, gap) {
  let y = top;
  for (const n of nodes) {
    n.x = x;
    n.w = w;
    n.h = boxH(n);
    n.y = y;
    y += n.h + gap;
  }
  return y;
}

function extent(nodes, pad) {
  let w = 0;
  let h = 0;
  for (const n of nodes) {
    w = Math.max(w, n.x + n.w);
    h = Math.max(h, n.y + n.h);
  }
  return { width: w + pad, height: h + pad };
}

function edgesOf(pairs, byId) {
  const out = [];
  for (const p of pairs) {
    const a = byId[p.from];
    const b = byId[p.to];
    if (!a || !b) continue;
    out.push({ from: p.from, to: p.to, kind: p.kind, label: p.label || '', d: elbow(a, b, p.bend == null ? 0.5 : p.bend) });
  }
  return out;
}

/* ----------------------------------------------------------------- modules */

const ROLE_SEGMENT = /^(domain|application|usecase|use_case|adapter|adapters|port|ports|infrastructure|web|persistence)$/;

// A module is a directory, which is the limit worth stating: a project whose modularity is not a
// directory gets the endpoint-prefix fallback instead, and says so.
function moduleFromPath(rel) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (ROLE_SEGMENT.test(parts[i])) return parts[i - 1];
  }
  return null;
}

function moduleFromEndpoint(e) {
  if (e.tags && e.tags.length) return String(e.tags[0]);
  const seg = String(e.path).split('/').filter(Boolean)[0] || '';
  return seg.replace(/[{}]/g, '') || null;
}

function modulesOf(cfg, eps, decls) {
  const byName = new Map();
  const take = (name) => {
    if (!name) return null;
    if (!byName.has(name)) byName.set(name, { name, endpoints: [], classes: [], source: null });
    return byName.get(name);
  };
  let fromDirs = 0;
  for (const d of decls) {
    const m = moduleFromPath(d.cite.rel);
    if (!m) continue;
    fromDirs++;
    take(m).classes.push(d);
  }
  for (const e of eps) {
    const m = moduleFromEndpoint(e);
    const bucket = take(m);
    if (bucket) bucket.endpoints.push(e);
  }
  // With no role directories anywhere, every class would land in no module at all. Put them with
  // the module their file name suggests, and if that fails, in one honest "unsorted" bucket.
  if (!fromDirs) {
    for (const d of decls) {
      const hit = Array.from(byName.keys()).find((n) => d.name.toLowerCase().startsWith(n.replace(/s$/, '')));
      take(hit || 'unsorted').classes.push(d);
    }
  }
  const list = Array.from(byName.values());
  for (const m of list) m.source = fromDirs ? 'directories' : 'endpoint paths';
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ levels */

function systemLevel(cfg, parts) {
  const nodes = [];
  const pairs = [];
  const hasWeb = fs.existsSync(path.join(cfg.root, cfg.frontend.dir || ''));
  if (hasWeb) {
    nodes.push({ id: 'app:web', kind: 'app', title: 'web', sub: cfg.frontend.dir,
      rows: [{ t: `${parts.web.length} declaration(s)` }], cite: null });
  }
  nodes.push({ id: 'app:api', kind: 'app', title: 'api', sub: parts.style ? `${cfg.backend.dir} · ${parts.style}` : cfg.backend.dir,
    rows: [{ t: `${parts.modules.length} module(s)` }, { t: `${parts.eps.endpoints.length} endpoint(s)` }],
    cite: null, drill: 'modules' });
  if (parts.db.tables.length) {
    nodes.push({ id: 'db:main', kind: 'data', title: 'database', sub: 'from the migrations',
      rows: [{ t: `${parts.db.tables.length} table(s)` }], cite: null, drill: 'er' });
  }
  if (parts.q.queues.length || parts.q.broker) {
    nodes.push({ id: 'mq:main', kind: 'queue', title: parts.q.broker ? parts.q.broker.name : 'queues',
      sub: parts.q.broker ? 'from the compose file' : 'from the publish sites',
      rows: [{ t: `${parts.q.queues.length} queue(s)` }], cite: parts.q.broker ? parts.q.broker.cite : null });
  }
  if (parts.c.crons.length) {
    nodes.push({ id: 'cron:all', kind: 'ext', title: 'scheduled', sub: 'jobs this repo declares',
      rows: [{ t: `${parts.c.crons.length} job(s)` }], cite: null });
  }

  const col1 = nodes.filter((n) => n.id === 'app:web');
  const col2 = nodes.filter((n) => n.id === 'app:api');
  const col3 = nodes.filter((n) => !col1.includes(n) && !col2.includes(n));
  column(col1, 30, 120, 190, 20);
  column(col2, 290, 100, 220, 20);
  column(col3, 600, 30, 200, 26);

  if (hasWeb) pairs.push({ from: 'app:web', to: 'app:api', kind: 'http', label: 'REST', bend: 0.5 });
  let bend = 0.3;
  for (const n of col3) {
    pairs.push({ from: 'app:api', to: n.id, kind: n.kind === 'data' ? 'sql' : n.kind === 'queue' ? 'queue' : 'call', bend });
    bend = Math.min(0.75, bend + 0.16);
  }
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  return Object.assign({ nodes, edges: edgesOf(pairs, byId) }, extent(nodes, 20));
}

function modulesLevel(parts) {
  const nodes = [];
  const pairs = [];
  for (const m of parts.modules) {
    nodes.push({ id: `mod:${m.name}`, kind: 'app', title: m.name, sub: `module · from ${m.source}`,
      rows: m.endpoints.slice(0, 6).map((e) => ({ t: `${e.method} ${e.path}` }))
        .concat(m.endpoints.length > 6 ? [{ t: `${m.endpoints.length - 6} more…` }] : []),
      cite: m.endpoints.length ? m.endpoints[0].cite : (m.classes[0] || {}).cite || null,
      drill: 'classes', module: m.name });
  }
  const right = [];
  for (const t of parts.db.tables) {
    right.push({ id: `tbl:${t.name}`, kind: 'data', title: t.name, sub: 'table',
      rows: [{ t: `${t.columns.length} column(s)` }], cite: t.cite });
  }
  for (const q of parts.q.queues) {
    right.push({ id: `q:${q.name}`, kind: 'queue', title: q.name, sub: q.listen ? 'consumed' : 'published', rows: [], cite: q.cite });
  }
  column(nodes, 30, 30, 290, 18);
  column(right, 640, 30, 240, 14);

  // An edge from a module to a table it writes needs a call graph keel does not have. What it does
  // have is the module a class sits in and the tables a migration declares; so the edge drawn is
  // "this module names this table", which is honest and is what the legend says.
  const all = nodes.concat(right);
  const byId = {};
  for (const n of all) byId[n.id] = n;
  for (const m of parts.modules) {
    const hay = m.classes.map((c) => c.name.toLowerCase()).join(' ') + ' ' + m.name.toLowerCase();
    let bend = 0.34;
    for (const t of parts.db.tables) {
      if (!hay.includes(t.name.toLowerCase().replace(/_/g, ''))
        && !hay.includes(t.name.toLowerCase())
        && !m.name.toLowerCase().startsWith(t.name.toLowerCase().slice(0, 4))) continue;
      pairs.push({ from: `mod:${m.name}`, to: `tbl:${t.name}`, kind: 'sql', bend });
      bend = Math.min(0.72, bend + 0.09);
    }
    for (const q of parts.q.queues) {
      const inModule = m.classes.some((c) => c.cite.rel === q.cite.rel);
      if (inModule) pairs.push({ from: `mod:${m.name}`, to: `q:${q.name}`, kind: 'queue', label: q.listen ? 'consume' : 'publish', bend });
    }
  }
  return Object.assign({ nodes: all, edges: edgesOf(pairs, byId) }, extent(all, 20));
}

// Capped per module. A 400-class module drawn whole is not a diagram, it is a wall; the overflow
// count is what the page renders as "23 more…".
const CLASS_CAP = 60;

function classesLevel(parts) {
  const byModule = {};
  for (const m of parts.modules) {
    const shown = m.classes.slice(0, CLASS_CAP);
    const nodes = shown.map((c) => ({
      id: `cls:${c.name}`, kind: c.role === 'port' ? 'port' : 'class', title: c.name,
      sub: `${c.kind} · ${c.role}`,
      rows: c.tests.length ? [{ t: `${c.tests.length} test file(s)` }] : [],
      cite: c.cite, tests: c.tests, module: m.name,
    }));
    const byRole = ['adapter · in', 'application', 'port', 'domain', 'adapter · out', 'ui', 'other'];
    let x = 24;
    for (const role of byRole) {
      const col = nodes.filter((n) => n.sub.endsWith(role));
      if (!col.length) continue;
      column(col, x, 30, 200, 16);
      x += 228;
    }
    const byId = {};
    for (const n of nodes) byId[n.id] = n;
    const pairs = [];
    for (const c of shown) {
      for (const imp of c.imports) {
        if (!byId[`cls:${imp}`]) continue;
        pairs.push({ from: `cls:${c.name}`, to: `cls:${imp}`, kind: 'call', label: 'imports', bend: 0.5 });
      }
    }
    byModule[m.name] = Object.assign({ nodes, edges: edgesOf(pairs, byId), overflow: Math.max(0, m.classes.length - CLASS_CAP) },
      extent(nodes, 20));
  }
  return { byModule };
}

function erLevel(parts) {
  const nodes = parts.db.tables.map((t) => ({
    id: `tbl:${t.name}`, kind: 'data', title: t.name, sub: `${t.columns.length} column(s)`,
    rows: t.columns.slice(0, 14).map((c) => ({ t: `${c.name}  ${c.type}`, flag: c.pk ? 'pk' : c.fk ? 'fk' : null })),
    cite: t.cite, columns: t.columns,
  }));
  const perCol = Math.max(1, Math.ceil(nodes.length / 3));
  for (let i = 0; i < 3; i++) {
    column(nodes.slice(i * perCol, (i + 1) * perCol), 30 + i * 300, 30, 250, 24);
  }
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  const pairs = [];
  for (const t of parts.db.tables) {
    for (const fk of t.fks) {
      if (!byId[`tbl:${fk.to}`] || fk.to === t.name) continue;
      pairs.push({ from: `tbl:${fk.to}`, to: `tbl:${t.name}`, kind: 'fk', label: '1 : n', bend: 0.5 });
    }
  }
  return Object.assign({ nodes, edges: edgesOf(pairs, byId) }, extent(nodes, 20));
}

/* ------------------------------------------------------------- the artefact */

// Hashes the inputs, not the output, for the same reason memory.contentHash does (lib/memory.js:164):
// freshness keyed only to HEAD re-stamps an unchanged map as current on every commit, and a map
// rebuilt from edited sources at the same commit must read as changed.
function contentHash(cfg) {
  const h = crypto.createHash('sha1');
  const add = (rel) => {
    h.update(rel);
    try { h.update(fs.readFileSync(path.join(cfg.root, rel))); } catch (e) { h.update('<missing>'); }
  };
  if (cfg.contract && cfg.contract.file) add(cfg.contract.file);
  for (const f of schema.tables(cfg).files) add(f);
  for (const dir of [cfg.backend.dir, cfg.frontend.dir]) {
    for (const rel of symbols.sources(cfg, dir)) {
      let size = 0;
      try { size = fs.statSync(path.join(cfg.root, rel)).size; } catch (e) { size = -1; }
      h.update(`${rel}:${size}`);
    }
  }
  return h.digest('hex').slice(0, 12);
}

function build(cfg) {
  const eps = contract.endpoints(cfg);
  const db = schema.tables(cfg);
  const q = symbols.queues(cfg);
  const c = symbols.crons(cfg);
  const api = symbols.declarations(cfg, cfg.backend.dir);
  const web = symbols.declarations(cfg, cfg.frontend.dir);
  const style = (cfg.architecture && cfg.architecture.style !== 'unknown') ? cfg.architecture.style : null;
  const modules = modulesOf(cfg, eps.endpoints, api);
  const parts = { eps, db, q, c, api, web, modules, style };

  const nodes = {};
  for (const e of eps.endpoints) {
    nodes[`ep:${e.method.toLowerCase()}:${e.path}`] = { kind: 'endpoint', label: `${e.method} ${e.path}`,
      module: moduleFromEndpoint(e), operationId: e.operationId, cite: e.cite };
  }
  for (const t of db.tables) nodes[`tbl:${t.name}`] = { kind: 'table', label: t.name, columns: t.columns, cite: t.cite };
  for (const x of q.queues) nodes[`q:${x.name}`] = { kind: 'queue', label: x.name, listen: x.listen, cite: x.cite };
  for (const x of c.crons) nodes[`cron:${x.name}`] = { kind: 'cron', label: x.name, schedule: x.schedule, source: x.source, cite: x.cite };
  for (const d of api.concat(web)) nodes[`cls:${d.name}`] = { kind: 'class', label: d.name, role: d.role, tests: d.tests, cite: d.cite };

  return {
    sha: gitOut('rev-parse HEAD', cfg.root, null),
    content: contentHash(cfg),
    at: new Date().toISOString(),
    demo: false,
    sources: {
      contract: eps.file || null,
      migrations: db.files,
      compose: (cfg.stack && cfg.stack.compose) || null,
      scanned: symbols.sources(cfg, cfg.backend.dir).length + symbols.sources(cfg, cfg.frontend.dir).length,
      skipped: [].concat(eps.skipped, db.skipped, q.skipped, c.skipped),
    },
    limits: [
      'endpoints come from the contract, not from the code',
      'tables come from the migrations, so an ORM-generated schema is invisible',
      'a queue is a literal name at a publish or listen site',
      'class edges are imports, not calls',
      modules.length && modules[0].source === 'endpoint paths'
        ? 'modules are grouped by endpoint path, because no role directories were found'
        : 'a module is a directory',
    ],
    counts: {
      modules: modules.length, endpoints: eps.endpoints.length, tables: db.tables.length,
      queues: q.queues.length, crons: c.crons.length, classes: api.length + web.length,
    },
    nodes,
    levels: {
      system: systemLevel(cfg, parts),
      modules: modulesLevel(parts),
      classes: classesLevel(parts),
      er: erLevel(parts),
    },
  };
}

function file(cfg) { return path.join(cfg.root, MAP_FILE); }

function read(cfg) { return readJson(file(cfg), null); }

// The bundled example. It is a real `build()` of a fictional project rather than a hand-written
// sample, so its shape can never drift from what a real map looks like — and a scenario can hold
// it to the same geometry invariants.
function demo() {
  const m = readJson(path.join(__dirname, '..', 'templates', 'map.json'), null);
  if (m) m.demo = true;
  return m;
}

// What the dashboard draws: this project's map, or the example when there is none. `read` stays
// the honest accessor — `check` must never be handed the demo and asked to resolve its citations
// against somebody else's repo.
function forDashboard(cfg, opts = {}) {
  if (opts.demo) return demo();
  return read(cfg) || demo();
}

function write(cfg, map) { writeJson(file(cfg), map); return map; }

// Does every node still point at a line that exists? This is what makes "checks citations" in the
// rebuild a real step rather than a decorative one, and it uses the same rule memory.check does:
// a citation past the end of its file is as wrong as one to a file that is gone.
function check(cfg, map) {
  const m = map || read(cfg);
  if (!m) return { pass: false, problems: ['no map has been built. Run `keel map build`.'], checked: 0 };
  const problems = [];
  const lines = new Map();
  let checked = 0;
  for (const [id, n] of Object.entries(m.nodes || {})) {
    if (!n.cite || !n.cite.rel) continue;
    checked++;
    const rel = n.cite.rel;
    if (!lines.has(rel)) {
      try { lines.set(rel, fs.readFileSync(path.join(cfg.root, rel), 'utf8').split('\n').length); } catch (e) { lines.set(rel, -1); }
    }
    const count = lines.get(rel);
    if (count < 0) problems.push(`${id} cites ${rel}, which does not exist`);
    else if (n.cite.line > count) problems.push(`${id} cites ${rel}:${n.cite.line}, past the end of a ${count}-line file`);
  }
  return { pass: problems.length === 0, problems, checked };
}

// Three honest states, the same three `keel memory` reports: current; built at this commit but the
// sources have changed since; behind by N commits.
function verdict(cfg) {
  const m = read(cfg);
  if (!m) return { exists: false, reason: 'no map has been built' };
  const head = gitOut('rev-parse HEAD', cfg.root, null);
  const behind = m.sha && head && m.sha !== head
    ? Number(gitOut(`rev-list --count ${m.sha}..HEAD`, cfg.root, '0')) || 0
    : 0;
  const contentChanged = m.content !== contentHash(cfg);
  const stale = Boolean((head && m.sha !== head) || contentChanged);
  const reason = !stale ? 'the map matches HEAD'
    : m.sha !== head
      ? `built ${behind || 'some'} commit(s) ago${contentChanged ? ', and the sources have changed since' : ''}`
      : 'built at this commit, but the sources it read have changed since';
  return { exists: true, sha: m.sha, head, behind, contentChanged, stale, reason, counts: m.counts, demo: Boolean(m.demo) };
}

module.exports = { build, read, write, check, verdict, demo, forDashboard, contentHash, file, MAP_FILE, CLASS_CAP, boxH, elbow, column };
