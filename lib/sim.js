'use strict';
// keel simulate — builds a throwaway repo with fake build tools, then drives the real
// hooks and CLI through scenarios and checks what they decide.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KEEL = path.join(__dirname, '..', 'bin', 'keel');

function sh(cmd, cwd) {
  const r = spawnSync(cmd, { shell: true, cwd, encoding: 'utf8' });
  return { code: r.status === null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function keel(args, cwd, stdin) {
  const r = spawnSync('node', [KEEL].concat(args), {
    cwd, encoding: 'utf8', input: stdin || '',
    env: Object.assign({}, process.env, {
      CLAUDE_PROJECT_DIR: cwd,
      PATH: path.join(cwd, 'fakebin') + ':' + process.env.PATH,
    }),
  });
  return { code: r.status === null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function hook(event, payload, cwd) {
  return keel(['hook', event], cwd, JSON.stringify(Object.assign({ cwd }, payload)));
}

/* ------------------------------------------------------------ fake repo */

function fakeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-sim-'));
  const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); };

  // A fake Gradle wrapper and vitest: they read .sim/<name> to decide what to do.
  // A fake Gradle wrapper and vitest: they read .sim/<name> (searching upward) to decide what to do.
  const fakeTool = (name) => `#!/usr/bin/env bash
mode=pass
for d in . .. ../.. ../../..; do
  if [ -f "$d/.sim/${name}" ]; then mode=$(cat "$d/.sim/${name}"); simdir="$d/.sim"; break; fi
done
case "$mode" in
  pass) echo "BUILD SUCCESSFUL"; exit 0 ;;
  assert) echo "FooTest > AC-001 rejects empty url FAILED"; echo "    org.opentest4j.AssertionFailedError: expected: 422 but was: 200"; exit 1 ;;
  compile) echo "e: file:///x/Foo.kt:12:5 Unresolved reference: bar"; echo "error: compilation error"; exit 1 ;;
  context) echo "java.lang.IllegalStateException: Failed to load ApplicationContext"; exit 1 ;;
  docker) echo "Could not connect to Docker daemon"; exit 1 ;;
  flaky) f="$simdir/${name}.count"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f";
         if [ "$n" -le 1 ]; then echo "FlakyTest > AC-009 FAILED"; echo "    AssertionFailedError: flake"; exit 1; else echo "BUILD SUCCESSFUL"; exit 0; fi ;;
  *) echo "BUILD SUCCESSFUL"; exit 0 ;;
esac
`;
  w('gradlew', fakeTool('gradle'));
  w('apps/api/gradlew', fakeTool('gradle'));
  w('bin/vitest', fakeTool('vitest'));
  fs.chmodSync(path.join(dir, 'gradlew'), 0o755);
  fs.chmodSync(path.join(dir, 'apps/api/gradlew'), 0o755);
  fs.chmodSync(path.join(dir, 'bin/vitest'), 0o755);

  w('.sim/gradle', 'pass');
  w('.sim/vitest', 'pass');
  w('apps/api/src/main/kotlin/app/BookmarkController.kt', 'package app\nclass BookmarkController\n');
  w('apps/api/src/test/kotlin/app/BookmarkControllerTest.kt', 'package app\n// AC-001\nclass BookmarkControllerTest\n');
  w('apps/api/src/main/resources/db/migration/V1__init.sql', 'create table bookmark(id uuid primary key);\n');
  w('apps/web/src/BookmarkForm.tsx', 'export const BookmarkForm = () => null;\n');
  w('apps/web/src/BookmarkForm.test.tsx', "// AC-004\nit('AC-004 renders', () => {});\n");
  w('apps/web/src/api/generated/client.ts', 'export const client = {};\n');
  w('contracts/openapi.yaml', 'openapi: 3.0.0\ninfo:\n  title: sim\n  version: 1.0.0\npaths: {}\n');
  w('e2e/placeholder.spec.ts', "// e2e\n");
  w('smoke/placeholder.sh', '#!/usr/bin/env bash\necho ok\n');
  w('specs/001-bookmarks.md', '# 001 bookmarks\n- AC-001 [API] reject a bookmark without a url\n');
  w('.env', 'DB_PASSWORD=supersecret\n');
  w('.env.example', 'DB_PASSWORD=\n');
  w('compose.yml', 'services:\n  db:\n    image: postgres:16\n');
  w('.keel/config.yml', `version: 1
backend:
  dir: apps/api
  build: ./gradlew
  migrations: src/main/resources/db/migration
frontend:
  dir: apps/web
  package_manager: npm
  generated: src/api/generated
contract:
  file: contracts/openapi.yaml
commands:
  deps_web: echo web deps ok
  api_compile: ./gradlew compileKotlin
  api_test_ac: ./gradlew test --tests {AC}
  api_test_module: ./gradlew test
  web_typecheck: ../../bin/vitest typecheck
  web_test_ac: ../../bin/vitest run -t {AC}
  web_test_module: ../../bin/vitest run
  contract_lint: echo contract lint ok
  codegen: echo codegen ok
  static_checks: echo static checks ok
  # The report files below are written directly by the sandbox, so the commands that
  # would normally generate them are switched off rather than left to hit the network.
  coverage_api: ''
  coverage_web: ''
coverage:
  changed_lines: 95
  changed_branches: 90
  global: ratchet
  reports:
    api: apps/api/build/reports/kover/report.xml
    web: apps/web/coverage/lcov.info
stack:
  compose: compose.yml
  per_lane_isolation: true
tests:
  module_suite_at: every-ac
stop_gate:
  enabled: true
  max_blocks_per_turn: 1
`);
  // Fake docker / gh / playwright so setup, stack and pr scenarios can run offline.
  const fakeBin = (name, body) => { w('fakebin/' + name, '#!/usr/bin/env bash\n' + body); fs.chmodSync(path.join(dir, 'fakebin', name), 0o755); };
  fakeBin('docker', 'if [ "$1" = "info" ]; then echo "Server Version: sim"; exit 0; fi\nif [ "$1" = "compose" ]; then echo "compose $*"; exit 0; fi\necho "docker $*"; exit 0');
  fakeBin('gh', 'if [ "$1" = "pr" ]; then echo "https://github.com/sim/repo/pull/1"; exit 0; fi\necho "gh $*"; exit 0');
  fakeBin('jq', 'cat >/dev/null; echo ok');

  // Coverage fixtures: Kover-style XML for the backend, LCOV for the frontend.
  w('apps/api/build/reports/kover/report.xml', `<?xml version="1.0" ?>
<report name="sim">
  <package name="app">
    <sourcefile name="BookmarkController.kt">
      <line nr="3" mi="0" ci="3" mb="0" cb="2"/>
      <line nr="4" mi="4" ci="0" mb="2" cb="0"/>
      <line nr="5" mi="0" ci="2" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`);
  w('apps/web/coverage/lcov.info', `SF:apps/web/src/BookmarkForm.tsx
DA:1,4
DA:2,0
BRDA:1,0,0,2
BRDA:2,0,0,-
end_of_record
`);
  w('smoke/smoke.sh', '#!/usr/bin/env bash\nif [ -f "$(dirname "$0")/../.sim/smoke" ]; then exit $(cat "$(dirname "$0")/../.sim/smoke"); fi\necho "smoke ok"');
  fs.chmodSync(path.join(dir, 'smoke/smoke.sh'), 0o755);

  sh('git init -q && git config user.email sim@keel.test && git config user.name "keel sim" && git add -A && git commit -q -m "init"', dir);
  sh('git branch -M main', dir);
  return dir;
}
function setSim(dir, tool, mode) {
  fs.writeFileSync(path.join(dir, '.sim', tool), mode);
  const c = path.join(dir, '.sim', tool + '.count');
  if (fs.existsSync(c)) fs.unlinkSync(c);
}

/* ------------------------------------------------------------ scenarios */

const scenarios = [];
function scenario(name, fn) { scenarios.push({ name, fn }); }
function expectBlocked(r, mustInclude) {
  if (r.code !== 2) return `expected the hook to block (exit 2), got ${r.code}: ${r.out.trim()}`;
  if (mustInclude && !r.out.toLowerCase().includes(mustInclude.toLowerCase())) return `blocked, but the reason did not mention "${mustInclude}": ${r.out.trim()}`;
  return null;
}
function expectAllowed(r) {
  return r.code === 0 ? null : `expected the hook to allow, got ${r.code}: ${r.out.trim()}`;
}
function expectFails(r, mustInclude) {
  if (r.code === 0) return `expected the command to fail: ${r.out.trim()}`;
  if (mustInclude && !r.out.toLowerCase().includes(mustInclude.toLowerCase())) return `failed, but without "${mustInclude}": ${r.out.trim()}`;
  return null;
}
function expectOk(r, mustInclude) {
  if (r.code !== 0) return `expected success, got ${r.code}: ${r.out.trim()}`;
  if (mustInclude && !r.out.toLowerCase().includes(mustInclude.toLowerCase())) return `succeeded, but without "${mustInclude}": ${r.out.trim()}`;
  return null;
}
const edit = (file) => ({ tool_name: 'Edit', tool_input: { file_path: file } });
const read = (file) => ({ tool_name: 'Read', tool_input: { file_path: file } });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

function startRed(dir, ac = 'AC-001', lane = 'api') {
  keel(['state', 'start', 'feature', '--spec', 'specs/001-bookmarks.md', '--lane', lane], dir);
  keel(['state', 'ac', ac, '--layer', lane === 'web' ? 'WEB' : 'API', '--current'], dir);
  keel(['state', 'phase', 'red'], dir);
}

scenario('no flow: edits are allowed', (dir) =>
  expectAllowed(hook('pre-tool', edit('apps/api/src/main/kotlin/app/BookmarkController.kt'), dir)));

scenario('always: writing .env is blocked', (dir) =>
  expectBlocked(hook('pre-tool', edit('.env'), dir), 'secret'));

scenario('always: reading .env is blocked', (dir) =>
  expectBlocked(hook('pre-tool', read('.env'), dir), 'secret'));

scenario('always: reading .env.local is blocked', (dir) =>
  expectBlocked(hook('pre-tool', read('.env.local'), dir), 'secret'));

scenario('always: printing an env file is blocked, mentioning one is not', (dir) => {
  const E = '.env';
  const mustBlock = [`cat ${E}`, `cat ${E}.local`, `head -n 5 ${E}`,
    `grep PASSWORD ${E}.production`, `echo hi && cat apps/api/${E}`];
  for (const cmd of mustBlock) {
    const r = hook('pre-tool', bash(cmd), dir);
    if (r.code !== 2) return `expected "${cmd}" to be blocked, got ${r.code}`;
  }
  // A heredoc body is prose, not a file read: this is what used to refuse commits
  // whose message happened to mention an env file.
  const mustAllow = [`cat ${E}.example`, `git commit -m "$(cat <<EOF\nmentions ${E}.local\nEOF\n)"`];
  for (const cmd of mustAllow) {
    const r = hook('pre-tool', bash(cmd), dir);
    if (r.code !== 0) return `expected "${cmd.split('\n')[0]}" to be allowed, got ${r.code}: ${r.out.trim()}`;
  }
  return null;
});

scenario('setup may write .env.local, other phases may not', (dir) => {
  const blockedBefore = hook('pre-tool', edit('.env.local'), dir);
  if (blockedBefore.code !== 2) return `expected .env.local writes blocked outside setup, got ${blockedBefore.code}`;
  keel(['state', 'start', 'feature', '--spec', 'specs/001-bookmarks.md', '--phase', 'setup'], dir);
  const allowed = hook('pre-tool', edit('.env.local'), dir);
  if (allowed.code !== 0) return `setup could not write .env.local: ${allowed.out.trim()}`;
  // Reading it must stay blocked even here, or values re-enter the conversation.
  return expectBlocked(hook('pre-tool', read('.env.local'), dir), 'secret');
});

scenario('always: editing generated code is blocked', (dir) =>
  expectBlocked(hook('pre-tool', edit('apps/web/src/api/generated/client.ts'), dir), 'generated'));

scenario('always: an existing migration is immutable', (dir) =>
  expectBlocked(hook('pre-tool', edit('apps/api/src/main/resources/db/migration/V1__init.sql'), dir), 'immutable'));

scenario('always: printing .env through bash is blocked', (dir) =>
  expectBlocked(hook('pre-tool', bash('cat .env'), dir), 'secret'));

scenario('always: force push is blocked', (dir) =>
  expectBlocked(hook('pre-tool', bash('git push --force origin main'), dir), 'not allowed'));

scenario('always: skipping tests in the build is blocked', (dir) =>
  expectBlocked(hook('pre-tool', bash('./gradlew build -x test'), dir), 'not allowed'));

scenario('RED: editing production code is blocked', (dir) => {
  startRed(dir);
  return expectBlocked(hook('pre-tool', edit('apps/api/src/main/kotlin/app/BookmarkController.kt'), dir), 'blocked in phase "red"');
});

scenario('RED: editing the test is allowed', (dir) => {
  startRed(dir);
  return expectAllowed(hook('pre-tool', edit('apps/api/src/test/kotlin/app/BookmarkControllerTest.kt'), dir));
});

scenario('RED: a passing test is refused as not-red', (dir) => {
  startRed(dir);
  setSim(dir, 'gradle', 'pass');
  return expectFails(keel(['state', 'red-done'], dir), 'already pass');
});

scenario('RED: a compile error is refused as a setup problem', (dir) => {
  startRed(dir);
  setSim(dir, 'gradle', 'compile');
  return expectFails(keel(['state', 'red-done'], dir), 'setup problem');
});

scenario('RED: a Spring context failure is refused as a setup problem', (dir) => {
  startRed(dir);
  setSim(dir, 'gradle', 'context');
  return expectFails(keel(['state', 'red-done'], dir), 'setup problem');
});

scenario('RED: an assertion failure is accepted', (dir) => {
  startRed(dir);
  setSim(dir, 'gradle', 'assert');
  return expectOk(keel(['state', 'red-done'], dir), 'red confirmed');
});

scenario('GREEN: editing a test is blocked (tests frozen)', (dir) => {
  startRed(dir);
  keel(['state', 'phase', 'green'], dir);
  return expectBlocked(hook('pre-tool', edit('apps/api/src/test/kotlin/app/BookmarkControllerTest.kt'), dir), 'frozen');
});

scenario('GREEN: production code is allowed', (dir) => {
  startRed(dir);
  keel(['state', 'phase', 'green'], dir);
  return expectAllowed(hook('pre-tool', edit('apps/api/src/main/kotlin/app/BookmarkController.kt'), dir));
});

scenario('GREEN: a new migration is allowed, an existing one is not', (dir) => {
  startRed(dir);
  keel(['state', 'phase', 'green'], dir);
  const a = expectAllowed(hook('pre-tool', edit('apps/api/src/main/resources/db/migration/V2__add_url.sql'), dir));
  if (a) return a;
  return expectBlocked(hook('pre-tool', edit('apps/api/src/main/resources/db/migration/V1__init.sql'), dir), 'immutable');
});

scenario('flow: raw git commit is blocked with the keel command', (dir) => {
  startRed(dir);
  return expectBlocked(hook('pre-tool', bash('git commit -m "wip"'), dir), 'keel commit');
});

scenario('commit red: production code in a test commit is refused', (dir) => {
  startRed(dir);
  setSim(dir, 'gradle', 'assert');
  fs.appendFileSync(path.join(dir, 'apps/api/src/test/kotlin/app/BookmarkControllerTest.kt'), '// AC-001 new test\n');
  fs.appendFileSync(path.join(dir, 'apps/api/src/main/kotlin/app/BookmarkController.kt'), '// sneaky\n');
  return expectFails(keel(['commit', 'red', 'AC-001', 'reject empty url'], dir), 'may not contain');
});

scenario('commit red then green: the happy path works', (dir) => {
  startRed(dir);
  setSim(dir, 'gradle', 'assert');
  fs.appendFileSync(path.join(dir, 'apps/api/src/test/kotlin/app/BookmarkControllerTest.kt'), '// AC-001 asserts 422\n');
  const r1 = keel(['state', 'red-done'], dir);
  if (expectOk(r1, 'red confirmed')) return expectOk(r1, 'red confirmed');
  const c1 = keel(['commit', 'red', 'AC-001', 'reject a bookmark without a url'], dir);
  if (expectOk(c1, 'test(AC-001)')) return expectOk(c1, 'test(AC-001)');
  setSim(dir, 'gradle', 'pass');
  fs.appendFileSync(path.join(dir, 'apps/api/src/main/kotlin/app/BookmarkController.kt'), '// validation\n');
  const g = keel(['state', 'green-done'], dir);
  if (expectOk(g, 'green')) return expectOk(g, 'green');
  const c2 = keel(['commit', 'green', 'AC-001', 'reject a bookmark without a url'], dir);
  return expectOk(c2, 'feat(AC-001)');
});

scenario('commit green: a test file in an implementation commit is refused', (dir) => {
  startRed(dir);
  keel(['state', 'phase', 'green'], dir);
  fs.appendFileSync(path.join(dir, 'apps/api/src/main/kotlin/app/BookmarkController.kt'), '// impl\n');
  fs.appendFileSync(path.join(dir, 'apps/api/src/test/kotlin/app/BookmarkControllerTest.kt'), '// tweak\n');
  return expectFails(keel(['commit', 'green', 'AC-001', 'implement'], dir), 'may not contain');
});

scenario('trivial: editing an existing test is refused and pushed to small', (dir) => {
  keel(['state', 'start', 'change', '--size', 'trivial', '--phase', 'trivial'], dir);
  fs.appendFileSync(path.join(dir, 'apps/api/src/test/kotlin/app/BookmarkControllerTest.kt'), '// changed\n');
  return expectFails(keel(['commit', 'trivial', 'api', 'rename service'], dir), 'not a trivial change');
});

scenario('change flow: touching the contract stops with the escalation trigger', (dir) => {
  keel(['state', 'start', 'change', '--size', 'small', '--phase', 'green'], dir);
  fs.appendFileSync(path.join(dir, 'contracts/openapi.yaml'), '# changed\n');
  return expectFails(keel(['commit', 'green', 'CHG-001.1', 'add field'], dir), 'escalation trigger');
});

scenario('escalate: a small change becomes a spec flow and keeps its ACs', (dir) => {
  keel(['state', 'start', 'change', '--size', 'small', '--phase', 'green'], dir);
  keel(['state', 'ac', 'CHG-001.1', '--layer', 'API', '--current'], dir);
  const r = keel(['escalate'], dir);
  if (expectOk(r, 'escalated')) return expectOk(r, 'escalated');
  const s = JSON.parse(keel(['state', 'show'], dir).out);
  return s.flow === 'feature' && s.spec ? null : `state did not become a spec flow: ${JSON.stringify(s.flow)} ${s.spec}`;
});

scenario('disabled test markers are rejected after an edit', (dir) => {
  startRed(dir);
  const f = 'apps/api/src/test/kotlin/app/BookmarkControllerTest.kt';
  fs.appendFileSync(path.join(dir, f), '@Disabled("later")\n');
  return expectBlocked(hook('post-tool', edit(f), dir), '@Disabled');
});

scenario('stop gate: no changes means no build', (dir) => {
  startRed(dir);
  const r = hook('stop', {}, dir);
  if (r.out.includes('decision')) return `expected no block, got ${r.out.trim()}`;
  return expectAllowed(r);
});

scenario('stop gate: a compile failure blocks the turn with trimmed output', (dir) => {
  startRed(dir);
  setSim(dir, 'gradle', 'compile');
  fs.appendFileSync(path.join(dir, 'apps/api/src/main/kotlin/app/BookmarkController.kt'), '// broken\n');
  const r = hook('stop', {}, dir);
  if (r.code !== 0) return `stop hook should exit 0 and print a decision, got ${r.code}`;
  if (!r.out.includes('"decision":"block"')) return `expected a block decision, got ${r.out.trim()}`;
  if (!/Unresolved reference|compilation error/.test(r.out)) return 'block reason did not include the compile error';
  if (r.out.split('\n')[0].length > 4000) return 'block reason was not trimmed';
  return null;
});

scenario('stop gate: the second stop in the same turn is allowed', (dir) => {
  startRed(dir);
  setSim(dir, 'gradle', 'compile');
  fs.appendFileSync(path.join(dir, 'apps/api/src/main/kotlin/app/BookmarkController.kt'), '// broken\n');
  hook('stop', {}, dir);
  const r = hook('stop', { stop_hook_active: true }, dir);
  return r.out.includes('block') ? `second stop should not block: ${r.out.trim()}` : expectAllowed(r);
});

scenario('stall detection: the same failure three times is reported as stalled', (dir) => {
  startRed(dir);
  keel(['state', 'phase', 'green'], dir);
  setSim(dir, 'gradle', 'assert');
  let last;
  for (let i = 0; i < 3; i++) last = keel(['state', 'green-done'], dir);
  if (!/stalled/i.test(last.out)) return `expected a stall message after 3 identical failures, got: ${last.out.trim()}`;
  return null;
});

scenario('flaky test: fails once, passes on rerun, recorded not failed', (dir) => {
  startRed(dir);
  keel(['state', 'phase', 'green'], dir);
  setSim(dir, 'gradle', 'flaky');
  const r = keel(['state', 'green-done'], dir);
  if (expectOk(r, 'green')) return expectOk(r, 'green');
  const s = JSON.parse(keel(['state', 'show'], dir).out);
  return s.flaky.length ? null : 'the flaky test was not recorded';
});

scenario('push without a coverage verdict is blocked', (dir) => {
  startRed(dir);
  return expectBlocked(hook('pre-tool', bash('git push -u origin HEAD'), dir), 'coverage');
});

scenario('push with a stale coverage verdict is blocked', (dir) => {
  startRed(dir);
  fs.writeFileSync(path.join(dir, '.keel/coverage.json'), JSON.stringify({ sha: 'deadbeefdeadbeef', pass: true }));
  return expectBlocked(hook('pre-tool', bash('gh pr create --fill'), dir), 'verdict is for');
});

scenario('push with a passing verdict for HEAD is allowed', (dir) => {
  startRed(dir);
  const head = sh('git rev-parse HEAD', dir).out.trim();
  fs.writeFileSync(path.join(dir, '.keel/coverage.json'), JSON.stringify({ sha: head, pass: true, summary: 'changed lines 97%' }));
  return expectAllowed(hook('pre-tool', bash('git push -u origin HEAD'), dir));
});

scenario('MCP write tools are blocked during a flow, read tools are not', (dir) => {
  startRed(dir);
  const w = hook('pre-tool', { tool_name: 'mcp__somestore__create_record', tool_input: {} }, dir);
  const e = expectBlocked(w, 'allowlist');
  if (e) return e;
  return expectAllowed(hook('pre-tool', { tool_name: 'mcp__context7__get_library_docs', tool_input: {} }, dir));
});

scenario('Serena edits follow the phase matrix, not a blanket block', (dir) => {
  startRed(dir);
  const bad = hook('pre-tool', { tool_name: 'mcp__serena__replace_symbol_body', tool_input: { relative_path: 'apps/api/src/main/kotlin/app/BookmarkController.kt' } }, dir);
  const e = expectBlocked(bad, 'blocked in phase "red"');
  if (e) return e;
  const okInRed = hook('pre-tool', { tool_name: 'mcp__serena__insert_after_symbol', tool_input: { relative_path: 'apps/api/src/test/kotlin/app/BookmarkControllerTest.kt' } }, dir);
  if (expectAllowed(okInRed)) return expectAllowed(okInRed);
  keel(['state', 'phase', 'green'], dir);
  const okInGreen = hook('pre-tool', { tool_name: 'mcp__serena__replace_symbol_body', tool_input: { relative_path: 'apps/api/src/main/kotlin/app/BookmarkController.kt' } }, dir);
  if (expectAllowed(okInGreen)) return expectAllowed(okInGreen);
  return expectBlocked(hook('pre-tool', { tool_name: 'mcp__serena__write_memory', tool_input: { memory_name: 'x' } }, dir), 'memories');
});

scenario('FileChanged warns when a frozen test file changes on disk', (dir) => {
  startRed(dir);
  keel(['state', 'phase', 'green'], dir);
  const r = hook('file-changed', { files: ['apps/api/src/test/kotlin/app/BookmarkControllerTest.kt'] }, dir);
  return expectBlocked(r, 'frozen');
});

scenario('FileChanged is quiet for a file the phase allows', (dir) => {
  startRed(dir);
  return expectAllowed(hook('file-changed', { files: ['apps/api/src/test/kotlin/app/BookmarkControllerTest.kt'] }, dir));
});

scenario('notification hook does nothing unless it is enabled', (dir) =>
  expectAllowed(hook('notify', { message: 'waiting for you' }, dir)));

scenario('read guard redirects a large whole-file read', (dir) => {
  fs.appendFileSync(path.join(dir, '.keel/config.yml'), '\nguards:\n  read_guard_max_lines: 50\n');
  const big = path.join(dir, 'apps/api/src/main/kotlin/app/Big.kt');
  fs.writeFileSync(big, Array.from({ length: 120 }, (_, i) => `// line ${i}`).join('\n'));
  const blocked = hook('pre-tool', read('apps/api/src/main/kotlin/app/Big.kt'), dir);
  const e = expectBlocked(blocked, 'bulk-reader');
  if (e) return e;
  return expectAllowed(hook('pre-tool', { tool_name: 'Read', tool_input: { file_path: 'apps/api/src/main/kotlin/app/Big.kt', offset: 1, limit: 50 } }, dir));
});

scenario('per-AC coverage warns at green-done', (dir) => {
  fs.appendFileSync(path.join(dir, '.keel/config.yml'), '\n  per_ac: warn\n');
  sh('git checkout -q -b feat/perac', dir);
  startRed(dir);
  keel(['state', 'phase', 'green'], dir);
  const f = path.join(dir, 'apps/api/src/main/kotlin/app/BookmarkController.kt');
  fs.writeFileSync(f, 'package app\nclass BookmarkController\nfun covered() = 1\nfun uncovered() = 2\n');
  sh('git add -A && git commit -q -m "feat(AC-001): work"', dir);
  const r = keel(['state', 'green-done'], dir);
  return /coverage of changed lines/i.test(r.out) ? null : `no coverage line at green-done: ${r.out.trim()}`;
});

scenario('changed-package tests run alongside the AC tests', (dir) => {
  fs.appendFileSync(path.join(dir, '.keel/config.yml'), '\n  per_ac_scope: changed-packages\n  api_test_pkg: ./gradlew test --tests {PKG}\n');
  startRed(dir);
  fs.appendFileSync(path.join(dir, 'apps/api/src/main/kotlin/app/BookmarkController.kt'), '// touched\n');
  setSim(dir, 'gradle', 'pass');
  const r = keel(['verify', 'ac', 'AC-001'], dir);
  return r.code === 0 ? null : `changed-package tier failed: ${r.out.trim()}`;
});

scenario('stall ladder advances one step per stall', (dir) => {
  startRed(dir);
  keel(['state', 'phase', 'green'], dir);
  setSim(dir, 'gradle', 'assert');
  for (let i = 0; i < 3; i++) keel(['state', 'green-done'], dir);
  const first = keel(['stall'], dir);
  if (!/ladder step used: 1\/4/.test(first.out)) return `expected step 1: ${first.out.trim()}`;
  keel(['state', 'green-done'], dir);
  const second = keel(['stall'], dir);
  return /ladder step used: 2\/4/.test(second.out) ? null : `expected step 2: ${second.out.trim()}`;
});

scenario('keel models shows defaults and needs --yes to write', (dir) => {
  // Rewrites a throwaway copy: set-all edits agent frontmatter, and a scenario must not
  // rewrite the real agents it is running beside.
  const src = path.join(__dirname, '..', 'agents');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'keel-agents-'));
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
  const withAgents = (args) => {
    const r = require('child_process').spawnSync('node', [KEEL].concat(args), {
      cwd: dir, encoding: 'utf8',
      env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir, KEEL_AGENT_DIR: tmp }),
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const reviewer = path.join(tmp, 'reviewer.md');
  const before = fs.readFileSync(reviewer, 'utf8');
  const fin = (msg) => { fs.rmSync(tmp, { recursive: true, force: true }); return msg; };
  // `show` reports model/effort together since 0.9.
  if (!/reviewer\s+opus\/high\s+\(default\)/.test(withAgents(['models', 'show']).out)) return fin('defaults not shown');
  const dry = withAgents(['models', 'set-all', 'haiku']);
  if (fs.readFileSync(reviewer, 'utf8') !== before) return fin('rewrote an agent without --yes');
  if (!/Rerun with --yes/.test(dry.out)) return fin(`no confirmation prompt: ${dry.out.trim()}`);
  withAgents(['models', 'set-all', 'haiku', '--yes']);
  const ok = /^model: haiku$/m.test(fs.readFileSync(reviewer, 'utf8'))
    && /^model: haiku$/m.test(fs.readFileSync(path.join(tmp, 'bulk-reader.md'), 'utf8'));
  return fin(ok ? null : 'set-all did not rewrite the frontmatter');
});

// The 404 that made every subagent unusable: `${user_config.model_x}` is not interpolated
// unless the user wrote pluginConfigs into settings.json, so it reached the API verbatim.
// K4: a single-module project keeps its build file and sources at the repository root.
scenario('a backend at the repo root is detected, and its files are still selected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-rootmod-'));
  fs.writeFileSync(path.join(root, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
  fs.mkdirSync(path.join(root, 'src/main/kotlin'), { recursive: true });
  const d = require('./config').detect(root);
  if (d.backendDir !== '.') { fs.rmSync(root, { recursive: true, force: true }); return `backendDir was ${d.backendDir}`; }
  // '.' must still match changed files; the old prefix test built './' and matched nothing.
  const hit = require('./verify').touched({ root }, ['src/main/kotlin/App.kt'], '.');
  fs.rmSync(root, { recursive: true, force: true });
  return hit ? null : "touched() ignored every file of a root module";
});

// K7: a check that inspected nothing must not read like a check that found nothing wrong.
scenario('arch verify outside a git repo reports that it inspected nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-nogit-'));
  fs.mkdirSync(path.join(root, '.keel'), { recursive: true });
  fs.writeFileSync(path.join(root, '.keel/config.yml'), 'version: 1\n');
  fs.writeFileSync(path.join(root, '.keel/architecture.json'), JSON.stringify({
    architecture: { style: 'hexagonal' },
    boundaries: { enforce: 'warn', rules: [{ from: './**/domain/**', deny_imports: ['org.springframework.**'] }] },
  }));
  const r = keel(['verify', 'arch'], root);
  fs.rmSync(root, { recursive: true, force: true });
  if (/boundaries hold\./.test(r.out) && !/inspected 0 files/.test(r.out)) return `bare pass over zero files: ${r.out.trim()}`;
  return /inspected 0 files/.test(r.out) ? null : `did not report the denominator: ${r.out.trim()}`;
});

// K9: usage must never be a side effect that starts containers.
scenario('--help on a subcommand prints usage and runs nothing', (dir) => {
  const r = keel(['ladder', '--help'], dir);
  if (/PASS|FAIL|PLANNED/.test(r.out)) return `the ladder ran: ${r.out.trim()}`;
  return /keel ladder/.test(r.out) ? null : `no usage printed: ${r.out.trim()}`;
});

// K11: '' is a project saying "there is none", not a project saying nothing.
scenario('an explicitly blank coverage report path is honoured', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-blankcov-'));
  fs.mkdirSync(path.join(root, '.keel'), { recursive: true });
  fs.writeFileSync(path.join(root, '.keel/config.yml'),
    "version: 1\ncoverage:\n  reports:\n    web: ''\n");
  const cfg = require('./config').load(root);
  const web = cfg.coverage.reports.web;
  fs.rmSync(root, { recursive: true, force: true });
  return web === '' ? null : `blank web report was overridden with ${JSON.stringify(web)}`;
});

scenario('a plan run leaves the recorded ladder verdicts alone', (dir) => {
  fs.mkdirSync(path.join(dir, '.keel'), { recursive: true });
  const file = path.join(dir, '.keel', 'setup.json');
  const before = { at: '2026-01-01T00:00:00.000Z',
    rungs: { toolchain: { id: 'toolchain', label: 'Toolchain', status: 'pass' } } };
  fs.writeFileSync(file, JSON.stringify(before));
  keel(['ladder', '--plan'], dir);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  return after.rungs.toolchain && after.rungs.toolchain.status === 'pass'
    ? null : `a dry run overwrote the verdicts: ${JSON.stringify(after.rungs)}`;
});

scenario('the step checklist covers the run ladder outside a flow', (dir) => {
  fs.mkdirSync(path.join(dir, '.keel'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.keel', 'setup.json'), JSON.stringify({
    at: new Date().toISOString(),
    rungs: {
      toolchain: { id: 'toolchain', label: 'Toolchain', status: 'pass' },
      compile: { id: 'compile', label: 'Both apps compile', status: 'fail' },
      smoke: { id: 'smoke', label: 'Smoke check', status: 'planned' },
    },
  }));
  const r = hook('post-tool', { tool_name: 'Bash', tool_input: { command: 'keel ladder --resume' } }, dir);
  if (!/todo\s+1\/3/.test(r.out)) return `no ladder checklist outside a flow: ${r.out.trim()}`;
  if (!/✔ Toolchain/.test(r.out)) return 'a passed rung is not ticked';
  if (!/▶ Both apps compile/.test(r.out)) return 'the failed rung is not the one in progress';
  // Mirroring must read as an offer: a session without a todo tool cannot obey an order.
  if (/Mirror this into your todo list/.test(r.out)) return 'still orders the model to mirror';
  return null;
});

scenario('no checklist after an unrelated command outside a flow', (dir) => {
  fs.mkdirSync(path.join(dir, '.keel'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.keel', 'setup.json'), JSON.stringify({
    at: new Date().toISOString(),
    rungs: { toolchain: { id: 'toolchain', label: 'Toolchain', status: 'pass' } },
  }));
  const r = hook('post-tool', { tool_name: 'Bash', tool_input: { command: 'ls -la' } }, dir);
  return /todo\s+\d+\/\d+/.test(r.out) ? `checklist after an unrelated command: ${r.out.trim()}` : null;
});

scenario('every agent declares a literal effort', () => {
  // The model line has had this check since 0.6.2. Effort had none, and was unmanaged entirely.
  const src = path.join(__dirname, '..', 'agents');
  const ok = ['low', 'medium', 'high'];
  const bad = [];
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.md'))) {
    const m = fs.readFileSync(path.join(src, f), 'utf8').match(/^effort:[ \t]*(.+)$/m);
    if (!m) { bad.push(`${f}: no effort line`); continue; }
    if (m[1].includes('${')) { bad.push(`${f}: unresolved placeholder`); continue; }
    if (!ok.includes(m[1].trim())) bad.push(`${f}: "${m[1].trim()}"`);
  }
  return bad.length ? bad.join('; ') : null;
});

scenario('keel models sets effort as well as model, and reset restores both', (dir) => {
  // Run against a throwaway copy, never the real agents.
  const tmp = path.join(dir, 'agents');
  fs.mkdirSync(tmp, { recursive: true });
  const src = path.join(__dirname, '..', 'agents');
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
  const env = { KEEL_AGENT_DIR: tmp };
  const run = (args) => sh(`KEEL_AGENT_DIR=${tmp} node ${path.join(__dirname, '..', 'bin', 'keel')} ${args}`, dir);

  const shown = run('models show');
  if (!/hunter\s+sonnet\/high/.test(shown.out)) return `show does not report model/effort: ${shown.out.trim()}`;
  const dry = run('models set-all sonnet --effort high');
  if (/set .* on \d+ agent/.test(dry.out)) return 'it wrote without --yes';
  run('models set-all sonnet --effort high --yes');
  const after = fs.readFileSync(path.join(tmp, 'reviewer.md'), 'utf8');
  if (!/^model: sonnet$/m.test(after)) return 'the model was not set';
  if (!/^effort: high$/m.test(after)) return 'the effort was not set';
  if (run('models set-all sonnet --effort enormous --yes').code === 0) return 'an unknown effort was accepted';
  run('models reset --yes');
  const back = fs.readFileSync(path.join(tmp, 'reviewer.md'), 'utf8');
  if (!/^model: opus$/m.test(back)) return 'reset did not restore the model';
  return /^effort: high$/m.test(back) ? null : 'reset did not restore the effort';
});

scenario('every agent declares a literal model, never an unresolved placeholder', () => {
  const src = path.join(__dirname, '..', 'agents');
  const bad = fs.readdirSync(src).filter((f) => f.endsWith('.md')
    && /^model:.*\$\{/m.test(fs.readFileSync(path.join(src, f), 'utf8')));
  return bad.length ? `unresolved model placeholder in: ${bad.join(', ')}` : null;
});

scenario('init --dev-container writes compose.dev.yml without touching compose.yml', (dir) => {
  const before = fs.readFileSync(path.join(dir, 'compose.yml'), 'utf8');
  keel(['init', '--dev-container'], dir);
  if (!fs.existsSync(path.join(dir, 'compose.dev.yml'))) return 'compose.dev.yml missing';
  const devText = fs.readFileSync(path.join(dir, 'compose.dev.yml'), 'utf8');
  if (!/include:/.test(devText) || !/docker\.sock/.test(devText)) return 'dev compose missing include or docker socket';
  return fs.readFileSync(path.join(dir, 'compose.yml'), 'utf8') === before ? null : 'compose.yml was modified';
});

scenario('init --new scaffolds a starter that keel understands', (dir) => {
  const empty = fs.mkdtempSync(path.join(require('os').tmpdir(), 'keel-new-'));
  sh('git init -q && git config user.email s@x && git config user.name s', empty);
  fs.mkdirSync(path.join(empty, '.keel'), { recursive: true });
  fs.writeFileSync(path.join(empty, '.keel/config.yml'), 'version: 1\n');
  const r = keel(['init', '--new'], empty);
  const want = ['settings.gradle.kts', 'apps/api/build.gradle.kts', 'apps/api/src/test/kotlin/app/HealthTest.kt',
    'contracts/openapi.yaml', 'compose.yml', 'CLAUDE.md', 'smoke/smoke.sh'];
  const missing = want.filter((f) => !fs.existsSync(path.join(empty, f)));
  try { fs.rmSync(empty, { recursive: true, force: true }); } catch (e) {}
  return missing.length ? `missing from the starter: ${missing.join(', ')} (${r.out.trim().slice(0, 200)})` : null;
});


scenario('shell writes into frozen paths are blocked', (dir) => {
  startRed(dir);
  return expectBlocked(hook('pre-tool', bash('echo "// hack" >> apps/api/src/main/kotlin/app/BookmarkController.kt'), dir), 'blocked in phase');
});

scenario('subagent brief is injected at start', (dir) => {
  startRed(dir);
  const r = hook('subagent-start', { agent_type: 'keel:reviewer' }, dir);
  return /frozen|finish with/.test(r.out) ? null : `no brief was printed: ${r.out.trim()}`;
});

// Advice, not a block: a block is cheapest to satisfy by replying with the marker alone,
// and that reply replaces the agent's result — so enforcing the contract destroyed the
// findings it existed to protect.
scenario('subagent without its result line is reminded, never blocked', (dir) => {
  const r = hook('subagent-stop', { agent_type: 'keel:reviewer', last_message: 'Looks fine to me.' }, dir);
  if (r.out.includes('"decision":"block"')) return `must not block: ${r.out.trim()}`;
  if (!/BLOCKING: yes\|no/.test(r.out)) return `did not name the contract: ${r.out.trim()}`;
  return /Repeat your full findings/.test(r.out) ? null : `did not ask for the findings back: ${r.out.trim()}`;
});

// K2: the marker sits in an earlier turn because the last assistant turn was a tool call.
scenario('the result line is found past a trailing tool-use turn', (dir) => {
  const tp = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(tp, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Full review.\nBLOCKING: no' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
  ].join('\n') + '\n');
  const r = hook('subagent-stop', { agent_type: 'keel:reviewer', last_message: '', transcript_path: tp }, dir);
  return /should end with its result line/.test(r.out)
    ? `scan stopped at the tool-use turn: ${r.out.trim()}` : expectAllowed(r);
});

scenario('subagent with its result line is allowed', (dir) => {
  const r = hook('subagent-stop', { agent_type: 'keel:reviewer', last_message: 'No findings.\nBLOCKING: no' }, dir);
  return r.out.includes('block') ? `should not block: ${r.out.trim()}` : expectAllowed(r);
});

scenario('session brief shows the phase and the next step', (dir) => {
  startRed(dir);
  const r = hook('session-start', { source: 'resume' }, dir);
  return /phase red/.test(r.out) && /next:/.test(r.out) ? null : `brief missing details: ${r.out.trim()}`;
});

scenario('trace --strict fails when an AC has no test', (dir) => {
  startRed(dir, 'AC-777');
  return expectFails(keel(['trace', '--strict'], dir), 'incomplete');
});

scenario('audit catches a disabled test added in a commit', (dir) => {
  startRed(dir);
  sh('git checkout -q -b feat/audit', dir);
  const f = path.join(dir, 'apps/api/src/test/kotlin/app/BookmarkControllerTest.kt');
  fs.appendFileSync(f, '@Disabled("nope")\n');
  sh('git add -A && git commit -q -m "test(AC-001): add"', dir);
  return expectFails(keel(['audit'], dir), '@Disabled');
});

scenario('gate approve moves to the next AC', (dir) => {
  startRed(dir, 'AC-001');
  keel(['state', 'ac', 'AC-002', '--layer', 'API'], dir);
  keel(['state', 'phase', 'gate'], dir);
  const r = keel(['gate', 'ac', 'approve'], dir);
  if (expectOk(r, 'AC-002')) return expectOk(r, 'AC-002');
  const s = JSON.parse(keel(['state', 'show'], dir).out);
  return s.phase === 'red' && s.current === 'AC-002' ? null : `unexpected state: ${s.phase} ${s.current}`;
});

scenario('gate skip records the scope and keeps checks on', (dir) => {
  startRed(dir);
  keel(['state', 'phase', 'gate'], dir);
  const r = keel(['gate', 'ac', 'skip', '--scope', 'lane'], dir);
  if (expectOk(r, 'skipped')) return expectOk(r, 'skipped');
  const s = JSON.parse(keel(['state', 'show'], dir).out);
  return s.gates.skipped.api ? null : 'skip was not recorded in state';
});

scenario('bug flow: production code is locked until Gate F', (dir) => {
  keel(['state', 'start', 'fix', '--phase', 'bug-investigate'], dir);
  const blocked = expectBlocked(hook('pre-tool', edit('apps/api/src/main/kotlin/app/BookmarkController.kt'), dir), 'gate f');
  if (blocked) return blocked;
  keel(['gate', 'F', 'approve'], dir);
  return expectAllowed(hook('pre-tool', edit('apps/api/src/main/kotlin/app/BookmarkController.kt'), dir));
});

scenario('unlock opens one path and records the reason', (dir) => {
  startRed(dir);
  const r = keel(['unlock', 'apps/api/src/main/kotlin/app/BookmarkController.kt', '--reason', 'generated stub needs a manual tweak'], dir);
  if (expectOk(r, 'unlocked')) return expectOk(r, 'unlocked');
  return expectAllowed(hook('pre-tool', edit('apps/api/src/main/kotlin/app/BookmarkController.kt'), dir));
});

scenario('keel env lists names and never values', (dir) => {
  const r = keel(['env'], dir);
  if (r.out.includes('supersecret')) return 'keel env printed a secret value';
  return /DB_PASSWORD: (set|MISSING)/.test(r.out) ? null : `unexpected output: ${r.out.trim()}`;
});

scenario('init detects the layout and the compose file', (dir) => {
  const r = keel(['init'], dir);
  return /compose\.yml/.test(r.out) && /apps\/api/.test(r.out) ? null : `detection output unexpected: ${r.out.trim()}`;
});


/* ------------------------------------------ v0.2 scenarios: setup and ops */

scenario('discover reports build, compose, services and env names', (dir) => {
  const r = keel(['discover'], dir);
  if (!/compose\.yml/.test(r.out)) return 'no compose file reported';
  if (!/DB_PASSWORD/.test(r.out)) return 'no env variable names reported';
  if (/supersecret/.test(r.out)) return 'discover printed a secret value';
  return null;
});

scenario('ladder --plan lists rungs without running them', (dir) => {
  const r = keel(['ladder', '--plan'], dir);
  return /PLANNED\s+Toolchain/.test(r.out) && /Services up/.test(r.out) ? null : `unexpected plan: ${r.out.trim()}`;
});

scenario('ladder runs the rungs and writes an honest runbook', (dir) => {
  const r = keel(['ladder'], dir);
  const book = path.join(dir, 'docs/RUNNING.md');
  if (!fs.existsSync(book)) return `no runbook written: ${r.out.trim()}`;
  const text = fs.readFileSync(book, 'utf8');
  // The runbook used to open "Verified by keel" over a liveness-only ladder, list only the rungs
  // that happened to be configured, and say nothing about what it had not looked at.
  if (/Verified by keel/.test(text)) return 'the runbook still claims to have verified the project';
  if (!/Checked by keel/.test(text)) return 'the runbook does not say when it was checked';
  if (!/\| Toolchain \|/.test(text)) return 'the runbook has no step table';
  if (!/steps ran and passed/.test(text)) return 'the runbook does not say how many steps ran';
  if (!/### Not checked/.test(text)) return 'the runbook hides the rungs nobody configured';
  if (!/no commands\.smoke configured/.test(text)) return 'a not-checked rung does not say why';
  if (!/What this does not tell you/.test(text)) return 'the runbook does not say what it cannot tell you';
  return /keel:hunt/.test(text) ? null : 'the runbook does not point at the flow that checks behaviour';
});

scenario('ladder stops at the first failing rung', (dir) => {
  setSim(dir, 'gradle', 'compile');
  const r = keel(['ladder'], dir);
  return /stopped at/.test(r.out) && r.code !== 0 ? null : `expected a stop, got: ${r.out.trim()}`;
});

scenario('ladder --resume skips rungs that already passed', (dir) => {
  keel(['ladder'], dir);
  const r = keel(['ladder', '--resume'], dir);
  return /PASS/.test(r.out) ? null : `resume output unexpected: ${r.out.trim()}`;
});

scenario('scaffold writes the claude block and the spec template', (dir) => {
  const r = keel(['scaffold', 'claude-md'], dir);
  const md = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(md)) return `no CLAUDE.md: ${r.out.trim()}`;
  const text = fs.readFileSync(md, 'utf8');
  if (!text.includes('<!-- keel:start -->')) return 'block markers missing';
  keel(['scaffold', 'claude-md'], dir);
  const twice = fs.readFileSync(md, 'utf8');
  return (twice.match(/keel:start/g) || []).length === 1 ? null : 'the block was added twice';
});

scenario('coverage: a fully covered change passes', (dir) => {
  sh('git checkout -q -b feat/cov', dir);
  // Line 4 of the controller is covered in the fixture report.
  const f = path.join(dir, 'apps/api/src/main/kotlin/app/BookmarkController.kt');
  fs.writeFileSync(f, 'package app\nclass BookmarkController\nfun covered() = 1\n');   // line 3 is covered in the report
  sh('git add -A && git commit -q -m "feat(AC-001): covered line"', dir);
  const r = keel(['verify', 'coverage'], dir);
  return /pass/.test(r.out) ? null : `expected a pass verdict: ${r.out.trim()}`;
});

scenario('coverage: an uncovered changed line fails and is listed', (dir) => {
  sh('git checkout -q -b feat/cov2', dir);
  const f = path.join(dir, 'apps/api/src/main/kotlin/app/BookmarkController.kt');
  fs.writeFileSync(f, 'package app\nclass BookmarkController\nfun covered() = 1\nfun uncovered() = 2\n');  // line 4 has ci=0
  sh('git add -A && git commit -q -m "feat(AC-002): uncovered line"', dir);
  const r = keel(['verify', 'coverage'], dir);
  if (r.code === 0) return `expected a failing verdict: ${r.out.trim()}`;
  return /uncovered changed lines/.test(r.out) && /BookmarkController\.kt:4/.test(r.out) ? null : `expected the uncovered line listed: ${r.out.trim()}`;
});

scenario('coverage verdict is written for HEAD and unblocks push', (dir) => {
  sh('git checkout -q -b feat/cov3', dir);
  const f = path.join(dir, 'apps/api/src/main/kotlin/app/BookmarkController.kt');
  fs.writeFileSync(f, 'package app\nclass BookmarkController\nfun covered() = 1\n');
  sh('git add -A && git commit -q -m "feat(AC-003): covered"', dir);
  keel(['verify', 'coverage'], dir);
  startRed(dir);
  return expectAllowed(hook('pre-tool', bash('git push -u origin HEAD'), dir));
});

scenario('smoke runs the shell checks', (dir) => {
  const r = keel(['smoke'], dir);
  return /ok\s+smoke\.sh/.test(r.out) ? null : `unexpected smoke output: ${r.out.trim()}`;
});

scenario('smoke fails loudly when a check fails', (dir) => {
  fs.writeFileSync(path.join(dir, '.sim/smoke'), '1');
  const r = keel(['smoke'], dir);
  return r.code !== 0 && /FAIL/.test(r.out) ? null : `expected a failure: ${r.out.trim()}`;
});

scenario('pr refuses without coverage, audit and the final review', (dir) => {
  startRed(dir);
  const r = keel(['pr'], dir);
  if (r.code === 0) return 'pr should have refused';
  return /coverage/.test(r.out) && /final human review/.test(r.out) ? null : `missing reasons: ${r.out.trim()}`;
});

scenario('pr --dry-run renders the body with the AC table', (dir) => {
  sh('git checkout -q -b feat/pr', dir);
  startRed(dir);
  keel(['state', 'ac', 'AC-001', '--layer', 'API', '--current', '--status', 'done'], dir);
  keel(['gate', 'final', 'approve'], dir);
  const r = keel(['pr', '--dry-run', '--force'], dir);
  return /Acceptance criteria/.test(r.out) && /AC-001/.test(r.out) ? null : `unexpected body: ${r.out.trim()}`;
});

scenario('lane start creates a worktree with its own branch and ports', (dir) => {
  const r = keel(['lane', 'start', 'web', '--background'], dir);
  if (r.code !== 0) return `lane start failed: ${r.out.trim()}`;
  if (!/port offset 100/.test(r.out)) return `no port isolation reported: ${r.out.trim()}`;
  const st = keel(['lane', 'status'], dir);
  return /web: open \(background\)/.test(st.out) ? null : `lane not recorded: ${st.out.trim()}`;
});

scenario('lane merge brings the branch back and removes the worktree', (dir) => {
  keel(['lane', 'start', 'web'], dir);
  const wt = path.join(path.dirname(dir), path.basename(dir) + '-web');
  fs.writeFileSync(path.join(wt, 'apps/web/src/Extra.tsx'), 'export const Extra = () => null;\n');
  sh('git add -A && git commit -q -m "web: extra"', wt);
  const r = keel(['lane', 'merge', 'web'], dir);
  if (r.code !== 0) return `merge failed: ${r.out.trim()}`;
  return fs.existsSync(path.join(dir, 'apps/web/src/Extra.tsx')) ? null : 'the lane commit did not arrive';
});

scenario('check-size reports must-escalate for a contract change', (dir) => {
  sh('git checkout -q -b chg/size', dir);
  fs.appendFileSync(path.join(dir, 'contracts/openapi.yaml'), '# new path\n');
  sh('git add -A && git commit -q -m "contract: touch"', dir);
  const r = keel(['check-size'], dir);
  return r.code !== 0 && /MUST escalate/.test(r.out) ? null : `expected a must-escalate: ${r.out.trim()}`;
});

scenario('triage proposes trivial for a rename', (dir) =>
  /proposed size: trivial/.test(keel(['triage', 'rename BookmarkSvc to BookmarkService'], dir).out) ? null : 'wrong proposal');

scenario('triage proposes small for a validation rule', (dir) =>
  /proposed size: small/.test(keel(['triage', 'add a validation error message for an empty url'], dir).out) ? null : 'wrong proposal');

scenario('verify contract runs lint, codegen and both compiles', (dir) => {
  const r = keel(['verify', 'contract'], dir);
  return r.code === 0 ? null : `contract tier failed: ${r.out.trim()}`;
});

scenario('verify full runs both module suites', (dir) => {
  setSim(dir, 'gradle', 'assert');
  const r = keel(['verify', 'full'], dir);
  return r.code !== 0 && /module suite failed/.test(r.out) ? null : `expected a failure report: ${r.out.trim()}`;
});

scenario('the coverage gate matches whole commands, not prefixes', () => {
  const m = require('./hooks').matchesAnyCommand;
  const gate = ['git push', 'gh pr create', 'keel pr'];
  const wrong = [['git push origin main', true], ['keel pr --dry-run', true], ['gh pr create', true],
    // `keel pr` used to match `keel preflight`, so adding that command tripped the gate.
    ['keel preflight 012-slug', false], ['keel prune', false], ['git pushall', false]]
    .filter(([cmd, want]) => m(cmd, gate) !== want).map(([cmd]) => cmd);
  return wrong.length ? `gate matching wrong for: ${wrong.join(', ')}` : null;
});

scenario('RED and GREEN are scoped to the lane', (dir) => {
  startRed(dir, 'AC-001', 'api');
  const ownLane = hook('pre-tool', edit('apps/api/src/test/kotlin/app/BookmarkControllerTest.kt'), dir);
  if (ownLane.code !== 0) return `the api lane should edit api tests: ${ownLane.out.trim()}`;
  const otherLane = hook('pre-tool', edit('apps/web/src/BookmarkForm.test.tsx'), dir);
  if (otherLane.code !== 2) return `the api lane should not edit web tests, got ${otherLane.code}`;
  if (!/lane/.test(otherLane.out)) return `blocked, but not for the lane reason: ${otherLane.out.trim()}`;
  return null;
});

scenario('coverage-fix may delete production lines but not add them', (dir) => {
  keel(['state', 'start', 'feature', '--spec', 'specs/001-bookmarks.md', '--phase', 'coverage-fix'], dir);
  const prod = 'apps/api/src/main/kotlin/app/BookmarkController.kt';
  const allowed = hook('pre-tool', edit(prod), dir);
  if (allowed.code !== 0) return `coverage-fix should allow a delete-only edit: ${allowed.out.trim()}`;
  // Adding a production line must be refused at commit even though the edit was allowed.
  fs.appendFileSync(path.join(dir, prod), '\n// an added line\n');
  const r = keel(['commit', 'coverage', 'AC-001', 'cover the duplicate-url branch'], dir);
  return expectFails(r, 'only delete');
});

scenario('a coverage commit may not lower the threshold', (dir) => {
  keel(['state', 'start', 'feature', '--spec', 'specs/001-bookmarks.md', '--phase', 'coverage-fix'], dir);
  fs.appendFileSync(path.join(dir, '.keel/config.yml'), '\n# sneaky\n');
  const r = keel(['commit', 'coverage', 'AC-001', 'cover the branch'], dir);
  return expectFails(r, 'lowering the threshold');
});

scenario('preflight refuses a dirty tree and reports what is missing', (dir) => {
  fs.writeFileSync(path.join(dir, 'scratch.txt'), 'uncommitted\n');
  const r = keel(['preflight', '012-bookmarks'], dir);
  if (r.code === 0) return `preflight should refuse a dirty tree: ${r.out.trim()}`;
  return /not clean/.test(r.out) ? null : `refused, but not for the dirty tree: ${r.out.trim()}`;
});

scenario('a [gate: skip] tag in the spec skips that AC\'s gate', (dir) => {
  const spec = 'specs/001-bookmarks.md';
  fs.appendFileSync(path.join(dir, spec), '\n- AC-009 [API] [gate: skip] a trivial rename\n');
  keel(['state', 'start', 'feature', '--spec', spec], dir);
  const r = keel(['state', 'ac', 'AC-009', '--layer', 'API', '--current'], dir);
  if (!/gate skipped/.test(r.out)) return `the tag was not read: ${r.out.trim()}`;
  const s = JSON.parse(keel(['state', 'show'], dir).out);
  return s.acs['AC-009'] && s.acs['AC-009'].gate === 'skip' ? null : 'the AC was not marked gate: skip';
});

scenario('the board is printed at the gate and by status', (dir) => {
  startRed(dir, 'AC-001', 'api');
  const s = keel(['status'], dir);
  if (!/AC-001/.test(s.out)) return `status did not show the board: ${s.out.trim()}`;
  const g = keel(['gate', 'ac', 'review'], dir);
  return /AC-001/.test(g.out) ? null : `the gate did not print the board: ${g.out.trim()}`;
});

scenario('state close archives the flow and clears it', (dir) => {
  keel(['state', 'start', 'feature', '--spec', 'specs/001-bookmarks.md'], dir);
  keel(['state', 'ac', 'AC-001', '--layer', 'API', '--current'], dir);
  const r = keel(['state', 'close'], dir);
  if (r.code !== 0) return `close failed: ${r.out.trim()}`;
  const archived = fs.readdirSync(path.join(dir, '.keel', 'archive'));
  if (!archived.length) return 'nothing was archived';
  const s = JSON.parse(keel(['state', 'show'], dir).out);
  return s.flow === null ? null : `state was not cleared: flow is still ${s.flow}`;
});

scenario('the ladder feeds proven commands back into config', (dir) => {
  const r = keel(['ladder'], dir);
  if (!/dependencies/.test(r.out)) return `the ladder did not run: ${r.out.trim()}`;
  const proven = JSON.parse(fs.readFileSync(path.join(dir, '.keel', 'proven.json'), 'utf8'));
  // deps_web is the sim's own configured command; deps_api comes from the rung fallback,
  // which is exactly the case that used to be proven and then forgotten.
  if (!proven.commands || !proven.commands.deps_api) return `deps_api was not persisted: ${JSON.stringify(proven)}`;
  const d = keel(['doctor'], dir);
  return /proven by the run ladder/.test(d.out) ? null : `doctor did not report proven commands: ${d.out.trim()}`;
});

// A helper for the architecture fixtures: write a small tree under apps/api.
function writeTree(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

scenario('architecture detection reads a hexagonal tree', (dir) => {
  const base = 'apps/api/src/main/kotlin/app';
  writeTree(dir, {
    [`${base}/domain/Bookmark.kt`]: 'package app.domain\nclass Bookmark(val url: String)\n',
    [`${base}/domain/BookmarkId.kt`]: 'package app.domain\nvalue class BookmarkId(val raw: String)\n',
    [`${base}/domain/BookmarkRepository.kt`]: 'package app.domain\ninterface BookmarkRepository { fun save(b: Bookmark) }\n',
    [`${base}/application/SaveBookmark.kt`]: 'package app.application\nimport app.domain.Bookmark\nclass SaveBookmark\n',
    [`${base}/adapter/persistence/JpaBookmarks.kt`]: 'package app.adapter.persistence\nimport jakarta.persistence.Entity\n@Entity\nclass JpaBookmark\n',
    [`${base}/adapter/web/BookmarkEndpoint.kt`]: 'package app.adapter.web\nimport org.springframework.web.bind.annotation.RestController\n@RestController\nclass BookmarkEndpoint\n',
  });
  const r = keel(['arch', 'detect'], dir);
  if (!/hexagonal/.test(r.out)) return `expected hexagonal, got: ${r.out.trim().split('\n')[0]}`;
  return /framework-free/.test(r.out) ? null : `detected, but domain purity was not the evidence: ${r.out.trim()}`;
});

scenario('architecture detection reads a layered tree', (dir) => {
  const base = 'apps/api/src/main/kotlin/app';
  writeTree(dir, {
    [`${base}/controller/BookmarkController.kt`]: 'package app.controller\nimport org.springframework.web.bind.annotation.RestController\n@RestController\nclass C\n',
    [`${base}/service/BookmarkService.kt`]: 'package app.service\nimport org.springframework.stereotype.Service\n@Service\nclass S\n',
    [`${base}/repository/BookmarkRepository.kt`]: 'package app.repository\nimport org.springframework.data.jpa.repository.JpaRepository\ninterface R\n',
    [`${base}/domain/Bookmark.kt`]: 'package app.domain\nimport jakarta.persistence.Entity\n@Entity\nclass Bookmark\n',
    [`${base}/domain/Tag.kt`]: 'package app.domain\nimport jakarta.persistence.Entity\n@Entity\nclass Tag\n',
    [`${base}/domain/Folder.kt`]: 'package app.domain\nimport jakarta.persistence.Entity\n@Entity\nclass Folder\n',
  });
  const r = keel(['arch', 'detect'], dir);
  return /layered/.test(r.out) ? null : `expected layered, got: ${r.out.trim().split('\n')[0]}`;
});

scenario('a crossed import boundary fails verify arch in block mode', (dir) => {
  const base = 'apps/api/src/main/kotlin/app';
  writeTree(dir, {
    [`${base}/domain/Bookmark.kt`]: 'package app.domain\nclass Bookmark\n',
    [`${base}/domain/BookmarkId.kt`]: 'package app.domain\nclass BookmarkId\n',
    [`${base}/domain/Repo.kt`]: 'package app.domain\ninterface Repo\n',
    [`${base}/adapter/Jpa.kt`]: 'package app.adapter\nclass Jpa\n',
  });
  keel(['arch', 'set', 'hexagonal', '--enforce', 'block'], dir);
  const clean = keel(['verify', 'arch'], dir);
  if (clean.code !== 0) return `a clean tree should pass: ${clean.out.trim()}`;
  // Now let a domain type import Spring, which is exactly what the rule forbids.
  writeTree(dir, { [`${base}/domain/Bookmark.kt`]: 'package app.domain\nimport org.springframework.stereotype.Component\n@Component\nclass Bookmark\n' });
  const bad = keel(['verify', 'arch'], dir);
  if (bad.code === 0) return `the crossed boundary was not caught: ${bad.out.trim()}`;
  return /domain-framework-free/.test(bad.out) ? null : `failed, but without naming the rule: ${bad.out.trim()}`;
});

scenario('greenfield recommendation defaults to layered and argues against DDD', (dir) => {
  const plain = keel(['arch', 'recommend', '--lifespan', 'short', '--nature', 'data'], dir);
  if (!/recommended: layered/.test(plain.out)) return `expected layered: ${plain.out.trim()}`;
  if (!/DDD not recommended/.test(plain.out)) return `no reason given against DDD: ${plain.out.trim()}`;
  const ddd = keel(['arch', 'recommend', '--lifespan', 'multi-year', '--nature', 'rules',
    '--contexts', '3', '--team', '4'], dir);
  return /recommended: ddd/.test(ddd.out) ? null : `expected ddd for the strong case: ${ddd.out.trim()}`;
});

scenario('always: a hardcoded secret is blocked at the edit', (dir) => {
  const f = 'apps/api/src/main/kotlin/app/Creds.kt';
  // A deliberate fixture: this is the value the scanner is supposed to catch. keel:allow-secret
  fs.writeFileSync(path.join(dir, f), 'package app\nval key = "AKIAIOSFODNN7EXAMPLE"\n'); // keel:allow-secret
  const r = hook('post-tool', { tool_name: 'Write', tool_input: { file_path: f } }, dir);
  if (r.code !== 2) return `expected the secret to be blocked, got ${r.code}: ${r.out.trim()}`;
  // A placeholder must not trip it, or the guard gets switched off.
  fs.writeFileSync(path.join(dir, f), 'package app\nval key = System.getenv("AWS_KEY")\nval p = "${DB_PASSWORD}"\n');
  const ok = hook('post-tool', { tool_name: 'Write', tool_input: { file_path: f } }, dir);
  return ok.code === 0 ? null : `a placeholder was wrongly flagged: ${ok.out.trim()}`;
});

scenario('the deps gate asks for nothing when no manifest changed', (dir) => {
  const deps = require('./deps');
  const cfg = require('./config').load(dir);
  if (deps.manifestsChanged(cfg).length) return 'the fixture unexpectedly has manifest changes';
  const v = deps.run(cfg);
  if (!v.skipped) return `expected a skip, got: ${JSON.stringify(v).slice(0, 120)}`;
  return v.pass ? null : 'a skip should not fail the verdict';
});

scenario('the deps gate blocks a push when a manifest changed with no verdict', (dir) => {
  fs.writeFileSync(path.join(dir, 'apps/web/package.json'), '{"name":"web","dependencies":{"left-pad":"1.0.0"}}\n');
  sh('git add -A && git commit -q -m "bump a dependency"', dir);
  try { fs.unlinkSync(path.join(dir, '.keel', 'security.json')); } catch (e) { /* none yet */ }
  // H10 runs before H17, so stub a passing coverage verdict for this HEAD to isolate the
  // gate under test rather than asserting on whichever gate happens to fire first.
  const head = sh('git rev-parse HEAD', dir).out.trim();
  fs.writeFileSync(path.join(dir, '.keel', 'coverage.json'),
    JSON.stringify({ sha: head, pass: true, summary: 'stubbed for this scenario' }));
  const r = hook('pre-tool', bash('git push'), dir);
  if (r.code !== 2) return `expected the push to be blocked, got ${r.code}: ${r.out.trim()}`;
  return /vulnerability verdict|verify deps/.test(r.out) ? null : `blocked, but not by the deps gate: ${r.out.trim()}`;
});

scenario('the coverage loop groups lines and needs a reason to accept one', (dir) => {
  const cover = require('./cover');
  const groups = cover.group(['a/B.kt:10', 'a/B.kt:12', 'a/B.kt:40', 'c/D.kt:5']);
  if (groups.length !== 3) return `expected 3 groups from 4 lines, got ${groups.length}`;
  if (groups[0].lines.length !== 2) return `the two nearby lines should group: ${JSON.stringify(groups[0])}`;
  const cfg = require('./config').load(dir);
  const bad = cover.decide(cfg, 'a/B.kt:10-12', 'accept');
  if (bad.ok) return 'accept without a reason should be refused';
  const good = cover.decide(cfg, 'a/B.kt:10-12', 'accept', 'a JVM shutdown hook');
  if (!good.ok) return `accept with a reason should be allowed: ${good.out}`;
  const s = keel(['cover', 'status'], dir);
  return /shutdown hook/.test(s.out) ? null : `the decision was not recorded: ${s.out.trim()}`;
});

scenario('a memory commit may only touch the knowledge base', (dir) => {
  keel(['state', 'start', 'feature', '--spec', 'specs/001-bookmarks.md', '--phase', 'memory'], dir);
  fs.mkdirSync(path.join(dir, 'docs', 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/knowledge/architecture.md'), '# Architecture\n');
  const ok = keel(['commit', 'memory', 'SPEC-001', 'refresh the knowledge base'], dir);
  if (ok.code !== 0) return `a knowledge-only commit should pass: ${ok.out.trim()}`;
  fs.writeFileSync(path.join(dir, 'docs/knowledge/domain.md'), '# Domain\n');
  fs.appendFileSync(path.join(dir, 'apps/api/src/main/kotlin/app/BookmarkController.kt'), '\n// sneaky\n');
  const bad = keel(['commit', 'memory', 'SPEC-001', 'refresh and sneak in code'], dir);
  // Either guard is a correct refusal: the bucket rule names api-main, the path rule names
  // the directory. What matters is that production code cannot ride in a memory commit.
  if (bad.code === 0) return `production code rode along in a memory commit: ${bad.out.trim()}`;
  return /may not contain|only touch docs\/knowledge/.test(bad.out) ? null : `refused, but unclearly: ${bad.out.trim()}`;
});

scenario('security is a read-only phase between integration and e2e', (dir) => {
  keel(['state', 'start', 'feature', '--spec', 'specs/001-bookmarks.md', '--phase', 'integration'], dir);
  const legal = keel(['state', 'phase', 'security'], dir);
  if (legal.code !== 0) return `integration -> security should be legal: ${legal.out.trim()}`;
  const blocked = hook('pre-tool', edit('apps/api/src/main/kotlin/app/BookmarkController.kt'), dir);
  return blocked.code === 2 ? null : `the security phase should be read-only, got ${blocked.code}`;
});

scenario('stack packs supply the lint command verify full requires', (dir) => {
  const skills = require('./skills');
  const cfg = require('./config').load(dir);
  // Both packs contribute a linter, joined so neither app's is dropped.
  const sc = skills.packCommands(cfg).static_checks || '';
  if (!/detekt|ktlint/.test(sc)) return `no Kotlin linter offered: ${JSON.stringify(sc)}`;
  if (!/eslint/.test(sc)) return `no frontend linter offered: ${JSON.stringify(sc)}`;
  // The sandbox sets static_checks itself, so the project's value must be the one in force.
  if (!/echo static checks ok/.test(cfg.commands.static_checks)) {
    return `a project value lost to the pack: ${JSON.stringify(cfg.commands.static_checks)}`;
  }
  // And an explicit blank means off, not unset — the packs must not fill it back in.
  return cfg.commands.coverage_web === '' ? null
    : `an explicit blank was overwritten by a pack: ${JSON.stringify(cfg.commands.coverage_web)}`;
});

scenario('GREEN loads both placement and implementation, per layer', (dir) => {
  const skills = require('./skills');
  keel(['arch', 'set', 'hexagonal'], dir);
  const cfg = require('./config').load(dir);
  const api = skills.resolve(cfg, 'green', 'API').filter((i) => i.skill).map((i) => i.skill);
  const web = skills.resolve(cfg, 'green', 'WEB').filter((i) => i.skill).map((i) => i.skill);
  if (!api.includes('keel:architecture')) return `API GREEN lost placement: ${api.join(', ')}`;
  if (!web.includes('keel:web-implementation')) return `WEB GREEN has no implementation skill: ${web.join(', ')}`;
  // Every reference a resolution names must exist on disk.
  for (const layer of ['API', 'WEB']) {
    for (const item of skills.resolve(cfg, 'green', layer)) {
      if (!item.reference) continue;
      const p = path.join(__dirname, '..', 'skills', 'architecture', item.reference);
      if (!fs.existsSync(p)) return `${layer} points at a missing reference: ${item.reference}`;
    }
  }
  return null;
});

scenario('spec check names the states a mockup has not drawn', (dir) => {
  const spec = 'specs/002-mockup.md';
  fs.writeFileSync(path.join(dir, spec), [
    '## Context', 'A feature.', '',
    '## Acceptance criteria', '- AC-001 [WEB] Given a list, when empty, then a hint shows', '',
    '## UI mockup', '', '```', 'Default', '[ input ] ( Save )', '```', '',
    '## Request path', '', '## Data and migrations', '', '## Validation and security rules', '',
    '## Out of scope', '',
  ].join('\n'));
  keel(['state', 'start', 'feature', '--spec', spec], dir);
  const r = keel(['spec', 'check'], dir);
  if (!/empty, loading, error/.test(r.out)) return `missing states not reported: ${r.out.trim()}`;
  if (r.code !== 0) return 'spec check must warn, not block';
  return /empty" is empty|is empty/.test(r.out) ? null : `empty sections not reported: ${r.out.trim()}`;
});

scenario('a drawing that mentions an AC id does not trigger [gate: skip]', (dir) => {
  const spec = 'specs/003-fenced.md';
  fs.writeFileSync(path.join(dir, spec), [
    '## Acceptance criteria', '- AC-001 [WEB] Given a form, when saved, then it closes', '',
    '## UI mockup', '', '```', 'Default  [gate: skip]  AC-001 lives here', '```', '',
  ].join('\n'));
  keel(['state', 'start', 'feature', '--spec', spec], dir);
  const r = keel(['state', 'ac', 'AC-001', '--layer', 'WEB', '--current'], dir);
  if (/gate skipped/.test(r.out)) return 'a fenced drawing wrongly set gate: skip';
  const s = JSON.parse(keel(['state', 'show'], dir).out);
  return s.acs['AC-001'].gate === 'skip' ? 'the AC was wrongly marked gate: skip' : null;
});

scenario('spec show re-renders a drawing, and escalate writes both sections', (dir) => {
  const spec = 'specs/004-show.md';
  fs.writeFileSync(path.join(dir, spec), [
    '## Acceptance criteria', '- AC-001 [API] something', '',
    '## Request path', '', '```', 'POST /x  + endpoint', '```', '',
  ].join('\n'));
  keel(['state', 'start', 'feature', '--spec', spec], dir);
  const shown = keel(['spec', 'show', '--path'], dir);
  if (!/POST \/x/.test(shown.out)) return `spec show --path did not render: ${shown.out.trim()}`;
  // An escalated spec must carry the drawing sections too, or keel flags a gap it created.
  keel(['state', 'start', 'change', '--size', 'small', '--phase', 'red'], dir);
  keel(['state', 'ac', 'CHG-1.1', '--layer', 'WEB', '--current'], dir);
  const esc = keel(['escalate'], dir);
  if (esc.code !== 0) return `escalate failed: ${esc.out.trim()}`;
  const written = fs.readFileSync(path.join(dir, JSON.parse(keel(['state', 'show'], dir).out).spec), 'utf8');
  if (!/## UI mockup/.test(written)) return 'the escalated spec has no UI mockup section';
  return /## Request path/.test(written) ? null : 'the escalated spec has no Request path section';
});

scenario('workflow gates stand down in a repo that never opted into keel', (dir) => {
  const cfgFile = path.join(dir, '.keel', 'config.yml');
  const saved = fs.readFileSync(cfgFile, 'utf8');
  try {
    // No .keel/config.yml means the project never adopted the workflow, so gating its
    // pushes would be keel imposing a process nobody asked for.
    fs.unlinkSync(cfgFile);
    const push = hook('pre-tool', bash('git push'), dir);
    if (push.code !== 0) return `an unconfigured repo should not be gated: ${push.out.trim()}`;
    // Harm-prevention guards are not workflow, so they still apply.
    const env = hook('pre-tool', read('.env'), dir);
    if (env.code !== 2) return `reading .env should still be blocked, got ${env.code}`;
  } finally {
    fs.writeFileSync(cfgFile, saved);
  }
  // And with config present the gate is back.
  const gated = hook('pre-tool', bash('git push'), dir);
  return gated.code === 2 ? null : `a configured repo should be gated, got ${gated.code}`;
});

scenario('the board shows the phase rail, the ACs and the next command', (dir) => {
  startRed(dir, 'AC-001', 'api');
  keel(['state', 'ac', 'AC-002', '--layer', 'WEB'], dir);
  const r = keel(['board'], dir);
  if (r.code !== 0) return `board failed: ${r.out.trim()}`;
  for (const want of ['phase', '[RED]', 'AC-001', 'AC-002', 'agents', 'blocking a push', 'next']) {
    if (!r.out.includes(want)) return `board is missing "${want}":\n${r.out}`;
  }
  // No ANSI: the simulator has no TTY and the model reads this as text.
  if (/\[/.test(r.out)) return 'the board emitted ANSI escape codes';
  // status is an alias, so the two cannot drift.
  const s = keel(['status'], dir);
  return s.out === r.out ? null : 'status and board rendered differently';
});

scenario('the board reports keel agents in flight, and clears them on stop', (dir) => {
  startRed(dir, 'AC-001', 'api');
  const start = (agent) => hook('subagent-start', { agent_type: agent }, dir);
  start('keel:explorer');
  start('keel:explorer');
  start('keel:reviewer');
  let r = keel(['board'], dir);
  if (!/keel:explorer ×2/.test(r.out)) return `two explorers not shown as ×2:\n${r.out}`;
  if (!/keel:reviewer/.test(r.out)) return `the reviewer is not shown:\n${r.out}`;
  // A matching stop clears exactly one run of that type.
  hook('subagent-stop', { agent_type: 'keel:explorer', last_message: 'MAP-END' }, dir);
  r = keel(['board'], dir);
  if (/keel:explorer ×2/.test(r.out)) return `a stop did not clear one explorer:\n${r.out}`;
  if (!/keel:explorer/.test(r.out)) return `the second explorer was wrongly cleared:\n${r.out}`;
  hook('subagent-stop', { agent_type: 'keel:explorer', last_message: 'MAP-END' }, dir);
  hook('subagent-stop', { agent_type: 'keel:reviewer', last_message: 'BLOCKING: no' }, dir);
  r = keel(['board'], dir);
  return /none running/.test(r.out) ? null : `agents were not all cleared:\n${r.out}`;
});

scenario('an agent with no recorded stop is flagged, not counted as live forever', (dir) => {
  startRed(dir, 'AC-001', 'api');
  hook('subagent-start', { agent_type: 'keel:implementer' }, dir);
  // Backdate it past the stale threshold: a crashed agent never fires SubagentStop, and a
  // counter that only increments would claim it was running for the rest of the flow.
  const f = path.join(dir, '.keel', 'state.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  s.agents['keel:implementer'] = [new Date(Date.now() - 3600 * 1000).toISOString()];
  fs.writeFileSync(f, JSON.stringify(s));
  const r = keel(['board'], dir);
  if (!/stale\?/.test(r.out)) return `a stale agent was not flagged:\n${r.out}`;
  const reaped = keel(['board', '--reap'], dir);
  if (!/cleared 1 stale/.test(reaped.out)) return `--reap did not clear it: ${reaped.out.trim()}`;
  return /none running/.test(keel(['board'], dir).out) ? null : 'the stale record survived --reap';
});

scenario('the board names the same push blockers the hook blocks on', (dir) => {
  startRed(dir, 'AC-001', 'api');
  // One predicate, two readers: if these ever disagree, the one the user reads is wrong.
  const shown = keel(['board'], dir).out;
  const blocked = hook('pre-tool', bash('git push'), dir);
  const boardSaysBlocked = /blocking a push\n\s+(coverage|deps):/.test(shown);
  if (boardSaysBlocked !== (blocked.code === 2)) {
    return `board says blocked=${boardSaysBlocked} but the hook exited ${blocked.code}`;
  }
  if (!boardSaysBlocked) return null;
  // And it names the same gate.
  const gate = (shown.match(/blocking a push\n\s+(\w+):/) || [])[1];
  return blocked.out.includes(gate) ? null
    : `board blamed "${gate}" but the hook said: ${blocked.out.trim()}`;
});

scenario('the checklist expands per criterion inside the loop, phases outside it', (dir) => {
  keel(['state', 'start', 'feature', '--spec', 'specs/001-bookmarks.md', '--phase', 'spec'], dir);
  keel(['state', 'ac', 'AC-001', '--layer', 'API', '--current'], dir);
  keel(['state', 'ac', 'AC-002', '--layer', 'WEB'], dir);
  let list = keel(['todos'], dir).out;
  // Outside the loop: phases are the steps, and the criteria are listed but not "in" a step.
  if (!/▶ spec\b/.test(list)) return `spec is not the in-progress phase:\n${list}`;
  if (!/AC-001/.test(list) || !/AC-002/.test(list)) return `criteria missing:\n${list}`;
  if (/AC-001 \[API\] · spec/.test(list)) return `a criterion is tagged with a non-loop phase:\n${list}`;
  // A single "RED" entry would sit in progress for every criterion, which is the thing this
  // avoids: inside the loop the current criterion is the in-progress step.
  keel(['state', 'phase', 'plan'], dir);
  keel(['state', 'phase', 'red'], dir);
  list = keel(['todos'], dir).out;
  if (!/▶ AC-001 \[API\] · red/.test(list)) return `the current criterion is not in progress:\n${list}`;
  if (/▶ .*\bred —/.test(list)) return `a bare red phase entry is in progress:\n${list}`;
  const json = JSON.parse(keel(['todos', '--json'], dir).out);
  const cur = json.filter((t) => t.status === 'in_progress');
  return cur.length === 1 && cur[0].id === 'AC-001' ? null
    : `--json should show exactly AC-001 in progress, got ${JSON.stringify(cur)}`;
});

scenario('statuses follow state, with nothing stored separately', (dir) => {
  startRed(dir, 'AC-001', 'api');
  keel(['state', 'ac', 'AC-002', '--layer', 'API'], dir);
  const before = JSON.parse(keel(['todos', '--json'], dir).out);
  if (before.find((t) => t.id === 'spec').status !== 'completed') return 'spec should be complete once past it';
  keel(['state', 'ac', 'AC-001', '--layer', 'API', '--status', 'done'], dir);
  const after = JSON.parse(keel(['todos', '--json'], dir).out);
  if (after.find((t) => t.id === 'AC-001').status !== 'completed') return 'a done criterion is not complete';
  // The board counts the same state, so the two views cannot disagree.
  const board = keel(['board'], dir).out;
  const done = after.filter((t) => t.status === 'completed').length;
  return keel(['todos'], dir).out.includes(`${done}/`) && /1\/2 done/.test(board) ? null
    : `board and checklist disagree:\n${board}`;
});

scenario('the checklist hook fires on a state change and stays quiet otherwise', (dir) => {
  startRed(dir, 'AC-001', 'api');
  const after = (command) => hook('post-tool', { tool_name: 'Bash', tool_input: { command } }, dir);
  const moved = after('keel state phase red');
  if (!/todo\s+\d+\/\d+/.test(moved.out)) return `no checklist after a state change:\n${moved.out}`;
  if (!/If you keep a todo list, mirror it/.test(moved.out)) return 'the checklist came without its mirroring note';
  // This dispatcher now matches every Bash call, so anything unrelated must be silent.
  for (const cmd of ['ls -la', 'git status', 'npm test', 'keel status']) {
    const quiet = after(cmd);
    if (quiet.out.trim()) return `"${cmd}" should produce nothing, got: ${quiet.out.trim()}`;
  }
  return null;
});

scenario('a config value ending in a quote keeps it', () => {
  // `--tests '*{AC}*'` ends in a quote without starting with one. Stripping leading and
  // trailing quotes independently silently unbalanced it, corrupting the command the
  // shipped template uses for api_test_ac and api_test_pkg.
  const { parseYaml } = require('./util');
  const c = parseYaml(["commands:",
    "  api_test_ac: ./gradlew -q test --tests '*{AC}*'",
    "  whole: 'npx vitest run'",
    '  plain: npx eslint .'].join('\n')).commands;
  if (c.api_test_ac !== "./gradlew -q test --tests '*{AC}*'") return `trailing quote lost: ${JSON.stringify(c.api_test_ac)}`;
  if (c.whole !== 'npx vitest run') return `a fully quoted value was not unwrapped: ${JSON.stringify(c.whole)}`;
  return c.plain === 'npx eslint .' ? null : `a plain value changed: ${JSON.stringify(c.plain)}`;
});

scenario('the ladder groups independent rungs and its output order is stable', (dir) => {
  const setup = require('./setup');
  const cfg = require('./config').load(dir);
  const groups = setup.levels(setup.rungs(cfg, setup.discover(cfg)));
  const ids = groups.map((g) => g.map((r) => r.id));
  const level = (id) => ids.findIndex((g) => g.includes(id));
  // The Docker pull needs Docker, not the build, so it must not queue behind Gradle.
  if (level('services') > level('compile')) return `services should not wait for compile: ${JSON.stringify(ids)}`;
  if (level('dependencies') !== level('dependencies-web')) return `the two dependency rungs should share a level: ${JSON.stringify(ids)}`;
  if (level('compile') <= level('dependencies')) return `compile must follow dependencies: ${JSON.stringify(ids)}`;
  // Concurrency must not make the output vary between runs.
  const a = keel(['ladder'], dir).out;
  const b = keel(['ladder'], dir).out;
  const strip = (s) => s.split('\n').filter((l) => !/^runbook:/.test(l)).join('\n');
  return strip(a) === strip(b) ? null : `ladder output differed between runs:\n--- a ---\n${a}\n--- b ---\n${b}`;
});

scenario('two failures in one level are both reported', (dir) => {
  // Break the api and web rungs of the same level; the old fail-fast reported only the first,
  // so you fixed it and rediscovered the second on the next run.
  fs.appendFileSync(path.join(dir, '.keel/config.yml'),
    '\ncommands:\n  deps_api: exit 7\n  deps_web: exit 8\n');
  const r = keel(['ladder'], dir);
  if (r.code === 0) return 'the ladder should have failed';
  if (!/dependencies/.test(r.out)) return `the api failure is missing:\n${r.out}`;
  return /Frontend dependencies/.test(r.out) ? null : `the sibling failure was not reported:\n${r.out}`;
});

scenario('the dev container is composed from the matched stack packs', (dir) => {
  const setup = require('./setup');
  const cfg = require('./config').load(dir);
  const dc = setup.devContainerFiles(cfg);
  if (!dc) return 'no dev container was composed';
  const compose = dc.files['compose.dev.yml'];
  if (/\{\{/.test(compose)) return `a placeholder was left unsubstituted:\n${compose}`;
  // Both stacks are present in the sandbox, so both toolchains must be, and that needs a
  // generated Dockerfile — a Java image has no Node.
  if (!dc.multi) return `two stacks matched but no Dockerfile was generated: ${dc.packs.join(', ')}`;
  const dockerfile = dc.files['.devcontainer/Dockerfile'];
  if (!/FROM /.test(dockerfile)) return 'the Dockerfile has no FROM';
  if (!/nodejs|node_/.test(dockerfile)) return `the second toolchain was not added:\n${dockerfile}`;
  // The JSON must stay a pointer: a second definition would drift from compose.
  const json = JSON.parse(dc.files['.devcontainer/devcontainer.json']);
  if (json.image || json.build) return 'devcontainer.json redefines the image instead of pointing at compose';
  return json.service === 'dev' && /compose\.dev\.yml/.test(String(json.dockerComposeFile))
    ? null : `the pointer is wrong: ${JSON.stringify(json)}`;
});

// A configured project that is NOT a git repository. fakeRepo() always runs `git init`, so the
// whole no-git class of bug was unreachable by every scenario in this file — which is how it
// survived to be found in the field.
function nonGitRepo() {
  const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'keel-nogit-'));
  fs.mkdirSync(path.join(d, '.keel'), { recursive: true });
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', 'config.yml'), 'utf8');
  fs.writeFileSync(path.join(d, '.keel', 'config.yml'), tpl.replace(/\{\{[A-Z_]*\}\}/g, 'x'));
  return d;
}

// A knowledge base whose sections say `body`, each citing the controller. `extra` is appended to
// conventions.md, which is where the proof rule applies.
// Each run owns a directory named for the day and its number, so a scenario has to ask which
// run is open rather than hardcoding a shared path.
function runIdOf(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.keel', 'hunt.json'), 'utf8')).run;
}
function reproRel(dir, id) { return path.join('.keel', 'hunt', runIdOf(dir), 'repro', `${id}.sh`); }
function reportDirOf(dir) { return path.join(dir, 'docs', 'hunts', runIdOf(dir)); }

const KB_CTRL = 'apps/api/src/main/kotlin/app/BookmarkController.kt';
const KB_TEST = 'apps/api/src/test/kotlin/app/BookmarkControllerTest.kt';
function knowledge(dir, extra) {
  const d = path.join(dir, 'docs', 'knowledge');
  fs.mkdirSync(d, { recursive: true });
  for (const n of ['architecture', 'domain', 'data', 'integrations']) {
    fs.writeFileSync(path.join(d, `${n}.md`), `# ${n}\n\nSee \`${KB_CTRL}:1\`.\n`);
  }
  fs.writeFileSync(path.join(d, 'conventions.md'),
    `# Conventions\n\nControllers live at \`${KB_CTRL}:1\`.\n${extra || ''}`);
  return d;
}

scenario('ladder: a not-checked rung does not read as a failure downstream', (dir) => {
  // Renaming `skipped` to `not-checked` broke preflight's allowlist, so every unconfigured rung
  // reported as "still failing" — found by a dry run against a real repo, not by a scenario.
  keel(['ladder'], dir);
  const pre = keel(['preflight', 'slug'], dir);
  if (/rungs still failing/.test(pre.out)) return `preflight read not-checked as failing: ${pre.out.trim()}`;
  // And the ladder repairs the ignore block itself, because it is what writes setup.json.
  const dirty = sh('git status --porcelain', dir).out.split('\n').filter((l) => /\.keel\/setup\.json/.test(l));
  return dirty.length ? `the ladder left its own verdict file dirtying the tree: ${dirty.join(', ')}` : null;
});

scenario('init: the runbook hands off instead of claiming the project is healthy', (dir) => {
  keel(['ladder'], dir);
  const book = fs.readFileSync(path.join(dir, 'docs/RUNNING.md'), 'utf8');
  // The one sentence that must never come back: an unqualified verification over a liveness ladder.
  if (/Verified by keel/.test(book)) return 'the runbook claims to have verified the project';
  if (!/liveness check/.test(book)) return 'the runbook does not say what class of check it ran';
  if (!/behaves correctly/.test(book)) return 'the runbook does not say what it cannot tell you';
  if (!/keel:hunt/.test(book)) return 'the runbook does not point at the flow that checks behaviour';
  // And the skill asks rather than deciding.
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'init', 'SKILL.md'), 'utf8');
  if (!/Do not tell the user the project is healthy/.test(skill)) return 'the skill still permits a health claim';
  if (!/keel ask audit-now --blocking/.test(skill)) return 'the skill does not raise the audit question';
  // Both answers get a command. Showing the one for "skip" and leaving "yes" as prose is a thumb
  // on the scale — the question is only real if declining and accepting cost the same.
  if (!/--answer "yes[^"]*" --by user/.test(skill)) return 'the skill offers no command for accepting';
  if (!/--answer "skip[^"]*" --by user/.test(skill)) return 'the skill offers no command for skipping';
  // And the decision needs its price: a hunt is not free and the reader is choosing to spend it.
  return /minutes/.test(skill) ? null : 'the skill does not say what a hunt costs';
});

scenario('memory: a claim about correctness needs a proof or an admission', (dir) => {
  // The field case: a real annotation, on a real line, that Spring ignores because nothing on the
  // class enables it. The citation resolves. The claim is still worthless as an instruction.
  knowledge(dir, `\nPagination uses \`@Valid @Min(0) @Max(100)\` on the parameter — \`${KB_CTRL}:2\`.\n`);
  const bad = keel(['memory', 'check'], dir);
  if (bad.code === 0) return 'an unproven @Valid claim was accepted';
  if (!/@Valid/.test(bad.out)) return `the refusal does not name the term: ${bad.out.trim()}`;
  if (!/unverified:/.test(bad.out)) return 'the refusal does not offer the marker';

  // Admitting it is unproven passes — that is the point, not a loophole.
  knowledge(dir, `\nunverified: pagination uses \`@Valid\` on the parameter — \`${KB_CTRL}:2\`.\n`);
  if (keel(['memory', 'check'], dir).code !== 0) return 'an `unverified:` claim was refused';

  // So does a citation into a test, because somebody ran that.
  knowledge(dir, `\nPagination \`@Valid\` is covered by \`${KB_TEST}:1\`.\n`);
  return keel(['memory', 'check'], dir).code === 0 ? null : 'a proven claim was refused';
});

scenario('memory: check refuses what cannot be checked', (dir) => {
  const d = knowledge(dir);
  // A citation to a file that is not there.
  fs.writeFileSync(path.join(d, 'domain.md'), '# Domain\n\nSee `apps/api/src/main/kotlin/app/Nope.kt:9`.\n');
  let r = keel(['memory', 'check'], dir);
  if (r.code === 0 || !/does not exist/.test(r.out)) return `a dangling citation passed: ${r.out.trim()}`;
  // A line past the end of a real file.
  fs.writeFileSync(path.join(d, 'domain.md'), `# Domain\n\nSee \`${KB_CTRL}:99999\`.\n`);
  r = keel(['memory', 'check'], dir);
  if (r.code === 0 || !/line\(s\)/.test(r.out)) return `a citation past the end passed: ${r.out.trim()}`;
  // A section with no citations at all was written from memory.
  fs.writeFileSync(path.join(d, 'domain.md'), '# Domain\n\nThe domain is about bookmarks.\n');
  r = keel(['memory', 'check'], dir);
  if (r.code === 0 || !/no citations at all/.test(r.out)) return `an unsourced section passed: ${r.out.trim()}`;
  // A template placeholder nobody replaced.
  fs.writeFileSync(path.join(d, 'domain.md'), `# Domain\n\nStyle {{ARCH_STYLE}} — \`${KB_CTRL}:1\`.\n`);
  r = keel(['memory', 'check'], dir);
  return r.code !== 0 && /placeholder/.test(r.out) ? null : `a surviving placeholder passed: ${r.out.trim()}`;
});

scenario('memory: update fills the placeholders the scaffold never did', (dir) => {
  const d = knowledge(dir);
  fs.writeFileSync(path.join(d, 'architecture.md'), `# Architecture\n\nStyle: {{ARCH_STYLE}} at {{COMMIT}} — \`${KB_CTRL}:1\`.\n`);
  const r = keel(['memory', 'update'], dir);
  const text = fs.readFileSync(path.join(d, 'architecture.md'), 'utf8');
  if (/\{\{/.test(text)) return `update left a placeholder behind: ${text}`;
  if (!/filled template values/.test(r.out)) return `update did not report the substitution: ${r.out.trim()}`;
  return r.code === 0 ? null : `update should pass on a clean base: ${r.out.trim()}`;
});

scenario('memory: an unchanged knowledge base is not re-stamped as current', (dir) => {
  knowledge(dir);
  keel(['memory', 'update'], dir);
  if (!/current/.test(keel(['memory', 'show'], dir).out)) return 'a fresh verdict is not reported as current';
  // A commit that changed nothing in docs/knowledge/ used to clear the staleness warning, because
  // freshness was `verdict.sha === HEAD` and nothing else.
  fs.writeFileSync(path.join(dir, 'README.md'), '# moved on\n');
  sh('git add -A && git commit -q -m "move on"', dir);
  const shown = keel(['memory', 'show'], dir).out;
  if (/^.*\(current\)/m.test(shown) && !/stale/.test(shown)) return `a stale base reports current: ${shown.trim()}`;
  return /have not changed|stale/.test(shown) ? null : `staleness is not reported: ${shown.trim()}`;
});

scenario('memory: a failing knowledge verdict blocks a push', (dir) => {
  // skills/memory has claimed since 0.6 that `keel pr` is refused while the verdict is stale.
  // gates.pushBlockers read coverage and security only.
  const d = knowledge(dir);
  fs.writeFileSync(path.join(d, 'domain.md'), '# Domain\n\nNo citations here.\n');
  keel(['memory', 'update'], dir);
  const blocked = hook('pre-tool', bash('git push'), dir);
  if (blocked.code !== 2) return `the push was not blocked: ${blocked.out.trim()}`;
  if (!/knowledge/.test(blocked.out)) return `blocked for another reason: ${blocked.out.trim()}`;
  // Fixed, and the push gate stops naming it.
  fs.writeFileSync(path.join(d, 'domain.md'), `# Domain\n\nSee \`${KB_CTRL}:1\`.\n`);
  keel(['memory', 'update'], dir);
  const after = hook('pre-tool', bash('git push'), dir);
  return /knowledge/.test(after.out) ? `still blocked on knowledge: ${after.out.trim()}` : null;
});

scenario('ladder: an unconfigured rung is a visible not-checked row, never absent', (dir) => {
  const r = keel(['ladder'], dir);
  // Four command keys ship empty, and those rungs used to be filtered out of the list entirely —
  // so a seven-rung run and a twelve-rung run produced identically clean output.
  for (const label of ['A container-backed test', 'Smoke check']) {
    if (!r.out.includes(label)) return `${label} vanished instead of reporting not-checked`;
  }
  if (!/NOT-CHECKED/.test(r.out)) return `no not-checked verdict: ${r.out.trim()}`;
  if (!/no commands\.smoke configured/.test(r.out)) return 'a not-checked rung does not say why';
  // And the runbook counts them rather than implying everything was looked at.
  const book = fs.readFileSync(path.join(dir, 'docs/RUNNING.md'), 'utf8');
  return /were not checked/.test(book) ? null : `the runbook does not count them: ${book.slice(0, 200)}`;
});

scenario('ladder: a test suite that ran nothing is not-checked, never pass', (dir) => {
  // keel already carries the phrase in loops.red_reject; the ladder never consulted it, so a
  // project with no tests at all passed the one rung that can see correctness.
  // The unit-tests rung runs in backend.dir, so it is apps/api/gradlew that answers, not the root
  // copy. A suite that finds nothing still exits 0 — that is the whole point.
  const gradlew = path.join(dir, 'apps', 'api', 'gradlew');
  fs.writeFileSync(gradlew, '#!/bin/sh\necho "no tests found for given includes"\nexit 0\n');
  fs.chmodSync(gradlew, 0o755);
  const r = keel(['ladder'], dir);
  const line = r.out.split('\n').find((l) => /Unit tests/.test(l)) || '';
  if (/^PASS/.test(line)) return `a suite that found no tests was recorded as a pass: ${line}`;
  return /NOT-CHECKED/.test(line) ? null : `expected not-checked for an empty suite: ${line}`;
});

scenario('ladder: lockfile drift is a finding, not a pass', (dir) => {
  // `frozen || loose` as one shell line meant an out-of-date lockfile exited 0 and read as PASS.
  const cfgFile = path.join(dir, '.keel', 'config.yml');
  fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, 'utf8').replace(/^\s+deps_web:.*$/m, "  deps_web: ''"));
  const pm = path.join(dir, 'fakebin', 'npm');
  fs.writeFileSync(pm, '#!/bin/sh\nfor a in "$@"; do [ "$a" = "--frozen-lockfile" ] && { echo "lockfile out of date"; exit 1; }; done\necho installed\nexit 0\n');
  fs.chmodSync(pm, 0o755);
  const r = keel(['ladder'], dir);
  const line = r.out.split('\n').find((l) => /Frontend dependencies/.test(l)) || '';
  if (/^PASS/.test(line)) return `lockfile drift passed: ${line}`;
  return /NEEDS-YOU/.test(line) ? null : `expected needs-you for lockfile drift: ${line} | ${r.out.trim().slice(0, 300)}`;
});

scenario('ladder: a rung that keeps failing becomes a blocking question', (dir) => {
  // setup.fix_attempts_per_rung was declared, cited in the docs, and read by nothing.
  // web_typecheck is `../../bin/vitest typecheck` in the fixture.
  const vitest = path.join(dir, 'bin', 'vitest');
  fs.writeFileSync(vitest, '#!/bin/sh\necho "typecheck exploded"\nexit 1\n');
  fs.chmodSync(vitest, 0o755);
  let raised = null;
  for (let i = 0; i < 3; i++) {
    keel(['ladder'], dir);
    const qf = path.join(dir, '.keel', 'questions.json');
    if (fs.existsSync(qf)) {
      const qs = JSON.parse(fs.readFileSync(qf, 'utf8')).questions;
      raised = Object.keys(qs).find((k) => /^rung-/.test(k));
      if (raised) break;
    }
    // A blocking question stops the next run, which is the point — clear it to keep counting.
    if (raised) break;
  }
  if (!raised) return 'a rung failed repeatedly and no question was ever raised';
  const q = JSON.parse(fs.readFileSync(path.join(dir, '.keel', 'questions.json'), 'utf8')).questions[raised];
  if (!q.blocking) return `${raised} is not blocking`;
  return /exclude it|not-checked/.test(q.question) ? null : `the question does not offer the options: ${q.question}`;
});

scenario('git: outside a repository, preflight names git rather than blaming the tree', () => {
  const d = nonGitRepo();
  try {
    const r = keel(['preflight', 'slug'], d);
    if (/not clean/.test(r.out)) return `preflight blamed a dirty tree for a missing repository: ${r.out.trim()}`;
    if (!/not a git repository/.test(r.out)) return `it should name git: ${r.out.trim()}`;
    // And the fatal string must never reach a value.
    if (/fatal:/.test(r.out)) return `git's stderr leaked into the output: ${r.out.trim()}`;
    return null;
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

scenario('git: a diff-scoped pass that compared nothing says so', () => {
  const d = nonGitRepo();
  try {
    const r = keel(['verify', 'fast'], d);
    if (r.code !== 0) return `fast should not fail for want of git: ${r.out.trim()}`;
    if (/^fast checks pass\.$/m.test(r.out)) return 'a vacuous pass is reported as a real one';
    return /nothing was compared/.test(r.out) ? null : `it should say nothing was compared: ${r.out.trim()}`;
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

scenario('git: the ladder raises a blocking question when there is no repository', () => {
  const d = nonGitRepo();
  try {
    const r = keel(['ladder'], d);
    if (!/Git repository/.test(r.out)) return `the git rung did not run: ${r.out.trim()}`;
    const q = JSON.parse(fs.readFileSync(path.join(d, '.keel', 'questions.json'), 'utf8')).questions['git-repo'];
    if (!q) return 'no question was raised';
    if (!q.blocking) return 'the question is not blocking';
    if (!/runbook|coverage|base_branch/.test(q.because)) return `the consequences are not named: ${q.because}`;
    // It blocks until answered, and a second ladder run does not re-ask.
    if (keel(['preflight', 'slug'], d).code === 0) return 'preflight ran with the question open';
    keel(['ask', 'git-repo', '--answer', 'no git for this one', '--by', 'user'], d);
    keel(['ladder'], d);
    const after = JSON.parse(fs.readFileSync(path.join(d, '.keel', 'questions.json'), 'utf8')).questions['git-repo'];
    return after.answer ? null : 'a second ladder run cleared the answer and re-asked';
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

scenario('ask: a blocking question refuses work until it is answered', (dir) => {
  const raised = keel(['ask', 'git-repo', '--question', 'not a git repository — initialise one?',
    '--because', 'the runbook cannot be pinned', '--blocking'], dir);
  if (raised.code !== 0) return `raising failed: ${raised.out.trim()}`;
  // Every gate refuses the same way and names the same way out.
  for (const cmd of [['ladder', '--plan'], ['preflight', 'slug'], ['memory', 'update'], ['init', '--write']]) {
    const r = keel(cmd, dir);
    if (r.code === 0) return `${cmd.join(' ')} ran with a blocking question open`;
    if (!/blocking question/.test(r.out)) return `${cmd.join(' ')} refused without saying why: ${r.out.trim()}`;
    if (!/keel ask git-repo --answer/.test(r.out)) return `${cmd.join(' ')} did not name the way out`;
  }
  const answered = keel(['ask', 'git-repo', '--answer', 'proceeding without git', '--by', 'user'], dir);
  if (answered.code !== 0) return `answering failed: ${answered.out.trim()}`;
  const after = keel(['ladder', '--plan'], dir);
  return after.code === 0 ? null : `the ladder should run once answered: ${after.out.trim()}`;
});

scenario('ask: an answer records who gave it, and a self-answer says so', (dir) => {
  keel(['ask', 'q1', '--question', 'one?', '--blocking'], dir);
  // keel cannot prove a human answered. The least it can do is not pretend otherwise.
  const self = keel(['ask', 'q1', '--answer', 'yes'], dir);
  if (!/self-answer/.test(self.out)) return `a model answer must be visible as one: ${self.out.trim()}`;
  const q = JSON.parse(fs.readFileSync(path.join(dir, '.keel', 'questions.json'), 'utf8')).questions.q1;
  if (q.answered_by !== 'model') return `default --by should be model, got ${q.answered_by}`;
  if (!q.answered_at) return 'the answer was not dated';
  keel(['ask', 'q2', '--question', 'two?'], dir);
  const byUser = keel(['ask', 'q2', '--answer', 'no', '--by', 'user'], dir);
  if (/self-answer/.test(byUser.out)) return 'a user answer was labelled a self-answer';
  if (keel(['ask', 'q2', '--answer', 'x', '--by', 'nobody'], dir).code === 0) return 'an unknown --by was accepted';
  return keel(['ask', 'nosuch', '--answer', 'x'], dir).code !== 0 ? null : 'answering an unknown question was accepted';
});

scenario('ask: raising a question again never clears its answer', (dir) => {
  // The rung that raises it runs every ladder pass; re-raising must not re-ask.
  keel(['ask', 'git-repo', '--question', 'initialise?', '--blocking'], dir);
  keel(['ask', 'git-repo', '--answer', 'no, later', '--by', 'user'], dir);
  const again = keel(['ask', 'git-repo', '--question', 'initialise?', '--blocking'], dir);
  if (!/already answered/.test(again.out)) return `re-raising should report the answer: ${again.out.trim()}`;
  if (keel(['ladder', '--plan'], dir).code !== 0) return 're-raising re-blocked an answered question';
  const cleared = keel(['ask', 'clear', 'git-repo'], dir);
  if (cleared.code !== 0) return `clear failed: ${cleared.out.trim()}`;
  return /no questions recorded/.test(keel(['ask', 'list'], dir).out) ? null : 'clear left the question behind';
});

scenario('every known phase has a guard-matrix row', () => {
  const missing = require('./state').PHASES.filter((p) => !require('./guards').MATRIX[p]);
  return missing.length ? `phases with no matrix row (they would fall through): ${missing.join(', ')}` : null;
});

scenario('hunt: the rail and the checklist show the five phases', (dir) => {
  const started = keel(['state', 'start', 'hunt'], dir);
  if (started.code !== 0) return `state start hunt failed: ${started.out.trim()}`;
  const board = keel(['board'], dir);
  for (const label of ['scope', 'sweep', 'prove', 'report', 'triage']) {
    if (!board.out.includes(label)) return `the rail is missing "${label}": ${board.out.trim()}`;
  }
  const todos = keel(['todos'], dir);
  if (/toolchain/i.test(todos.out)) return `the checklist fell through to the setup ladder: ${todos.out.trim()}`;
  return /0\/5/.test(todos.out) ? null : `expected a five-step checklist: ${todos.out.trim()}`;
});

// A hunt in its sweep, with `n` candidates already ingested from the security lens.
function huntWithCandidates(dir, candidates) {
  keel(['hunt', 'start', '--scope', 'all'], dir);
  keel(['hunt', 'lenses', '--confirm', 'security,behavioral'], dir);
  const f = path.join(dir, 'cand.json');
  fs.writeFileSync(f, JSON.stringify(candidates));
  return keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'cand.json'], dir);
}
const CAND = { title: 'a duplicate url returns 500', where: ['apps/api/src/main/kotlin/app/BookmarkPort.kt:88'], symptom: 'the caller sees a 500 where 409 was documented' };
// Findings at distinct places. Dedup merges anything landing on the same file within 10 lines, so a
// fixture that reuses one location now describes one finding however many titles it carries.
const candAt = (n, extra = {}) => Object.assign({}, CAND, {
  title: `finding ${n}`, symptom: `symptom ${n}`,
  where: [`apps/api/src/main/kotlin/app/Port${n}.kt:${10 + n * 40}`],
}, extra);

scenario('hunt: candidates cannot be ingested before the lens set is confirmed', (dir) => {
  keel(['hunt', 'start', '--scope', 'all'], dir);
  fs.writeFileSync(path.join(dir, 'cand.json'), JSON.stringify([CAND]));
  const early = keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'cand.json'], dir);
  if (early.code === 0) return 'a candidate was ingested with no lens set confirmed';
  // Reaching the sweep by hand must not be a way round the gate: the phase moved, the
  // confirmation did not, and `add` still refuses.
  keel(['state', 'phase', 'hunt-sweep'], dir);
  const bypass = keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'cand.json'], dir);
  if (bypass.code === 0) return '`keel state phase hunt-sweep` bypassed the lens gate';
  if (!/confirm/i.test(bypass.out)) return `refused without naming the gate: ${bypass.out.trim()}`;
  const ok = keel(['hunt', 'lenses', '--confirm', 'security'], dir);
  if (ok.code !== 0) return `confirming failed: ${ok.out.trim()}`;
  const after = keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'cand.json'], dir);
  return after.code === 0 ? null : `ingest should work once confirmed: ${after.out.trim()}`;
});

scenario('hunt: confirming the lens set is what opens the sweep', (dir) => {
  keel(['hunt', 'start'], dir);
  if (JSON.parse(keel(['state', 'show'], dir).out).phase !== 'hunt-scope') return 'hunt start did not land in hunt-scope';
  const bad = keel(['hunt', 'lenses', '--confirm', 'security,vibes'], dir);
  if (bad.code === 0) return 'an unconfigured lens was confirmed';
  if (!/vibes/.test(bad.out)) return `refused without naming the lens: ${bad.out.trim()}`;
  if (keel(['hunt', 'lenses', '--confirm'], dir).code === 0) return '--confirm with no value was accepted';
  const read = keel(['hunt', 'lenses'], dir);
  if (!/none yet/.test(read.out)) return `the read should say nothing is confirmed: ${read.out.trim()}`;
  keel(['hunt', 'lenses', '--confirm', 'security,behavioral'], dir);
  return JSON.parse(keel(['state', 'show'], dir).out).phase === 'hunt-sweep' ? null
    : 'confirming did not move the flow into the sweep';
});

scenario('hunt: a malformed candidate is refused by field and index, a fenced one is accepted', (dir) => {
  keel(['hunt', 'start'], dir);
  keel(['hunt', 'lenses', '--confirm', 'security'], dir);
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify([{ lens: 'security' }]));
  const bad = keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'bad.json'], dir);
  if (bad.code === 0) return 'a candidate with no title was accepted';
  if (!/\[0\]\.title/.test(bad.out)) return `the refusal must name the field and the index: ${bad.out.trim()}`;
  fs.writeFileSync(path.join(dir, 'nowhere.json'), JSON.stringify([{ title: 't', symptom: 's' }]));
  if (!/\[0\]\.where/.test(keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'nowhere.json'], dir).out)) return 'a candidate with no location was not named';
  // What a model actually returns: a fenced block, with a sentence and a result line round it.
  const fence = '```'; // eslint-disable-line
  fs.writeFileSync(path.join(dir, 'fenced.json'),
    `Here is what I found.\n\n${fence}json\n${JSON.stringify([CAND])}\n${fence}\n\nFINDINGS: 1\n`);
  const ok = keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'fenced.json'], dir);
  return ok.code === 0 && /ingested 1/.test(ok.out) ? null
    : `a fenced result set should ingest: ${ok.out.trim()}`;
});

scenario('hunt: a lens agent cannot set a severity, and the cap is enforced', (dir) => {
  const r = huntWithCandidates(dir, [{ ...CAND, severity: 'critical' }]);
  if (r.code !== 0) return `ingest failed: ${r.out.trim()}`;
  if (!/dropped a lens-supplied severity/.test(r.out)) return `the drop must be reported, not silent: ${r.out.trim()}`;
  const run = JSON.parse(fs.readFileSync(path.join(dir, '.keel', 'hunt', runIdOf(dir), 'run.json'), 'utf8'));
  if (run.findings[0].severity !== null) return `the severity was stored anyway: ${run.findings[0].severity}`;
  if (run.findings[0].status !== 'candidate') return `a fresh candidate should not have a verdict: ${run.findings[0].status}`;
  const many = Array.from({ length: 13 }, (_, i) => candAt(i));
  fs.writeFileSync(path.join(dir, 'many.json'), JSON.stringify(many));
  const over = keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'many.json'], dir);
  return over.code !== 0 && /cap of 12/.test(over.out) ? null : `13 candidates should be refused: ${over.out.trim()}`;
});

scenario('hunt: start repairs the gitignore so the backlog never dirties the tree', (dir) => {
  const started = keel(['hunt', 'start'], dir);
  if (started.code !== 0) return `hunt start failed: ${started.out.trim()}`;
  keel(['hunt', 'lenses', '--confirm', 'security'], dir);
  fs.writeFileSync(path.join(dir, 'cand.json'), JSON.stringify([CAND]));
  keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'cand.json'], dir);
  const dirty = sh('git status --porcelain', dir).out.split('\n').filter((l) => /\.keel\/hunt/.test(l));
  if (dirty.length) return `the backlog is in git status, so preflight would refuse: ${dirty.join(', ')}`;
  // `keel preflight` is what this protects: it refuses a tree that is not clean, and it is
  // step 0 of the fix flow a hunt hands off to.
  const ignored = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  for (const l of ['.keel/hunt/', '.keel/hunt.json']) if (!ignored.includes(l)) return `${l} is not ignored`;
  return null;
});

// A hunt with `n` proven findings, ready for grouping. Recipes are real files, because the
// proof bar refuses anything else.
function huntProven(dir, n = 2) {
  const cands = Array.from({ length: n }, (_, i) => candAt(i));
  huntWithCandidates(dir, cands);
  keel(['state', 'phase', 'hunt-prove'], dir);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `F-${String(i + 1).padStart(3, '0')}`;
    const rel = reproRel(dir, id);
    fs.writeFileSync(path.join(dir, rel), `curl -fsS localhost:8080/x   # ${id}\n`);
    keel(['hunt', 'prove', id, '--verdict', 'proven', '--severity', i === 0 ? 'high' : 'low',
      '--evidence', 'ran it twice, failed twice', '--repro', rel], dir);
    ids.push(id);
  }
  return ids;
}

scenario('hunt: a proven verdict without a runnable recipe is refused', (dir) => {
  huntWithCandidates(dir, [CAND]);
  keel(['state', 'phase', 'hunt-prove'], dir);
  const noRepro = keel(['hunt', 'prove', 'F-001', '--verdict', 'proven', '--severity', 'high', '--evidence', 'curl gave 500'], dir);
  if (noRepro.code === 0) return 'proven was accepted with no recipe';
  if (!/--repro/.test(noRepro.out)) return `refused without naming the recipe: ${noRepro.out.trim()}`;
  // Outside the backlog, so it would not travel with it.
  fs.writeFileSync(path.join(dir, 'loose.sh'), 'curl -fsS localhost\n');
  if (keel(['hunt', 'prove', 'F-001', '--verdict', 'proven', '--severity', 'high', '--evidence', 'e', '--repro', 'loose.sh'], dir).code === 0) {
    return 'a recipe outside the run\'s repro directory was accepted';
  }
  const rel = reproRel(dir, 'F-001');
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), '');
  if (keel(['hunt', 'prove', 'F-001', '--verdict', 'proven', '--severity', 'high', '--evidence', 'e', '--repro', rel], dir).code === 0) {
    return 'an empty recipe was accepted';
  }
  fs.writeFileSync(path.join(dir, rel), 'curl -fsS localhost:8080/x\n');
  if (keel(['hunt', 'prove', 'F-001', '--verdict', 'proven', '--evidence', 'e', '--repro', rel], dir).code === 0) {
    return 'proven was accepted with no severity';
  }
  if (keel(['hunt', 'prove', 'F-001', '--verdict', 'proven', '--severity', 'spicy', '--evidence', 'e', '--repro', rel], dir).code === 0) {
    return 'a severity outside the ladder was accepted';
  }
  const ok = keel(['hunt', 'prove', 'F-001', '--verdict', 'proven', '--severity', 'high', '--evidence', 'ran twice, failed twice', '--repro', rel], dir);
  if (ok.code !== 0) return `a complete proof should be accepted: ${ok.out.trim()}`;
  // An unproven verdict needs evidence but no recipe, and must not claim a severity.
  const again = keel(['hunt', 'prove', 'F-001', '--verdict', 'unproven', '--evidence', 'x'], dir);
  return again.code !== 0 ? null : 'a second verdict overwrote the first';
});

scenario('hunt: an unproven finding is kept, without a severity', (dir) => {
  huntWithCandidates(dir, [CAND]);
  keel(['state', 'phase', 'hunt-prove'], dir);
  if (keel(['hunt', 'prove', 'F-001', '--verdict', 'unproven'], dir).code === 0) return 'a verdict with no evidence was accepted';
  if (keel(['hunt', 'prove', 'F-001', '--verdict', 'unproven', '--evidence', 'e', '--severity', 'high'], dir).code === 0) {
    return 'an unproven finding was given a severity';
  }
  const ok = keel(['hunt', 'prove', 'F-001', '--verdict', 'unproven', '--evidence', '20 loads, no repeat'], dir);
  if (ok.code !== 0) return `unproven should record: ${ok.out.trim()}`;
  const shown = keel(['hunt', 'list'], dir);
  if (!/unproven/.test(shown.out)) return 'an unproven finding was dropped rather than kept';
  return /F-001/.test(shown.out) ? null : 'the finding vanished from the backlog';
});

scenario('hunt: candidates hands out one batch at a time', (dir) => {
  // prove_concurrency shipped in 0.8 as a number no code read. It is a limit now.
  const many = Array.from({ length: 6 }, (_, i) => candAt(i));
  huntWithCandidates(dir, many);
  const first = keel(['hunt', 'candidates', '--batch'], dir);
  if (first.code !== 0) return `candidates failed: ${first.out.trim()}`;
  const shown = (first.out.match(/^\s+F-\d+/gm) || []).length;
  if (shown !== 4) return `expected 4 ids (prove_concurrency), got ${shown}: ${first.out.trim()}`;
  if (!/6 candidate/.test(first.out)) return `it should say how many are waiting: ${first.out.trim()}`;
  if (!/again for the next 2/.test(first.out)) return `it should say what is left: ${first.out.trim()}`;
  // Verdicts recorded, next batch is the remainder.
  keel(['state', 'phase', 'hunt-prove'], dir);
  for (const id of ['F-001', 'F-002', 'F-003', 'F-004']) {
    keel(['hunt', 'prove', id, '--verdict', 'unproven', '--evidence', 'could not reproduce'], dir);
  }
  const second = keel(['hunt', 'candidates', '--batch'], dir);
  if ((second.out.match(/^\s+F-\d+/gm) || []).length !== 2) return `the second batch should hold 2: ${second.out.trim()}`;
  return /That is all of them/.test(second.out) ? null : `it should say the queue is empty: ${second.out.trim()}`;
});

scenario('hunt: a proven finding with no spec is flagged and asked about', (dir) => {
  huntProven(dir, 1);
  keel(['state', 'phase', 'hunt-report'], dir);
  const r = keel(['hunt', 'report'], dir);
  if (r.code !== 0) return `report failed: ${r.out.trim()}`;
  const run = JSON.parse(fs.readFileSync(path.join(dir, '.keel', 'hunt', runIdOf(dir), 'run.json'), 'utf8'));
  if (!run.findings[0].needs_e2e) return 'a finding no spec mentions was not flagged';
  // Blocking, because "we will write it later" is how a bug comes back unnoticed.
  const q = JSON.parse(fs.readFileSync(path.join(dir, '.keel', 'questions.json'), 'utf8')).questions['e2e-cover'];
  if (!q) return 'no e2e question was raised';
  if (!q.blocking) return 'the e2e question is not blocking';
  if (!/e2e-author/.test(q.because)) return 'the question does not say who would write it';
  // And `next` tells the fix flow it is not optional.
  sh('git add -A && git commit -q -m "hunt report"', dir);
  keel(['state', 'phase', 'hunt-triage'], dir);
  keel(['ask', 'e2e-cover', '--answer', 'yes', '--by', 'user'], dir);
  const n = keel(['hunt', 'next'], dir);
  return /NOT optional/.test(n.out) && /e2e-author/.test(n.out) ? null
    : `next does not make phase 4 mandatory: ${n.out.trim()}`;
});

scenario('hunt: a finding an existing spec references is not flagged', (dir) => {
  huntProven(dir, 1);
  // The fixture's e2e dir gets a spec naming the source file the finding cites.
  const run0 = JSON.parse(fs.readFileSync(path.join(dir, '.keel', 'hunt', runIdOf(dir), 'run.json'), 'utf8'));
  const base = path.basename(String(run0.findings[0].where[0]).split(':')[0]).replace(/\.[^.]+$/, '');
  const spec = path.join(dir, 'e2e', 'covered.spec.ts');
  fs.mkdirSync(path.dirname(spec), { recursive: true });
  fs.writeFileSync(spec, `test('covers ${base}', async () => {});\n`);
  keel(['state', 'phase', 'hunt-report'], dir);
  keel(['hunt', 'report'], dir);
  const run = JSON.parse(fs.readFileSync(path.join(dir, '.keel', 'hunt', runIdOf(dir), 'run.json'), 'utf8'));
  if (run.findings[0].needs_e2e) return 'a covered finding was flagged as uncovered';
  return fs.existsSync(path.join(dir, '.keel', 'questions.json'))
    && JSON.parse(fs.readFileSync(path.join(dir, '.keel', 'questions.json'), 'utf8')).questions['e2e-cover']
    ? 'the e2e question was raised with nothing uncovered' : null;
});

scenario('hunt: resume says where you were at every step', (dir) => {
  keel(['hunt', 'start'], dir);
  // Before the gate: resume points at the gate.
  let r = keel(['hunt', 'resume'], dir);
  if (!/lenses --confirm/.test(r.out)) return `resume should point at the lens gate: ${r.out.trim()}`;

  keel(['hunt', 'lenses', '--confirm', 'security,technical'], dir);
  r = keel(['hunt', 'resume'], dir);
  if (!/0\/4 lens/.test(r.out)) return `resume should count the pairs: ${r.out.trim()}`;
  if (!/keel:hunter security:api/.test(r.out)) return 'resume does not name the hunters still to send';

  // A partial sweep: three pairs left, and it says which.
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify([candAt(1)]));
  keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'c.json'], dir);
  r = keel(['hunt', 'resume'], dir);
  if (!/1\/4/.test(r.out)) return `resume lost the swept pair: ${r.out.trim()}`;
  if (/keel:hunter security:api/.test(r.out)) return 'resume still lists a pair that was already ingested';
  if (!/keel:hunter security:web/.test(r.out)) return 'resume dropped a pair that is still owed';

  // Everything swept: it moves on to proving.
  for (const pair of [['security', 'web'], ['technical', 'api'], ['technical', 'web']]) {
    fs.writeFileSync(path.join(dir, 'e.json'), JSON.stringify([]));
    keel(['hunt', 'add', '--lens', pair[0], '--lane', pair[1], '--json', 'e.json'], dir);
  }
  r = keel(['hunt', 'resume'], dir);
  return /candidates --batch/.test(r.out) ? null : `resume should move on to proving: ${r.out.trim()}`;
});

scenario('hunt: the candidate report renders unverified, while the real one still refuses', (dir) => {
  huntWithCandidates(dir, [candAt(1), candAt(2)]);
  keel(['state', 'phase', 'hunt-prove'], dir);
  keel(['state', 'phase', 'hunt-report'], dir);

  // The real report refuses while anything is unverified. The candidate page is the whole point:
  // it renders exactly then, and says on every screen that nothing has been measured.
  if (keel(['hunt', 'report'], dir).code === 0) return 'the real report rendered with candidates outstanding';
  const c = keel(['hunt', 'report', '--candidates'], dir);
  if (c.code !== 0) return `the candidate report should render: ${c.out.trim()}`;

  const md = fs.readFileSync(path.join(reportDirOf(dir), 'candidates.md'), 'utf8');
  if (!/UNVERIFIED/.test(md)) return 'the candidate page does not mark itself unverified';
  if (!/No severity here has been measured|no severity/i.test(md)) return 'it does not say severities are unmeasured';
  if (/^\| proven \|/m.test(md)) return 'it reports proven counts it cannot have';
  if (!/F-001/.test(md) || !/F-002/.test(md)) return 'it omits a candidate';
  if (!/security:api/.test(md)) return 'it does not group by lens and lane';
  // It is honest about its own completeness, since a sweep may be part-done.
  if (!/Swept \d+ of \d+/.test(md)) return 'it does not say how much of the sweep it covers';
  // And it never claims a proof it does not have.
  if (!/nobody has tried to reproduce this/.test(md)) return 'a candidate does not say it is unproven';
  return null;
});

scenario('hunt: a proven 500 cannot be filed as moderate', (dir) => {
  // A severity used to be whatever the prover felt. The rubric puts a 5xx on a documented path at
  // `high`, and that is the one clause a program can check against the evidence itself.
  huntWithCandidates(dir, [candAt(1)]);
  keel(['state', 'phase', 'hunt-prove'], dir);
  const rel = reproRel(dir, 'F-001');
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), 'curl -s -o /dev/null -w "%{http_code}" localhost:8080/x\n');

  const low = keel(['hunt', 'prove', 'F-001', '--verdict', 'proven', '--severity', 'moderate',
    '--evidence', 'the caller gets HTTP 500 where 409 is documented', '--repro', rel], dir);
  if (low.code === 0) return 'a proven 500 was filed as moderate';
  if (!/cannot be filed as moderate/.test(low.out)) return `the refusal does not name the problem: ${low.out.trim()}`;
  if (!/high/.test(low.out)) return 'the refusal does not quote the rubric row';

  const ok = keel(['hunt', 'prove', 'F-001', '--verdict', 'proven', '--severity', 'high',
    '--evidence', 'the caller gets HTTP 500 where 409 is documented', '--repro', rel], dir);
  if (ok.code !== 0) return `high should be accepted: ${ok.out.trim()}`;

  // A finding with no 5xx anywhere is still free to be low.
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify([candAt(5)]));
  keel(['state', 'phase', 'hunt-sweep'], dir);
  keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'c.json'], dir);
  keel(['state', 'phase', 'hunt-prove'], dir);
  const rel2 = reproRel(dir, 'F-002');
  fs.writeFileSync(path.join(dir, rel2), 'grep -n filterText apps/web/src/x.tsx\n');
  const cosmetic = keel(['hunt', 'prove', 'F-002', '--verdict', 'proven', '--severity', 'low',
    '--evidence', 'the sort arrow points the wrong way', '--repro', rel2], dir);
  return cosmetic.code === 0 ? null : `a finding with no 5xx should accept low: ${cosmetic.out.trim()}`;
});

scenario('hunt: an unusable severity names the whole rubric', (dir) => {
  huntWithCandidates(dir, [candAt(1)]);
  keel(['state', 'phase', 'hunt-prove'], dir);
  const rel = reproRel(dir, 'F-001');
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), 'echo probe\n');
  const r = keel(['hunt', 'prove', 'F-001', '--verdict', 'proven', '--severity', 'spicy',
    '--evidence', 'e', '--repro', rel], dir);
  if (r.code === 0) return 'an unknown severity was accepted';
  // The rubric is what makes the answer repeatable, so the refusal has to carry it.
  for (const word of ['critical', 'high', 'moderate', 'low', 'cross-tenant']) {
    if (!r.out.includes(word)) return `the refusal omits "${word}": ${r.out.trim()}`;
  }
  return null;
});

scenario('fast: the ladder checks the same things, it just stops repeating itself', (dir) => {
  const setup = require('./setup');
  const cfg = require('./config').load(dir);
  const disc = setup.discover(cfg);
  const normal = setup.rungs(cfg, disc, {}).map((r) => r.id);
  const fast = setup.rungs(cfg, disc, { fast: true }).map((r) => r.id);
  // "All the rungs, but fast" — nothing may disappear from the list.
  if (JSON.stringify(normal) !== JSON.stringify(fast)) {
    return `a fast run changed the rung list:\n  ${normal.join(' ')}\n  ${fast.join(' ')}`;
  }
  // Only the redundant probe loses its command, and it says why.
  const probe = setup.rungs(cfg, disc, { fast: true }).find((r) => r.id === 'dependencies');
  if (probe.cmd) return 'the redundant build-tool probe still runs under --fast';
  if (!/compile/.test(probe.why || '')) return `the skip does not explain itself: ${probe.why}`;
  return null;
});

scenario('fast: a real dependency task is kept, because compile does not prove it', (dir) => {
  const cfgFile = path.join(dir, '.keel', 'config.yml');
  // The fixture has no deps_api at all, so this has to be inserted under `commands:`, not replaced.
  fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, 'utf8')
    .replace(/^commands:$/m, 'commands:\n  deps_api: ./gradlew -q dependencies'));
  const setup = require('./setup');
  const cfg = require('./config').load(dir);
  const probe = setup.rungs(cfg, setup.discover(cfg), { fast: true }).find((r) => r.id === 'dependencies');
  // The default `-q help` probe is a subset of compile. A real resolution task is not.
  return probe.cmd && /dependencies/.test(probe.cmd) ? null
    : `a configured dependency task should survive --fast: ${JSON.stringify(probe.cmd)}`;
});

scenario('fast: a fast hunt narrows the lenses and never the proof bar', (dir) => {
  const started = keel(['hunt', 'start', '--fast'], dir);
  if (started.code !== 0) return `hunt start --fast failed: ${started.out.trim()}`;
  if (!/\(--fast\)/.test(started.out)) return 'the start banner does not say it was fast';
  if (!/not looked at/.test(started.out)) return 'it does not name the lenses it will skip';
  if (!/narrows what is looked at, not that/.test(started.out)) return 'it does not say the proof bar is untouched';

  const fastLenses = require('./config').DEFAULTS.hunt.fast_lenses;
  const all = require('./config').DEFAULTS.hunt.lenses;
  if (fastLenses.length >= all.length) return 'the fast lens set is not narrower';
  for (const l of fastLenses) if (!started.out.includes(l)) return `the fast set omits ${l} from the banner`;

  keel(['hunt', 'lenses', '--confirm', fastLenses.join(',')], dir);
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify([candAt(1)]));
  keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'c.json'], dir);
  keel(['state', 'phase', 'hunt-prove'], dir);
  keel(['state', 'phase', 'hunt-report'], dir);

  // The whole point: fast or not, an unverified finding still stops the report.
  const refused = keel(['hunt', 'report'], dir);
  if (refused.code === 0) return 'a fast hunt rendered its report with a candidate unverified';

  // And the candidate page carries the banner, so a short list is not mistaken for a clean one.
  keel(['hunt', 'report', '--candidates'], dir);
  const md = fs.readFileSync(path.join(reportDirOf(dir), 'candidates.md'), 'utf8');
  if (!/`--fast` hunt/.test(md)) return 'the candidate page does not say it was a fast run';
  return /not a clean bill of health/.test(md) ? null : 'the banner does not warn against reading it as clean';
});

scenario('hunt: a lens is swept per lane, and contract-drift never is', () => {
  const cfg = require('./config').DEFAULTS.hunt;
  const pairs = require('./hunt').sweepPairs({ hunt: cfg }, cfg.lenses);
  // Splitting contract-drift would give each half one side of a disagreement it exists to find.
  if (!pairs.includes('contract-drift:both')) return 'contract-drift is not swept as one agent';
  if (pairs.some((x) => /^contract-drift:(api|web)$/.test(x))) return 'contract-drift was split by lane';
  for (const want of ['security:api', 'security:web', 'concurrency:api', 'idempotency:web']) {
    if (!pairs.includes(want)) return `missing pair ${want}: ${pairs.join(', ')}`;
  }
  // Races and schema are backend-shaped; a web concurrency hunter would read the wrong half.
  if (pairs.includes('concurrency:web')) return 'concurrency was split onto the web lane';
  if (pairs.includes('data-migration:web')) return 'data-migration was split onto the web lane';
  return pairs.length > cfg.lenses.length ? null : 'the sweep did not widen at all';
});

scenario('hunt: a hunter that leaves its lane is refused at the ingest', (dir) => {
  // A hook cannot hold a subagent to a path subset — the payload carries no instance id — so the
  // write is the only place scope can actually be forced.
  keel(['hunt', 'start'], dir);
  keel(['hunt', 'lenses', '--confirm', 'security,behavioral'], dir);
  const strayed = [{ title: 'a web control does nothing', symptom: 'clicking it is inert',
    where: ['apps/web/src/pages/UsersPage.tsx:63'] }];
  fs.writeFileSync(path.join(dir, 'stray.json'), JSON.stringify(strayed));
  const out = keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'stray.json'], dir);
  if (out.code === 0) return 'an out-of-lane finding was ingested';
  if (!/outside the "api" lane/.test(out.out)) return `the refusal does not name the lane: ${out.out.trim()}`;
  if (!/apps\/web/.test(out.out)) return 'the refusal does not name the offending path';
  // The same finding under its own lane is fine.
  const ok = keel(['hunt', 'add', '--lens', 'security', '--lane', 'web', '--json', 'stray.json'], dir);
  if (ok.code !== 0) return `the web lane should accept it: ${ok.out.trim()}`;
  // And a lens with two lanes will not take an unlabelled batch.
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify([candAt(9)]));
  const bare = keel(['hunt', 'add', '--lens', 'security', '--json', 'c.json'], dir);
  return bare.code !== 0 && /--lane/.test(bare.out) ? null : 'a two-lane lens accepted no lane';
});

scenario('hunt: the same bug from two lenses is one finding with two witnesses', (dir) => {
  keel(['hunt', 'start'], dir);
  keel(['hunt', 'lenses', '--confirm', 'security,technical'], dir);
  const one = [{ title: 'the port catch never fires', symptom: 'a duplicate returns 500',
    where: ['apps/api/src/main/kotlin/app/BookmarkPort.kt:88'] }];
  // Same file, four lines apart: the same defect, described twice.
  const two = [{ title: 'constraint violation escapes the adapter', symptom: 'a raw 500 body reaches the caller',
    where: ['apps/api/src/main/kotlin/app/BookmarkPort.kt:92'] }];
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(one));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(two));
  keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'a.json'], dir);
  const second = keel(['hunt', 'add', '--lens', 'technical', '--lane', 'api', '--json', 'b.json'], dir);
  if (!/merged into existing/.test(second.out)) return `the duplicate was re-filed: ${second.out.trim()}`;
  if (!/corroboration/.test(second.out)) return 'the merge does not explain itself';
  const run = JSON.parse(fs.readFileSync(path.join(dir, '.keel', 'hunt', runIdOf(dir), 'run.json'), 'utf8'));
  if (run.findings.length !== 1) return `expected one finding, got ${run.findings.length}`;
  if (!(run.findings[0].also_found_by || []).includes('technical:api')) {
    return `the second witness was not recorded: ${JSON.stringify(run.findings[0].also_found_by)}`;
  }
  // A genuinely different place is still its own finding.
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify([candAt(7)]));
  keel(['hunt', 'add', '--lens', 'technical', '--lane', 'api', '--json', 'c.json'], dir);
  const after = JSON.parse(fs.readFileSync(path.join(dir, '.keel', 'hunt', runIdOf(dir), 'run.json'), 'utf8'));
  return after.findings.length === 2 ? null : `a distinct finding was wrongly merged: ${after.findings.length}`;
});

scenario('hunt: two hunts in one day do not overwrite each other, and the report stands alone', (dir) => {
  // The live defect: repro/ and incoming/ were shared across runs while finding ids restarted at
  // F-001 every run, so run 2's recipe landed exactly where run 1's proof had been.
  const proveOne = (text) => {
    const id = runIdOf(dir);
    keel(['state', 'phase', 'hunt-prove'], dir);
    const rel = reproRel(dir, 'F-001');
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
    keel(['hunt', 'prove', 'F-001', '--verdict', 'proven', '--severity', 'high',
      '--evidence', 'ran twice, failed twice', '--repro', rel], dir);
    keel(['state', 'phase', 'hunt-report'], dir);
    keel(['hunt', 'report'], dir);
    return id;
  };

  huntWithCandidates(dir, [CAND]);
  const first = proveOne('echo "run one proof"\n');
  keel(['hunt', 'close', 'F-001', '--as', 'accepted', '--note', 'done with run one'], dir);

  keel(['hunt', 'start', '--new', '--scope', 'all'], dir);
  keel(['hunt', 'lenses', '--confirm', 'security,behavioral'], dir);
  fs.writeFileSync(path.join(dir, 'cand.json'), JSON.stringify([CAND]));
  keel(['hunt', 'add', '--lens', 'security', '--lane', 'api', '--json', 'cand.json'], dir);
  const second = proveOne('echo "run two proof"\n');

  if (first === second) return `both hunts got the same id: ${first}`;
  if (!/-01$/.test(first) || !/-02$/.test(second)) return `ids should be numbered per day: ${first}, ${second}`;

  // Run one's recipe must still say what it always said.
  const one = fs.readFileSync(path.join(dir, '.keel', 'hunt', first, 'repro', 'F-001.sh'), 'utf8');
  if (!/run one/.test(one)) return `run 1's recipe was overwritten: ${one.trim()}`;

  // And each report carries its own copy, cited relative to itself, so it can be handed on.
  for (const [id, want] of [[first, 'run one'], [second, 'run two']]) {
    const md = fs.readFileSync(path.join(dir, 'docs', 'hunts', id, 'report.md'), 'utf8');
    if (!/`repro\/F-001\.sh`/.test(md)) return `${id}'s report does not cite its own copy: ${md.slice(0, 300)}`;
    // The footer names its own source file, which is fine; what must never point into the
    // gitignored backlog is a *proof citation*, because that is what a reader goes to run.
    const proofLines = md.split('\n').filter((l) => /Proved at|proved by/i.test(l));
    if (proofLines.some((l) => /\.keel\/hunt/.test(l))) return `${id}'s proof cites the gitignored backlog`;
    const beside = path.join(dir, 'docs', 'hunts', id, 'repro', 'F-001.sh');
    if (!fs.existsSync(beside)) return `${id}'s report has no recipe beside it`;
    if (!new RegExp(want).test(fs.readFileSync(beside, 'utf8'))) return `${id}'s copied recipe is the wrong one`;
  }
  return null;
});

scenario('hunt: a 0.9 run file without its own directory still opens', (dir) => {
  // A hunt open at the moment of upgrade must not become unreadable.
  huntWithCandidates(dir, [CAND]);
  const id = runIdOf(dir);
  const nested = path.join(dir, '.keel', 'hunt', id, 'run.json');
  const flat = path.join(dir, '.keel', 'hunt', `${id}.json`);
  fs.copyFileSync(nested, flat);
  fs.rmSync(path.join(dir, '.keel', 'hunt', id), { recursive: true, force: true });
  const r = keel(['hunt', 'list'], dir);
  return r.code === 0 && /F-001/.test(r.out) ? null
    : `a 0.9-era flat run file should still be readable: ${r.out.trim()}`;
});

scenario('hunt: the report refuses to render while a candidate has no verdict', (dir) => {
  huntWithCandidates(dir, [candAt(1), candAt(2)]);
  keel(['state', 'phase', 'hunt-prove'], dir);
  const rel = reproRel(dir, 'F-001');
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), 'curl -fsS localhost:8080/x\n');
  keel(['hunt', 'prove', 'F-001', '--verdict', 'proven', '--severity', 'high', '--evidence', 'e', '--repro', rel], dir);
  keel(['state', 'phase', 'hunt-report'], dir);
  const refused = keel(['hunt', 'report'], dir);
  if (refused.code === 0) return 'the report rendered with a finding nobody verified';
  if (!/F-002/.test(refused.out)) return `it must name the finding without a verdict: ${refused.out.trim()}`;
  // `unproven` is a verdict — a verifier looked and failed. That renders.
  keel(['state', 'phase', 'hunt-prove'], dir);
  keel(['hunt', 'prove', 'F-002', '--verdict', 'unproven', '--evidence', 'could not reproduce in 20 tries'], dir);
  keel(['state', 'phase', 'hunt-report'], dir);
  const ok = keel(['hunt', 'report'], dir);
  if (ok.code !== 0) return `it should render once every finding has a verdict: ${ok.out.trim()}`;
  const md = fs.readFileSync(path.join(reportDirOf(dir), 'report.md'), 'utf8');
  if (!/## Proven/.test(md) || !/## Suspected/.test(md)) return 'the report is missing a section';
  // The suspected section must not imply a measurement nobody took.
  const suspected = md.slice(md.indexOf('## Suspected'));
  return /carry no severity/.test(md) && !/high/.test(suspected) ? null
    : 'a suspected finding is being presented as measured';
});

scenario('hunt: the report is byte-identical on a second render', (dir) => {
  huntProven(dir, 2);
  keel(['state', 'phase', 'hunt-report'], dir);
  keel(['hunt', 'report'], dir);
  const f = path.join(reportDirOf(dir), 'report.md');
  const first = fs.readFileSync(f, 'utf8');
  keel(['hunt', 'report'], dir);
  const second = fs.readFileSync(f, 'utf8');
  // Without this, "deterministic" is a claim: a `Date.now()` in the header would pass every
  // other scenario in this file and produce a diff on every render.
  if (first !== second) return 'a second render differs — something in the report is not derived from the backlog';
  return /Generated by `keel hunt report`/.test(first) ? null : 'the report does not say what produced it';
});

scenario('hunt: next dispatches the group, not the symptom', (dir) => {
  const ids = huntProven(dir, 3);
  keel(['state', 'phase', 'hunt-report'], dir);
  const g = keel(['hunt', 'group', ...ids, '--cause', 'the port catch never fires', '--lead', ids[0]], dir);
  if (g.code !== 0) return `grouping failed: ${g.out.trim()}`;
  if (!/1 cause, 2 symptom/.test(g.out)) return `the group summary is wrong: ${g.out.trim()}`;
  // Regrouping a grouped finding is refused: a finding has one cause.
  if (keel(['hunt', 'group', ids[1], '--cause', 'something else'], dir).code === 0) return 'a grouped finding was regrouped';

  const r = keel(['hunt', 'report'], dir);
  if (r.code !== 0) return `report failed: ${r.out.trim()}`;
  sh('git add -A && git commit -q -m "hunt report"', dir);
  keel(['state', 'phase', 'hunt-triage'], dir);

  const n = keel(['hunt', 'next'], dir);
  if (n.code !== 0) return `next failed: ${n.out.trim()}`;
  for (const id of ids) if (!n.out.includes(id)) return `next omitted ${id}: it must hand over the whole group`;
  if (!/regression criteria/.test(n.out)) return 'next does not say the symptoms are regression criteria';
  if (!/repro/.test(n.out)) return 'next does not name the recipe to hand keel:reproducer';
  const took = keel(['hunt', 'next', '--take'], dir);
  if (took.code !== 0) return `--take failed: ${took.out.trim()}`;
  const after = keel(['hunt', 'next'], dir);
  return /nothing open/.test(after.out) ? null
    : `the dispatched group should not come back: ${after.out.trim()}`;
});

scenario('hunt: next refuses while the report is uncommitted', (dir) => {
  huntProven(dir, 1);
  keel(['state', 'phase', 'hunt-report'], dir);
  const early = keel(['hunt', 'next'], dir);
  if (early.code === 0) return 'next ran with no report rendered';
  if (!/keel hunt report/.test(early.out)) return `it should name the command: ${early.out.trim()}`;
  keel(['hunt', 'report'], dir);
  const uncommitted = keel(['hunt', 'next'], dir);
  if (uncommitted.code === 0) return 'next ran with the report uncommitted';
  if (!/keel commit docs/.test(uncommitted.out)) return `it should name the commit: ${uncommitted.out.trim()}`;
  sh('git add -A && git commit -q -m "hunt report"', dir);
  return keel(['hunt', 'next'], dir).code === 0 ? null : 'next still refuses after the report is committed';
});

scenario('hunt: closing a finding records how, and never deletes it', (dir) => {
  huntProven(dir, 1);
  if (keel(['hunt', 'close', 'F-001', '--as', 'accepted'], dir).code === 0) return 'closed with no note';
  if (keel(['hunt', 'close', 'F-001', '--as', 'shrug', '--note', 'n'], dir).code === 0) return 'an unknown disposition was accepted';
  const ok = keel(['hunt', 'close', 'F-001', '--as', 'accepted', '--note', 'documented behaviour, needs a spec change'], dir);
  if (ok.code !== 0) return `close failed: ${ok.out.trim()}`;
  const shown = keel(['hunt', 'list'], dir);
  if (!/F-001/.test(shown.out)) return 'the closed finding was deleted';
  if (!/accepted/.test(shown.out)) return 'the disposition is not shown';
  if (!/nothing open/.test(keel(['hunt', 'list', '--open'], dir).out)) return 'a closed finding is still open';
  return keel(['hunt', 'close', 'F-001', '--as', 'fixed', '--note', 'again'], dir).code !== 0 ? null
    : 'a closed finding was closed twice';
});

scenario('hunt: a verdict taken on an older commit is flagged, never silently trusted', (dir) => {
  huntProven(dir, 1);
  fs.writeFileSync(path.join(dir, 'README.md'), '# moved on\n');
  sh('git add -A && git commit -q -m "move on"', dir);
  const shown = keel(['hunt', 'list'], dir);
  return /reprove/.test(shown.out) ? null
    : `a stale verdict must say so: ${shown.out.trim()}`;
});

scenario('hunt: sweep and prove deny every source bucket', (dir) => {
  keel(['state', 'start', 'hunt'], dir);
  keel(['state', 'phase', 'hunt-sweep'], dir);
  const src = 'apps/api/src/main/kotlin/app/BookmarkController.kt';
  let blocked = expectBlocked(hook('pre-tool', edit(src), dir), 'hunt-sweep');
  if (blocked) return blocked;
  if (!/never fixes them/.test(hook('pre-tool', edit(src), dir).out)) return 'the refusal does not say where a finding goes instead';
  let allowed = expectAllowed(hook('pre-tool', edit('.keel/hunt/notes.md'), dir));
  if (allowed) return `the backlog must be writable in the sweep: ${allowed}`;

  keel(['state', 'phase', 'hunt-prove'], dir);
  blocked = expectBlocked(hook('pre-tool', edit(src), dir), 'hunt-prove');
  if (blocked) return blocked;
  allowed = expectAllowed(hook('pre-tool', edit('.keel/hunt/2026-01-01-01/repro/F-001.sh'), dir));
  if (allowed) return `a shell recipe must be writable: ${allowed}`;
  // A .spec.ts recipe is a regression test in disguise, and the classifier buckets it by
  // filename alone — so it lands in api-test and is refused. That is the right answer, and it
  // is pinned here because it would otherwise look arbitrary to whoever hit it.
  return expectBlocked(hook('pre-tool', edit('.keel/hunt/2026-01-01-01/repro/F-001.spec.ts'), dir), 'hunt-prove');
});

scenario('bug gates can be waived, and the waiver is recorded', (dir) => {
  // Waived: no decision is an automatic approval that advances the phase.
  keel(['state', 'start', 'fix', '--no-gates', '--phase', 'bug-repro'], dir);
  const auto = keel(['gate', 'R'], dir);
  if (auto.code !== 0) return `a waived Gate R should pass: ${auto.out.trim()}`;
  let s = JSON.parse(keel(['state', 'show'], dir).out);
  if (s.phase !== 'bug-investigate') return `Gate R did not advance: phase ${s.phase}`;
  if (!s.gates.log.some((l) => /automatically/.test(String(l)))) return `the waiver was not logged: ${JSON.stringify(s.gates.log)}`;
  if (!s.gates.skipped['bug-gates']) return 'the waiver is not in skipped, so the PR body cannot report it';
  const autoF = keel(['gate', 'F'], dir);
  if (autoF.code !== 0) return `a waived Gate F should pass: ${autoF.out.trim()}`;
  if (JSON.parse(keel(['state', 'show'], dir).out).phase !== 'bug-fix') return 'Gate F did not unlock the fix phase';

  // Not waived: no decision is a usage error, not a recorded empty decision.
  keel(['state', 'start', 'fix', '--phase', 'bug-repro'], dir);
  const bare = keel(['gate', 'R'], dir);
  if (bare.code === 0) return 'Gate R was accepted with no decision';
  if (!/needs a decision/.test(bare.out)) return `refused without saying why: ${bare.out.trim()}`;
  s = JSON.parse(keel(['state', 'show'], dir).out);
  if (s.gates.log.length) return `an empty decision was recorded anyway: ${JSON.stringify(s.gates.log)}`;
  return s.phase === 'bug-repro' ? null : `the phase moved on a refused gate: ${s.phase}`;
});

scenario('every flow starts in a phase that exists', () => {
  const { PHASES } = require('./state');
  const bad = Object.entries(require('./cli').FLOW_START).filter(([, p]) => !PHASES.includes(p));
  return bad.length ? `flows starting in an unknown phase: ${bad.map(([f, p]) => `${f} -> ${p}`).join(', ')}` : null;
});

scenario('flow names are validated, and each flow starts in its own phase', (dir) => {
  const { FLOW_START } = require('./cli');
  for (const [flow, phase] of Object.entries(FLOW_START)) {
    const r = keel(['state', 'start', flow], dir);
    if (r.code !== 0) return `state start ${flow} failed: ${r.out.trim()}`;
    const got = JSON.parse(keel(['state', 'show'], dir).out).phase;
    if (got !== phase) return `${flow} should start in ${phase}, started in ${got}`;
  }
  const bogus = keel(['state', 'start', 'bogus'], dir);
  if (bogus.code === 0) return 'an unknown flow was accepted';
  if (!/unknown flow/.test(bogus.out)) return `refused without naming the problem: ${bogus.out.trim()}`;
  const badPhase = keel(['state', 'start', 'fix', '--phase', 'nonsense'], dir);
  return badPhase.code !== 0 && /unknown phase/.test(badPhase.out) ? null
    : `--phase nonsense should be refused: ${badPhase.out.trim()}`;
});

scenario('a flow with no rail says so instead of showing the setup ladder', (dir) => {
  // Registered in PHASES but forgotten in RAILS is the mistake a new flow invites, and the
  // checklist used to answer it with the init ladder — confidently, about the wrong thing.
  keel(['state', 'start', 'feature', '--spec', 'specs/001-bookmarks.md'], dir);
  const f = path.join(dir, '.keel', 'state.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...s, flow: 'mystery', phase: 'spec' }));
  const r = keel(['todos'], dir);
  if (/toolchain|ladder/i.test(r.out)) return `showed the setup ladder for an unknown flow: ${r.out.trim()}`;
  return /unknown flow: mystery/.test(r.out) ? null : `expected an honest "unknown flow": ${r.out.trim()}`;
});

scenario("every agent's declared result line has a hook-table entry", () => {
  const { CONTRACTS } = require('./hooks');
  const src = path.join(__dirname, '..', 'agents');
  const problems = [];
  for (const file of fs.readdirSync(src).filter((f) => f.endsWith('.md'))) {
    const body = fs.readFileSync(path.join(src, file), 'utf8');
    const declared = body.match(/End with[^\n]*?`([^`]+)`/);
    if (!declared) continue;                      // bulk-reader has none, by design
    const key = 'keel:' + file.replace(/\.md$/, '');
    const contract = CONTRACTS[key];
    if (!contract) { problems.push(`${key} declares "${declared[1]}" but has no CONTRACTS entry`); continue; }
    // A label carrying a <placeholder> is not a literal instance, so it cannot be matched.
    if (!contract.label.includes('<') && !contract.re.test(contract.label)) {
      problems.push(`${key}: the regex does not match its own label "${contract.label}"`);
    }
  }
  return problems.length ? problems.join('; ') : null;
});

scenario('the gitignore block covers every per-machine file keel writes, and repeats cleanly', (dir) => {
  const { PER_MACHINE_IGNORES, ensureGitignore } = require('./util');
  const gi = path.join(dir, '.gitignore');
  fs.writeFileSync(gi, '.keel/state.json\nnode_modules/\n');
  const added = ensureGitignore(dir);
  if (added.includes('.keel/state.json')) return 'added a line that was already there';
  const text = fs.readFileSync(gi, 'utf8');
  const missing = PER_MACHINE_IGNORES.filter((l) => !text.split('\n').includes(l));
  if (missing.length) return `not ignored after the repair: ${missing.join(', ')}`;
  // Twice must be a no-op, because every hunt start calls it.
  if (ensureGitignore(dir).length) return 'a second call added lines again';
  if (fs.readFileSync(gi, 'utf8') !== text) return 'a second call rewrote the file';
  // The verdict files keel writes by itself must not sit in `git status`, because preflight
  // refuses a tree that is not clean and would then block the branch forever.
  for (const f of ['.keel/security.json', '.keel/architecture.json', '.keel/hunt/', '.keel/hunt.json',
    '.keel/setup.json', '.keel/questions.json']) {
    if (!PER_MACHINE_IGNORES.includes(f)) return `${f} is written but never ignored`;
  }
  return null;
});

scenario('illegal phase transitions are refused, --force records the override', (dir) => {
  keel(['state', 'start', 'feature', '--spec', 'specs/001-bookmarks.md'], dir);
  // spec -> green would skip RED entirely, which is the ordering the whole flow rests on.
  const blocked = keel(['state', 'phase', 'green'], dir);
  if (blocked.code === 0) return `expected spec -> green to be refused: ${blocked.out.trim()}`;
  if (!/cannot move to/.test(blocked.out)) return `refused, but without an explanation: ${blocked.out.trim()}`;
  const legal = keel(['state', 'phase', 'plan'], dir);
  if (legal.code !== 0) return `spec -> plan should be legal: ${legal.out.trim()}`;
  const forced = keel(['state', 'phase', 'green', '--force'], dir);
  if (forced.code !== 0) return `--force should be accepted: ${forced.out.trim()}`;
  const s = JSON.parse(keel(['state', 'show'], dir).out);
  return (s.gates.log || []).some((e) => e.forced === 'plan -> green')
    ? null : 'the forced transition was not recorded in the gate log';
});

scenario('per-lane ports resolve to distinct host ports', (dir) => {
  const ops = require('./ops');
  const cfg = { root: dir, stack: { per_lane_isolation: true } };
  const api = ops.portEnv(cfg, 'api').KEEL_DB_PORT;
  const web = ops.portEnv(cfg, 'web').KEEL_DB_PORT;
  if (api !== '5432') return `api lane should keep 5432, got ${api}`;
  if (web !== '5532') return `web lane should be 5432+100, got ${web}`;
  const off = ops.portEnv({ root: dir, stack: { per_lane_isolation: false } }, 'web').KEEL_DB_PORT;
  return off === '5432' ? null : `with isolation off the web lane should keep 5432, got ${off}`;
});

scenario('stack up uses a per-lane compose project', (dir) => {
  const a = keel(['stack', 'up'], dir);
  const b = keel(['stack', 'up', '--lane', 'web'], dir);
  return /port offset 0/.test(a.out) && /port offset 100/.test(b.out) ? null : `no isolation: ${a.out.trim()} | ${b.out.trim()}`;
});

scenario('migration drift is reported before e2e', (dir) => {
  fs.writeFileSync(path.join(dir, 'apps/api/src/main/resources/db/migration/V2__add_url.sql'), 'alter table bookmark add column url text;\n');
  const r = keel(['verify', 'e2e'], dir);
  return /migration\(s\) not applied/.test(r.out) ? null : `no drift warning: ${r.out.trim()}`;
});

scenario('Serena write_memory is blocked inside a flow', (dir) => {
  startRed(dir);
  return expectBlocked(hook('pre-tool', { tool_name: 'mcp__serena__write_memory', tool_input: { memory_name: 'x' } }, dir), 'memories');
});

scenario('large-file reads are redirected when the guard is on', (dir) => {
  fs.appendFileSync(path.join(dir, '.keel/config.yml'), '\nguards:\n  read_guard_max_lines: 10\n');
  fs.writeFileSync(path.join(dir, 'apps/api/src/main/kotlin/app/Big.kt'), 'x\n'.repeat(50));
  return expectBlocked(hook('pre-tool', read('apps/api/src/main/kotlin/app/Big.kt'), dir), 'bulk-reader');
});

scenario('a frozen test file changed on disk is reported at once', (dir) => {
  startRed(dir);
  keel(['state', 'phase', 'green'], dir);
  return expectBlocked(hook('file-changed', { files: ['apps/api/src/test/kotlin/app/BookmarkControllerTest.kt'] }, dir), 'frozen');
});

scenario('the stall ladder advances one step per stall', (dir) => {
  startRed(dir);
  keel(['state', 'phase', 'green'], dir);
  setSim(dir, 'gradle', 'assert');
  for (let i = 0; i < 3; i++) keel(['state', 'green-done'], dir);
  const r = keel(['stall'], dir);
  return /ladder step used: 1\/4/.test(r.out) ? null : `unexpected stall report: ${r.out.trim()}`;
});

scenario('keel models shows defaults and needs --yes to write', (dir) => {
  const show = keel(['models', 'show'], dir);
  if (!/reviewer\s+opus/.test(show.out)) return `unexpected: ${show.out.trim()}`;
  const dry = keel(['models', 'set-all', 'opus'], dir);
  return /Rerun with --yes/.test(dry.out) ? null : `should not write without --yes: ${dry.out.trim()}`;
});

scenario('init --new scaffolds a starter project', (dir) => {
  const fresh = fs.mkdtempSync(require('os').tmpdir() + '/keel-new-');
  sh('git init -q && git config user.email s@x && git config user.name s', fresh);
  fs.mkdirSync(path.join(fresh, '.keel'), { recursive: true });
  fs.writeFileSync(path.join(fresh, '.keel/config.yml'), 'version: 1\n');
  const r = keel(['init', '--new'], fresh);
  const ok = fs.existsSync(path.join(fresh, 'contracts/openapi.yaml')) && fs.existsSync(path.join(fresh, 'CLAUDE.md'));
  fs.rmSync(fresh, { recursive: true, force: true });
  return ok ? null : `starter incomplete: ${r.out.trim()}`;
});

/* ------------------------------------------------------------- runner */

function runAll(filter) {
  const chosen = scenarios.filter((s) => !filter || s.name.includes(filter));
  let pass = 0; const failures = [];
  const t0 = Date.now();
  for (const s of chosen) {
    const dir = fakeRepo();
    let err = null;
    try { err = s.fn(dir); } catch (e) { err = 'threw: ' + (e && e.message); }
    if (err) failures.push([s.name, err]); else pass++;
    process.stdout.write((err ? 'FAIL  ' : 'ok    ') + s.name + '\n');
    if (err) process.stdout.write('      ' + String(err).split('\n').join('\n      ') + '\n');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  const ms = Date.now() - t0;
  process.stdout.write(`\n${pass}/${chosen.length} scenarios passed in ${(ms / 1000).toFixed(1)}s\n`);
  if (failures.length) process.exit(1);
}

function keepRepo() {
  const dir = fakeRepo();
  process.stdout.write(`sandbox repo: ${dir}\nTry:\n  cd ${dir}\n  node ${KEEL} status\n  node ${KEEL} state start feature --spec specs/001-bookmarks.md\n`);
}

function selfTest() {
  // Used by the ladder's "hooks" rung: do the always-on guard rules still fire?
  const dir = fakeRepo();
  try {
    const cases = scenarios.filter((s) => s.name.startsWith('always:'));
    for (const c of cases) if (c.fn(dir)) return false;
    return true;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

module.exports = { runAll, keepRepo, fakeRepo, scenarios, selfTest };
