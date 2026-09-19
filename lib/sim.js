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
  const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'keel-home-'));
  const withHome = (args) => {
    const r = require('child_process').spawnSync('node', [KEEL].concat(args), {
      cwd: dir, encoding: 'utf8',
      env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: dir, CLAUDE_CONFIG_DIR: home }),
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  if (!/reviewer\s+opus \(default\)/.test(withHome(['models', 'show']).out)) return 'defaults not shown';
  const dry = withHome(['models', 'set-all', 'opus']);
  if (fs.existsSync(path.join(home, 'settings.json'))) return 'wrote settings without --yes';
  if (!/Rerun with --yes/.test(dry.out)) return `no confirmation prompt: ${dry.out.trim()}`;
  withHome(['models', 'set-all', 'opus', '--yes']);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
  const cfg = saved.pluginConfigs.keel;
  return cfg.model_reviewer === 'opus' && cfg.model_bulk_reader === 'opus' ? null : `unexpected settings: ${JSON.stringify(cfg)}`;
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

scenario('subagent without its result line is blocked', (dir) => {
  const r = hook('subagent-stop', { agent_type: 'keel:reviewer', last_message: 'Looks fine to me.' }, dir);
  return r.out.includes('"decision":"block"') ? null : `expected a block, got ${r.out.trim()}`;
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

scenario('ladder runs the rungs and writes a verified runbook', (dir) => {
  const r = keel(['ladder'], dir);
  const book = path.join(dir, 'docs/RUNNING.md');
  if (!fs.existsSync(book)) return `no runbook written: ${r.out.trim()}`;
  const text = fs.readFileSync(book, 'utf8');
  return /Verified by keel/.test(text) && /\| Toolchain \|/.test(text) ? null : 'runbook missing verified steps';
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
  if (!/Mirror this into your todo list/.test(moved.out)) return 'the checklist came without an instruction';
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

scenario('every known phase has a guard-matrix row', () => {
  const missing = require('./state').PHASES.filter((p) => !require('./guards').MATRIX[p]);
  return missing.length ? `phases with no matrix row (they would fall through): ${missing.join(', ')}` : null;
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
