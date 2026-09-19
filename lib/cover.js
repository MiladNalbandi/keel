'use strict';
// The coverage-fix loop. Its job is to turn a flat list of uncovered lines into work items
// with a decision attached, because "every uncovered line wants a test" is wrong often
// enough to matter: some want deleting, and a few are honestly untestable.
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, matchGlob } = require('./util');
const coverage = require('./coverage');

const VERDICTS = ['test', 'delete', 'accept'];

// Group uncovered lines into items a single test can plausibly address: same file, and
// lines close enough together to belong to one branch or function.
function group(uncovered, gap = 8) {
  const byFile = {};
  for (const u of uncovered) {
    const m = String(u).match(/^(.*):(\d+)$/);
    if (!m) continue;
    (byFile[m[1]] = byFile[m[1]] || []).push(Number(m[2]));
  }
  const items = [];
  for (const [file, lines] of Object.entries(byFile)) {
    lines.sort((a, b) => a - b);
    let run = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] - run[run.length - 1] <= gap) run.push(lines[i]);
      else { items.push({ file, lines: run.slice() }); run = [lines[i]]; }
    }
    items.push({ file, lines: run });
  }
  return items.sort((a, b) => (b.lines.length - a.lines.length) || a.file.localeCompare(b.file));
}

function statePath(cfg) { return path.join(cfg.root, '.keel', 'cover.json'); }

function measure(cfg, opts = {}) {
  const v = coverage.run(cfg, { base: opts.base || cfg.base_branch || 'main' });
  const critical = ((cfg.security || {}).coverage_paths) || [];
  const items = [];
  for (const app of v.apps || []) {
    if (app.error) continue;
    for (const item of group(app.uncovered || [])) {
      items.push(Object.assign({ app: app.app, critical: !!(critical.length && matchGlob(item.file, critical)) }, item));
    }
  }
  // Security-critical paths first: their bar is 100%, so they gate on a single line.
  items.sort((a, b) => (b.critical ? 1 : 0) - (a.critical ? 1 : 0));
  return { verdict: v, items };
}

// Carry decisions across rounds so an accepted line is not re-proposed every time.
function load(cfg) { return readJson(statePath(cfg), { round: 0, decisions: {} }); }
function save(cfg, s) { writeJson(statePath(cfg), s); return s; }

function key(item) { return `${item.file}:${item.lines[0]}-${item.lines[item.lines.length - 1]}`; }

function decide(cfg, k, verdict, reason) {
  if (!VERDICTS.includes(verdict)) return { ok: false, out: `verdict must be one of ${VERDICTS.join(', ')}` };
  if (verdict === 'accept' && !reason) {
    return { ok: false, out: 'accepting an uncovered line needs a reason: it is recorded like an unlock and printed in the final review.' };
  }
  const s = load(cfg);
  s.decisions[k] = { verdict, reason: reason || null, at: new Date().toISOString() };
  save(cfg, s);
  return { ok: true, out: `${k}: ${verdict}${reason ? ` — ${reason}` : ''}` };
}

// The fingerprint for stall detection is the set of still-uncovered lines: if a round does
// not move it, the existing ladder fires rather than a counter invented here.
function fingerprint(items) {
  return items.map(key).sort().join('|');
}

function report(cfg, opts = {}) {
  const { verdict, items } = measure(cfg, opts);
  const s = load(cfg);
  const open = items.filter((i) => !s.decisions[key(i)]);
  const lines = [];
  if (verdict.skipped) return { ok: true, out: `coverage: ${verdict.skipped}` };
  lines.push(verdict.summary || 'coverage measured');
  if (verdict.pass && !open.length) {
    return { ok: true, out: [verdict.summary, 'coverage meets the threshold; nothing to fix.'].join('\n'), items: [], done: true };
  }
  lines.push('', `${open.length} uncovered group(s), ${items.length - open.length} already decided:`);
  for (const i of open.slice(0, 20)) {
    const span = i.lines.length === 1 ? `${i.lines[0]}` : `${i.lines[0]}-${i.lines[i.lines.length - 1]}`;
    lines.push(`  ${i.critical ? '! ' : '  '}${i.file}:${span}  (${i.lines.length} line${i.lines.length > 1 ? 's' : ''})  ${key(i)}`);
  }
  if (open.some((i) => i.critical)) {
    lines.push('', '! marks a security-critical path: the bar there is 100%, so one line is enough to fail.');
  }
  lines.push('', 'For each group decide one of:',
    '  keel cover decide <key> test              write a test, then have it reviewed',
    '  keel cover decide <key> delete            the line is unreachable; delete it (production edits are delete-only here)',
    '  keel cover decide <key> accept --reason "…"   untestable; recorded like an unlock and shown in the final review');
  return { ok: true, out: lines.join('\n'), items: open, fingerprint: fingerprint(open) };
}

module.exports = { group, measure, report, decide, load, save, key, fingerprint, VERDICTS };
