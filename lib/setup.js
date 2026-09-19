'use strict';
const fs = require('fs');
const path = require('path');
const { run, runAsync, readJson, writeJson, trim } = require('./util');
const config = require('./config');

function stateFile(cfg) { return path.join(cfg.root, '.keel', 'setup.json'); }

/* ------------------------------------------------------------- discovery */

function discover(cfg) {
  const d = config.detect(cfg.root);
  const read = (p) => { try { return fs.readFileSync(path.join(cfg.root, p), 'utf8'); } catch (e) { return ''; } };
  const exists = (p) => fs.existsSync(path.join(cfg.root, p));

  const ci = ['.github/workflows', '.gitlab-ci.yml', 'Jenkinsfile'].filter(exists);
  const ciCommands = [];
  if (exists('.github/workflows')) {
    for (const f of fs.readdirSync(path.join(cfg.root, '.github/workflows'))) {
      const text = read('.github/workflows/' + f);
      for (const m of text.matchAll(/run:\s*\|?\s*(.+)/g)) {
        const cmd = m[1].trim();
        if (/gradlew|mvnw|npm|pnpm|yarn|docker|playwright/.test(cmd)) ciCommands.push(cmd.split('\n')[0].slice(0, 120));
      }
    }
  }
  const services = [];
  if (d.compose) {
    const text = read(d.compose);
    for (const m of text.matchAll(/^\s{2}([a-z0-9_-]+):\s*$/gim)) services.push(m[1]);
    for (const m of text.matchAll(/image:\s*(\S+)/g)) services.push('image ' + m[1]);
  }
  const envNames = new Set();
  for (const f of ['.env.example', '.env.sample']) {
    for (const line of read(f).split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m) envNames.add(m[1]);
    }
  }
  const srcDirs = [d.backendDir, d.frontendDir].filter(Boolean);
  for (const dir of srcDirs) {
    for (const file of walk(cfg.root, dir, 400)) {
      if (!/\.(kt|java|ts|tsx|yml|yaml|properties)$/.test(file)) continue;
      const text = read(file);
      for (const m of text.matchAll(/\$\{([A-Z0-9_]+)(?::[^}]*)?\}/g)) envNames.add(m[1]);
      for (const m of text.matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)) envNames.add(m[1]);
    }
  }
  const tooling = {
    java: run('java -version').out.split('\n')[0] || null,
    node: run('node -v').out.trim() || null,
    docker: run('docker info', { timeout: 15000 }).code === 0,
    dockerCompose: run('docker compose version').code === 0 ? 'docker compose'
      : run('docker-compose version').code === 0 ? 'docker-compose' : null,
    gh: run('gh --version').code === 0,
  };
  return { detect: d, ci, ciCommands: ciCommands.slice(0, 15), services: Array.from(new Set(services)),
    envNames: Array.from(envNames).sort(), tooling };
}

function walk(root, dir, limit) {
  const out = [];
  const rec = (d) => {
    if (out.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, d), { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (['node_modules', 'build', 'target', '.git', 'dist', '.gradle'].includes(e.name)) continue;
      const rel = d + '/' + e.name;
      if (e.isDirectory()) rec(rel); else out.push(rel);
      if (out.length >= limit) return;
    }
  };
  rec(dir);
  return out;
}

/* ------------------------------------------------------------- run ladder */

function rungs(cfg, disc) {
  const c = cfg.commands || {};
  const b = cfg.backend.dir, w = cfg.frontend.dir;
  const compose = (cfg.stack && cfg.stack.compose) || disc.detect.compose;
  const composeCmd = disc.tooling.dockerCompose || 'docker compose';
  const reduced = cfg.runtime && cfg.runtime.services === 'none';
  const list = [
    { id: 'toolchain', label: 'Toolchain', cmd: null, check: () => {
      const miss = [];
      if (!disc.tooling.java) miss.push('java');
      if (!disc.tooling.node) miss.push('node');
      if (!reduced && !disc.tooling.docker) miss.push('docker');
      return miss.length ? { ok: false, out: 'missing: ' + miss.join(', ') } : { ok: true, out: `java ${disc.tooling.java}, node ${disc.tooling.node}, docker ${disc.tooling.docker ? 'ok' : 'n/a'}` };
    } },
    { id: 'dependencies', label: 'Dependencies resolve', cmd: c.deps_api || `${cfg.backend.build} -q help`, cwd: b },
    { id: 'dependencies-web', label: 'Frontend dependencies', cmd: c.deps_web || `${cfg.frontend.package_manager} install --frozen-lockfile || ${cfg.frontend.package_manager} install`, cwd: w },
    { id: 'compile', label: 'Both apps compile', cmd: c.api_compile, cwd: b },
    { id: 'compile-web', label: 'Frontend typecheck', cmd: c.web_typecheck, cwd: w },
    { id: 'unit-tests', label: 'Unit tests', cmd: c.unit_tests || c.api_test_module, cwd: b },
    { id: 'testcontainers', label: 'A container-backed test', cmd: c.testcontainers_test, cwd: b, optional: !c.testcontainers_test },
    { id: 'services', label: 'Services up and healthy', cmd: compose && !reduced ? `${composeCmd} -f ${compose} up -d --wait` : null, cwd: '.', optional: !compose || reduced },
    { id: 'api-boot', label: 'API boots and is healthy', cmd: c.api_health_check, cwd: '.', optional: !c.api_health_check },
    { id: 'web-boot', label: 'Frontend serves', cmd: c.web_health_check, cwd: '.', optional: !c.web_health_check },
    { id: 'smoke', label: 'Smoke check', cmd: c.smoke, cwd: '.', optional: !c.smoke },
    { id: 'hooks', label: 'Hook self-test', cmd: null, check: null, selfTest: true },
  ];
  return list.filter((r) => r.cmd || r.check || r.selfTest);
}

// Which rungs may run together. The ladder used to be strictly sequential, so a Docker pull
// queued behind Gradle resolving dependencies even though neither touches the other — and
// the pull is often the longest wait in a cold init.
const LEVEL = {
  toolchain: 0,
  hooks: 0,            // depends on nothing; free to run here
  dependencies: 1,
  'dependencies-web': 1,
  services: 1,         // needs Docker, not the build: the pull and health wait overlap Gradle
  compile: 2,
  'compile-web': 2,
  'unit-tests': 3,
  testcontainers: 3,
  'api-boot': 4,
  'web-boot': 4,
  smoke: 5,
};

// [[rung, …], …] in ascending level order, preserving each rung's declared order inside a
// level so output stays deterministic.
function levels(all) {
  const byLevel = new Map();
  all.forEach((r, i) => {
    const l = LEVEL[r.id] === undefined ? 90 + i : LEVEL[r.id];
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l).push(r);
  });
  return Array.from(byLevel.keys()).sort((a, b) => a - b).map((k) => byLevel.get(k));
}

// One rung. Async so a level can run its rungs together; the result shape is unchanged.
async function runRung(cfg, r) {
  if (r.selfTest) {
    let ok = true;
    try { ok = require('./sim').selfTest(); } catch (e) { ok = false; }
    return { id: r.id, label: r.label, status: ok ? 'pass' : 'fail', out: ok ? 'guard rules fire' : 'guard rules did not fire' };
  }
  if (r.check) {
    const res = r.check();
    return { id: r.id, label: r.label, status: res.ok ? 'pass' : 'fail', out: res.out };
  }
  if (!r.cmd || typeof r.cmd !== 'string') {
    return { id: r.id, label: r.label, status: 'skipped', out: 'no command configured' };
  }
  const cwd = path.join(cfg.root, r.cwd === '.' || !r.cwd ? '' : r.cwd);
  const res = await runAsync(r.cmd, { cwd: fs.existsSync(cwd) ? cwd : cfg.root, timeout: 900000 });
  const ok = res.code === 0;
  return { id: r.id, label: r.label, cmd: r.cmd, cwd: r.cwd || '.',
    status: ok ? 'pass' : (r.optional ? 'needs-you' : 'fail'), out: ok ? '' : trim(res.out, 15) };
}

// Levels run their rungs concurrently; the levels themselves run in order. On failure the
// level is allowed to finish and every failure in it is reported — a cold init used to
// surface the Gradle failure, you fixed it, and only then discovered npm was broken too.
async function ladder(cfg, opts = {}) {
  const disc = discover(cfg);
  const all = rungs(cfg, disc);
  const prev = readJson(stateFile(cfg), { rungs: {} });
  const order = all.map((r) => r.id);
  const fromIdx = opts.from ? order.indexOf(opts.from) : 0;
  const max = Math.max(1, Number((cfg.setup || {}).max_parallel || 4));
  const results = [];
  let stopped = null;

  for (const level of levels(all)) {
    const todo = [];
    for (const r of level) {
      if (fromIdx > 0 && order.indexOf(r.id) < fromIdx) { results.push({ id: r.id, label: r.label, status: 'skipped' }); continue; }
      if (opts.resume && prev.rungs[r.id] && prev.rungs[r.id].status === 'pass') {
        results.push(Object.assign({}, prev.rungs[r.id], { status: 'pass', cached: true }));
        continue;
      }
      if (opts.plan) { results.push({ id: r.id, label: r.label, cmd: r.cmd, status: 'planned' }); continue; }
      todo.push(r);
    }
    if (!todo.length) continue;

    // Collected in the level's declared order, never completion order: otherwise two rungs
    // racing would print differently run to run and the scenarios would go flaky.
    const settled = [];
    for (let i = 0; i < todo.length; i += max) {
      settled.push(...await Promise.all(todo.slice(i, i + max).map((r) => runRung(cfg, r))));
    }
    results.push(...settled);

    const failed = settled.filter((r) => r.status === 'fail');
    if (failed.length) { stopped = failed.map((r) => r.id).join(', '); break; }
  }

  const saved = { at: new Date().toISOString(), rungs: {} };
  for (const r of results) saved.rungs[r.id] = r;
  writeJson(stateFile(cfg), saved);
  persistProven(cfg, results);
  return { results, stopped, discovery: disc };
}

// Which command key each rung proves. Design §6 says every passing command is recorded
// and that config receives "the working commands" — the recording happened, the feeding
// back did not, which is why a verified project could still have unconfigured commands.
const RUNG_COMMAND = {
  dependencies: 'deps_api',
  'dependencies-web': 'deps_web',
  compile: 'api_compile',
  'compile-web': 'web_typecheck',
  'unit-tests': 'unit_tests',
  testcontainers: 'testcontainers_test',
  'api-boot': 'api_health_check',
  'web-boot': 'web_health_check',
  smoke: 'smoke',
};

// Written to .keel/proven.json and merged *beneath* .keel/config.yml, so the ladder can
// close the loop without ever rewriting a file the user hand-edits and comments.
function persistProven(cfg, results) {
  const file = path.join(cfg.root, '.keel', 'proven.json');
  const prev = readJson(file, { commands: {} });
  const commands = Object.assign({}, prev.commands);
  let changed = false;
  for (const r of results) {
    const key = RUNG_COMMAND[r.id];
    if (!key || r.status !== 'pass' || !r.cmd) continue;
    if (commands[key] !== r.cmd) { commands[key] = r.cmd; changed = true; }
  }
  if (changed) writeJson(file, { at: new Date().toISOString(), commands });
  return commands;
}

/* ----------------------------------------------------------------- runbook */

function runbook(cfg, ladderResult) {
  const disc = ladderResult.discovery || discover(cfg);
  const head = run('git rev-parse --short HEAD', { cwd: cfg.root }).out.trim();
  const rows = ladderResult.results.map((r) => `| ${r.label} | ${r.cmd ? '`' + r.cmd + '`' : '—'} | ${r.status} |`);
  const needsYou = ladderResult.results.filter((r) => r.status === 'needs-you' || r.status === 'fail');
  const text = [
    '# Running this project',
    '',
    `Verified by keel on ${new Date().toISOString().slice(0, 10)} at commit ${head}.`,
    '',
    '## Prerequisites',
    '',
    `- JDK: ${disc.tooling.java || 'not detected'}`,
    `- Node: ${disc.tooling.node || 'not detected'}`,
    `- Docker: ${disc.tooling.docker ? 'running' : 'not available'}${disc.detect.compose ? ` (services from \`${disc.detect.compose}\`)` : ''}`,
    disc.envNames.length ? `- Environment variables: ${disc.envNames.join(', ')} (values in \`.env.local\`)` : null,
    '',
    '## Verified steps',
    '',
    '| Step | Command | Result |',
    '|---|---|---|',
    ...rows,
    '',
    needsYou.length ? '## Needs you\n\n' + needsYou.map((r) => `- **${r.label}**: ${r.out || 'not verified'}`).join('\n') : null,
    '',
    '## Day to day',
    '',
    '```bash',
    'keel stack up          # services',
    'keel status            # where the current flow stands',
    'keel verify fast       # compile and typecheck what changed',
    '```',
    '',
    '_Regenerate with `keel ladder --write-runbook` after changing the build or Compose files._',
  ].filter((l) => l !== null).join('\n');
  const file = path.join(cfg.root, (cfg.setup && cfg.setup.runbook) || 'docs/RUNNING.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text + '\n');
  return path.relative(cfg.root, file);
}

/* ----------------------------------------------------------------- scaffold */

// Compose the dev container from whichever stack packs this repo matched, rather than from a
// hardcoded Java image. Returns the three files to write, or null when no pack has a
// devcontainer block to contribute.
function devContainerFiles(cfg) {
  const skills = require('./skills');
  const blocks = [];
  for (const name of skills.listPacks()) {
    const pack = skills.loadPack(name);
    if (!pack || !pack.devcontainer) continue;
    const dir = pack.lane === 'web' ? (cfg.frontend || {}).dir : (cfg.backend || {}).dir;
    if (!dir || !fs.existsSync(path.join(cfg.root, dir))) continue;
    blocks.push(Object.assign({ pack: name }, pack.devcontainer));
  }
  if (!blocks.length) return null;

  const primary = blocks.find((b) => b.primary) || blocks[0];
  const others = blocks.filter((b) => b !== primary);
  const indent = (lines, n) => lines.map((l) => ' '.repeat(n) + l).join('\n');
  const list = (b, key) => (Array.isArray(b[key]) ? b[key] : []);

  // A single stack uses its own image; two or more need one image carrying both toolchains,
  // which means a generated Dockerfile — features cannot help when compose defines the image.
  const multi = others.length > 0;
  const installs = others.flatMap((b) => list(b, 'toolchain_install').map((x) => (typeof x === 'string' ? x : x.run)))
    .filter(Boolean);
  const compose = (cfg.stack && cfg.stack.compose) || 'compose.yml';

  const volumes = blocks.flatMap((b) => list(b, 'volumes')
    .map((v) => (typeof v === 'string' ? v : `${v.name}:${v.at}`)));
  const named = Array.from(new Set(blocks.flatMap((b) => list(b, 'volumes')
    .map((v) => (typeof v === 'string' ? String(v).split(':')[0] : v.name))).filter(Boolean)));
  const ports = blocks.flatMap((b) => list(b, 'ports')
    .map((p) => (typeof p === 'string' ? p : `${p.host}:${p.container}`)));
  const env = Object.assign({}, ...blocks.map((b) => b.env || {}));

  // Only depend on a service the project's own compose actually defines.
  let dependsOn = '';
  try {
    const text = fs.readFileSync(path.join(cfg.root, compose), 'utf8');
    if (/^\s{2}db:/m.test(text)) dependsOn = '    depends_on:\n      db:\n        condition: service_healthy';
  } catch (e) { /* no compose file yet */ }

  const tpl = (name) => fs.readFileSync(path.join(__dirname, '..', 'templates', name), 'utf8');
  const files = {};
  files['compose.dev.yml'] = tpl('compose.dev.yml')
    .replaceAll('{{COMPOSE}}', compose)
    .replaceAll('{{DEV_IMAGE_OR_BUILD}}', multi
      ? 'build:\n      context: .\n      dockerfile: .devcontainer/Dockerfile'
      : `image: ${primary.image}`)
    .replaceAll('{{DEV_VOLUMES}}', volumes.length ? indent(volumes.map((v) => `- ${v}`), 6) : '')
    .replaceAll('{{DEV_ENV}}', Object.keys(env).length
      ? indent(Object.entries(env).map(([k, v]) => `${k}: ${v}`), 6) : '')
    .replaceAll('{{DEV_DEPENDS_ON}}', dependsOn)
    .replaceAll('{{DEV_PORTS}}', ports.length ? indent(ports.map((p) => `- "${p}"`), 6) : '      []')
    .replaceAll('{{DEV_NAMED_VOLUMES}}', named.length ? indent(named.map((n) => `${n}:`), 2) : '  {}');

  files['.devcontainer/devcontainer.json'] = tpl('devcontainer.json')
    .replaceAll('{{PROJECT}}', path.basename(cfg.root))
    .replaceAll('{{DEV_COMPOSE}}', 'compose.dev.yml');

  if (multi) {
    files['.devcontainer/Dockerfile'] = tpl('devcontainer.Dockerfile')
      .replaceAll('{{FROM}}', primary.image)
      .replaceAll('{{TOOLCHAIN_INSTALL}}', installs.join('\n'));
  }
  return { files, packs: blocks.map((b) => b.pack), multi };
}

function scaffold(cfg, what) {
  const tpl = (name) => fs.readFileSync(path.join(__dirname, '..', 'templates', name), 'utf8');
  const write = (rel, text) => {
    const p = path.join(cfg.root, rel);
    if (fs.existsSync(p)) return `skipped (exists): ${rel}`;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return `wrote ${rel}`;
  };
  const done = [];
  if (what === 'compose' || what === 'all') done.push(write('compose.yml', tpl('compose.yml')));
  if (what === 'dev-container' || what === 'all') {
    // Composed from the matched stack packs, not copied verbatim: the old template hardcoded
    // a Java image, a Gradle cache and Spring's datasource URL, so a Python repo got a JDK.
    const dc = devContainerFiles(cfg);
    if (!dc) done.push('skipped: no stack pack here declares a dev container');
    else {
      for (const [rel, text] of Object.entries(dc.files)) done.push(write(rel, text));
      done.push(`dev container from: ${dc.packs.join(', ')}${dc.multi ? ' (generated Dockerfile: more than one toolchain)' : ''}`);
    }
  }
  if (what === 'playwright' || what === 'all') done.push(write(path.join(cfg.e2e.dir, 'playwright.config.ts'), tpl('playwright.config.ts')));
  if (what === 'smoke' || what === 'all') done.push(write(path.join(cfg.smoke.dir, 'smoke.sh'), tpl('smoke.sh')));
  if (what === 'spec' || what === 'all') done.push(write(path.join(cfg.specs.dir, 'TEMPLATE.md'), tpl('spec.md')));
  if (what === 'starter') {
    const s = (name) => fs.readFileSync(path.join(__dirname, '..', 'templates', 'starter', name), 'utf8');
    done.push(write('README.md', s('README.md')));
    done.push(write('settings.gradle.kts', s('settings.gradle.kts')));
    done.push(write(path.join(cfg.backend.dir, 'build.gradle.kts'), s('api-build.gradle.kts')));
    done.push(write(path.join(cfg.backend.dir, 'src/test/kotlin/app/HealthTest.kt'), s('HealthTest.kt')));
    done.push(write(path.join(cfg.frontend.dir, 'vitest.config.ts'), s('vitest.config.ts')));
    done.push(write(cfg.contract.file, s('openapi.yaml')));
    done.push(...scaffold(cfg, 'compose'));
    done.push(...scaffold(cfg, 'playwright'));
    done.push(...scaffold(cfg, 'smoke'));
    done.push(...scaffold(cfg, 'spec'));
    done.push(...scaffold(cfg, 'claude-md'));
  }
  if (what === 'claude-md' || what === 'all') {
    const block = tpl('claude-block.md')
      .replace(/\{\{BACKEND\}\}/g, cfg.backend.dir).replace(/\{\{FRONTEND\}\}/g, cfg.frontend.dir)
      .replace(/\{\{CONTRACT\}\}/g, cfg.contract.file);
    const p = path.join(cfg.root, 'CLAUDE.md');
    let text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (text.includes('<!-- keel:start -->')) {
      text = text.replace(/<!-- keel:start -->[\s\S]*<!-- keel:end -->/, block.trim());
      done.push('updated the keel block in CLAUDE.md');
    } else {
      text = (text ? text.trimEnd() + '\n\n' : '') + block.trim() + '\n';
      done.push('added the keel block to CLAUDE.md');
    }
    fs.writeFileSync(p, text);
  }
  return done;
}

module.exports = { discover, ladder, runbook, scaffold, rungs, levels, devContainerFiles, persistProven, RUNG_COMMAND, LEVEL };
