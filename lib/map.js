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
const infra = require('./infra');
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
    const flat = Math.abs(y1 - y2) < 2;
    return { d: `M ${round(x1)} ${round(y1)} H ${mx} V ${round(y2)} H ${round(x2 - 7)}`,
      lx: flat ? round((x1 + x2) / 2) : mx, ly: flat ? round(y1 - 7) : round((y1 + y2) / 2) };
  }
  if (b.y > a.y + ah) {
    const xa = round(a.x + a.w / 2);
    const ya = a.y + ah;
    const xb = round(b.x + b.w / 2);
    const my = round(ya + (b.y - ya) * bend);
    return { d: `M ${xa} ${round(ya)} V ${my} H ${xb} V ${round(b.y - 7)}`,
      lx: round((xa + xb) / 2), ly: round(my - 5) };
  }
  // Right to left, wrapping under both boxes rather than cutting back through them.
  const rx = a.x + a.w;
  const ry = a.y + ah / 2;
  const tx = b.x + b.w;
  const ty = b.y + bh / 2;
  const my = round(Math.max(a.y + ah, b.y + bh) + 26);
  return { d: `M ${round(rx)} ${round(ry)} H ${round(rx + 22)} V ${my} H ${round(tx + 22)} V ${round(ty + 7)}`,
    lx: round((rx + tx) / 2 + 22), ly: round(my - 5) };
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

// A label can sit outside every box — an edge that wraps under two rows puts its label below
// both. The extent has to know, or the viewBox clips it.
function span(nodes, edges) {
  const n = extent(nodes, 20);
  const e = edgeExtent(edges);
  return { width: Math.max(n.width, e.width + 20), height: Math.max(n.height, e.height + 20) };
}

function edgeExtent(edges) {
  let w = 0;
  let h = 0;
  for (const e of edges) { w = Math.max(w, e.lx || 0); h = Math.max(h, e.ly || 0); }
  return { width: w, height: h };
}

function edgesOf(pairs, byId) {
  const out = [];
  for (const p of pairs) {
    const a = byId[p.from];
    const b = byId[p.to];
    if (!a || !b) continue;
    const e = elbow(a, b, p.bend == null ? 0.5 : p.bend);
    out.push({ from: p.from, to: p.to, kind: p.kind, label: p.label || '', d: e.d, lx: e.lx, ly: e.ly,
      bend: p.bend == null ? 0.5 : p.bend });
  }
  return out;
}

/* ----------------------------------------------------------------- modules */

const ROLE_SEGMENT = /^(domain|application|usecase|use_case|adapter|adapters|port|ports|infrastructure|web|persistence)$/;

// A module is a directory, which is the limit worth stating: a project whose modularity is not a
// directory gets the endpoint-prefix fallback instead, and says so.
//
// The directory holding `src/` first. That is what a person calls the module — `engine-application`,
// `apps/api` — and it is the one segment a build tool agrees with. The role-segment rule below it
// cannot be trusted on its own: in
// `engine/engine-application/src/main/java/io/ludus/application/identity/...` the first role segment
// is `application`, so it returned `ludus`, the package root. Every class in the project landed in
// one bucket named after the namespace, that bucket matched none of the modules the endpoints
// produced, and the class diagram drew nothing at all while the header counted 262 classes.
// Which side of the role directory carries the module name.
//
// Two layouts are both common and they disagree. `com/acme/orders/application/PlaceOrder.kt` puts
// the module BEFORE the role; `io/ludus/application/content/AuthorWave.java` puts it AFTER, with
// the roles at the top and features nested inside. Guessing one produced, on a real project, the
// package root for all 253 classes — one bucket called `ludus` — while the endpoints produced ten
// buckets of their own, so no module had both and the class diagram drew nothing at all.
//
// Counting settles it without guessing: the side that varies is the side that names the module.
// Roles nest: `adapter/persistence/content` and `adapter/web/player` are two role segments and
// then the module. Taking the segment straight after the first role made `persistence` and `web`
// into modules of their own, holding 113 classes between them and no endpoints.
function afterRoles(parts, i) {
  let j = i;
  while (j + 1 < parts.length && ROLE_SEGMENT.test(parts[j + 1])) j++;
  const next = parts[j + 1];
  return next && !/\.\w+$/.test(next) ? next : null;
}

function moduleSide(decls) {
  const before = new Set();
  const after = new Set();
  for (const d of decls) {
    const parts = d.cite.rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (!ROLE_SEGMENT.test(parts[i])) continue;
      if (parts[i - 1]) before.add(parts[i - 1]);
      const next = afterRoles(parts, i);
      if (next) after.add(next);
      break;
    }
  }
  if (!before.size && !after.size) return null;
  return after.size > before.size ? 'after' : 'before';
}

function moduleFromPath(rel, side) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (!ROLE_SEGMENT.test(parts[i])) continue;
    if (side === 'after') return afterRoles(parts, i);
    return parts[i - 1] || null;
  }
  // No role directory anywhere: a build module under `src`, then a flat top directory. Both are
  // worse answers than a role tree, and both are better than dropping the class out of every
  // module — which is what returning null did.
  const srcAt = parts.indexOf('src');
  if (srcAt > 0) return parts[srcAt - 1];
  return parts.length > 1 ? parts[0] : null;
}

function moduleFromEndpoint(e) {
  if (e.tags && e.tags.length) return String(e.tags[0]);
  const seg = String(e.path).split('/').filter(Boolean)[0] || '';
  return seg.replace(/[{}]/g, '') || null;
}

// Words worth matching on, lowercased and de-pluralised. "Players" and `player` are the same
// module; so are "Wave authoring" and the `content` module that holds every Wave class.
function stems(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)
    .map((w) => w.replace(/(ies|es|s)$/, (m) => (m === 'ies' ? 'y' : '')));
}

// Put an endpoint in a directory module: by the module's own name first, then by the name of a
// class that module holds. A contract tag and a package name are written by different people for
// different reasons, and nothing guarantees they agree.
function placeEndpoint(e, modules) {
  const want = stems(`${moduleFromEndpoint(e) || ''} ${e.path}`);
  let best = null;
  let bestScore = 0;
  for (const m of modules) {
    const own = stems(m.name);
    let score = own.some((w) => want.includes(w)) ? 3 : 0;
    for (const c of m.classes) {
      if (stems(c.name).some((w) => w.length > 3 && want.includes(w))) { score += 1; break; }
    }
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return bestScore > 0 ? best : null;
}

function modulesOf(cfg, eps, decls) {
  const byName = new Map();
  const take = (name) => {
    if (!name) return null;
    if (!byName.has(name)) byName.set(name, { name, endpoints: [], classes: [], source: null });
    return byName.get(name);
  };

  const side = moduleSide(decls);
  for (const d of decls) {
    const m = moduleFromPath(d.cite.rel, side);
    if (m) take(m).classes.push(d);
  }
  const dirModules = Array.from(byName.values());

  if (dirModules.length) {
    // One vocabulary. Merging directory names and contract tags into a single list produced
    // sixteen "modules" for a project that has six: ten tag buckets holding endpoints and no
    // code, six directory buckets holding code and no endpoints, and every one of the ten drew
    // an empty class diagram when it was opened. An endpoint belongs to a module that exists.
    const unplaced = [];
    for (const e of eps) {
      const m = placeEndpoint(e, dirModules);
      if (m) m.endpoints.push(e);
      else unplaced.push(e);
    }
    for (const m of dirModules) m.source = 'directories';
    const placed = new Set();
    for (const m of dirModules) for (const c of m.classes) placed.add(c);
    const orphans = decls.filter((d) => !placed.has(d));
    if (orphans.length) take('unattributed').classes.push(...orphans);
    if (unplaced.length) {
      // Named, not hidden: an endpoint keel could not attribute is a gap in the match, and
      // pretending it belongs somewhere is how the sixteen-module list happened.
      const rest = take('unattributed');
      rest.endpoints = unplaced;
      rest.source = 'endpoints keel could not attribute to a module';
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  // No role directories at all: the contract is the only thing that groups anything, so the tags
  // are the modules and the classes are filed against them by name.
  for (const e of eps) {
    const bucket = take(moduleFromEndpoint(e));
    if (bucket) bucket.endpoints.push(e);
  }
  for (const d of decls) {
    const hit = Array.from(byName.keys()).find((n) => d.name.toLowerCase().startsWith(n.replace(/s$/, '')));
    take(hit || 'unsorted').classes.push(d);
  }
  for (const m of byName.values()) m.source = 'endpoint paths';
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
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
      // Say which source actually found it. A broker named by a chart dependency was being
      // labelled "from the compose file", which is the kind of confident wrong caption the map's
      // whole citation discipline exists to avoid.
      sub: parts.q.brokerSource ? `from ${parts.q.brokerSource}`
        : parts.q.broker ? 'from the compose file' : 'from the publish sites',
      rows: [{ t: `${parts.q.queues.length} queue(s)` }], cite: parts.q.broker ? parts.q.broker.cite : null });
  }
  if (parts.c.crons.length) {
    nodes.push({ id: 'cron:all', kind: 'ext', title: 'scheduled', sub: 'jobs this repo declares',
      rows: [{ t: `${parts.c.crons.length} job(s)` }], cite: null });
  }
  // What actually runs, and how many of it. Without this the map shows one of everything, which
  // for a system that runs four API replicas behind a broker is not a gap but a wrong picture.
  const inf = (parts.inf && parts.inf.instances) || [];
  if (inf.length) {
    const total = inf.reduce((n, i) => n + (i.replicas === null ? 0 : i.replicas), 0);
    const unknown = inf.filter((i) => i.replicas === null).length;
    const rows = inf.slice(0, 5).map((i) => ({
      t: `${i.replicas === null ? '?' : i.replicas} x ${i.name}`,
      flag: i.replicas === null,
    }));
    if (inf.length > 5) rows.push({ t: `and ${inf.length - 5} more` });
    nodes.push({ id: 'run:all', kind: 'ext',
      title: `${total} instance(s)`,
      sub: `${inf.length} workload(s)${unknown ? `, ${unknown} unresolved` : ''}`,
      rows, cite: inf[0].cite });
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
  const edges = edgesOf(pairs, byId);
  return Object.assign({ nodes, edges }, span(nodes, edges));
}

// How wide a column has to be for the widest thing in it. The rows are the endpoint lines, which
// are the longest text on a module box.
function columnWidth(nodes, min, max) {
  let need = min;
  for (const n of nodes) {
    need = Math.max(need, 24 + (n.title || '').length * CH_TITLE, 24 + (n.sub || '').length * CH_SUB);
    for (const r of n.rows || []) need = Math.max(need, 24 + String(r.t).length * CH_SUB);
  }
  return Math.ceil(Math.min(need, max));
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
  const leftW = columnWidth(nodes, 290, 460);
  const rightW = columnWidth(right, 240, 360);
  column(nodes, 30, 30, leftW, 18);
  column(right, 30 + leftW + 120, 30, rightW, 14);

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
  const edges = edgesOf(pairs, byId);
  return Object.assign({ nodes: all, edges }, span(all, edges));
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
      const w = columnWidth(col, 200, 340);
      column(col, x, 30, w, 16);
      x += w + 28;
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
    const edges = edgesOf(pairs, byId);
    byModule[m.name] = Object.assign({ nodes, edges, overflow: Math.max(0, m.classes.length - CLASS_CAP) },
      span(nodes, edges));
  }
  return { byModule };
}

/* ------------------------------------------------------------- the journey */

// The one level that cannot be derived from code. A call graph shows which class calls which; it
// cannot show that placing an order and charging for it are one piece of business, or that the
// charge is allowed to happen later. So it is read from what a person wrote — the journeys section
// of the knowledge base — and, until somebody writes that, from the specs, which at least encode
// numbered, ordered, layer-tagged intent. Both are labelled, so nobody mistakes one for the other.
const LANES = [
  { id: 'actor', label: 'a person' },
  { id: 'web', label: 'web' },
  { id: 'api', label: 'api' },
  { id: 'data', label: 'database' },
  { id: 'queue', label: 'queue' },
  { id: 'ext', label: 'external' },
];

const LANE_H = 86;
const LANE_GUTTER = 96;
const STEP_MIN = 180;
const STEP_MAX = 340;
const STEP_GAP = 28;
const STEP_PAD = 12;
// The page draws these in a monospace face, so a character really is a fixed width and the box
// can be sized to its text rather than guessed at. Title is 12px bold, the line under it 10px.
const CH_TITLE = 7.3;
const CH_SUB = 6.2;

// Fit to the widest box worth drawing, and say so with an ellipsis rather than letting the text
// run out of the box. An overflowing label is not clipped by SVG — it carries on across whatever
// is drawn next, and the neighbour's opaque fill hides the end of it.
function fitText(text, ch) {
  const room = Math.floor((STEP_MAX - STEP_PAD * 2) / ch);
  const t = String(text);
  return t.length <= room ? t : `${t.slice(0, Math.max(1, room - 1))}\u2026`;
}

// Who performs a step, from the column the author wrote it in.
//
// The path alone cannot answer this. A backend project keeps all of its code under one directory,
// so asking the filesystem "who does this" answers "the backend" for every step and every box
// lands in one lane — which is a list, not a swimlane diagram. It did exactly that: eleven of
// twelve steps in `api`, on one row, for a project whose journeys involve an editor, a game and a
// player. The table already names them, so read that first and keep the path as the fallback.
// Ordered structural-first, with the person last. "the player module" and "a player's client"
// both contain a person word, and both mean something else; whoever writes the table names the
// machine when there is one, and only says "a player" when the actor really is the point. The
// limit this leaves: "an editor, in the web tool" reads as web rather than as a person, because
// the tool is named. That is the wrong way round only if you think the editor is doing the work
// rather than driving it, and it is stated rather than hidden.
const WHO_LANE = [
  [/\b(third party|external|provider|vendor|upstream)\b/i, 'ext'],
  [/\b(database|table|migration|store|repository|persistence)\b/i, 'data'],
  [/\b(worker|consumer|listener|job|scheduler|cron|queue|broker|subscriber)\b/i, 'queue'],
  [/\b(api|module|service|server|backend|use case|controller|endpoint)\b/i, 'api'],
  [/\b(browser|web tool|front ?end|client|game|app|ui|page)\b/i, 'web'],
  [/\b(person|people|editor|author|player|customer|user|anyone|somebody|admin|operator)\b/i, 'actor'],
];

function laneOfWho(who) {
  const text = String(who || '');
  if (!text.trim()) return null;
  for (const [re, lane] of WHO_LANE) if (re.test(text)) return lane;
  return null;
}

function laneOfCite(rel, cfg) {
  if (!rel) return 'actor';
  if (cfg.backend.migrations && rel.includes(cfg.backend.migrations)) return 'data';
  if (cfg.frontend.dir && rel.startsWith(cfg.frontend.dir)) return 'web';
  if (cfg.backend.dir && rel.startsWith(cfg.backend.dir)) return 'api';
  return 'actor';
}

const LAYER_LANE = { WEB: 'web', API: 'api', E2E: 'actor', SMOKE: 'api' };

// A step row in a journeys table: a leading number, then the step, then who, then where.
function journeysFrom(cfg) {
  const memory = require('./memory');
  let text = '';
  try { text = fs.readFileSync(path.join(cfg.root, 'docs', 'knowledge', 'journeys.md'), 'utf8'); } catch (e) { return null; }
  const journeys = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const head = raw.match(/^##\s+(.+?)\s*$/);
    if (head) {
      if (/^journeys this project does not have$/i.test(head[1])) { current = null; continue; }
      current = { name: head[1], steps: [] };
      journeys.push(current);
      continue;
    }
    if (!current) continue;
    const cells = raw.trim().startsWith('|') ? raw.trim().split('|').slice(1, -1).map((x) => x.trim()) : null;
    if (!cells || cells.length < 4 || !/^\d+$/.test(cells[0])) continue;
    const cites = memory.citationsIn(cells[3] || '');
    // A step whose "where" is still the template's placeholder is not written yet.
    if (/\{\{[A-Z_]+\}\}/.test(cells.slice(1).join(' '))) continue;
    current.steps.push({
      n: Number(cells[0]), text: cells[1], who: cells[2],
      cite: cites.length ? { rel: cites[0].rel, line: cites[0].line } : null,
      lane: laneOfWho(cells[2]) || (cites.length ? laneOfCite(cites[0].rel, cfg) : 'actor'),
      sourced: cites.length > 0,
    });
  }
  const filled = journeys.filter((j) => j.steps.length);
  return filled.length ? { journeys: filled, source: 'docs/knowledge/journeys.md' } : null;
}

function journeysFromSpecs(cfg) {
  const spec = require('./spec');
  const dir = path.join(cfg.root, (cfg.specs && cfg.specs.dir) || 'specs');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /\.md$/.test(f)).sort(); } catch (e) { return null; }
  const journeys = [];
  for (const f of names) {
    const rel = path.join(path.relative(cfg.root, dir), f);
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { continue; }
    const acs = spec.acs(text);
    if (!acs.length) continue;
    const lines = text.split('\n');
    journeys.push({
      name: f.replace(/\.md$/, ''),
      steps: acs.map((a, i) => ({
        n: i + 1,
        text: a.line.replace(/^[-*]\s*/, '').replace(/\b(AC-\d+)\b\s*/, '').replace(/\[(API|WEB|E2E|SMOKE)\]\s*/i, '').trim(),
        who: a.id,
        cite: { rel, line: lines.findIndex((l) => l.includes(a.id)) + 1 || 1 },
        lane: LAYER_LANE[a.layer] || 'api',
        sourced: true,
      })),
    });
  }
  return journeys.length ? { journeys, source: 'the specs, not yet written up as journeys' } : null;
}

function flowLevel(cfg) {
  const found = journeysFrom(cfg) || journeysFromSpecs(cfg);
  if (!found) {
    return { nodes: [], edges: [], bands: [], width: 20, height: 20, source: null,
      empty: 'no journeys section and no specs, so there is no business flow to draw' };
  }
  // One figure per journey, the same shape the classes level uses per module. Stacking three
  // journeys on one horizontal axis read as one twelve-step story: authoring a wave, booting a
  // game and submitting a score are not a sequence, and drawing them as one said they were.
  const byJourney = {};
  for (const j of found.journeys) {
    const nodes = [];
    const pairs = [];
    let prev = null;
    let col = 0;
    let cursor = LANE_GUTTER;
    // Only the lanes this journey actually uses. Six bands for a journey that touches two is
    // four empty stripes and a figure three times taller than it needs to be.
    const used = LANES.filter((l) => j.steps.some((st) => st.lane === l.id));
    const lanes = used.length ? used : [LANES[2]];
    for (const st of j.steps) {
      const laneIdx = Math.max(0, lanes.findIndex((l) => l.id === st.lane));
      const id = `step:${j.name}:${st.n}`;
      const node = {
        id, kind: st.lane === 'data' ? 'data' : st.lane === 'queue' ? 'queue' : st.lane === 'ext' ? 'ext' : 'app',
        title: fitText(st.text, CH_TITLE), sub: fitText(`${st.n}. ${st.who}`, CH_SUB),
        rows: st.sourced ? [] : [{ t: 'not sourced' }],
        cite: st.cite, journey: j.name, unsourced: !st.sourced,
      };
      // Wide enough for the step as written. Truncating to 26 characters turned every box into
      // "submits a wave documen" \u2014 the words that tell one step from the next are the ones cut.
      node.w = Math.max(STEP_MIN,
        Math.ceil(STEP_PAD * 2 + Math.max(node.title.length * CH_TITLE, node.sub.length * CH_SUB)));
      // Walk a cursor. Multiplying the column index by *this* box's width priced every earlier
      // column at the current one's size, so as soon as two steps had different-length text the
      // boxes drifted into each other — three of them overlapping, text printed over text, and
      // an edge that could no longer go left to right took a U-turn under the lane to get there.
      node.x = cursor;
      cursor += node.w + STEP_GAP;
      node.h = boxH(node);
      node.y = 24 + laneIdx * LANE_H + Math.round((LANE_H - node.h) / 2);
      nodes.push(node);
      if (prev) pairs.push({ from: prev, to: id, kind: 'call', label: '', bend: 0.5 });
      prev = id;
      col++;
    }
    const byId = {};
    for (const n of nodes) byId[n.id] = n;
    const edges = edgesOf(pairs, byId);
    const width = Math.max(extent(nodes, 20).width, 320);
    const bands = lanes.map((l, i) => ({ id: l.id, label: l.label, x: 8, y: 24 + i * LANE_H, w: width - 16, h: LANE_H - 8 }));
    byJourney[j.name] = { nodes, edges, bands, width, height: 24 + lanes.length * LANE_H + 12 };
  }
  const first = byJourney[found.journeys[0].name];
  return Object.assign({ byJourney, source: found.source }, first);
}

function erLevel(parts) {
  const nodes = parts.db.tables.map((t) => ({
    id: `tbl:${t.name}`, kind: 'data', title: t.name, sub: `${t.columns.length} column(s)`,
    rows: t.columns.slice(0, 14).map((c) => ({ t: `${c.name}  ${c.type}`, flag: c.pk ? 'pk' : c.fk ? 'fk' : null })),
    cite: t.cite, columns: t.columns,
  }));
  const perCol = Math.max(1, Math.ceil(nodes.length / 3));
  let ex = 30;
  for (let i = 0; i < 3; i++) {
    const col = nodes.slice(i * perCol, (i + 1) * perCol);
    if (!col.length) continue;
    const w = columnWidth(col, 250, 380);
    column(col, ex, 30, w, 24);
    ex += w + 50;
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
  const edges = edgesOf(pairs, byId);
  return Object.assign({ nodes, edges }, span(nodes, edges));
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
  // Charts and manifests. A queue declared in a chart's values and one named at a publish site are
  // the same queue seen from two ends, so they are merged by name rather than drawn twice; a chart
  // that names a broker wins over a compose image, because a chart is what actually ships.
  const inf = infra.instances(cfg);
  const infq = infra.queues(cfg);
  for (const iq of infq.queues) if (!q.queues.some((x) => x.name === iq.name)) q.queues.push(iq);
  q.queues.sort((a, b) => a.name.localeCompare(b.name));
  if (infq.broker) q.broker = infq.broker;
  if (infq.source) q.brokerSource = infq.source;
  q.skipped = (q.skipped || []).concat(infq.skipped || []);
  const api = symbols.declarations(cfg, cfg.backend.dir);
  // `null`, not '': the web lane is optional and a blank frontend.dir means there is no frontend —
  // the same reading verify.js, guards.js and skills.js use. Passing '' walks the repository root,
  // which in a single-module project is the backend tree again, and every class was counted twice.
  const webDir = String(cfg.frontend.dir || '').trim() ? cfg.frontend.dir : null;
  const web = symbols.declarations(cfg, webDir);
  const style = (cfg.architecture && cfg.architecture.style !== 'unknown') ? cfg.architecture.style : null;
  // Both lanes. The frontend's declarations were counted in the header and handed to nobody, so
  // a project with a web app reported more classes than every figure put together could show.
  const modules = modulesOf(cfg, eps.endpoints, api.concat(web));
  const parts = { eps, db, q, c, api, web, modules, style, inf };

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
      skipped: [].concat(eps.skipped, db.skipped, q.skipped, c.skipped, inf.skipped),
      charts: inf.charts.map((x) => x.name),
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
      instances: inf.instances.reduce((n, i) => n + (i.replicas === null ? 0 : i.replicas), 0),
      workloads: inf.instances.length,
    },
    nodes,
    levels: {
      system: systemLevel(cfg, parts),
      flow: flowLevel(cfg),
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
