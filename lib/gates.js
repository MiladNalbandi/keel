'use strict';
// What is standing between this commit and a push. Extracted from the hook so the board can
// report it without re-deriving it: two copies of this logic would drift, and the one the
// user reads would stop matching the one that actually blocks.
const path = require('path');
const { readJson, git, gitOut } = require('./util');

// Files that never change what a verdict proved: docs, specs, markdown and keel's own state. A
// verdict for an older commit still holds at HEAD when only these changed in between — otherwise a
// docs(memory) or spec-amendment commit sent coverage, release, lint and Sonar round again for
// code that did not move.
const DOCS_ONLY = [/^docs\//, /^specs\//, /\.md$/i, /^\.keel\//, /^CHANGELOG/i, /^LICENSE/i];

function changedSince(cfg, sha, head) {
  const out = gitOut(`diff --name-only ${sha} ${head}`, cfg.root, null);
  return out === null ? null : out.split('\n').map((x) => x.trim()).filter(Boolean);
}

// Does a verdict recorded at `sha` still hold at `head`?
function fresh(cfg, sha, head) {
  if (!sha) return false;
  if (sha === head) return true;
  const files = changedSince(cfg, sha, head);
  return files !== null && files.every((f) => DOCS_ONLY.some((re) => re.test(f)));
}

// [{ gate, why, fix }] — empty means a push would go through.
// The knowledge base's verdict. `skills/memory/SKILL.md` has said since 0.6 that "`keel pr` is
// refused while the verdict is missing or stale" — and nothing read the file. Conditional on the
// directory existing, the same shape the deps gate uses for manifests.
function memoryBlocker(cfg, head) {
  const fs_ = require('fs');
  const pathm = require('path');
  if (!fs_.existsSync(pathm.join(cfg.root, 'docs', 'knowledge'))) return null;
  const v = readJson(pathm.join(cfg.root, '.keel', 'memory.json'), null);
  if (!v || !v.sha) return { gate: 'knowledge', why: 'no knowledge verdict for this commit', fix: 'keel memory update' };
  if (v.pass === false) return { gate: 'knowledge', why: `the knowledge base has ${(v.problems || []).length} unresolved problem(s)`, fix: 'keel memory check' };
  // An older verdict does not block. Requiring one for HEAD made every code commit cost a
  // knowledge refresh — re-reading code and re-pointing shifted file:line citations — before any
  // push. Staleness is reported by `keel memory show` and offered at ship instead.
  return null;
}

function pushBlockers(cfg, opts = {}) {
  const out = [];
  // Workflow gates only apply to a project that adopted the workflow.
  if (!cfg.configured) return out;
  const head = opts.head || gitOut('rev-parse HEAD', cfg.root);
  const short = (s) => String(s || '').slice(0, 7);

  // The release verdict: every module suite, e2e and smoke, against this commit. Without it here,
  // a fix made during ship — after e2e already ran — is pushed on the strength of a suite that
  // never saw it.
  const rel = readJson(path.join(cfg.root, '.keel', 'release.json'), null);
  const ok = (v) => fresh(cfg, v.sha, head);
  if (!rel) {
    out.push({ gate: 'release', why: 'no release verdict for this commit', fix: 'keel verify release' });
  } else if (!ok(rel)) {
    out.push({ gate: 'release', why: `verdict is for ${short(rel.sha)}, not ${short(head)}`, fix: 'keel verify release' });
  } else if (!rel.pass) {
    out.push({ gate: 'release', why: rel.summary || 'release checks failed', fix: 'keel verify release' });
  }

  // `coverage.enabled: false` turns the gate off for projects that measure coverage elsewhere,
  // or are not ready to enforce it yet. It needs to be its own key: `gate_commands: []` reads as
  // "unset" in `matchesAnyCommand` and falls back to the defaults, so an empty list looked like
  // a way to disable this and silently was not.
  const cov = (cfg.coverage || {}).enabled === false
    ? null : readJson(path.join(cfg.root, '.keel', 'coverage.json'), null);
  if ((cfg.coverage || {}).enabled === false) {
    // deliberately off — no blocker, and the board says so rather than staying silent
  } else if (!cov) {
    out.push({ gate: 'coverage', why: 'no coverage verdict for this commit', fix: 'keel verify coverage' });
  } else if (!ok(cov)) {
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
      } else if (!ok(sec)) {
        out.push({ gate: 'deps', why: `verdict is for ${short(sec.sha)}, not ${short(head)}`, fix: 'keel verify deps' });
      } else if (!sec.pass) {
        out.push({ gate: 'deps', why: sec.summary || `findings at or above ${sec.threshold}`, fix: 'review the findings or add an allowlist entry with a reason and an expiry' });
      }
    }
  }

  // The pre-push checks a stack bundle declares — lint, Sonar. Each is a question for the user
  // rather than an automatic run (they are slow), so the gate waits for an answer per tool.
  let pushChecks = [];
  try { pushChecks = require('./tools').pushStatus(cfg, head); } catch (e) { pushChecks = []; }
  const undecided = pushChecks.filter((c) => c.state === 'undecided').map((c) => c.name);
  const failed = pushChecks.filter((c) => c.state === 'fail');
  if (undecided.length) {
    out.push({ gate: 'lint', why: `not run or skipped for this commit: ${undecided.join(', ')}`,
      fix: `ask the user, per tool, whether to run it — then \`keel lint run [${undecided.join(' ')}]\` or \`keel lint skip [<tool>] --reason "<why>"\`` });
  }
  if (failed.length) {
    out.push({ gate: 'lint', why: `failed for this commit: ${failed.map((c) => `${c.name} (${c.summary})`).join(', ')}`,
      fix: 'fix the findings and commit, then `keel lint run <tool>`' });
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
  if (!fresh(cfg, v.sha, h)) return { state: 'stale', label: `for ${String(v.sha).slice(0, 7)}, not HEAD`, verdict: v };
  return { state: v.pass ? 'pass' : 'fail', label: v.pass ? 'current' : (v.summary || 'failing'), verdict: v };
}

module.exports = { pushBlockers, verdictState, fresh, DOCS_ONLY };
