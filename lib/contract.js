'use strict';
// The endpoints the project declares, read out of the API contract.
//
// Endpoints come from the contract and not from the code, which is a real limit: an endpoint a
// controller serves without a contract entry is invisible here. That is the trade the rest of keel
// already makes — the contract is the thing the generated client, the body tests and the review all
// key on — so the map reads the same source rather than inventing a second truth.
const fs = require('fs');
const path = require('path');

const { parseYaml } = require('./util');

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

// parseYaml keeps the quotes on a quoted key, because `scalar` is only applied to values and
// lib/util.js:221 records why that must not change. Strip them here instead of there.
function unquote(k) {
  const s = String(k);
  const q = s.length > 1 && (s[0] === "'" || s[0] === '"') && s[s.length - 1] === s[0];
  return q ? s.slice(1, -1) : s;
}

function parse(text, file) {
  if (/\.json$/i.test(file)) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }
  try { return parseYaml(text); } catch (e) { return null; }
}

// The line a path item starts on, so every endpoint node can cite the contract the way a knowledge
// claim cites a source. Matching the raw text is cheaper and more honest than threading line
// numbers through the parser, which no other caller wants.
function pathLines(text) {
  const out = {};
  const lines = String(text).split('\n');
  let inPaths = false;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^paths:\s*$/.test(l)) { inPaths = true; depth = 0; continue; }
    if (!inPaths) continue;
    if (/^\S/.test(l)) { inPaths = false; continue; }
    const m = l.match(/^(\s+)(['"]?\/[^:]*?['"]?):\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    if (depth === 0) depth = indent;
    if (indent !== depth) continue;
    out[unquote(m[2])] = i + 1;
  }
  return out;
}

// One operation per verb under a path item. A verb only counts when its value is a map: without
// that rule a block scalar (`description: |`) leaks its prose lines into the parent as keys, and a
// line of documentation reading `get: the list` would invent an endpoint.
function endpoints(cfg) {
  const rel = (cfg.contract && cfg.contract.file) || '';
  const file = rel ? path.join(cfg.root, rel) : '';
  const out = { file: rel, endpoints: [], skipped: [] };
  if (!rel || !fs.existsSync(file)) {
    out.skipped.push(rel ? `no contract at ${rel}` : 'no contract file is configured');
    return out;
  }
  const text = fs.readFileSync(file, 'utf8');
  const doc = parse(text, rel);
  if (!doc || !doc.paths || typeof doc.paths !== 'object') {
    out.skipped.push(`${rel} declares no paths keel could read`);
    return out;
  }
  const lines = pathLines(text);
  let refs = 0;
  for (const rawPath of Object.keys(doc.paths)) {
    const p = unquote(rawPath);
    const item = doc.paths[rawPath];
    if (!item || typeof item !== 'object') continue;
    // A path item behind a $ref is a whole file keel is not going to open. Count it: a silent
    // drop would read on the map as "this project has no such endpoint", which is a lie.
    if (item.$ref || item['$ref']) { refs++; continue; }
    let found = 0;
    for (const verb of VERBS) {
      const op = item[verb];
      if (!op || typeof op !== 'object' || Array.isArray(op)) continue;
      found++;
      out.endpoints.push({
        method: verb.toUpperCase(),
        path: p,
        operationId: typeof op.operationId === 'string' ? op.operationId : null,
        tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
        summary: typeof op.summary === 'string' ? op.summary : null,
        cite: { rel, line: lines[p] || 1 },
      });
    }
    if (!found) refs++;
  }
  if (refs) out.skipped.push(`${refs} path item${refs === 1 ? '' : 's'} behind a $ref keel did not follow`);
  out.endpoints.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
  return out;
}

module.exports = { endpoints, VERBS };
