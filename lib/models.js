'use strict';
// Which model, effort and context each keel agent runs on — chosen once for this machine, applied
// to every harness keel is installed in.
//
// The choice lives in ~/.keel/models.json, not in the agent files. The agent files belong to the
// installed plugin, and a plugin update replaces them: a choice written only there was silently
// reset by every update. The JSON is the record; `apply` writes it into Claude Code's agent
// frontmatter (`model:` / `effort:`) and into OpenCode's agent files (`model: anthropic/<id>`), and
// session start re-applies it, so an update costs one reload rather than the user's settings.
const fs = require('fs');
const path = require('path');

// Aliases follow the newest model of a family; exact ids pin one. `inherit` uses whatever the
// main session runs on.
const CATALOG = [
  { id: 'inherit', label: 'same as the main session', family: null },
  { id: 'opus', label: 'Opus — latest', family: 'opus' },
  { id: 'sonnet', label: 'Sonnet — latest', family: 'sonnet' },
  { id: 'haiku', label: 'Haiku — latest', family: 'haiku' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'fable' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', family: 'opus' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', family: 'sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', family: 'haiku' },
];
// What an alias means where a harness needs an exact id (OpenCode's `provider/model`).
const LATEST = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5-20251001', fable: 'claude-fable-5-1' };
const EFFORTS = ['low', 'medium', 'high'];
// Families with a 1M-token context variant. Haiku has none, and `inherit` decides nothing.
const LONG = ['opus', 'sonnet', 'fable'];

function file() { return path.join(require('./projects').home(), 'models.json'); }

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { agents: (j && j.agents) || {} };
  } catch (e) { return { agents: {} }; }
}

function write(data) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file() + '.tmp', JSON.stringify({ version: 1, agents: data.agents }, null, 2) + '\n');
  fs.renameSync(file() + '.tmp', file());
}

function defaults() {
  const cli = require('./cli');
  return { models: cli.AGENT_DEFAULTS, efforts: cli.AGENT_EFFORTS };
}

function familyOf(id) { const c = CATALOG.find((x) => x.id === id); return c ? c.family : null; }

// One agent's choice, or why it is not one.
function problem(choice) {
  if (!choice || typeof choice !== 'object') return 'not a choice';
  if (choice.model !== undefined && !CATALOG.some((c) => c.id === choice.model)) {
    return `unknown model "${choice.model}" — one of ${CATALOG.map((c) => c.id).join(', ')}`;
  }
  if (choice.effort !== undefined && !EFFORTS.includes(choice.effort)) return `unknown effort "${choice.effort}" — one of ${EFFORTS.join(', ')}`;
  if (choice.context !== undefined && !['default', '1m'].includes(choice.context)) return `unknown context "${choice.context}" — default or 1m`;
  if (choice.context === '1m' && !LONG.includes(familyOf(choice.model))) return `${choice.model} has no 1M-context variant`;
  return null;
}

// The effective choice: what was saved, over the agent's default.
function effective(agent, saved) {
  const d = defaults();
  const s = (saved || read()).agents[agent] || {};
  return { model: s.model || d.models[agent], effort: s.effort || d.efforts[agent], context: s.context || 'default' };
}

// Frontmatter values per harness.
function claudeModel(c) { return c.context === '1m' && LONG.includes(familyOf(c.model)) ? `${c.model}[1m]` : c.model; }
function opencodeModel(c) {
  if (c.model === 'inherit') return null;
  return `anthropic/${LATEST[c.model] || c.model}`;
}

function setField(text, key, value) {
  const re = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm');
  const end = text.indexOf('\n---', 4);
  if (value === null) return re.test(text) ? text.replace(new RegExp(`^${key}:[ \\t]*.+\\n`, 'm'), '') : text;
  if (re.test(text)) return text.replace(re, `${key}: ${value}`);
  return end > 0 ? `${text.slice(0, end)}\n${key}: ${value}${text.slice(end)}` : text;
}

function opencodeDirs(projectRoot) {
  const home = process.env.HOME || require('os').homedir();
  const dirs = [path.join(home, '.config', 'opencode', 'agents'), path.join(home, '.config', 'opencode', 'agent')];
  if (projectRoot) dirs.push(path.join(projectRoot, '.opencode', 'agents'), path.join(projectRoot, '.opencode', 'agent'));
  return dirs.filter((d) => fs.existsSync(d));
}

// Write every agent's effective choice into the harnesses. Only lines that differ are rewritten,
// so this is cheap to run at every session start.
function apply(opts = {}) {
  const agentDir = opts.agentDir || process.env.KEEL_AGENT_DIR || path.join(__dirname, '..', 'agents');
  const saved = read();
  const changed = [];
  for (const agent of Object.keys(defaults().models)) {
    const c = effective(agent, saved);
    const f = path.join(agentDir, `${agent}.md`);
    if (fs.existsSync(f)) {
      const before = fs.readFileSync(f, 'utf8');
      const after = setField(setField(before, 'model', claudeModel(c)), 'effort', c.effort);
      if (after !== before) { fs.writeFileSync(f, after); changed.push(`claude:${agent}`); }
    }
    for (const d of opencodeDirs(opts.projectRoot)) {
      const of = path.join(d, `keel-${agent}.md`);
      if (!fs.existsSync(of)) continue;
      const before = fs.readFileSync(of, 'utf8');
      const after = setField(before, 'model', opencodeModel(c));
      if (after !== before) { fs.writeFileSync(of, after); changed.push(`opencode:${agent}`); }
    }
  }
  return changed;
}

// Change the saved choice for one agent, or for every agent with `agent: '*'`. `reset` drops the
// choice so the default applies again.
function update(body, opts = {}) {
  const d = defaults();
  const agents = Object.keys(d.models);
  const target = body && body.agent;
  if (!target || (target !== '*' && !agents.includes(target))) return { ok: false, error: `unknown agent "${target}"` };
  const saved = read();
  const list = target === '*' ? agents : [target];
  for (const a of list) {
    if (body.reset) { delete saved.agents[a]; continue; }
    const next = Object.assign({}, effective(a, saved));
    for (const k of ['model', 'effort', 'context']) if (body[k] !== undefined && body[k] !== null && body[k] !== '') next[k] = body[k];
    // Switching a 1M agent to a model without that variant drops the 1M quietly; asking for 1M on
    // such a model is refused, so nobody believes they got it.
    if (next.context === '1m' && !LONG.includes(familyOf(next.model))) {
      if (body.context === '1m') return { ok: false, error: `${a}: ${next.model} has no 1M-context variant` };
      next.context = 'default';
    }
    const why = problem(next);
    if (why) return { ok: false, error: `${a}: ${why}` };
    // Keep only what differs from the default, so a later change of default still reaches it.
    const keep = {};
    if (next.model !== d.models[a]) keep.model = next.model;
    if (next.effort !== d.efforts[a]) keep.effort = next.effort;
    if (next.context !== 'default') keep.context = next.context;
    if (Object.keys(keep).length) saved.agents[a] = keep; else delete saved.agents[a];
  }
  write(saved);
  const changed = apply(opts);
  return { ok: true, changed, note: 'Run /reload-plugins in Claude Code, and restart OpenCode, for the change to reach new agents.' };
}

function describe(agentDir, agent) {
  try {
    const t = fs.readFileSync(path.join(agentDir, `${agent}.md`), 'utf8');
    const m = t.match(/^description:\s*(.+)$/m);
    const first = m ? m[1].split(/(?<=\.)\s/)[0] : '';
    return first.length > 140 ? first.slice(0, 139).replace(/\s+\S*$/, '') + '…' : first;
  } catch (e) { return ''; }
}

// Everything the dashboard's agents tab shows.
function view(opts = {}) {
  const agentDir = opts.agentDir || process.env.KEEL_AGENT_DIR || path.join(__dirname, '..', 'agents');
  const d = defaults();
  const saved = read();
  const rows = Object.keys(d.models).sort().map((a) => {
    const c = effective(a, saved);
    return { agent: a, description: describe(agentDir, a), model: c.model, effort: c.effort, context: c.context,
      default: { model: d.models[a], effort: d.efforts[a] }, custom: !!saved.agents[a] };
  });
  return { file: file(), agents: rows, catalog: CATALOG, efforts: EFFORTS, long: LONG,
    opencode: opencodeDirs(opts.projectRoot).length > 0 };
}

module.exports = { CATALOG, LATEST, EFFORTS, LONG, file, read, write, problem, effective, claudeModel, opencodeModel, apply, update, view };
