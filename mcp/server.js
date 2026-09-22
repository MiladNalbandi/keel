#!/usr/bin/env node
'use strict';
// keel's MCP server. Hand-rolled JSON-RPC over stdio rather than the official SDK, because keel
// has no package.json, no lockfile and no install step, and this is not the feature that should
// introduce all three. The protocol surface it needs is three methods and newline-delimited JSON.
//
// Everything here is read-only. It never calls st.update(): that is read-modify-write with no
// locking, so a server that wrote would race the hooks it exists to report on.
const path = require('path');

const view = require('./view');
const board = require('../lib/board');
const config = require('../lib/config');
const st = require('../lib/state');
const events = require('../lib/events');
const guards = require('../lib/guards');

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const FALLBACK = '2024-11-05';

function projectDir(args) {
  return (args && args.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

const TOOLS = [
  {
    name: 'keel_status',
    description: 'The whole keel board: which flow and phase, acceptance criteria, running agents, '
      + 'checks, what is blocking a push, open blocking questions, and the single next command. '
      + 'Use this to answer "where are we" without running several commands.',
    inputSchema: {
      type: 'object',
      properties: { cwd: { type: 'string', description: 'Project directory. Defaults to the session cwd.' } },
    },
  },
  {
    name: 'keel_timeline',
    description: 'Recent keel events, newest first: tool calls with their result and duration, agent '
      + 'starts/stops with their verdict, phase transitions, gate decisions and guard denials. '
      + 'Use this to answer "what just happened" or "why did that fail".',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: Object.keys(events.FILTERS), description: 'Which kind of event. Default all.' },
        limit: { type: 'number', description: 'How many events, 1-1000. Default 40.' },
        cwd: { type: 'string' },
      },
    },
  },
  {
    name: 'keel_next',
    description: 'The single next action in the current keel flow, plus anything blocking it.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } },
  },
  {
    name: 'keel_explain',
    description: 'What a keel phase means, what it permits and refuses, and what comes before and '
      + 'after it on the flow rail. Pass a phase name, or omit it for the current phase.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: { type: 'string', description: 'A phase name such as red, green, gate, hunt-sweep. Defaults to the current one.' },
        cwd: { type: 'string' },
      },
    },
  },
  {
    name: 'keel_dashboard',
    description: 'Open the live keel dashboard: a local web page showing the flow, acceptance '
      + 'criteria, running agents, a live tool feed and what is blocking a push, updating as it '
      + 'happens. Returns the URL to give the user.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } },
  },
];

function fmtStatus(args) {
  const cwd = projectDir(args);
  const cfg = config.load(cwd);
  const state = st.read(cfg);
  const v = view.build(cwd);
  const out = [];

  // The board keel already prints, so the terminal and the dashboard can never disagree.
  try { out.push(board.render(cfg, state)); }
  catch (e) { out.push('board unavailable: ' + ((e && e.message) || e)); }

  if (v.questions && v.questions.length) {
    out.push('', 'waiting on you');
    for (const q of v.questions) {
      out.push(`        ${q.blocking ? 'BLOCKING' : 'open'}  ${q.id}: ${q.question}`);
      if (q.because) out.push(`                  because ${q.because}`);
    }
  }
  const recent = (v.timeline || []).slice(0, 8);
  if (recent.length) {
    out.push('', 'recent');
    for (const e of recent) out.push('        ' + eventLine(e));
  }
  return out.join('\n');
}

function eventLine(e) {
  const t = String(e.at || '').slice(11, 19);
  if (e.kind === 'tool') {
    return `${t}  ${e.tool} ${e.arg || ''}`.trimEnd()
      + `  ${e.ok === false ? 'FAIL' : 'ok'}${e.ms != null ? ' ' + (e.ms < 1000 ? e.ms + 'ms' : (e.ms / 1000).toFixed(1) + 's') : ''}`;
  }
  if (e.kind === 'agent') return `${t}  agent ${e.agent} ${e.ev}${e.verdict ? '  ' + e.verdict : ''}${e.ac ? '  ' + e.ac : ''}`;
  if (e.kind === 'phase') return `${t}  phase ${e.from} -> ${e.to}`;
  if (e.kind === 'gate') return `${t}  gate ${e.ac || e.gate || ''} ${e.verdict || ''}`.trimEnd();
  if (e.kind === 'guard') return `${t}  guard ${e.tool} denied ${e.arg || ''} · ${e.denied || ''}`;
  return `${t}  ${e.kind}`;
}

function fmtTimeline(args) {
  const cwd = projectDir(args);
  const cfg = config.load(cwd);
  const rows = events.read(cfg, { filter: args.filter || 'all', limit: args.limit || 40 });
  if (!rows.length) {
    return events.count(cfg)
      ? `no ${args.filter || ''} events.`.replace('  ', ' ')
      : 'no events recorded yet. keel logs tool calls, agent runs, phase changes, gate decisions '
        + 'and guard denials to .keel/logs/events.jsonl once a flow is running.';
  }
  return rows.map(eventLine).join('\n');
}

function fmtNext(args) {
  const v = view.build(projectDir(args));
  if (!v.active) return 'no active flow. Start one with /keel:feature, /keel:change, /keel:fix or /keel:hunt.';
  const out = [v.next];
  const blocking = (v.questions || []).filter((q) => q.blocking);
  if (blocking.length) {
    out.push('', `${blocking.length} blocking question(s) must be answered first:`);
    for (const q of blocking) out.push(`  ${q.id}: ${q.question}`);
  }
  if ((v.blockers || []).length) {
    out.push('', 'blocking a push:');
    for (const b of v.blockers) out.push(`  ${b.gate}: ${b.why} -> ${b.fix}`);
  }
  if (v.lastFailure) out.push('', 'last failure: ' + v.lastFailure);
  return out.join('\n');
}

function fmtExplain(args) {
  const cwd = projectDir(args);
  const v = view.build(cwd);
  const phase = args.phase || (v.flow && v.flow.phase) || (v.active ? null : 'none');
  if (!phase) return 'no active flow, and no phase given. Pass one, e.g. { "phase": "red" }.';
  if (!st.PHASES.includes(phase)) {
    return `no phase "${phase}". keel knows: ${st.PHASES.join(', ')}`;
  }
  const out = [`phase  ${phase}`];
  const blurb = view.PHASE_BLURB[phase];
  if (blurb) out.push('', blurb);

  // Where it sits on each rail it belongs to.
  for (const [flow, names] of Object.entries(board.RAILS)) {
    const i = names.indexOf(phase);
    if (i < 0) continue;
    out.push('', `on the ${flow} rail, step ${i + 1} of ${names.length}:`);
    out.push('  ' + names.map((n, j) => (j === i ? `[${n}]` : n)).join(' - '));
  }

  const row = guards.MATRIX[phase];
  if (row) {
    const fallback = row['*'] || 'deny';
    const allowed = [];
    const denied = [];
    const partial = [];
    for (const b of ['api-main', 'api-test', 'web-src', 'web-test', 'contract', 'specs',
      'migration', 'e2e', 'smoke', 'generated', 'protected-env', 'other']) {
      const rule = row[b] || fallback;
      if (rule === 'allow') allowed.push(b);
      else if (rule === 'deny') denied.push(b);
      else partial.push(`${b} (${rule})`);
    }
    out.push('', 'you may edit:  ' + (allowed.join(', ') || 'nothing'));
    if (partial.length) out.push('partly:        ' + partial.join(', '));
    out.push('frozen:        ' + (denied.join(', ') || 'nothing'));
    out.push('', 'This is the table the pre-tool hook enforces. `keel unlock <path> --reason "..."` opens one path.');
  }

  const legal = st.TRANSITIONS[phase];
  if (legal) out.push('', 'may move to:   ' + legal.join(', '));
  return out.join('\n');
}

function fmtDashboard(args) {
  const cwd = projectDir(args);
  return require('./http').start(cwd).then((r) => {
    const v = view.build(cwd);
    return [
      `keel dashboard ${r.started ? 'started' : 'already running'} at ${r.url}`,
      '',
      v.active
        ? `Showing ${v.header.flow} · phase ${v.flow.phase}${v.acs && v.acs.total ? ` · ${v.acs.done}/${v.acs.total} ACs` : ''}.`
        : 'No flow is running yet; the page will fill in as soon as one starts.',
      'It updates by itself as the flow moves — leave it open.',
    ].join('\n');
  }).catch((e) => `could not start the dashboard: ${(e && e.message) || e}`);
}

const HANDLERS = {
  keel_status: fmtStatus,
  keel_timeline: fmtTimeline,
  keel_next: fmtNext,
  keel_explain: fmtExplain,
  keel_dashboard: fmtDashboard,
};

// ---- JSON-RPC over stdio -----------------------------------------------------------------

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function reply(id, result) { write({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

function onMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return;
  const { id, method, params } = msg;
  // A notification has no id and takes no response — `notifications/initialized` included.
  const isRequest = id !== undefined && id !== null;

  if (method === 'initialize') {
    const want = params && params.protocolVersion;
    return reply(id, {
      protocolVersion: SUPPORTED.includes(want) ? want : FALLBACK,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'keel', version: pluginVersion() },
    });
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const fn = HANDLERS[name];
    if (!fn) return fail(id, -32602, `no tool "${name}"`);
    let out;
    try { out = fn(args); } catch (e) {
      return reply(id, { content: [{ type: 'text', text: `keel: ${(e && e.message) || e}` }], isError: true });
    }
    return Promise.resolve(out).then(
      (text) => reply(id, { content: [{ type: 'text', text: String(text) }] }),
      (e) => reply(id, { content: [{ type: 'text', text: `keel: ${(e && e.message) || e}` }], isError: true }),
    );
  }
  if (isRequest) return fail(id, -32601, `unsupported method "${method}"`);
  return undefined;
}

function pluginVersion() {
  try { return require(path.join(__dirname, '..', '.claude-plugin', 'plugin.json')).version || '0'; }
  catch (e) { return '0'; }
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      try { onMessage(msg); } catch (e) { /* one bad message must not kill the server */ }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  // stdout must carry protocol only; anything else would corrupt the stream.
  process.on('uncaughtException', (e) => { process.stderr.write('keel-mcp: ' + e.stack + '\n'); });
}

if (require.main === module) main();
module.exports = { onMessage, TOOLS, HANDLERS };
