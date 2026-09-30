// Install keel into an OpenCode project: the enforcement plugin, and one command per keel flow.
//
//   node opencode/install.mjs            into ./.opencode/
//   node opencode/install.mjs --global   into ~/.config/opencode/
//   node opencode/install.mjs --dry-run  print what would be written
//
// The commands are GENERATED from keel's own skills/ tree rather than kept as copies here. A copy
// of eleven command files would drift from the skills they mirror, and the copy the user's agent
// reads would be the stale one. Each generated command points at the SKILL.md by absolute path,
// which is the same harness-agnostic trick Phase A used for stack packs: a file path needs no
// plugin system to resolve.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
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

// Only the flows a person starts. keel marks those `disable-model-invocation: true` — the reference
// skills are for the model to pull in mid-task, and turning them into slash commands would invite
// a user to run a reference sheet as if it were a flow.
function flowSkills() {
  const dir = join(KEEL_ROOT, 'skills');
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const fm = frontmatter(readFileSync(file, 'utf8'));
    if (fm['disable-model-invocation'] === true) out.push({ name, file, fm });
  }
  return out;
}

function commandBody(skill) {
  const hint = skill.fm['argument-hint'] ? `\nArguments: \`${skill.fm['argument-hint']}\`\n` : '';
  return `---
description: ${skill.fm.description || `keel ${skill.name}`}
---

Read ${skill.file} in full and follow it exactly. It is the authoritative procedure; do not
summarise it or work from memory of it.

The arguments for this run are: $ARGUMENTS
${hint}
keel enforces the phase rules itself through the plugin — an edit the phase does not allow is
refused before it happens, and \`keel commit\` refuses a commit whose staged files do not match
the phase. Do not try to work around either; if you think one is wrong, stop and say so.
`;
}

// --- write -------------------------------------------------------------------------------------

const planned = [];

const pdir = join(base, pluginDirName(base));
planned.push([join(pdir, 'keel.js'), readFileSync(join(HERE, 'plugin', 'keel.js'), 'utf8')]);

const skills = flowSkills();
for (const s of skills) {
  planned.push([join(base, 'command', `keel-${s.name}.md`), commandBody(s)]);
}

if (!skills.length) {
  process.stderr.write(`keel: no flow skills found under ${join(KEEL_ROOT, 'skills')}.\n`);
  process.exit(1);
}

for (const [path, body] of planned) {
  if (dryRun) { process.stdout.write(`would write  ${path}\n`); continue; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  process.stdout.write(`wrote  ${path}\n`);
}

process.stdout.write(
  `\n${dryRun ? 'Dry run. ' : ''}${skills.length} command(s) and the enforcement plugin`
  + `${dryRun ? ' would be' : ''} installed ${global ? 'globally' : `into ${base}`}.\n`
  + 'Restart OpenCode to load the plugin.\n\n'
  + 'One thing to know: OpenCode does not run plugin hooks for tool calls made inside a subagent,\n'
  + "so keel's edit guard cannot reach them. The plugin therefore refuses to spawn keel's seven\n"
  + 'write-capable agents while a flow is running, keeping every write on the primary agent. The\n'
  + 'commit guard is unaffected — it checks the staged set from the CLI, in any harness.\n'
);
