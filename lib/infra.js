'use strict';
// Deployment shape: what runs, how many of it, and the brokers and queues declared outside the
// code entirely.
//
// lib/symbols.js finds a queue only where a string literal sits beside a publish or listen call,
// and a broker only where a compose file names its image. Neither sees the half of a system that
// lives in a chart: a RabbitMQ pulled in as a Helm dependency, the queues its values declare, and
// how many replicas of anything actually run. A map drawn without those says a single instance of
// everything and no broker, which is not a gap — it is wrong.
//
// Three limits, stated here and carried onto the map rather than worked around:
//
//   1. A Helm template is not YAML. `replicas: {{ .Values.replicaCount }}` parses as nothing, so
//      values are read from the chart's own values.yaml and resolved one level. A value that comes
//      from a parent chart, `--set`, or an `if` is reported as unresolved, never guessed.
//   2. Only the default values file is read. An environment overlay — values-prod.yaml, a
//      kustomize patch — is a deployment-time input keel cannot know it should prefer.
//   3. A queue is a name in the chart's values. A queue a broker creates at runtime, or one named
//      by an operator CRD keel does not model, is not here.
const fs = require('fs');
const path = require('path');

const { parseYaml } = require('./util');

// Where a chart or a manifest plausibly lives. Walking the whole repository would read every
// node_modules fixture and every test resource; these are the directories a deployment goes in.
const ROOTS = ['deploy', 'deployment', 'charts', 'chart', 'helm', 'k8s', 'kubernetes', 'infra', 'manifests', '.'];
const WORKLOAD = /^\s*kind:\s*["']?(Deployment|StatefulSet|DaemonSet|ReplicaSet|CronJob)["']?\s*$/m;
const BROKER = /(rabbitmq|kafka|redpanda|nats|artemis|pulsar|activemq|sqs|servicebus)/i;
const TEMPLATE = /\{\{-?\s*\.Values\.([A-Za-z0-9_.]+)/;

function rel(cfg, abs) { return path.relative(cfg.root, abs).split(path.sep).join('/'); }

// Files worth opening, bounded. depth 3 under each root is enough for chart/templates/x.yaml and
// deep enough for a monorepo that nests one service per directory.
function yamlFiles(cfg) {
  const out = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!/\.ya?ml$/i.test(e.name)) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    }
  };
  for (const r of ROOTS) {
    const base = path.join(cfg.root, r);
    if (!fs.existsSync(base)) continue;
    walk(base, r === '.' ? 3 : 1);
  }
  return out;
}

function readText(abs) {
  try { return fs.readFileSync(abs, 'utf8'); } catch (e) { return ''; }
}

/* ------------------------------------------------------------------- charts */

// A chart is a directory holding Chart.yaml. Its values.yaml is what the templates beside it
// interpolate, which is the only way `{{ .Values.replicaCount }}` becomes a number.
function charts(cfg) {
  const out = [];
  for (const abs of yamlFiles(cfg)) {
    if (path.basename(abs).toLowerCase() !== 'chart.yaml') continue;
    const dir = path.dirname(abs);
    const meta = parseYaml(readText(abs)) || {};
    const valuesAbs = path.join(dir, 'values.yaml');
    const values = fs.existsSync(valuesAbs) ? (parseYaml(readText(valuesAbs)) || {}) : {};
    out.push({ dir, name: String(meta.name || path.basename(dir)), meta, values,
      cite: { rel: rel(cfg, abs), line: 1 },
      valuesRel: fs.existsSync(valuesAbs) ? rel(cfg, valuesAbs) : null });
  }
  return out;
}

// One level of `.Values.a.b`. Deliberately not a template engine: anything with a conditional or a
// parent-chart override is reported unresolved instead of being half-evaluated into a wrong number.
function fromValues(values, dotted) {
  let cur = values;
  for (const part of String(dotted).split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function chartFor(cs, abs) {
  let best = null;
  for (const c of cs) if (abs.startsWith(c.dir + path.sep) && (!best || c.dir.length > best.dir.length)) best = c;
  return best;
}

/* ---------------------------------------------------------------- instances */

// What runs, and how many. `replicas` absent means Kubernetes' own default of 1 — which is a fact
// about the manifest, not a guess, so it is reported as 1 and marked so the map can say where the
// number came from.
function instances(cfg) {
  const out = { instances: [], skipped: [], charts: [] };
  const cs = charts(cfg);
  out.charts = cs.map((c) => ({ name: c.name, cite: c.cite }));

  for (const abs of yamlFiles(cfg)) {
    const base = path.basename(abs).toLowerCase();
    if (base === 'chart.yaml' || base === 'values.yaml') continue;
    const text = readText(abs);
    if (!WORKLOAD.test(text)) continue;
    const r = rel(cfg, abs);

    // One file can hold several documents separated by ---, and a chart's templates routinely do.
    for (const doc of text.split(/^---\s*$/m)) {
      const k = doc.match(WORKLOAD);
      if (!k) continue;
      const kind = k[1];
      const nameM = doc.match(/^\s*name:\s*(.+?)\s*$/m);
      let name = nameM ? nameM[1].replace(/["']/g, '').trim() : path.basename(abs, path.extname(abs));
      const line = text.slice(0, text.indexOf(doc.slice(0, 40))).split('\n').length;

      let replicas = 1;
      let from = 'the Kubernetes default';
      const repM = doc.match(/^\s*replicas:\s*(.+?)\s*$/m);
      if (repM) {
        const raw = repM[1].trim();
        if (/^\d+$/.test(raw)) { replicas = Number(raw); from = 'the manifest'; }
        else {
          const t = raw.match(TEMPLATE);
          const c = chartFor(cs, abs);
          const v = t && c ? fromValues(c.values, t[1]) : undefined;
          if (typeof v === 'number' || /^\d+$/.test(String(v))) {
            replicas = Number(v); from = c.valuesRel || 'the chart values';
          } else {
            replicas = null;
            from = t ? `.Values.${t[1]}, which is not set in the chart's own values` : 'an expression';
            out.skipped.push(`${r}: replicas is ${raw}, which keel did not resolve`);
          }
        }
      }
      // `{{ .Release.Name }}-api` is the chart name plus a suffix at install time. Replacing the
      // whole string with the chart name loses the suffix, and the suffix is the part that tells
      // one workload in a chart from another — so substitute the release and keep the rest.
      if (/\{\{/.test(name)) {
        const c = chartFor(cs, abs);
        const release = c ? c.name : path.basename(path.dirname(abs));
        name = name
          .replace(/\{\{-?\s*\.Release\.Name\s*-?\}\}/g, release)
          .replace(/\{\{-?\s*(?:include|template)\s+[^}]*\}\}/g, release)
          .replace(/\{\{[^}]*\}\}/g, '')
          .replace(/^[-.\s]+|[-.\s]+$/g, '')
          .trim();
        if (!name) name = release;
      }
      const imgM = doc.match(/^\s*image:\s*(.+?)\s*$/m);
      const image = imgM ? imgM[1].replace(/["']/g, '').trim() : null;
      out.instances.push({ name, kind, replicas, from, image, cite: { rel: r, line } });
    }
  }
  out.instances.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/* ------------------------------------------------------------------- queues */

// A broker and its queues, declared in a chart rather than in the code. Two sources: a chart
// dependency (`dependencies: - name: rabbitmq`), and an image on a workload.
function queues(cfg) {
  const out = { broker: null, queues: [], skipped: [], source: null };
  const cs = charts(cfg);

  for (const c of cs) {
    const deps = Array.isArray(c.meta.dependencies) ? c.meta.dependencies : [];
    for (const d of deps) {
      const n = String((d && d.name) || '');
      if (BROKER.test(n) && !out.broker) {
        out.broker = { name: n.toLowerCase(), cite: c.cite };
        out.source = `a dependency of the ${c.name} chart`;
      }
    }
    // Queue names a chart declares. `queues:` is the key every broker subchart this targets uses;
    // a list of strings, or of objects with a name.
    for (const key of ['queues', 'rabbitmq', 'kafka']) {
      const v = c.values[key];
      const list = Array.isArray(v) ? v : (v && Array.isArray(v.queues) ? v.queues : null);
      if (!list) continue;
      for (const item of list) {
        const name = typeof item === 'string' ? item : (item && item.name ? String(item.name) : null);
        if (name && !out.queues.some((q) => q.name === name)) {
          out.queues.push({ name, cite: { rel: c.valuesRel || c.cite.rel, line: 1 }, listen: false, source: 'chart values' });
        }
      }
    }
  }

  if (!out.broker) {
    for (const i of instances(cfg).instances) {
      const m = i.image && i.image.match(BROKER);
      if (m) { out.broker = { name: m[1].toLowerCase(), cite: i.cite }; out.source = 'a workload image'; break; }
    }
  }
  out.queues.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

module.exports = { charts, instances, queues, yamlFiles, fromValues, ROOTS };
