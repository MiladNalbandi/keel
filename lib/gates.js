'use strict';
// What is standing between this commit and a push. Extracted from the hook so the board can
// report it without re-deriving it: two copies of this logic would drift, and the one the
// user reads would stop matching the one that actually blocks.
const path = require('path');
const { readJson, git, gitOut } = require('./util');

// [{ gate, why, fix }] — empty means a push would go through.
// The knowledge base's verdict. `skills/memory/SKILL.md` has said since 0.6 that "`keel pr` is
// refused while the verdict is missing or stale" — and nothing read the file. Conditional on the
// directory existing, the same shape the deps gate uses for manifests.
function memoryBlocker(cfg, head) {
  const fs_ = require('fs');
  const pathm = require('path');
  if (!fs_.existsSync(pathm.join(cfg.root, 'docs', 'knowledge'))) return null;
  const v = readJson(pathm.join(cfg.root, '.keel', 'memory.json'), null);
  if (!v) return { gate: 'knowledge', why: 'no knowledge verdict for this commit', fix: 'keel memory update' };
  if (v.pass === false) return { gate: 'knowledge', why: `the knowledge base has ${(v.problems || []).length} unresolved problem(s)`, fix: 'keel memory check' };
  if (v.sha !== head) return { gate: 'knowledge', why: `the knowledge verdict is for ${String(v.sha).slice(0, 7)}, not this commit`, fix: 'keel memory update' };
  return null;
}

function pushBlockers(cfg, opts = {}) {
  const out = [];
  // Workflow gates only apply to a project that adopted the workflow.
  if (!cfg.configured) return out;
  const head = opts.head || gitOut('rev-parse HEAD', cfg.root);
  const short = (s) => String(s || '').slice(0, 7);

  const cov = readJson(path.join(cfg.root, '.keel', 'coverage.json'), null);
  if (!cov) {
    out.push({ gate: 'coverage', why: 'no coverage verdict for this commit', fix: 'keel verify coverage' });
  } else if (cov.sha !== head) {
    out.push({ gate: 'coverage', why: `verdict is for ${short(cov.sha)}, not ${short(head)}`, fix: 'keel verify coverage' });
  } else if (!cov.pass) {
    out.push({ gate: 'coverage', why: cov.summary || 'below the threshold', fix: 'keel cover' });
  }

  const wantsDeps = (cfg.security || {}).enabled !== false
    && ((cfg.security || {}).pipelines || ['code', 'deps']).includes('deps');
  if (wantsDeps) {
    let manifests = [];
    try { manifests = require('./deps').manifestsChanged(cfg); } catch (e) { manifests = []; }
    // No manifest changed means there is nothing new a scan could tell us, so the gate
    // stands down rather than demanding a verdict for a change that cannot have introduced
    // a vulnerability.
    if (manifests.length) {
      const sec = readJson(path.join(cfg.root, '.keel', 'security.json'), null);
      if (!sec) {
        out.push({ gate: 'deps', why: `${manifests.length} manifest/lockfile changed and there is no vulnerability verdict`, fix: 'keel verify deps' });
      } else if (sec.sha !== head) {
        out.push({ gate: 'deps', why: `verdict is for ${short(sec.sha)}, not ${short(head)}`, fix: 'keel verify deps' });
      } else if (!sec.pass) {
        out.push({ gate: 'deps', why: sec.summary || `findings at or above ${sec.threshold}`, fix: 'review the findings or add an allowlist entry with a reason and an expiry' });
      }
    }
  }

  const mem = memoryBlocker(cfg, head);
  if (mem) out.push(mem);
  return out;
}

// Freshness of a stored verdict, for the board's check row.
function verdictState(cfg, file, head) {
  const v = readJson(path.join(cfg.root, '.keel', file), null);
  if (!v) return { state: 'none', label: 'never run' };
  if (v.skipped) return { state: 'skipped', label: v.skipped, verdict: v };
  const h = head || gitOut('rev-parse HEAD', cfg.root);
  if (v.sha !== h) return { state: 'stale', label: `for ${String(v.sha).slice(0, 7)}, not HEAD`, verdict: v };
  return { state: v.pass ? 'pass' : 'fail', label: v.pass ? 'current' : (v.summary || 'failing'), verdict: v };
}

module.exports = { pushBlockers, verdictState };
