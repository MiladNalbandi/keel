'use strict';
// Reading the spec file: its sections, its drawings, and what is missing from them.
// Warns rather than blocks — a one-line change does not need a wireframe, and the human at
// the spec gate is the one who decides that. The job here is to make the gap visible at the
// moment of the decision, not to have an opinion about it.
const fs = require('fs');
const path = require('path');

const REQUIRED_STATES = ['default', 'empty', 'loading', 'error'];

function read(cfg, spec) {
  if (!spec) return null;
  try { return fs.readFileSync(path.join(cfg.root, spec), 'utf8'); } catch (e) { return null; }
}

// Split into `## heading` sections, and record which lines sit inside a fenced block so
// callers can ignore drawings when scanning for anything else.
function parse(text) {
  const lines = String(text || '').split('\n');
  const sections = {};
  const fenced = new Set();
  let current = null;
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; fenced.add(i); return; }
    if (inFence) { fenced.add(i); if (current) sections[current].lines.push(line); return; }
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      current = h[1].toLowerCase();
      sections[current] = { heading: h[1], start: i, lines: [] };
      return;
    }
    if (current) sections[current].lines.push(line);
  });
  return { sections, fenced, lines };
}

// Lines outside any fenced block: what `[gate: skip]` and AC parsing should look at, so a
// drawing that happens to mention an id cannot be mistaken for a criterion.
function unfencedLines(text) {
  const { lines, fenced } = parse(text);
  return lines.map((l, i) => (fenced.has(i) ? '' : l));
}

function acs(text) {
  const out = [];
  for (const line of unfencedLines(text)) {
    const m = line.match(/\b(AC-\d+)\b/);
    if (!m) continue;
    const layer = (line.match(/\[(API|WEB|E2E|SMOKE)\]/i) || [])[1];
    out.push({ id: m[1], layer: layer ? layer.toUpperCase() : null, line: line.trim() });
  }
  return out;
}

function body(sections, name) {
  const s = sections[name];
  if (!s) return null;
  return s.lines.join('\n');
}

// A section counts as filled when it has something other than the template's angle-bracket
// guidance. Placeholder prose is not content.
function filled(sections, name) {
  const text = body(sections, name);
  if (text === null) return false;
  const real = text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^<.*>$/.test(l) && !/^</.test(l));
  return real.length > 0;
}

function statesDrawn(sections) {
  const text = body(sections, 'ui mockup');
  if (!text) return [];
  const low = text.toLowerCase();
  return REQUIRED_STATES.filter((s) => new RegExp(`(^|\\n)\\s*${s}\\b`, 'i').test(low));
}

function check(cfg, spec) {
  const text = read(cfg, spec);
  if (!text) return { ok: false, fatal: `cannot read ${spec || 'the spec'}` };
  const { sections } = parse(text);
  const list = acs(text);
  const warnings = [];

  const web = list.filter((a) => a.layer === 'WEB');
  const api = list.filter((a) => a.layer === 'API');

  if (web.length) {
    if (!sections['ui mockup']) {
      warnings.push(`${web.length} [WEB] criterion(s) and no "## UI mockup" section`);
    } else {
      const drawn = statesDrawn(sections);
      const missing = REQUIRED_STATES.filter((s) => !drawn.includes(s));
      if (missing.length) {
        warnings.push(`UI mockup does not draw: ${missing.join(', ')} — these are where the missing criteria usually are`);
      }
    }
  }

  if (api.length) {
    const p = body(sections, 'request path');
    if (!sections['request path']) {
      warnings.push(`${api.length} [API] criterion(s) and no "## Request path" section`);
    } else if (!/[+~]/.test(p || '')) {
      warnings.push('request path marks nothing as + new or ~ changed, so the blast radius is not visible');
    }
  }

  // The sections phase-1 already treats as an exit-criteria failure.
  for (const name of ['validation and security rules', 'data and migrations', 'out of scope']) {
    if (!filled(sections, name)) warnings.push(`"${sections[name] ? sections[name].heading : name}" is empty`);
  }

  const untagged = list.filter((a) => !a.layer);
  if (untagged.length) warnings.push(`untagged criterion(s): ${untagged.map((a) => a.id).join(', ')}`);

  return { ok: warnings.length === 0, warnings, acs: list, sections: Object.keys(sections) };
}

// The fenced drawing from one section, for re-rendering to the terminal.
function drawing(cfg, spec, which) {
  const text = read(cfg, spec);
  if (!text) return null;
  const name = which === 'path' ? 'request path' : 'ui mockup';
  const { sections } = parse(text);
  if (!sections[name]) return null;
  const inner = sections[name].lines.join('\n').trim();
  return inner || null;
}

module.exports = { check, parse, acs, drawing, unfencedLines, filled, statesDrawn, REQUIRED_STATES };
