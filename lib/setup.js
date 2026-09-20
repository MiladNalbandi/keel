'use strict';
const fs = require('fs');
const path = require('path');
const { run, runAsync, gitOut, readJson, writeJson, trim, moduleDir, modulePath } = require('./util');
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
  const depsCmd = c.deps_api || `${cfg.backend.build} -q help`;
  const list = [
    // First, because everything downstream assumes it: without a repository the runbook cannot be
    // pinned to a commit, `verify arch` cannot tell which files changed, changed-line coverage
    // cannot be measured and `base_branch` is fiction. keel used to record this as a footnote and
    // carry on; it raises a blocking question now.
    { id: 'git', label: 'Git repository', cmd: null, check: () => {
      const has = require('./verify').hasGit(cfg);
      if (has) return { ok: true, out: `on ${require('./util').gitOut('rev-parse --abbrev-ref HEAD', cfg.root, 'an unnamed branch')}` };
      try {
        require('./ask').raise(cfg, 'git-repo', {
          question: 'This directory is not a git repository. Initialise one before going further?',
          because: 'without git the runbook cannot be pinned to a commit, `keel verify arch` cannot tell '
            + 'which files changed, changed-line coverage cannot be measured, and base_branch is fiction',
          blocking: true, by: 'ladder:git',
        });
      } catch (e) { /* the verdict below still stands */ }
      return { ok: false, out: 'not a git repository — `keel ask git-repo` records what you decide' };
    } },
    { id: 'toolchain', label: 'Toolchain', cmd: null, check: () => {
      const miss = [];
      if (!disc.tooling.java) miss.push('java');
      if (!disc.tooling.node) miss.push('node');
      if (!reduced && !disc.tooling.docker) miss.push('docker');
      return miss.length ? { ok: false, out: 'missing: ' + miss.join(', ') } : { ok: true, out: `java ${disc.tooling.java}, node ${disc.tooling.node}, docker ${disc.tooling.docker ? 'ok' : 'n/a'}` };
    } },
    // The default proves the build tool starts, which is not the same as resolving the graph —
    // the label used to claim the latter. A project that wants the stronger check points
    // commands.deps_api at a real resolution task.
    // The label comes from the command, not from whether config happened to hold one: the ladder's
    // own persistProven() writes the resolved command into .keel/proven.json, which config.load()
    // merges back — so keying the label off `c.deps_api` made it change on the second run.
    { id: 'dependencies', label: /\s-q\s+help\b/.test(depsCmd) ? 'Build tool starts' : 'Backend dependencies',
      cmd: depsCmd, cwd: b },
    // Frozen first, loose only as a fallback, and the fallback is a finding rather than a pass:
    // `frozen || loose` in one shell line meant lockfile drift reported PASS.
    { id: 'dependencies-web', label: 'Frontend dependencies', cmd: c.deps_web
      || `${cfg.frontend.package_manager} install --frozen-lockfile`, cwd: w,
      fallback: c.deps_web ? null : `${cfg.frontend.package_manager} install`,
      fallbackNote: 'the lockfile is out of date — the frozen install failed and a loose one succeeded' },
    { id: 'compile', label: 'Both apps compile', cmd: c.api_compile, cwd: b },
    { id: 'compile-web', label: 'Frontend typecheck', cmd: c.web_typecheck, cwd: w },
    // A suite that ran nothing is not a passing suite. keel already knows the phrase: it is in
    // loops.red_reject, which the RED loop consults and the ladder never did.
    { id: 'unit-tests', label: 'Unit tests', cmd: c.unit_tests || c.api_test_module, cwd: b,
      rejectOutput: (cfg.loops || {}).red_reject || [] },
    { id: 'testcontainers', label: 'A container-backed test', cmd: c.testcontainers_test, cwd: b,
      why: 'no commands.testcontainers_test configured' },
    { id: 'services', label: 'Services up and healthy', cmd: compose && !reduced ? `${composeCmd} -f ${compose} up -d --wait` : null, cwd: '.',
      why: reduced ? 'runtime.services is "none"' : 'no compose file found' },
    { id: 'api-boot', label: 'API boots and is healthy', cmd: c.api_health_check, cwd: '.',
      why: 'no commands.api_health_check configured' },
    { id: 'web-boot', label: 'Frontend serves', cmd: c.web_health_check, cwd: '.',
      why: 'no commands.web_health_check configured' },
    { id: 'smoke', label: 'Smoke check', cmd: c.smoke, cwd: '.',
      why: 'no commands.smoke configured' },
    { id: 'hooks', label: 'Hook self-test', cmd: null, check: null, selfTest: true },
  ];
  // Every rung stays in the list. Dropping the ones with no command is how a seven-rung ladder
  // came to look exactly like a twelve-rung one: an unconfigured rung vanished from the run AND
  // from the runbook, so nothing said it had not been checked.
  const chosen = (cfg.setup || {}).ladder;
  return list.map((r) => {
    if (Array.isArray(chosen) && chosen.length && !chosen.includes(r.id) && r.id !== 'git') {
      return Object.assign({}, r, { cmd: null, check: null, selfTest: false, why: 'excluded in setup.ladder' });
    }
    return r;
  });
}

// Which rungs may run together. The ladder used to be strictly sequential, so a Docker pull
// queued behind Gradle resolving dependencies even though neither touches the other — and
// the pull is often the longest wait in a cold init.
const LEVEL = {
  git: 0,
  toolchain: 0,
  hooks: 0,            // depends on nothing; free to run here
  dependencies: 1,
  'dependencies-web': 1,
  services: 1,         // needs Docker, not the build: the pull and health wait overlap Gradle
  compile: 2,
  'compile-web': 2,
  'unit-tests': 3,
  // Not level 3 with unit-tests: both are the same build tool in the same project
  // directory, so they block on its project lock and serialize anyway — while the
  // container-backed test is usually a subset of the unit suite it queued behind.
  testcontainers: 4,
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
  // `not-checked`, not `skipped`. A rung nobody configured was previously deleted from the list
  // entirely, so the runbook simply had no row for it and a reader could not tell the difference
  // between "this passed" and "nobody looked".
  if (!r.cmd || typeof r.cmd !== 'string') {
    return { id: r.id, label: r.label, status: 'not-checked', out: r.why || 'no command configured' };
  }
  const cwd = modulePath(cfg.root, r.cwd);
  const dir = fs.existsSync(cwd) ? cwd : cfg.root;
  let res = await runAsync(r.cmd, { cwd: dir, timeout: 900000 });
  let ok = res.code === 0;
  let note = null;
  let cmd = r.cmd;

  // The fallback is a finding. `frozen-install || loose-install` as one shell line meant an
  // out-of-date lockfile exited 0 and was recorded as a pass.
  if (!ok && r.fallback) {
    const alt = await runAsync(r.fallback, { cwd: dir, timeout: 900000 });
    if (alt.code === 0) {
      return { id: r.id, label: r.label, cmd: `${r.cmd}  (then ${r.fallback})`, cwd: r.cwd || '.',
        status: 'needs-you', out: r.fallbackNote || 'the primary command failed and the fallback succeeded' };
    }
    res = alt; ok = false; cmd = `${r.cmd} / ${r.fallback}`;
  }

  // A suite that found no tests exits 0. That is not a passing suite, and keel already carries
  // the phrases that say so.
  if (ok && Array.isArray(r.rejectOutput) && r.rejectOutput.length) {
    const hay = String(res.out || '').toLowerCase();
    const hit = r.rejectOutput.find((p) => hay.includes(String(p).toLowerCase()));
    if (hit) {
      return { id: r.id, label: r.label, cmd, cwd: r.cwd || '.', status: 'not-checked',
        out: `the command succeeded but reported "${hit}" — nothing was actually exercised` };
    }
  }

  return { id: r.id, label: r.label, cmd, cwd: r.cwd || '.',
    status: ok ? 'pass' : (r.optional ? 'needs-you' : 'fail'),
    out: ok ? (note || '') : trim(res.out, 15) };
}

// Levels run their rungs concurrently; the levels themselves run in order. On failure the
// level is allowed to finish and every failure in it is reported — a cold init used to
// surface the Gradle failure, you fixed it, and only then discovered npm was broken too.
async function ladder(cfg, opts = {}) {
  // The ladder writes .keel/setup.json, and an unignored keel artifact leaves the tree dirty —
  // which `keel preflight` refuses. Repair the block here rather than relying on `init --write`,
  // which cannot be re-run because it overwrites a hand-edited config.
  try { require('./util').ensureGitignore(cfg.root); } catch (e) { /* not fatal to the run */ }
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
      // `not-checked` is cached as well as `pass`: re-running a rung that has no command cannot
      // produce a different answer, and a late failure used to force a full redo of everything
      // before it.
      const seen = opts.resume && prev.rungs[r.id];
      if (seen && (seen.status === 'pass' || seen.status === 'not-checked')) {
        results.push(Object.assign({}, prev.rungs[r.id], { cached: true }));
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

    // `setup.fix_attempts_per_rung` was declared in the defaults, cited in the ladder reference,
    // and read by nothing. A rung that has failed this many times in a row stops being a retry
    // and becomes a decision: fix it, exclude it in setup.ladder, or accept it as not-checked.
    const cap = Math.max(1, Number((cfg.setup || {}).fix_attempts_per_rung || 3));
    for (const r of settled) {
      const before = ((prev.rungs || {})[r.id] || {}).attempts || 0;
      r.attempts = r.status === 'fail' ? before + 1 : 0;
      if (r.status === 'fail' && r.attempts >= cap) {
        try {
          require('./ask').raise(cfg, `rung-${r.id}`, {
            question: `The "${r.label}" rung has failed ${r.attempts} times. Fix it, exclude it from setup.ladder, or accept it as not-checked?`,
            because: `setup.fix_attempts_per_rung is ${cap}, and a rung that keeps failing is a decision rather than a retry`,
            blocking: true, by: `ladder:${r.id}`,
          });
        } catch (e) { /* the verdict below still stands */ }
      }
    }

    const failed = settled.filter((r) => r.status === 'fail');
    if (failed.length) { stopped = failed.map((r) => r.id).join(', '); break; }
  }

  // A plan run proves nothing, so it must not persist. It marks every rung `planned`, and
  // writing that over the recorded verdicts destroyed the ladder's memory: `--resume` lost
  // its cache and re-ran everything, and the setup checklist dropped back to 0/n after a
  // dry run that changed nothing.
  if (!opts.plan) {
    const saved = { at: new Date().toISOString(), rungs: {} };
    for (const r of results) saved.rungs[r.id] = r;
    writeJson(stateFile(cfg), saved);
    persistProven(cfg, results);
  }
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

// The runbook used to open "Verified by keel on <date> at commit <sha>." under a heading that
// said "Verified steps" — over a ladder that only ever checked liveness, listing only the rungs
// that happened to be configured. A reader could not tell a seven-rung run from a twelve-rung one,
// and nothing anywhere said that no endpoint had been exercised. It says what it did now.
function runbook(cfg, ladderResult) {
  const disc = ladderResult.discovery || discover(cfg);
  const head = gitOut('rev-parse --short HEAD', cfg.root, null);
  const by = (st) => ladderResult.results.filter((r) => r.status === st);
  const checked = by('pass');
  const notChecked = by('not-checked');
  const needsYou = ladderResult.results.filter((r) => r.status === 'needs-you' || r.status === 'fail');
  const rows = ladderResult.results.map((r) => `| ${r.label} | ${r.cmd ? '`' + r.cmd + '`' : '—'} | ${r.status} | ${r.status === 'pass' ? '' : (r.out || '').split('\n')[0]} |`);

  const text = [
    '# Running this project',
    '',
    `Checked by keel on ${new Date().toISOString().slice(0, 10)}`
      + (head ? ` at commit ${head}.` : '. **This is not a git repository**, so nothing here is pinned to a commit.'),
    '',
    `${checked.length} of ${ladderResult.results.length} steps ran and passed; ${notChecked.length} were not checked.`,
    '',
    '## Prerequisites',
    '',
    `- JDK: ${disc.tooling.java || 'not detected'}`,
    `- Node: ${disc.tooling.node || 'not detected'}`,
    `- Docker: ${disc.tooling.docker ? 'running' : 'not available'}${disc.detect.compose ? ` (services from \`${disc.detect.compose}\`)` : ''}`,
    disc.envNames.length ? `- Environment variables: ${disc.envNames.join(', ')} (values in \`.env.local\`)` : null,
    '',
    '## What was checked',
    '',
    '| Step | Command | Result | Note |',
    '|---|---|---|---|',
    ...rows,
    '',
    notChecked.length
      ? '### Not checked\n\n' + notChecked.map((r) => `- **${r.label}**: ${r.out || 'no command configured'}`).join('\n') + '\n'
      : null,
    needsYou.length ? '## Needs you\n\n' + needsYou.map((r) => `- **${r.label}**: ${r.out || 'not verified'}`).join('\n') + '\n' : null,
    '## What this does not tell you',
    '',
    'Every step above is a liveness check: the project builds, boots, and its own test suite passes.',
    'None of them asks whether any endpoint *behaves correctly*. A repository can pass this ladder',
    'end to end and still return the wrong status code, leak another tenant\'s data, or ignore a',
    'validation annotation that was never wired up.',
    '',
    'To check behaviour, run `/keel:hunt` — it proves each finding against the running stack before',
    'reporting it.',
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
  // These two used to be copied raw, so every project inherited another one's shape: a pnpm
  // workspace, apps/api, port 5173 and a Spring actuator path. The substitution machinery is
  // already used three lines below for claude-block.md; these just had no placeholders.
  if (what === 'playwright' || what === 'all' || what === 'smoke') {
    const webUrl = (cfg.e2e && cfg.e2e.web_url) || 'http://localhost:5173';
    const apiUrl = (cfg.e2e && cfg.e2e.api_url) || 'http://localhost:8080';
    const healthCmd = (cfg.commands || {}).api_health_check || '';
    const healthUrl = (healthCmd.match(/https?:\/\/[^\s'"]+/) || [])[0] || apiUrl;
    const pm = (cfg.frontend && cfg.frontend.package_manager) || 'npm';
    const feDir = moduleDir(cfg.frontend && cfg.frontend.dir);
    const beDir = moduleDir(cfg.backend && cfg.backend.dir);
    const e2eDir = moduleDir(cfg.e2e && cfg.e2e.dir) || '.';
    const up = path.relative(path.join(cfg.root, e2eDir), cfg.root) || '.';
    const webCmd = pm === 'npm'
      ? `npm --prefix ${path.join(up, feDir) || up} run dev`
      : `${pm} --dir ${path.join(up, feDir) || up} run dev`;
    const build = (cfg.backend && cfg.backend.build) || './gradlew';
    const apiCmd = /mvnw|mvn/.test(build)
      ? `${path.join(up, beDir) || up}/mvnw -f ${path.join(up, beDir) || up} spring-boot:run`
      : `${path.join(up, beDir, 'gradlew')} -p ${path.join(up, beDir) || up} bootRun`;
    const fill = (text) => text
      .replaceAll('{{WEB_URL}}', webUrl)
      .replaceAll('{{API_URL}}', apiUrl)
      .replaceAll('{{API_HEALTH_URL}}', healthUrl)
      .replaceAll('{{API_HEALTH_PATH}}', healthCmd ? '$API' + (healthUrl.replace(apiUrl, '') || '') : '$API')
      .replaceAll('{{WEB_SERVER_CMD}}', webCmd)
      .replaceAll('{{API_SERVER_CMD}}', apiCmd)
      .replaceAll('{{API_SERVER_NOTE}}', 'Derived from backend.build and backend.dir. Change the task if this is not Spring Boot.');
    if (what === 'playwright' || what === 'all') done.push(write(path.join(e2eDir, 'playwright.config.ts'), fill(tpl('playwright.config.ts'))));
    if (what === 'smoke' || what === 'all') done.push(write(path.join(cfg.smoke.dir, 'smoke.sh'), fill(tpl('smoke.sh'))));
  }
  if (what === 'spec' || what === 'all') done.push(write(path.join(cfg.specs.dir, 'TEMPLATE.md'), tpl('spec.md')));
  // templates/knowledge/ shipped five good templates that nothing ever copied, so the
  // knowledge base could not be created: `memory show` sent you to `memory update`, which
  // sent you back to init. `write` skips files that already exist, so this is safe to rerun.
  if (what === 'knowledge' || what === 'all') {
    const kdir = path.join(__dirname, '..', 'templates', 'knowledge');
    let names = [];
    try { names = fs.readdirSync(kdir).filter((f) => f.endsWith('.md')); } catch (e) { names = []; }
    if (!names.length) done.push('skipped: no knowledge templates in this build');
    for (const n of names) {
      done.push(write(path.join('docs', 'knowledge', n), fs.readFileSync(path.join(kdir, n), 'utf8')));
    }
  }
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
