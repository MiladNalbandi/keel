'use strict';
const fs = require('fs');
const path = require('path');
const { run, readJson, writeJson, trim } = require('./util');
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

function ladder(cfg, opts = {}) {
  const disc = discover(cfg);
  const all = rungs(cfg, disc);
  const prev = readJson(stateFile(cfg), { rungs: {} });
  const results = [];
  const from = opts.from ? all.findIndex((r) => r.id === opts.from) : 0;
  let stopped = null;

  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (i < from) { results.push({ id: r.id, label: r.label, status: 'skipped' }); continue; }
    if (opts.resume && prev.rungs[r.id] && prev.rungs[r.id].status === 'pass') {
      results.push(Object.assign({}, prev.rungs[r.id], { status: 'pass', cached: true }));
      continue;
    }
    if (opts.plan) { results.push({ id: r.id, label: r.label, cmd: r.cmd, status: 'planned' }); continue; }

    if (r.selfTest) {
      const sim = require('./sim');
      let ok = true;
      try { ok = sim.selfTest(); } catch (e) { ok = false; }
      results.push({ id: r.id, label: r.label, status: ok ? 'pass' : 'fail', out: ok ? 'guard rules fire' : 'guard rules did not fire' });
      if (!ok) { stopped = r.id; break; }
      continue;
    }
    if (r.check) {
      const res = r.check();
      results.push({ id: r.id, label: r.label, status: res.ok ? 'pass' : 'fail', out: res.out });
      if (!res.ok) { stopped = r.id; break; }
      continue;
    }
    if (!r.cmd || typeof r.cmd !== 'string') { results.push({ id: r.id, label: r.label, status: 'skipped', out: 'no command configured' }); continue; }
    const cwd = path.join(cfg.root, r.cwd === '.' || !r.cwd ? '' : r.cwd);
    const res = run(r.cmd, { cwd: fs.existsSync(cwd) ? cwd : cfg.root, timeout: 900000 });
    const ok = res.code === 0;
    results.push({ id: r.id, label: r.label, cmd: r.cmd, cwd: r.cwd || '.', status: ok ? 'pass' : (r.optional ? 'needs-you' : 'fail'), out: ok ? '' : trim(res.out, 15) });
    if (!ok && !r.optional) { stopped = r.id; break; }
  }

  const saved = { at: new Date().toISOString(), rungs: {} };
  for (const r of results) saved.rungs[r.id] = r;
  writeJson(stateFile(cfg), saved);
  return { results, stopped, discovery: disc };
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
  if (what === 'dev-container' || what === 'all') done.push(write('compose.dev.yml', tpl('compose.dev.yml')));
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

module.exports = { discover, ladder, runbook, scaffold, rungs };
