'use strict';
const fs = require('fs');
const path = require('path');
const { matchGlob, negated } = require('./util');

// Which bucket does a file belong to?
function classify(cfg, absOrRel) {
  const rel = path.isAbsolute(absOrRel)
    ? path.relative(cfg.root, absOrRel).split(path.sep).join('/')
    : String(absOrRel).replace(/^\.\//, '');

  const inDir = (dir) => dir && (rel === dir || rel.startsWith(dir.replace(/\/$/, '') + '/'));
  const isTestPath = /(^|\/)(test|tests)\//.test(rel) || /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(rel) ||
    /Test\.(kt|java)$/.test(rel) || /Tests\.(kt|java)$/.test(rel) || /(^|\/)src\/test\//.test(rel) ||
    /(^|\/)src\/integrationTest\//.test(rel);

  if (matchGlob(rel, cfg.guards.protected) && !negated(rel, cfg.guards.protected)) return 'protected-env';
  if (matchGlob(rel, cfg.guards.generated)) return 'generated';
  if (cfg.contract.file && rel === cfg.contract.file) return 'contract';
  if (/openapi\.(ya?ml|json)$/.test(rel)) return 'contract';
  if (inDir(cfg.specs.dir)) return 'specs';
  if (inDir(cfg.e2e.dir)) return 'e2e';
  if (inDir(cfg.smoke.dir)) return 'smoke';
  if (inDir(cfg.backend.dir)) {
    if (rel.includes(cfg.backend.migrations)) return 'migration';
    return isTestPath ? 'api-test' : 'api-main';
  }
  if (inDir(cfg.frontend.dir)) return isTestPath ? 'web-test' : 'web-src';
  if (/(^|\/)db\/migration\//.test(rel)) return 'migration';
  if (isTestPath) return 'api-test';
  return 'other';
}

// phase -> { bucket: 'allow' | 'deny' | 'new-only' | 'existing-tests-frozen' }
const MATRIX = {
  none:              { '*': 'allow' },
  setup:             { 'other': 'allow', '*': 'deny' },
  spec:              { specs: 'allow', other: 'allow', '*': 'deny' },
  plan:              { specs: 'allow', other: 'allow', '*': 'deny' },
  contract:          { contract: 'allow', other: 'allow', '*': 'deny' },
  red:               { 'api-test': 'allow', 'web-test': 'allow', other: 'allow', '*': 'deny' },
  green:             { 'api-main': 'allow', 'web-src': 'allow', migration: 'new-only', other: 'allow', '*': 'deny' },
  // Production code only, and existing migrations stay immutable. Tests are frozen for the same
  // reason as in GREEN: a refactor that may edit its own tests is a refactor that can change
  // behaviour and still be green.
  refactor:          { 'api-main': 'allow', 'web-src': 'allow', other: 'allow', '*': 'deny' },
  // `loops.commit_style: single` — the test and the code are written together, so this phase
  // permits both. Same shape as `review-fix` and `trivial` below; what makes it different is
  // that nothing verified a RED first, which is the mode's stated cost, not a gap here.
  ac:                { 'api-main': 'allow', 'web-src': 'allow', 'api-test': 'allow', 'web-test': 'allow', migration: 'new-only', other: 'allow', '*': 'deny' },
  gate:              { '*': 'deny', other: 'allow' },
  'review-fix':      { 'api-main': 'allow', 'web-src': 'allow', 'api-test': 'allow', 'web-test': 'allow', migration: 'new-only', other: 'allow', '*': 'deny' },
  integration:       { 'api-main': 'allow', 'web-src': 'allow', other: 'allow', '*': 'deny' },
  e2e:               { e2e: 'allow', other: 'allow', '*': 'deny' },
  smoke:             { smoke: 'allow', other: 'allow', '*': 'deny' },
  // Coverage fixes add tests; production code may only *lose* unreachable lines, which is
  // the third verdict the coverage loop can reach ("delete it" rather than "test it").
  'coverage-fix':    { 'api-test': 'allow', 'web-test': 'allow', 'api-main': 'delete-only',
    'web-src': 'delete-only', e2e: 'deny', other: 'allow', '*': 'deny' },
  trivial:           { 'api-main': 'allow', 'web-src': 'allow', 'api-test': 'new-only', 'web-test': 'new-only', other: 'allow', '*': 'deny' },
  'bug-report':      { other: 'allow', '*': 'deny' },
  'bug-repro':       { 'api-test': 'allow', 'web-test': 'allow', e2e: 'allow', other: 'allow', '*': 'deny' },
  'bug-investigate': { other: 'allow', '*': 'deny' },
  'bug-fix':         { 'api-main': 'allow', 'web-src': 'allow', migration: 'new-only', other: 'allow', '*': 'deny' },
  ship:              { other: 'allow', '*': 'deny' },
  // Phases that decide or prepare rather than edit. They all still allow the `other`
  // bucket, which is where .keel/ and notes live.
  preflight:         { other: 'allow', '*': 'deny' },
  workspace:         { other: 'allow', '*': 'deny' },
  triage:            { other: 'allow', '*': 'deny' },
  'small-change':    { other: 'allow', '*': 'deny' },
  'gate-r':          { other: 'allow', '*': 'deny' },
  'gate-f':          { other: 'allow', '*': 'deny' },
  reset:             { other: 'allow', '*': 'deny' },
  'final-review':    { other: 'allow', '*': 'deny' },
  // Close writes an ADR and archives state; it never touches application code.
  close:             { specs: 'allow', other: 'allow', '*': 'deny' },
  // Regenerating the knowledge base. Only docs/knowledge/ and the verdict, enforced again
  // by `keel commit memory` against the staged set.
  memory:            { other: 'allow', '*': 'deny' },
  // The security audit is read-only: both pipelines only look. Applying a finding happens
  // in review-fix, which already permits production code and tests.
  security:          { other: 'allow', '*': 'deny' },
  // The hunt looks and proves; it never fixes. `other` is all it needs: the backlog under
  // .keel/hunt/ and the rendered report under docs/hunts/. hunt-prove is read-only too, and
  // that is structural rather than frugal — writing the failing *test* belongs to
  // keel:reproducer in bug-repro, and a test written by an agent that was shown the theory is
  // the contamination that agent exists to prevent.
  'hunt-scope':      { other: 'allow', '*': 'deny' },
  'hunt-sweep':      { other: 'allow', '*': 'deny' },
  'hunt-prove':      { other: 'allow', '*': 'deny' },
  'hunt-report':     { other: 'allow', '*': 'deny' },
  'hunt-triage':     { other: 'allow', '*': 'deny' },
};

// A phase with no row must fail closed. It used to fall back to MATRIX.none, which is
// allow-all, so adding a phase and forgetting its row disabled every edit guard for it.
const CLOSED = { other: 'allow', '*': 'deny' };

const ALWAYS_DENY = {
  'protected-env': 'holds secrets. Ask the user to change it.',
  generated: 'is generated. Change the source and rerun codegen.',
};

function checkEdit(cfg, state, file) {
  const bucket = classify(cfg, file);
  const rel = path.isAbsolute(file) ? path.relative(cfg.root, file).split(path.sep).join('/') : file;

  // Setup has to write the env file it asks you to fill in, and the protected-env
  // bucket otherwise forbids it. Only this one path, only during setup, and only for
  // writes: reading it stays blocked in every phase so values never reach the
  // conversation.
  const envFile = String((cfg.setup && cfg.setup.env_file) || '.env.local').replace(/^\.\//, '');
  if (bucket === 'protected-env' && rel === envFile && state && state.phase === 'setup') {
    return { ok: true, bucket, note: 'setup may write the env file' };
  }

  if (ALWAYS_DENY[bucket]) return { ok: false, bucket, reason: `${rel} ${ALWAYS_DENY[bucket]}` };

  if (bucket === 'migration' && fs.existsSync(path.join(cfg.root, rel))) {
    return { ok: false, bucket, reason: `${rel} is an existing migration and is immutable. Add a new migration file instead.` };
  }
  if (!state || !state.flow || state.phase === 'none') return { ok: true, bucket };

  const unlocked = (state.unlocks || []).some((u) => u.path === rel && u.phase === state.phase);
  if (unlocked) return { ok: true, bucket, note: 'unlocked' };


  const rules = MATRIX[state.phase] || CLOSED;
  const rule = rules[bucket] || rules['*'] || 'deny';
  const exists = fs.existsSync(path.join(cfg.root, rel));

  // The design splits RED and GREEN by lane: an [API] criterion has no business editing
  // frontend code and vice versa. The matrix is lane-blind, so apply the lane here.
  const laneMiss = laneMismatch(state, bucket);
  if (laneMiss && rule !== 'deny') {
    return { ok: false, bucket, reason: `${rel}: this is the "${state.lane}" lane, so ${bucket} is out of scope`
      + ` in phase "${state.phase}". Switch lanes with \`keel state lane ${laneMiss}\` if that is really the work.` };
  }

  if (rule === 'allow') return { ok: true, bucket };
  if (rule === 'new-only') {
    if (!exists) return { ok: true, bucket };
    return { ok: false, bucket, reason: `${rel}: in phase "${state.phase}" only new ${bucket} files may be created, not edits to existing ones.` };
  }
  // "delete-only": production code may lose unreachable lines but gain nothing. The line
  // count is checked here; `keel commit coverage` re-checks the staged diff, because an
  // edit that removes one line and adds another would pass a size check alone.
  if (rule === 'delete-only') {
    if (!exists) return { ok: false, bucket, reason: `${rel}: phase "${state.phase}" may only delete unreachable lines from existing files, not create new ones.` };
    return { ok: true, bucket, note: 'delete-only: removals are allowed, additions are refused at commit' };
  }
  return { ok: false, bucket, reason: `${rel}: editing ${bucket} is blocked in phase "${state.phase}".${hint(state.phase, bucket)}` };
}

// In the lane-scoped phases, which lane does this bucket belong to — and is it the wrong one?
const LANE_OF = { 'api-main': 'api', 'api-test': 'api', migration: 'api', 'web-src': 'web', 'web-test': 'web' };
const LANE_SCOPED_PHASES = new Set(['red', 'green']);
function laneMismatch(state, bucket) {
  if (!LANE_SCOPED_PHASES.has(state.phase)) return null;
  const owner = LANE_OF[bucket];
  if (!owner) return null;
  // The criterion's own layer decides which side this work belongs to. Reading state.lane here
  // meant a default flow — which never leaves lane 'api' — blocked a [WEB] criterion from
  // editing the very test it needs, while still calling it a lane violation.
  const lane = require('./state').acLaneOf(state);
  return owner === lane ? null : owner;
}

function hint(phase, bucket) {
  if (phase === 'red' && (bucket === 'api-main' || bucket === 'web-src')) {
    return ' Write the failing test first, then run `keel state red-done` to enter GREEN.';
  }
  if (phase === 'green' && (bucket === 'api-test' || bucket === 'web-test')) {
    return ' Tests are frozen in GREEN. If the test itself is wrong, reject at the gate and go back to RED.';
  }
  if (phase === 'bug-investigate') {
    return ' Production code is locked until you approve Gate F (`keel gate F approve`).';
  }
  if (phase.startsWith('hunt-')) {
    return ' A hunt proves findings; it never fixes them. Take one into a flow with `keel hunt next`.';
  }
  if (bucket === 'contract') return ' Contract changes belong to the contract phase.';
  return '';
}

const ENV_PRINTERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep',
  'bat', 'xxd', 'od', 'strings', 'awk', 'nl']);
const bare = (w) => w.replace(/^[^A-Za-z0-9_./-]+/, '').replace(/[^A-Za-z0-9_./-]+$/, '');

// Does this command print an env file? Tokenised rather than matched as one regex,
// because the old pattern flagged ".env" appearing anywhere after a "cat" — which
// refused `cat <<'EOF'` whenever the heredoc body merely mentioned .env.
function printsEnvFile(command) {
  for (const segment of String(command || '').split(/[\n;]|&&|\|\||\|/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      if (!ENV_PRINTERS.has(bare(words[i]).replace(/^.*\//, ''))) continue;
      if (words[i + 1] && bare(words[i + 1]).startsWith('<<')) continue; // a heredoc, not a file
      for (let j = i + 1; j < words.length; j++) {
        const arg = bare(words[j]);
        if (arg.startsWith('<<')) break;
        const m = arg.match(/(?:^|\/)(\.env(?:\.[A-Za-z0-9_-]+)?)$/);
        if (m && m[1] !== '.env.example') return m[1];
      }
    }
  }
  return null;
}

function checkRead(cfg, file, toolInput) {
  const bucket = classify(cfg, file);
  const rel = path.isAbsolute(file) ? path.relative(cfg.root, file).split(path.sep).join('/') : file;
  if (bucket === 'protected-env') {
    return { ok: false, reason: `Reading ${rel} is blocked so secrets stay out of the conversation. Run \`keel env\` to see which variables are required and whether they are set.` };
  }
  if (matchGlob(rel, cfg.guards.read_block)) {
    return { ok: false, reason: `${rel} is build output; reading it wastes context. Read the source instead.` };
  }
  const max = Number(cfg.guards.read_guard_max_lines || 0);
  const ti = toolInput || {};
  const targeted = ti.offset !== undefined || ti.limit !== undefined;
  if (max > 0 && !targeted) {
    const abs = path.isAbsolute(file) ? file : path.join(cfg.root, rel);
    try {
      const lines = fs.readFileSync(abs, 'utf8').split('\n').length;
      if (lines > max) {
        return { ok: false, reason: `${rel} has ${lines} lines. Ask the keel:bulk-reader subagent a specific question about it, or read the part you need with offset and limit.` };
      }
    } catch (e) { /* unreadable: let the tool report it */ }
  }
  return { ok: true };
}

// Which package is this command adding, if any — and `null` for a command that only restores
// what a lockfile already names. That distinction is the whole of it: the run ladder itself does
// `npm install --frozen-lockfile || npm install`, and a rule that blocked those would stop the
// setup it is supposed to protect. A package *name* after install/add is what makes it a decision.
// Flags that swallow the next word. Without these, `npm install --prefix web` reads "web" as the
// package and refuses a command that installs nothing new.
const FLAGS_WITH_VALUE = new Set([
  '--prefix', '--registry', '--workspace', '-w', '--filter', '-C', '--directory', '--cwd',
  '-r', '--requirement', '--index-url', '--extra-index-url', '-t', '--target', '--python',
]);

// A path is a local install, not a new third-party dependency: `npm install ./packages/shared`
// wires up a workspace that is already in the repo.
function looksLikePath(a) {
  return a.startsWith('./') || a.startsWith('../') || a.startsWith('/') || a.startsWith('~')
    || /\.(txt|lock|json|toml|cfg|ini)$/.test(a) || a === '.';
}

// Which package is this command adding, if any — `null` for anything that only restores what a
// manifest already names. That distinction is the whole rule: the run ladder itself does
// `npm install --frozen-lockfile || npm install`, and `pip install -r requirements.txt` installs
// exactly what is already pinned. A package *name* is what makes it a decision.
function addsDependency(cmd) {
  // Quoted text is data, not command structure — a commit message mentioning "npm install"
  // is not an install.
  const bare = String(cmd).replace(/"[^"]*"|'[^']*'/g, ' ');
  const re = /\b(npm|pnpm|yarn|bun|pip|pip3|poetry|gem|cargo|go|uv)\b([^&|;]*)/g;
  let m;
  while ((m = re.exec(bare))) {
    // The subcommand may sit behind flags: `npm --prefix web install zod`.
    const words = (m[2] || '').trim().split(/\s+/).filter(Boolean);
    const at = words.findIndex((w) => ['install', 'i', 'add', 'get'].includes(w));
    if (at === -1) continue;
    const rest = words.slice(at + 1);
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (FLAGS_WITH_VALUE.has(a)) { i++; continue; }
      if (a.startsWith('-')) continue;
      if (looksLikePath(a)) continue;
      return a;
    }
  }
  return null;
}

// Which files declare dependencies, and what an added dependency line looks like in each. This
// is checked on the staged *diff* rather than on the edit, deliberately: these same files carry
// source sets, compiler flags and plugin config, so denying the file to stop a dependency line
// would fail closed on every legitimate build change. The commit is the last boundary before it
// is in history, and it is the one that can read what actually changed.
const MANIFESTS = [
  [/(^|\/)build\.gradle(\.kts)?$/, /^\s*(implementation|api|testImplementation|testRuntimeOnly|runtimeOnly|compileOnly|kapt|ksp|annotationProcessor)\s*[("']/],
  [/(^|\/)libs\.versions\.toml$/, /^\s*[A-Za-z0-9_-]+\s*=\s*\{?\s*(module|group)\s*=/],
  [/(^|\/)package\.json$/, /^\s*"[^"]+"\s*:\s*"[~^>=<* \d]/],
  [/(^|\/)pyproject\.toml$/, /^\s*[A-Za-z0-9_-]+\s*=\s*"[~^>=<* \d]/],
  [/(^|\/)requirements\.txt$/, /^\s*[A-Za-z0-9_.-]+\s*(==|>=|~=)/],
  [/(^|\/)Cargo\.toml$/, /^\s*[A-Za-z0-9_-]+\s*=\s*[{"]/],
  [/(^|\/)go\.mod$/, /^\s*require\s+\S+\s+v/],
];

// Added dependency declarations in a staged diff, as `{ file, line }`. `diff` is `git diff
// --cached` output with file headers, so the current file is tracked as it is walked.
function manifestAdditions(diff) {
  const found = [];
  let file = null;
  let rule = null;
  for (const raw of String(diff || '').split('\n')) {
    const head = raw.match(/^\+\+\+ b\/(.+)$/);
    if (head) {
      file = head[1];
      const hit = MANIFESTS.find(([f]) => f.test(file));
      rule = hit ? hit[1] : null;
      continue;
    }
    if (!rule || !raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1);
    if (rule.test(line)) found.push({ file, line: line.trim() });
  }
  return found;
}

// What is this manifest line naming? Every form quotes or assigns the thing being added, so the
// candidates are the quoted strings plus a leading bare key — and for a Gradle coordinate both
// `io.ktor:ktor-client` and `ktor-client` count, because that is how a person records it.
function manifestNames(line) {
  const out = [];
  const quoted = String(line).match(/["']([^"']+)["']/g) || [];
  for (const q of quoted) {
    const v = q.slice(1, -1);
    if (/^[~^>=<*\d]/.test(v)) continue;          // a version, not a name
    out.push(v);
    const parts = v.split(':');
    if (parts.length >= 2) out.push(parts.slice(0, 2).join(':'), parts[1]);
  }
  const bare = String(line).match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
  if (bare) out.push(bare[1]);
  const req = String(line).match(/^\s*require\s+(\S+)/);
  if (req) out.push(req[1]);
  return out;
}

// A dependency the user approved through the spec. `keel state dep <name> --by user` records it,
// and the guard steps aside for exactly that package — otherwise an approved criterion could be
// written, agreed and then still not be installable, which is where the 0.40 rule dead-ended.
function dependencyApproved(state, name) {
  const list = (state && state.deps) || [];
  const bare = String(name).replace(/@[^@/]+$/, '');   // strip a version: zod@3.22 -> zod
  return list.some((d) => d === name || d === bare);
}

function checkBash(cfg, state, command) {
  const cmd = String(command || '');
  const flow = state && state.flow && state.phase !== 'none';

  for (const pat of cfg.guards.bash_deny_always) {
    if (cmd.includes(pat)) {
      return { ok: false, reason: `"${pat}" is not allowed: it skips checks that keel relies on.` };
    }
  }
  const envArg = printsEnvFile(cmd);
  if (envArg) {
    return { ok: false, reason: `Printing ${envArg} would put secrets in the conversation. Use \`keel env\` instead.` };
  }
  if (!flow) return { ok: true };

  if (/^\s*git\s+commit\b/.test(cmd) || /&&\s*git\s+commit\b/.test(cmd)) {
    return { ok: false, reason: `Use \`keel commit <type> <ID> "<message>"\` during a keel flow: it stages the right files and checks them against phase "${state.phase}".` };
  }
  for (const pat of cfg.guards.bash_deny_in_flow) {
    if (cmd.includes(pat)) return { ok: false, reason: `"${pat}" is blocked during a keel flow.` };
  }
  const dep = addsDependency(cmd);
  if (dep && !dependencyApproved(state, dep)) {
    return { ok: false, reason: [
      `adding "${dep}" is a dependency decision, and it is not one to make mid-flow.`,
      '',
      'A new dependency outlives this branch: somebody maintains it, it carries a licence and a',
      'supply chain, and it ships to everyone. That is a criterion the spec should name and a',
      'human should approve — not a side effect of getting one test to compile.',
      '',
      'Put it in the spec as an acceptance criterion, take it through the gate, then record the',
      `approval and install it:  keel state dep ${dep} --by user`,
      'If the spec is already frozen, that is an amendment: `keel state phase spec`.',
      '',
      'Restoring what a lockfile already names is not this: a bare `npm install`, `npm ci` or',
      '`./gradlew build` is left alone.',
    ].join('\n') };
  }
  // Writes into frozen paths through the shell.
  const writeMatch = cmd.match(/(?:>|>>|sed\s+-i(?:\s+\S+)?|tee|perl\s+-pi)\s+([^\s;|&]+)/);
  if (writeMatch) {
    const target = writeMatch[1].replace(/^["']|["']$/g, '');
    const verdict = checkEdit(cfg, state, target);
    if (!verdict.ok) return { ok: false, reason: `Shell write to ${verdict.reason}` };
  }
  return { ok: true };
}

const SERENA_EDIT = /(replace_symbol_body|insert_after_symbol|insert_before_symbol|insert_at_line|delete_lines|replace_lines|replace_regex|create_text_file|rename_symbol|write_memory)/i;

function checkMcp(cfg, state, toolName, toolInput) {
  const name = String(toolName || '');
  // Serena's editing tools change files, so they follow exactly the same phase rules as Edit.
  if (/serena/i.test(name) && SERENA_EDIT.test(name)) {
    if (/write_memory/i.test(name)) {
      return { ok: false, reason: 'Serena memories are off inside keel flows: the spec, the state file and git are the record.' };
    }
    const ti = toolInput || {};
    const file = ti.relative_path || ti.file_path || ti.path || ti.filepath;
    if (!file) return { ok: false, reason: `${name} did not name a file, so keel cannot check it against phase "${state && state.phase}".` };
    const v = checkEdit(cfg, state, file);
    return v.ok ? { ok: true } : { ok: false, reason: `via ${name}: ${v.reason}` };
  }
  if (!state || !state.flow || state.phase === 'none') return { ok: true };
  const allow = (cfg.mcp && cfg.mcp.allow) || [];
  if (allow.some((a) => name.includes(a))) return { ok: true };
  const readish = /(read|get|list|search|find|query|fetch|docs|resolve|symbol|overview|status|logs)/i.test(name);
  const writeish = /(write|create|insert|update|delete|replace|edit|apply|execute|run|commit|merge|push)/i.test(name);
  if (readish && !writeish) return { ok: true };
  if (writeish) {
    return { ok: false, reason: `MCP tool "${name}" can change things and is not on keel's allowlist for phase "${state.phase}". Use keel's own commands, or add it to \`mcp.allow\` in .keel/config.yml.` };
  }
  return { ok: true };
}

module.exports = { classify, checkEdit, checkRead, checkBash, checkMcp, printsEnvFile, MATRIX, SERENA_EDIT, LANE_OF, manifestAdditions, manifestNames, dependencyApproved };
