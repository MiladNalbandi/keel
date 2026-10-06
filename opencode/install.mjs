// Install keel into an OpenCode project: the enforcement plugin, and one command per keel flow.
//
//   node opencode/install.mjs            into ./.opencode/
//   node opencode/install.mjs --global   into ~/.config/opencode/
//   node opencode/install.mjs --dry-run  print what would be written
//
// Everything is GENERATED from keel's own skills/ tree at install time, never kept as copies in this
// repo: every skill becomes an OpenCode skill (keel-<name>, with its references beside it), and
// every flow also becomes a command that carries the flow's text inline. Re-run after updating keel.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEEL_ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const global = argv.includes('--global');

// OpenCode has shipped both spellings of this directory. Write the one that already exists, and
// default to the plural the current docs name — guessing wrong means the plugin silently never
// loads, which is the one failure mode that looks like everything is fine.
function pluginDirName(base) {
  if (existsSync(join(base, 'plugin'))) return 'plugin';
  if (existsSync(join(base, 'plugins'))) return 'plugins';
  return 'plugins';
}

const base = global ? join(homedir(), '.config', 'opencode') : join(process.cwd(), '.opencode');

// --- frontmatter -------------------------------------------------------------------------------

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim().replace(/^["']|["']$/g, '');
    out[kv[1]] = v === 'true' ? true : v === 'false' ? false : v;
  }
  return out;
}

// --- what to install ---------------------------------------------------------------------------

// Every keel skill — the flows a person starts and the reference skills the model pulls in mid-task
// (keel-sonar, keel-architecture, …). OpenCode has native skills: `.opencode/skills/<name>/SKILL.md`,
// loaded with its `skill` tool. Before this, only the flows were installed, as commands that said
// "Read /abs/path/SKILL.md" — a file outside the project, so OpenCode asked for external-directory
// permission (or the model announced the read and never made it), and the reference skills did
// not exist in OpenCode at all.
function allSkills() {
  const dir = join(KEEL_ROOT, 'skills');
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, 'SKILL.md');
    if (!existsSync(file)) continue;
    out.push({ name, dir: join(dir, name), file, fm: frontmatter(readFileSync(file, 'utf8')) });
  }
  return out;
}

// Skill names must be lowercase-hyphen in OpenCode, so `keel:sonar` is `keel-sonar` there. Only
// skill names are rewritten — `keel:implementer` and the other agents are not skills.
function rewrite(text, names) {
  let out = text.replace(/\bkeel:([a-z][a-z0-9-]*)/g, (m, n) => (names.has(n) ? `keel-${n}` : m));
  // Claude Code's question tool is OpenCode's `question` tool.
  out = out.replace(/`AskUserQuestion`/g, 'the `question` tool').replace(/\bAskUserQuestion\b/g, 'the question tool');
  return out;
}

function body(text) { return text.replace(/^---\n[\s\S]*?\n---\n/, ''); }

function skillFile(skill, names, where) {
  const desc = rewrite(String(skill.fm.description || `keel ${skill.name}`), names).replace(/\n/g, ' ').slice(0, 1024);
  return `---
name: keel-${skill.name}
description: ${JSON.stringify(desc)}
---

> OpenCode: the files this skill names (\`references/…\`, \`examples/…\`) are in \`${where}\`.
> Load another keel skill with the \`skill\` tool, e.g. \`skill({ name: "keel-sonar" })\`.
${rewrite(body(readFileSync(skill.file, 'utf8')), names)}`;
}

// A flow's command carries the flow itself, so it starts the moment it is run — no tool call to
// make first, nothing to ask permission for.
function commandBody(skill, names, where) {
  const hint = skill.fm['argument-hint'] ? `Arguments: \`${skill.fm['argument-hint']}\` — this run: $ARGUMENTS\n\n` : '';
  return `---
description: ${JSON.stringify(rewrite(String(skill.fm.description || `keel ${skill.name}`), names).replace(/\n/g, ' '))}
---

${hint}Follow this procedure exactly; it is the whole of the instructions. Files it names
(\`references/…\`) are in \`${where}\`. Other keel skills load with the \`skill\` tool (\`keel-<name>\`).
keel enforces the phase rules itself through the plugin — an edit the phase does not allow is
refused before it happens, and \`keel commit\` refuses a commit whose staged files do not match the
phase. Do not work around either; if you think one is wrong, stop and say so.

${rewrite(body(readFileSync(skill.file, 'utf8')), names)}`;
}

// Every file under a directory, relative to it.
function walk(root, rel = '') {
  const out = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}

// --- write -------------------------------------------------------------------------------------

const planned = [];

const pdir = join(base, pluginDirName(base));
planned.push([join(pdir, 'keel.js'), readFileSync(join(HERE, 'plugin', 'keel.js'), 'utf8')]);

const skills = allSkills();
if (!skills.length) {
  process.stderr.write(`keel: no skills found under ${join(KEEL_ROOT, 'skills')}.\n`);
  process.exit(1);
}
const names = new Set(skills.map((s) => s.name));
// Anything a human can type gets a command: the flows, and a skill that is both (memory sets
// user-invocable and lets the model load it too) — keyed on one flag only, /keel-memory was missing.
const flows = skills.filter((s) => s.fm['disable-model-invocation'] === true || s.fm['user-invocable'] === true);

for (const s of skills) {
  const target = join(base, 'skills', `keel-${s.name}`);
  for (const rel of walk(s.dir)) {
    const src = join(s.dir, rel);
    const text = readFileSync(src);
    if (rel === 'SKILL.md') planned.push([join(target, rel), skillFile(s, names, target)]);
    else if (rel.endsWith('.md')) planned.push([join(target, rel), rewrite(text.toString('utf8'), names)]);
    else planned.push([join(target, rel), text]);
  }
}
for (const s of flows) {
  planned.push([join(base, 'command', `keel-${s.name}.md`), commandBody(s, names, join(base, 'skills', `keel-${s.name}`))]);
}

// Skills from an older install that keel no longer ships would otherwise linger and be loaded.
const skillsRoot = join(base, 'skills');
if (!dryRun && existsSync(skillsRoot)) {
  for (const d of readdirSync(skillsRoot)) {
    if (d.startsWith('keel-') && !names.has(d.slice(5))) rmSync(join(skillsRoot, d), { recursive: true, force: true });
  }
}
const cmdRoot = join(base, 'command');
if (!dryRun && existsSync(cmdRoot)) {
  const flowNames = new Set(flows.map((f) => f.name));
  for (const f of readdirSync(cmdRoot)) {
    const m = f.match(/^keel-(.+)\.md$/);
    if (m && !flowNames.has(m[1])) rmSync(join(cmdRoot, f), { force: true });
  }
}

for (const [path, content] of planned) {
  if (dryRun) { process.stdout.write(`would write  ${path}\n`); continue; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
if (!dryRun) process.stdout.write(`wrote  ${planned.length} file(s) under ${base}\n`);

// A global install puts the skills outside every project, where OpenCode asks before reading
// (external_directory defaults to "ask"). Allow exactly keel's skill directories, nothing wider.
let permissionNote = '';
if (global) {
  const cfgFile = join(base, 'opencode.json');
  const rule = '~/.config/opencode/skills/keel-*/**';
  let cfg = {};
  let readable = true;
  if (existsSync(cfgFile)) { try { cfg = JSON.parse(readFileSync(cfgFile, 'utf8')); } catch (e) { readable = false; } }
  if (readable) {
    cfg.$schema = cfg.$schema || 'https://opencode.ai/config.json';
    cfg.permission = cfg.permission || {};
    const ext = cfg.permission.external_directory;
    if (typeof ext === 'string') cfg.permission.external_directory = { '*': ext, [rule]: 'allow' };
    else cfg.permission.external_directory = Object.assign({}, ext || {}, { [rule]: 'allow' });
    if (dryRun) process.stdout.write(`would allow  ${rule} in ${cfgFile}\n`);
    else { writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n'); process.stdout.write(`allowed  ${rule} in ${cfgFile}\n`); }
  } else {
    permissionNote = `\n${cfgFile} has comments or is not plain JSON, so it was not changed. Add this yourself:\n`
      + `  "permission": { "external_directory": { "${rule}": "allow" } }\n`;
  }
}

process.stdout.write(
  `\n${dryRun ? 'Dry run. ' : ''}${skills.length} skill(s), ${flows.length} command(s) and the enforcement plugin`
  + `${dryRun ? ' would be' : ''} installed ${global ? 'globally' : `into ${base}`}.\n`
  + permissionNote
  + 'Restart OpenCode to load them. Re-run this after updating keel — the skills are copies.\n\n'
  + 'One thing to know: OpenCode does not run plugin hooks for tool calls made inside a subagent,\n'
  + "so keel's edit guard cannot reach them. The plugin therefore refuses to spawn keel's\n"
  + 'write-capable agents while a flow is running, keeping every write on the primary agent. The\n'
  + 'commit guard is unaffected — it checks the staged set from the CLI, in any harness.\n'
);
