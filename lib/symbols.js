'use strict';
// Declarations, queues and scheduled jobs, read from the source tree by pattern.
//
// Three limits, stated here and printed in the map's legend rather than buried:
//
//   - These are *declarations and imports*, not a call graph. An edge means "this file imports a
//     name this module also declares". In Kotlin a same-package reference needs no import, so those
//     edges are invisible. Building the real graph needs a parser per language, which is the
//     dependency this repo has never taken.
//   - A queue is a string literal at a publish or listen site. A name assembled at runtime, read
//     from an environment variable or held in a constants class is not found.
//   - A scheduled job is a declaration in this repo. Quartz jobs stored in a database and platform
//     schedulers are invisible by construction.
const fs = require('fs');
const path = require('path');

const { walk } = require('./arch');
const { parseYaml } = require('./util');

const SOURCE = /\.(kt|java|ts|tsx|js|jsx|php)$/;

const DECL = [
  /^\s*(?:@\w+\s+)*(?:public\s+|final\s+|abstract\s+|open\s+|sealed\s+|data\s+|internal\s+)*(class|interface|object|enum class|record|trait)\s+([A-Z]\w*)/,
  /^\s*export\s+(?:default\s+)?(class|interface|type|function|const)\s+([A-Z]\w*)/,
];
const IMPORT = /^\s*(?:import|use)\s+.*?([A-Z]\w*)\s*(?:;|$|\})/;

// The same vocabulary lib/arch.js scores structure with, so a class's role on the map and the
// architecture verdict never disagree about what `adapter/in` means.
const ROLES = [
  [/(^|\/)adapter\/in(\/|$)|(^|\/)(controller|rest|http)(\/|$)/, 'adapter · in'],
  [/(^|\/)adapter\/out(\/|$)|(^|\/)(persistence|repository|client|gateway)(\/|$)/, 'adapter · out'],
  [/(^|\/)(application|usecase|use_case|service)(\/|$)/, 'application'],
  [/(^|\/)(domain|model|entity)(\/|$)/, 'domain'],
  [/(^|\/)(port|ports)(\/|$)/, 'port'],
  [/(^|\/)(component|components|pages|routes|features)(\/|$)/, 'ui'],
];

function roleOf(rel, fallback) {
  for (const [re, name] of ROLES) if (re.test(rel)) return name;
  return fallback || 'other';
}

function isTest(rel) {
  return /(^|\/)(test|tests)\//i.test(rel)
    || /(^|\/)src\/(test|integrationTest)\//.test(rel)
    || /Tests?\.(kt|java|php)$/.test(rel)
    || /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(rel);
}

function sources(cfg, dir) {
  if (!dir) return [];
  const base = path.join(cfg.root, dir);
  if (!fs.existsSync(base)) return [];
  return walk(cfg.root, dir).filter((rel) => SOURCE.test(rel) && !rel.includes('/generated/'));
}

function read(cfg, rel) {
  try { return fs.readFileSync(path.join(cfg.root, rel), 'utf8'); } catch (e) { return ''; }
}

// Every declaration in one directory, with the file:line it is declared at and the test file that
// sits beside it under the usual naming. Tests are not declarations: they are the "show tests"
// answer for the class they are named after.
function declarations(cfg, dir) {
  // A file in the frontend tree with no role segment is a piece of UI, not an unclassified
  // backend class: the lane the caller asked for is a better default than 'other'.
  const fallback = dir && dir === cfg.frontend.dir ? 'ui' : 'other';
  const out = [];
  const tests = new Map();
  for (const rel of sources(cfg, dir)) {
    if (!isTest(rel)) continue;
    const base = path.basename(rel).replace(/\.(kt|java|ts|tsx|js|jsx|php)$/, '')
      .replace(/(Tests?)$/, '').replace(/\.(test|spec)$/, '');
    if (!tests.has(base)) tests.set(base, []);
    tests.get(base).push(rel);
  }
  for (const rel of sources(cfg, dir)) {
    if (isTest(rel)) continue;
    const lines = read(cfg, rel).split('\n');
    const imports = [];
    for (let i = 0; i < lines.length; i++) {
      const im = lines[i].match(IMPORT);
      if (im) imports.push(im[1]);
      for (const re of DECL) {
        const m = lines[i].match(re);
        if (!m) continue;
        out.push({
          name: m[2],
          kind: m[1],
          role: roleOf(rel, fallback),
          cite: { rel, line: i + 1 },
          tests: tests.get(m[2]) || [],
          imports,
        });
        break;
      }
    }
  }
  // An edge is only drawn between two declarations we actually found, which is what keeps the
  // figure closed: every edge endpoint is a node.
  const known = new Set(out.map((d) => d.name));
  for (const d of out) d.imports = d.imports.filter((n) => n !== d.name && known.has(n));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const BROKER_IMAGE = /(rabbitmq|kafka|redpanda|nats|artemis|pulsar|activemq)/i;
const QUEUE_SITE = /(convertAndSend|@RabbitListener|@KafkaListener|@JmsListener|@SqsListener|NewTopic\(|TopicBuilder\.name\(|MessageBusInterface)/;
const QUEUE_NAME = /["']([a-z0-9]+(?:[.\-_][a-z0-9]+)+)["']/i;

// Two independent sources. The compose file says which broker technology is in play; a literal
// beside a publish or listen call names an individual queue. Either can be absent — a managed
// broker is often not in compose at all — so neither is required for the other to be reported.
function queues(cfg) {
  const out = { broker: null, queues: [], sites: 0, skipped: [] };
  const composeRel = (cfg.stack && cfg.stack.compose) || 'compose.yml';
  const composeAbs = path.join(cfg.root, composeRel);
  if (fs.existsSync(composeAbs)) {
    const text = fs.readFileSync(composeAbs, 'utf8');
    const m = text.match(new RegExp('image:\\s*\\S*' + BROKER_IMAGE.source, 'i'));
    if (m) out.broker = { name: m[1].toLowerCase(), cite: { rel: composeRel, line: text.slice(0, m.index).split('\n').length } };
  }
  const seen = new Map();
  for (const rel of sources(cfg, cfg.backend.dir)) {
    const lines = read(cfg, rel).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!QUEUE_SITE.test(lines[i])) continue;
      out.sites++;
      const n = lines[i].match(QUEUE_NAME);
      if (!n) continue;
      if (!seen.has(n[1])) seen.set(n[1], { name: n[1], cite: { rel, line: i + 1 }, listen: /Listener/.test(lines[i]) });
    }
  }
  out.queues = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  const unnamed = out.sites - out.queues.length;
  if (unnamed > 0) out.skipped.push(`${unnamed} publish or listen site${unnamed === 1 ? '' : 's'} whose queue name is not a literal`);
  return out;
}

const CRON_ANNOTATION = /@Scheduled\s*\(([^)]*)\)/;

function crons(cfg) {
  const out = { crons: [], skipped: [] };
  for (const rel of sources(cfg, cfg.backend.dir)) {
    const lines = read(cfg, rel).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(CRON_ANNOTATION);
      if (!m) continue;
      const expr = (m[1].match(/["']([^"']+)["']/) || [])[1] || m[1].trim();
      const next = (lines[i + 1] || '').match(/\b(?:fun|void|public)\s+(\w+)/);
      out.crons.push({ name: next ? next[1] : path.basename(rel).replace(/\.\w+$/, ''), schedule: expr, source: 'code', cite: { rel, line: i + 1 } });
    }
  }
  // A workflow schedule is a cron this repo really runs, even though nothing in the app declares it.
  const wf = path.join(cfg.root, '.github', 'workflows');
  let names = [];
  try { names = fs.readdirSync(wf).filter((f) => /\.ya?ml$/.test(f)); } catch (e) { names = []; }
  for (const f of names) {
    const rel = path.join('.github', 'workflows', f);
    const text = read(cfg, rel);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*-?\s*cron:\s*["']?([^"'#]+)["']?\s*$/);
      if (m) out.crons.push({ name: f.replace(/\.ya?ml$/, ''), schedule: m[1].trim(), source: 'workflow', cite: { rel, line: i + 1 } });
    }
    // A Kubernetes CronJob manifest is plain nested maps, which parseYaml handles.
    if (/kind:\s*CronJob/.test(text)) {
      const doc = parseYaml(text);
      if (doc && doc.spec && doc.spec.schedule) {
        out.crons.push({ name: (doc.metadata && doc.metadata.name) || f, schedule: String(doc.spec.schedule), source: 'k8s', cite: { rel, line: 1 } });
      }
    }
  }
  return out;
}

module.exports = { declarations, queues, crons, roleOf, isTest, sources };
