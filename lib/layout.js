'use strict';
// Where keel keeps the files it writes into a project — and whether git sees them.
//
//   repo      specs/, docs/knowledge/, docs/RUNNING.md, docs/adr/, docs/hunts/, the compose override
//             and a CLAUDE.md block, committed like code. The layout keel always had.
//   keel      all of it under .keel/, and .keel/ hidden from git — through .git/info/exclude, git's
//             own per-clone ignore file, so not even .gitignore changes. The team's diff is code only.
//   external  the same, but .keel is a link to ~/.keel/projects/<id>/: the clone holds nothing of keel.
//
// Tests are product code and stay where they are (e2e/, smoke/), in every layout. So does
// .devcontainer/, which editors only look for at the root.
//
// The layout is one line in .keel/config.yml (`layout: keel`). `keel upgrade --layout <name>` moves
// the existing files and writes that line; everything else reads the paths from here.
const fs = require('fs');
const path = require('path');
const { git, gitOut } = require('./util');

const LAYOUTS = ['repo', 'keel', 'external'];

const REPO = { specs: 'specs', knowledge: 'docs/knowledge', runbook: 'docs/RUNNING.md', adr: 'docs/adr',
  hunts: 'docs/hunts', override: 'compose.keel.override.yml', claude: 'CLAUDE.md' };
const HIDDEN = { specs: '.keel/specs', knowledge: '.keel/knowledge', runbook: '.keel/RUNNING.md', adr: '.keel/adr',
  hunts: '.keel/hunts', override: '.keel/compose.override.yml', claude: '.keel/CLAUDE.md' };

function nameOf(cfg) { const l = String((cfg && cfg.layout) || 'repo'); return LAYOUTS.includes(l) ? l : 'repo'; }
function hidden(cfg) { return nameOf(cfg) !== 'repo'; }

// The layout read straight from the config file — for util.ensureGitignore, which runs where a
// loaded config is not at hand.
function hiddenAt(root) {
  try { return /^layout:\s*(keel|external)\s*$/m.test(fs.readFileSync(path.join(root, '.keel', 'config.yml'), 'utf8')); } catch (e) { return false; }
}

// Called at the end of config.load. In a hidden layout the paths are keel's, whatever the keys say:
// a spec written to specs/ in a layout that hides specs would quietly land in the team's diff.
function resolve(cfg) {
  const l = nameOf(cfg);
  const repoSpecs = (cfg.specs && cfg.specs.dir) || REPO.specs;
  const p = l === 'repo' ? Object.assign({}, REPO, { specs: repoSpecs,
    runbook: (cfg.setup && cfg.setup.runbook) || REPO.runbook, hunts: (cfg.hunt && cfg.hunt.report_dir) || REPO.hunts,
    override: (cfg.stack && cfg.stack.override) || REPO.override, knowledge: (cfg.memory && cfg.memory.dir) || REPO.knowledge }) : HIDDEN;
  cfg.layout = l;
  cfg.paths = p;
  cfg.specs = Object.assign({}, cfg.specs, { dir: p.specs });
  cfg.memory = Object.assign({}, cfg.memory, { dir: p.knowledge });
  if (cfg.setup) { cfg.setup.runbook = p.runbook; cfg.setup.compose_override = p.override; }
  if (cfg.hunt) cfg.hunt.report_dir = p.hunts;
  if (cfg.stack) cfg.stack.override = p.override;
  return cfg;
}

/* ---------------------------------------------------------------- git hiding */

function excludeFile(root) {
  const common = gitOut('rev-parse --git-common-dir', root, null);
  if (!common) return null;
  return path.join(path.isAbsolute(common) ? common : path.join(root, common), 'info', 'exclude');
}

// Hide keel from git for this clone only. .git/info/exclude is never committed, so nobody else's
// diff changes. CLAUDE.local.md is Claude Code's per-person instruction file; keel's block goes
// there (as an import) instead of into the shared CLAUDE.md.
const EXCLUDE = ['/.keel', '/.keel/', '/CLAUDE.local.md'];
function exclude(root) {
  const f = excludeFile(root);
  if (!f) return false;
  let cur = '';
  try { cur = fs.readFileSync(f, 'utf8'); } catch (e) { cur = ''; }
  const have = new Set(cur.split('\n').map((l) => l.trim()));
  const add = EXCLUDE.filter((l) => !have.has(l));
  if (!add.length) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + '# keel (layout keel/external)\n' + add.join('\n') + '\n');
  return true;
}

/* ------------------------------------------------------------------- moving */

function externalDir(root) {
  return path.join(require('./projects').home(), 'projects', require('./projects').idOf(root));
}

// What `keel upgrade --layout <to>` would do, as a list of steps a person can read first.
function plan(cfg, to) {
  if (!LAYOUTS.includes(to)) return { error: `unknown layout "${to}" — one of ${LAYOUTS.join(', ')}` };
  const from = nameOf(cfg);
  const root = cfg.root;
  const steps = [];
  const src = from === 'repo' ? cfg.paths || REPO : HIDDEN;
  const dst = to === 'repo' ? REPO : HIDDEN;
  if (from !== to) {
    for (const k of ['specs', 'knowledge', 'runbook', 'adr', 'hunts', 'override']) {
      if (src[k] === dst[k]) continue;
      if (fs.existsSync(path.join(root, src[k]))) steps.push({ kind: 'move', from: src[k], to: dst[k] });
    }
    const claudeFrom = path.join(root, src.claude);
    // keel → external keeps the block where it is (.keel/ itself moves), so there is no step.
    if (src.claude !== dst.claude && fs.existsSync(claudeFrom) && /<!-- keel:start -->/.test(fs.readFileSync(claudeFrom, 'utf8'))) {
      steps.push({ kind: 'block', from: src.claude, to: dst.claude });
    }
  }
  // The running flow's spec may sit somewhere the config does not name (a project that kept its
  // specs in docs/specs while the key said specs). Move that folder too, so the flow keeps its spec.
  if (to !== 'repo') {
    try {
      const stt = JSON.parse(fs.readFileSync(path.join(root, '.keel', 'state.json'), 'utf8'));
      const d = stt.spec ? path.dirname(String(stt.spec)).split(path.sep).join('/') : null;
      if (d && d !== '.' && !d.startsWith('.keel') && !steps.some((x) => x.kind === 'move' && x.from === d)
        && fs.existsSync(path.join(root, d))) steps.unshift({ kind: 'move', from: d, to: dst.specs });
    } catch (e) { /* no flow */ }
  }
  // git's exclude file hides only untracked files. Anything under .keel/ that was committed before
  // (usually config.yml) stays visible to the team until it is untracked — the file stays on disk.
  if (to !== 'repo') {
    const tracked = (gitOut('ls-files -- .keel', root, '') || '').split('\n').filter(Boolean);
    if (tracked.length) steps.push({ kind: 'untrack', files: tracked });
  }
  const isLink = (() => { try { return fs.lstatSync(path.join(root, '.keel')).isSymbolicLink(); } catch (e) { return false; } })();
  if (to === 'external' && !isLink) steps.push({ kind: 'externalize', to: externalDir(root) });
  if (to !== 'external' && isLink) steps.push({ kind: 'internalize', from: fs.realpathSync(path.join(root, '.keel')) });
  if (to !== 'repo') steps.push({ kind: 'exclude' });
  steps.push({ kind: 'config', layout: to });
  return { from, to, steps };
}

function moveInto(rootAbs, from, to) {
  const a = path.join(rootAbs, from);
  const b = path.join(rootAbs, to);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  if (fs.existsSync(b) && fs.statSync(a).isDirectory() && fs.statSync(b).isDirectory()) {
    for (const e of fs.readdirSync(a)) moveInto(rootAbs, path.join(from, e), path.join(to, e));
    fs.rmdirSync(a);
    return;
  }
  fs.renameSync(a, b);
}

const BLOCK = /<!-- keel:start -->[\s\S]*?<!-- keel:end -->\n?/;

function apply(cfg, to) {
  const p = plan(cfg, to);
  if (p.error) return p;
  const root = cfg.root;
  const done = [];
  // Only keel's own changes get staged — never the rest of the working tree, which may hold work
  // in progress the person did not mean to commit with this.
  const tracked = (rel) => !!(gitOut(`ls-files -- ${JSON.stringify(rel)}`, root, '') || '').trim();
  const stage = p.steps.filter((x) => (x.kind === 'move' || x.kind === 'block') && tracked(x.from)).map((x) => x.from);
  for (const s of p.steps) {
    if (s.kind === 'move') {
      moveInto(root, s.from, s.to);
      done.push(`moved ${s.from} → ${s.to}`);
      // A flow in progress remembers its spec by path. Moving the specs folder without this left the
      // flow pointing at a file that was no longer there.
      const sf = path.join(root, '.keel', 'state.json');
      try {
        const stt = JSON.parse(fs.readFileSync(sf, 'utf8'));
        const pre = s.from.replace(/\/$/, '') + '/';
        if (stt.spec && String(stt.spec).startsWith(pre)) {
          stt.spec = s.to.replace(/\/$/, '') + '/' + String(stt.spec).slice(pre.length);
          fs.writeFileSync(sf, JSON.stringify(stt, null, 2) + '\n');
          done.push(`pointed the running flow at ${stt.spec}`);
        }
      } catch (e) { /* no state, or no flow: nothing to point */ }
    }
    if (s.kind === 'block') {
      const fromAbs = path.join(root, s.from);
      const text = fs.readFileSync(fromAbs, 'utf8');
      const block = (text.match(BLOCK) || [''])[0];
      const rest = text.replace(BLOCK, '').replace(/\n{3,}/g, '\n\n');
      fs.mkdirSync(path.dirname(path.join(root, s.to)), { recursive: true });
      if (s.to === 'CLAUDE.md') {
        const target = path.join(root, 'CLAUDE.md');
        const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
        fs.writeFileSync(target, (cur ? cur.trimEnd() + '\n\n' : '') + block.trim() + '\n');
        fs.rmSync(fromAbs, { force: true });
        dropImport(root);
      } else {
        fs.writeFileSync(path.join(root, s.to), block.trim() + '\n');
        if (rest.trim()) fs.writeFileSync(fromAbs, rest.trimEnd() + '\n'); else fs.rmSync(fromAbs, { force: true });
        addImport(root);
      }
      done.push(`moved the keel block ${s.from} → ${s.to}`);
    }
    if (s.kind === 'externalize') {
      const local = path.join(root, '.keel');
      fs.mkdirSync(path.dirname(s.to), { recursive: true });
      if (fs.existsSync(s.to)) fs.rmSync(s.to, { recursive: true, force: true });
      fs.cpSync(local, s.to, { recursive: true });
      fs.rmSync(local, { recursive: true, force: true });
      fs.symlinkSync(s.to, local, 'dir');
      done.push(`moved .keel/ → ${s.to} (.keel is now a link to it)`);
    }
    if (s.kind === 'internalize') {
      const local = path.join(root, '.keel');
      fs.unlinkSync(local);
      fs.cpSync(s.from, local, { recursive: true });
      done.push(`copied ${s.from} back into .keel/`);
    }
    if (s.kind === 'untrack') {
      git('rm -r --cached -q -- .keel', root);
      done.push(`stopped tracking ${s.files.length} file(s) under .keel/ (${s.files.slice(0, 3).join(', ')}${s.files.length > 3 ? ', …' : ''}) — they stay on disk`);
    }
    if (s.kind === 'exclude') { if (exclude(root)) done.push('hid .keel/ and CLAUDE.local.md from git in .git/info/exclude (nothing committed)'); }
    if (s.kind === 'config') { writeLayout(root, s.layout); done.push(`set layout: ${s.layout} in .keel/config.yml`); }
  }
  if (stage.length) git(`add -A -- ${stage.map((x) => JSON.stringify(x)).join(' ')}`, root);
  return Object.assign(p, { done, staged: stage });
}

// Claude Code reads CLAUDE.local.md as the personal, uncommitted counterpart of CLAUDE.md.
const IMPORT = '@.keel/CLAUDE.md';
function addImport(root) {
  const f = path.join(root, 'CLAUDE.local.md');
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (cur.split('\n').some((l) => l.trim() === IMPORT)) return;
  fs.writeFileSync(f, (cur ? cur.trimEnd() + '\n\n' : '') + `# keel — its instructions live in .keel/ (layout keel)\n${IMPORT}\n`);
}
function dropImport(root) {
  const f = path.join(root, 'CLAUDE.local.md');
  if (!fs.existsSync(f)) return;
  const rest = fs.readFileSync(f, 'utf8').replace(/# keel — its instructions live in \.keel\/ \(layout keel\)\n/, '')
    .split('\n').filter((l) => l.trim() !== IMPORT).join('\n').trim();
  if (rest) fs.writeFileSync(f, rest + '\n'); else fs.rmSync(f, { force: true });
}

function writeLayout(root, layout) {
  const f = path.join(root, '.keel', 'config.yml');
  let text = fs.readFileSync(f, 'utf8');
  if (/^layout:.*$/m.test(text)) text = text.replace(/^layout:.*$/m, `layout: ${layout}`);
  else text = text.trimEnd() + `\n\n# Where keel keeps its files: repo (committed), keel (.keel/, hidden from git) or external.\nlayout: ${layout}\n`;
  fs.writeFileSync(f, text);
}

module.exports = { LAYOUTS, REPO, HIDDEN, nameOf, hidden, hiddenAt, resolve, exclude, excludeFile, plan, apply, externalDir, addImport };
