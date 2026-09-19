'use strict';
const fs = require('fs');
const path = require('path');
const { parseYaml, findRepoRoot } = require('./util');

const DEFAULTS = {
  version: 1,
  flow_default: 'full',
  runtime: { services: 'docker', app: 'host', agent: 'host' },
  backend: { dir: 'apps/api', build: './gradlew', migrations: 'src/main/resources/db/migration' },
  frontend: { dir: 'apps/web', package_manager: 'pnpm', generated: 'src/api/generated' },
  contract: { file: 'contracts/openapi.yaml' },
  e2e: { dir: 'e2e' },
  smoke: { dir: 'smoke' },
  specs: { dir: 'specs' },
  commands: {
    api_compile: './gradlew -q compileKotlin compileTestKotlin',
    api_test_ac: "./gradlew -q test --tests '*{AC}*'",
    api_test_module: './gradlew -q test',
    web_typecheck: 'npx tsc --noEmit',
    web_test_ac: 'npx vitest run -t {AC}',
    web_test_module: 'npx vitest run',
    api_test_pkg: "./gradlew -q test --tests '{PKG}.*'",
    web_test_paths: 'npx vitest run {PATHS}',
    contract_lint: '',
  },
  gates: { mode: 'every-ac', ai_review_on_skip: false, bug_gates: true },
  loops: {
    stall_repeats: 3,
    flaky_reruns: 1,
    green_author: 'main',
    red_accept: ['assertionfailederror', 'assertionerror', 'comparisonfailure', 'expected:', 'expected <',
      'expected but was', 'received:', 'tobe(', 'toequal(', 'status expected', 'but was:'],
    red_reject: ['compilation error', 'cannot find symbol', 'unresolved reference', 'applicationcontext',
      'no qualifying bean', 'could not connect to docker', 'docker environment', 'initializationerror',
      'no tests found', 'classnotfoundexception', 'noclassdeffounderror', 'syntax error'],
  },
  tests: { per_ac_scope: 'changed-packages', module_suite_at: 'gate' },
  coverage: { changed_lines: 95, changed_branches: 90, per_ac: 'warn' },
  guards: {
    protected: ['**/.env', '**/.env.*', '!**/.env.example'],
    generated: ['**/generated/**', '**/build/generated/**'],
    read_block: ['**/build/**', '**/node_modules/**', '**/playwright-report/**', '**/target/**'],
    bash_deny_always: ['git push --force', 'git push -f', '--no-verify', '-x test', '-x check'],
    bash_deny_in_flow: ['git commit', 'git reset --hard', 'git rebase -i'],
    read_guard_max_lines: 0,
  },
  stop_gate: { enabled: true, max_blocks_per_turn: 1 },
  caps: { red_turns: 8, green_turns: 15, e2e_turns: 40, ship_rounds: 2 },
  code_intel: 'lsp',
  notify: { enabled: false },
  change: { max_inline_acs: 3, must_escalate: ['contract', 'migration', 'auth'], size_limits_files: 10, size_limits_lines: 300, auth_paths: ['**/security/**', '**/auth/**'] },
};

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(extra || {})) {
    const v = extra[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined && v !== '' && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) {
      out[k] = v;
    }
  }
  return out;
}

function load(cwd) {
  const root = findRepoRoot(cwd);
  const file = path.join(root, '.keel', 'config.yml');
  let user = {};
  if (fs.existsSync(file)) {
    try { user = parseYaml(fs.readFileSync(file, 'utf8')); } catch (e) { user = {}; }
  }
  const cfg = deepMerge(DEFAULTS, user);
  cfg.root = root;
  cfg.configured = fs.existsSync(file);
  return cfg;
}

// Guess the layout of an unknown repo.
function detect(root) {
  const has = (p) => fs.existsSync(path.join(root, p));
  const firstDir = (candidates) => candidates.find((c) => has(c)) || null;
  const backendDir = firstDir(['apps/api', 'api', 'backend', 'engine', 'server', 'service']);
  const frontendDir = firstDir(['apps/web', 'web', 'frontend', 'editor', 'ui', 'client']);
  const build = has(path.join(backendDir || '', 'gradlew')) || has('gradlew')
    ? './gradlew' : (has('mvnw') ? './mvnw' : null);
  const compose = ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml',
    'deploy/docker-compose.yml'].find((c) => has(c)) || null;
  const contract = ['contracts/openapi.yaml', 'contracts/openapi.yml', 'docs/api/openapi.json',
    'openapi.yaml'].find((c) => has(c)) || null;
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') ? 'bun' : 'npm';
  const e2e = firstDir(['e2e', 'tests/e2e', 'playwright']);
  return { backendDir, frontendDir, build, compose, contract, pm, e2e };
}

module.exports = { DEFAULTS, load, detect, deepMerge };
