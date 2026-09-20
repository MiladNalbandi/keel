'use strict';
const fs = require('fs');
const path = require('path');
const { parseYaml, findRepoRoot, moduleDir } = require('./util');

const DEFAULTS = {
  version: 1,
  flow_default: 'full',
  base_branch: 'main',
  runtime: { services: 'docker', app: 'host', agent: 'host' },
  backend: { dir: 'apps/api', build: './gradlew', migrations: 'src/main/resources/db/migration' },
  frontend: { dir: 'apps/web', package_manager: 'pnpm', generated: 'src/api/generated' },
  contract: { file: 'contracts/openapi.yaml' },
  e2e: { dir: 'e2e', web_url: 'http://localhost:5173', api_url: 'http://localhost:8080' },
  smoke: { dir: 'smoke', max_seconds: 60 },
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
    codegen: '',
    static_checks: '',
    e2e: 'npx playwright test',
    smoke_e2e: 'npx playwright test --grep @smoke',
    migrate: '',
    coverage_api: './gradlew -q koverXmlReport',
    coverage_web: 'npx vitest run --coverage',
    deps_api: '',
    deps_web: '',
    unit_tests: '',
    testcontainers_test: '',
    api_health_check: '',
    web_health_check: '',
    smoke: '',
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
  coverage: {
    changed_lines: 95,
    changed_branches: 90,
    per_ac: 'warn',
    global: 'ratchet',
    // Left empty on purpose: deriveReports() fills these from backend.dir / frontend.dir,
    // so a standard layout needs no hand-editing and a custom one can still override.
    reports: {},
    exclude: {
      api: ['**/generated/**', '**/*ApplicationKt*'],
      web: ['src/api/generated/**', 'src/main.tsx'],
    },
    gate_commands: ['git push', 'gh pr create', 'keel pr'],
  },
  guards: {
    protected: ['**/.env', '**/.env.*', '!**/.env.example'],
    generated: ['**/generated/**', '**/build/generated/**'],
    read_block: ['**/build/**', '**/node_modules/**', '**/playwright-report/**', '**/target/**'],
    bash_deny_always: ['git push --force', 'git push -f', '--no-verify', '-x test', '-x check'],
    bash_deny_in_flow: ['git commit', 'git reset --hard', 'git rebase -i'],
    read_guard_max_lines: 0,
  },
  stop_gate: { enabled: true, max_blocks_per_turn: 1 },
  lanes: { web: 'interactive' },
  review: { lenses: ['correctness', 'security', 'performance'] },
  mcp: { context7: false, serena: false, database_readonly: false, chrome: false, allow: [] },
  stack: {
    per_lane_isolation: true,
    compose: 'compose.yml',
    dev_compose: 'compose.dev.yml',
    override: 'compose.keel.override.yml',
    image_smoke_at_ship: false,
  },
  architecture: { style: 'unknown', confidence: 'low', source: 'detected', modules: {}, evidence: [] },
  boundaries: { enforce: 'off', rules: [] },
  security: {
    enabled: true,
    pipelines: ['code', 'deps'],
    gate: 'on-finding',
    deps: { fail_on: 'high', allowlist: [] },
    // Paths where a 100% changed-line bar applies instead of the global one: an
    // authorization branch should not count the same as a getter.
    coverage_paths: ['**/security/**', '**/auth/**'],
  },
  memory: {
    // Rules whose correctness cannot be read off the page. A conventions.md line mentioning one of
    // these needs a citation into a test or a hunt recipe, or the literal `unverified:` marker —
    // a repo was onboarded whose pagination "pattern" was an annotation Spring silently ignores,
    // because nothing on the class enabled it.
    proof_required_terms: ['@Valid', '@Validated', '@Transactional', '@PreAuthorize', '@Secured',
      'ExceptionHandler', 'ControllerAdvice', 'catch (', 'rollbackFor', 'Isolation.'],
  },
  hunt: {
    // The menu a hunt proposes. It is shown to the user and confirmed before anything fans
    // out, so this is a default rather than a decision — a project adds a seventh lens here
    // and a brief in the hunt skill's references/lenses.md, with no code change.
    lenses: ['security', 'behavioral', 'technical', 'concurrency', 'idempotency',
      'contract-drift', 'test-integrity', 'data-migration'],
    // Which side of the codebase each lens reads. A lens with two lanes is swept by two agents,
    // each given half the tree — which is most of what makes a wide sweep affordable.
    // `both` means one agent that must see both sides: contract-drift's whole subject is the
    // disagreement *between* client and server, so splitting it blinds each half to the thing it
    // exists to find.
    lens_lanes: {
      security: ['api', 'web'],
      behavioral: ['web', 'api'],
      technical: ['api', 'web'],
      concurrency: ['api'],
      idempotency: ['api', 'web'],
      'contract-drift': ['both'],
      'test-integrity': ['api', 'web'],
      'data-migration': ['api'],
    },
    // A finding that lands on the same file within this many lines of an existing one is the same
    // finding seen twice, not two findings. A wide sweep makes that common.
    dedup_line_window: 10,
    // What each severity means, so the answer does not depend on which prover looked. keel cannot
    // judge impact, but it can refuse the one clause that is mechanically checkable — see
    // severity_floor_5xx below.
    severity_rubric: {
      critical: 'data loss or corruption; cross-tenant exposure; authentication or authorization bypass; a silent wrong write',
      high: 'a 5xx on a documented path; a lost update under ordinary concurrency; a retry that creates duplicates',
      moderate: 'a wrong status code with otherwise correct behaviour; missing validation with no exploit path',
      low: 'cosmetic; unreachable in the current code',
    },
    // A proven finding whose own evidence shows a 5xx cannot be filed below this. The rubric puts a
    // 5xx on a documented path at `high`, and a severity that contradicts the rubric it was judged
    // against is the one mistake here that a program can catch.
    severity_floor_5xx: 'high',
    // `keel hunt start --fast`: the lenses that carry the most per token, plus contract-drift, which
    // is nearly mechanical — it walks the contract, the routes and the client and diffs them.
    // concurrency and idempotency are left out because they are the most expensive to *prove*, and a
    // fast hunt narrows what is looked at, never whether a finding is verified.
    fast_lenses: ['security', 'technical', 'contract-drift'],
    // There is no default autonomy on purpose: `keel hunt start` refuses without --auto or --semi,
    // because how closely you want to supervise a hunt is not a choice the model should inherit.
    // --semi gates the sweep, the provers and the report; --auto pre-approves all three as the model.
    gates: ['sweep', 'prove', 'report'],
    default_scope: 'diff',
    // A lens that returns forty items has stopped judging and started listing.
    max_candidates_per_lens: 12,
    prove_concurrency: 4,
    report_dir: 'docs/hunts',
  },
  setup: {
    // Which rungs to run. Empty means all of them; listing a subset marks the rest `not-checked
    // (excluded in setup.ladder)` rather than hiding them. The `git` rung always runs.
    ladder: [],
    // Read by setup.js since 0.6 and declared nowhere until now, so it was effectively hardcoded.
    max_parallel: 4,
    fix_attempts_per_rung: 3,
    runbook: 'docs/RUNNING.md',
    env_file: '.env.local',
    compose_override: 'compose.keel.override.yml',
    install_toolchains: 'suggest',
  },
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
    } else if (v !== undefined && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) {
      // An explicit empty string overrides a default on purpose: it is how a project
      // turns a command off. Empty objects still fall through to the default.
      out[k] = v;
    }
  }
  return out;
}

// Coverage report paths follow from the app directories, so derive them rather than
// making every project restate them. An explicit coverage.reports entry always wins.
function deriveReports(cfg) {
  const reports = (cfg.coverage && cfg.coverage.reports) || {};
  const api = cfg.backend && cfg.backend.dir;
  const web = cfg.frontend && cfg.frontend.dir;
  // `=== undefined`, not falsy: deepMerge deliberately preserves an explicit '' as the way a
  // project says "there is no coverage here", and testing truthiness clobbered it right back.
  const join = (d, rest) => (moduleDir(d) ? `${moduleDir(d)}/${rest}` : rest);
  if (reports.api === undefined && api) reports.api = join(api, 'build/reports/kover/report.xml');
  if (reports.web === undefined && web) reports.web = join(web, 'coverage/lcov.info');
  cfg.coverage.reports = reports;
  return cfg;
}

function load(cwd) {
  const root = findRepoRoot(cwd);
  const file = path.join(root, '.keel', 'config.yml');
  let user = {};
  if (fs.existsSync(file)) {
    try { user = parseYaml(fs.readFileSync(file, 'utf8')); } catch (e) { user = {}; }
  }
  // Three layers: defaults, then the commands the run ladder actually proved on this
  // machine, then the project's own config. The ladder can therefore close the loop
  // without rewriting a file the user hand-edits and comments.
  let proven = {};
  try {
    const p = JSON.parse(fs.readFileSync(path.join(root, '.keel', 'proven.json'), 'utf8'));
    if (p && p.commands) proven = { commands: p.commands };
  } catch (e) { /* no ladder run yet */ }

  // Detected architecture and its boundary rules live in their own file, written by
  // `keel arch set`, so a machine-written block never has to be merged into hand-edited
  // YAML. The project config still overrides it.
  let arch = {};
  try {
    const a = JSON.parse(fs.readFileSync(path.join(root, '.keel', 'architecture.json'), 'utf8'));
    if (a && a.architecture) arch = { architecture: a.architecture, boundaries: a.boundaries || {} };
  } catch (e) { /* not detected yet */ }

  // Keys the project names explicitly, including ones it blanks. An explicit '' means
  // "off", so a stack pack must not treat it as "unset" and fill it back in.
  const userCommands = Object.keys((user && user.commands) || {});
  let cfg = deepMerge(deepMerge(deepMerge(DEFAULTS, proven), arch), user);
  cfg.root = root;
  cfg.configured = fs.existsSync(file);
  cfg.proven = proven.commands || {};

  // Stack packs fill in command defaults the bare DEFAULTS cannot know — they depend on
  // which stacks this repo has. Applied beneath proven and user config: a command the
  // ladder verified, or one the project set, always wins over a pack's suggestion.
  try {
    const packs = require('./skills').packCommands(cfg);
    const filled = {};
    for (const [k, v] of Object.entries(packs)) {
      if (userCommands.includes(k)) continue; // the project has an opinion, including ''
      if (!String((cfg.commands || {})[k] || '').trim()) filled[k] = v;
    }
    if (Object.keys(filled).length) {
      cfg = deepMerge(cfg, { commands: filled });
      cfg.from_packs = Object.keys(filled);
    }
  } catch (e) { /* packs are optional */ }

  return deriveReports(cfg);
}

// Every commands.* key the code reads, and whether a tier fails without it.
// `keel doctor` prints this, so an unconfigured check is visible instead of silent.
const COMMAND_KEYS = {
  api_compile: { required: true, tiers: ['fast', 'contract'] },
  api_test_ac: { required: true, tiers: ['ac'] },
  api_test_module: { required: true, tiers: ['module', 'full'] },
  api_test_pkg: { required: false, tiers: ['ac'] },
  web_typecheck: { required: true, tiers: ['fast'] },
  web_test_ac: { required: true, tiers: ['ac'] },
  web_test_module: { required: true, tiers: ['module', 'full'] },
  web_test_paths: { required: false, tiers: ['ac'] },
  contract_lint: { required: false, tiers: ['fast', 'contract'] },
  codegen: { required: true, tiers: ['contract'] },
  static_checks: { required: true, tiers: ['full'] },
  e2e: { required: true, tiers: ['e2e', 'release'] },
  smoke_e2e: { required: false, tiers: ['smoke', 'release'] },
  migrate: { required: false, tiers: ['stack migrate'] },
  coverage_api: { required: true, tiers: ['coverage'] },
  coverage_web: { required: true, tiers: ['coverage'] },
  deps_api: { required: false, tiers: ['ladder'] },
  deps_web: { required: false, tiers: ['ladder'] },
  unit_tests: { required: false, tiers: ['ladder'] },
  testcontainers_test: { required: false, tiers: ['ladder'] },
  // A hunt reports the stack it proved against, so these are what `keel doctor` should name
  // when a hunt cannot say whether the app was up.
  api_health_check: { required: false, tiers: ['ladder', 'hunt'] },
  web_health_check: { required: false, tiers: ['ladder', 'hunt'] },
  smoke: { required: false, tiers: ['ladder'] },
};

// Which configured commands are missing, split by whether anything depends on them.
function commandGaps(cfg) {
  const set = cfg.commands || {};
  const missing = { required: [], optional: [] };
  for (const [key, meta] of Object.entries(COMMAND_KEYS)) {
    if (String(set[key] || '').trim()) continue;
    missing[meta.required ? 'required' : 'optional'].push({ key, tiers: meta.tiers });
  }
  return missing;
}

// Guess the layout of an unknown repo.
function detect(root) {
  const has = (p) => fs.existsSync(path.join(root, p));
  const isDir = (p) => { try { return fs.statSync(path.join(root, p)).isDirectory(); } catch (e) { return false; } };
  const firstDir = (candidates) => candidates.find((c) => isDir(c)) || null;
  // A single-module project keeps its build file and sources at the repository root. Without
  // this, init reported "backend: not found   build: ./gradlew" — which cannot both be true —
  // and then wrote apps/api into the config, pointing every command at a directory that does
  // not exist.
  const rootBackend = ['build.gradle.kts', 'build.gradle', 'pom.xml'].some(has)
    && ['src/main/kotlin', 'src/main/java'].some(isDir) ? '.' : null;
  const rootFrontend = has('package.json')
    && ['src', 'app', 'pages'].some(isDir)
    && ['vite.config.ts', 'vite.config.js', 'next.config.ts', 'next.config.js', 'next.config.mjs',
        'index.html', 'angular.json', 'svelte.config.js'].some(has) ? '.' : null;
  const backendDir = firstDir(['apps/api', 'api', 'backend', 'engine', 'server', 'service']) || rootBackend;
  const frontendDir = firstDir(['apps/web', 'web', 'frontend', 'editor', 'ui', 'client']) || rootFrontend;
  const build = has(path.join(backendDir || '', 'gradlew')) || has('gradlew')
    ? './gradlew' : (has('mvnw') ? './mvnw' : null);
  const compose = ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml',
    'deploy/docker-compose.yml'].find((c) => has(c)) || null;
  const contract = ['contracts/openapi.yaml', 'contracts/openapi.yml', 'docs/api/openapi.json',
    'openapi.yaml'].find((c) => has(c)) || null;
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') ? 'bun' : 'npm';
  const e2e = firstDir(['e2e', 'tests/e2e', 'playwright']);
  // Read, do not assume. Writing `koverXmlReport` into a JaCoCo project, or vitest commands
  // into a repo with no vitest, produced a config that `keel doctor` counted as "set" and
  // every tier then failed on at run time rather than at init, when it could have been said.
  const readIf = (p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch (e) { return ''; } };
  const buildText = ['build.gradle.kts', 'build.gradle', 'pom.xml']
    .map((f) => readIf(backendDir && backendDir !== '.' ? path.join(backendDir, f) : f)).join('\n');
  const coverageTool = /kover/i.test(buildText) ? 'kover'
    : /jacoco/i.test(buildText) ? 'jacoco' : null;
  const pkgText = readIf(frontendDir && frontendDir !== '.' ? path.join(frontendDir, 'package.json') : 'package.json');
  let pkg = {};
  try { pkg = JSON.parse(pkgText || '{}'); } catch (e) { pkg = {}; }
  const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  const hasVitest = !!deps.vitest;
  const hasPlaywright = !!deps['@playwright/test'];
  const hasJest = !!deps.jest;
  // The dev-server port differs by framework and guessing 5173 everywhere sent Playwright
  // and the smoke check at a port nothing was listening on.
  const webPort = deps.next ? 3000 : (deps['react-scripts'] ? 3000 : 5173);
  return { backendDir, frontendDir, build, compose, contract, pm, e2e,
    coverageTool, hasVitest, hasPlaywright, hasJest, webPort };
}

module.exports = { DEFAULTS, load, detect, deepMerge, COMMAND_KEYS, commandGaps, deriveReports };
