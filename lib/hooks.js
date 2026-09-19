'use strict';
const fs = require('fs');
const path = require('path');
const { readStdin, run, readJson, trim } = require('./util');
const config = require('./config');
const st = require('./state');
const guards = require('./guards');
const verify = require('./verify');

function input() {
  const raw = readStdin();
  try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
}

const DEFAULT_GATE_COMMANDS = ['git push', 'gh pr create', 'keel pr'];

// Does the command contain one of these phrases as whole words? Substring matching made
// `keel pr` fire on `keel preflight`, and `git push` on `git pushall`.
function matchesAnyCommand(cmd, phrases) {
  const list = (phrases && phrases.length ? phrases : DEFAULT_GATE_COMMANDS);
  return list.some((phrase) => {
    const words = String(phrase).trim().split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return false;
    return new RegExp(`(?:^|[\\s;&|(])${words.join('\\s+')}(?=$|[\\s;&|)])`).test(cmd);
  });
}
function block(reason) { process.stderr.write('keel: ' + reason + '\n'); process.exit(2); }
function allow() { process.exit(0); }
function say(text) { process.stdout.write(text.endsWith('\n') ? text : text + '\n'); process.exit(0); }
function stopBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

function ctx(inp) {
  const cfg = config.load(inp.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  return { cfg, state: st.read(cfg) };
}

// H1 — session brief
function sessionStart() {
  const inp = input();
  const { cfg, state } = ctx(inp);
  if (!cfg.configured) {
    return say('keel: this project has no .keel/config.yml yet. Run /keel:init before starting a flow.');
  }
  if (!st.active(state)) return allow();
  const sum = st.acSummary(state);
  const lines = [
    `keel: ${state.flow} flow (${state.size || 'full'}) — phase ${state.phase}`,
    state.spec ? `spec: ${state.spec}` : null,
    state.branch ? `branch: ${state.branch}   lane: ${state.lane}` : null,
    sum.total ? `ACs: ${sum.done}/${sum.total} done   current: ${state.current || '-'}` : null,
    state.last_failure ? `last failure: ${state.last_failure}` : null,
    state.stall.count > 1 ? `same failure repeated ${state.stall.count}x` : null,
    skillLine(cfg, state),
    // A cleared session loses the todo list while the flow carries on, so the brief says how
    // far along it is — a stale checklist is worse than none, because it looks authoritative.
    (() => {
      try {
        const items = require('./todos').build(state, cfg);
        if (!items.length) return null;
        return `todo: ${items.filter((i) => i.status === 'completed').length}/${items.length} steps — rebuild it with \`keel todos\``;
      } catch (e) { return null; }
    })(),
    `next: ${nextStep(state)}`,
  ].filter(Boolean);
  say(lines.slice(0, 40).join('\n'));
}
// Which skills this phase wants, as one line for a brief. Advisory by nature: the absence
// of a Skill call is not a blockable tool event, so the teeth are on the output side
// (`keel verify arch`, and the architecture reviewer lens at ship).
function skillLine(cfg, state, layerHint) {
  try {
    const skills = require('./skills');
    const layer = layerHint || (state.current && state.acs[state.current] && state.acs[state.current].layer) || 'API';
    const items = skills.resolve(cfg, state.phase, layer).filter((i) => i.skill);
    if (!items.length) return null;
    return 'load: ' + items.map((i) => i.skill + (i.reference ? ` (${i.reference})` : '')).join(', ');
  } catch (e) { return null; }
}

function nextStep(state) {
  switch (state.phase) {
    case 'spec': return 'finish the spec, then ask the user to approve it';
    case 'plan': return 'write the plan into the spec, then ask for approval';
    case 'contract': return 'change the contract, regenerate, then `keel commit contract`';
    case 'red': return `write the failing test for ${state.current || 'the current AC'}, then \`keel state red-done\``;
    case 'green': return `make ${state.current || 'the AC'} pass, then \`keel state green-done\``;
    case 'gate': return 'run the gate: `keel gate ac approve|review|reject|skip`';
    case 'e2e': return 'write the E2E spec, then `keel commit e2e <AC>`';
    case 'smoke': return 'write the smoke checks, then `keel commit smoke`';
    case 'bug-repro': return 'write the failing test, then `keel state repro-done`';
    case 'bug-investigate': return 'investigate, then present the fix plan for Gate F';
    case 'bug-fix': return 'fix the root cause, then `keel state green-done`';
    case 'trivial': return 'make the change, then `keel commit trivial <area> "<message>"`';
    case 'hunt-scope': return 'show the lens set and confirm it: `keel hunt lenses --confirm <a,b,c>`';
    case 'hunt-sweep': return 'one keel:hunter per confirmed lens, in parallel, then `keel hunt add`';
    case 'hunt-prove': return 'one keel:prover per candidate, then `keel hunt prove <id> --verdict ...`';
    case 'hunt-report': return 'group the causes, then `keel hunt report`';
    case 'hunt-triage': return 'take the top group with `keel hunt next`, or close one';
    case 'ship': return 'run /keel:ship';
    default: return 'see `keel status`';
  }
}

// H2, H3, H4, H11 — one pre-tool dispatcher
function preTool() {
  const inp = input();
  const { cfg, state } = ctx(inp);
  const tool = inp.tool_name || '';
  const ti = inp.tool_input || {};

  if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(tool)) {
    const file = ti.file_path || ti.path || ti.notebook_path;
    if (!file) return allow();
    const v = guards.checkEdit(cfg, state, file);
    if (!v.ok) return block(v.reason);
    return allow();
  }
  if (tool === 'Read') {
    const file = ti.file_path || ti.path;
    if (!file) return allow();
    const v = guards.checkRead(cfg, file, ti);
    if (!v.ok) return block(v.reason);
    return allow();
  }
  if (tool === 'Bash') {
    const v = guards.checkBash(cfg, state, ti.command);
    if (!v.ok) return block(v.reason);
    // H10 — coverage gate on push / PR. Driven by coverage.gate_commands rather than a
    // hardcoded regex, and matched on whole words: the old pattern's `keel\s+pr` also
    // matched `keel preflight`, so adding that command silently tripped the gate.
    //
    // Only in a repo that opted into keel. These are workflow gates, and a project with no
    // .keel/config.yml has not adopted the workflow — gating its pushes is keel imposing a
    // process nobody asked for, which it did in every repo until now. The always-on guards
    // above (secrets, .env, protected paths) still apply: those prevent harm rather than
    // enforce a process.
    // H10 and H17 both live in gates.pushBlockers, so `keel board` can report exactly what
    // would block without re-deriving it. Two copies of this would drift, and the copy the
    // user reads is the one that would be wrong.
    if (cfg.configured && matchesAnyCommand(String(ti.command || ''), (cfg.coverage || {}).gate_commands)) {
      const blockers = require('./gates').pushBlockers(cfg);
      if (blockers.length) {
        const first = blockers[0];
        return block(`${first.gate}: ${first.why}. Run \`${first.fix}\`.`
          + (blockers.length > 1 ? `\n(${blockers.length - 1} more: ${blockers.slice(1).map((b) => b.gate).join(', ')})` : ''));
      }
    }
    return allow();
  }
  if (/^mcp__/.test(tool)) {
    const v = guards.checkMcp(cfg, state, tool, ti);
    if (!v.ok) return block(v.reason);
    return allow();
  }
  allow();
}

// H5, H6, H16 — format the edited file, reject disabled-test markers, scan for secrets.
// H18 — after a command that moved the flow on, emit the step checklist.
function postTool() {
  const inp = input();
  const { cfg, state } = ctx(inp);
  const ti = inp.tool_input || {};

  // H18. This dispatcher now also matches Bash, so it runs after *every* shell command —
  // hence the early return. A checklist after `ls` is noise, and the per-call cost is the
  // thing design §15's one-dispatcher-per-event rule exists to keep down.
  if (!ti.file_path && !ti.path) {
    const todos = require('./todos');
    // Two rails, not one: inside a flow the AC steps, and outside it the run ladder, which
    // used to show nothing at all while `keel:init` worked through a dozen rungs.
    const active = st.active(state);
    const relevant = active ? todos.isStateChanging(ti.command) : todos.isSetupCommand(ti.command);
    if (!relevant) return allow();
    if (!active && !todos.hasSetup(cfg)) return allow();
    const list = todos.render(state, cfg);
    if (!list) return allow();
    // A hook cannot call the todo tool — only the model can, and some sessions have no such
    // tool at all. So the rendered list has to stand on its own: mirroring it is an offer,
    // not an instruction, because an instruction that cannot be followed reads as a failure.
    return say([list, '', 'This is the current checklist. If you keep a todo list, mirror it so the two agree.'].join('\n'));
  }

  const file = ti.file_path || ti.path;
  if (!file) return allow();
  const rel = path.isAbsolute(file) ? path.relative(cfg.root, file) : file;
  const abs = path.join(cfg.root, rel);

  // H16: secrets, before anything else. Fails closed, and at the edit rather than the
  // commit: a secret that reaches a commit needs history rewriting to remove, which is a
  // much worse conversation than a blocked edit. Skipped for generated and build output,
  // and for .env.example, which exists to hold placeholder values.
  if (fs.existsSync(abs) && /\.(kt|java|ts|tsx|js|jsx|py|go|rb|yml|yaml|json|properties|sh|env|md|txt|xml|toml)$/.test(rel)
      && !/(^|\/)(node_modules|build|dist|target|generated)\//.test(rel)
      && !/\.env\.example$/.test(rel)) {
    const secrets = require('./secrets');
    let hits = [];
    try { hits = secrets.scan(fs.readFileSync(abs, 'utf8')); } catch (e) { hits = []; }
    if (hits.length) {
      const first = hits[0];
      return block([`${rel}:${first.line} looks like ${first.why}.`,
        'Secrets belong in the env file, which is gitignored; reference the variable name instead.',
        'If this is a fixture or an example, append `keel:allow-secret` to that line.'].join('\n'));
    }
  }

  // H6: markers in test files
  if (/Test\.(kt|java)$|\.(test|spec)\.(ts|tsx|js|jsx)$/.test(rel) && fs.existsSync(abs)) {
    const text = fs.readFileSync(abs, 'utf8');
    const markers = verify.findDisabledMarkers(text.split('\n').map((l) => '+' + l).join('\n'));
    if (markers.length) {
      return block(`${rel} contains ${markers.join(', ')}. Tests must not be disabled or skipped; fix the code or reject the AC at the gate.`);
    }
  }
  // H5: format
  if (/\.(ts|tsx|css|json|md)$/.test(rel)) {
    const dir = path.join(cfg.root, cfg.frontend.dir);
    run(`npx --no-install prettier --write "${abs}"`, { cwd: fs.existsSync(dir) ? dir : cfg.root, timeout: 20000 });
  } else if (/\.(kt|kts)$/.test(rel)) {
    // Queue for the batch hook instead of starting a JVM per edit.
    const q = path.join(cfg.root, '.keel', 'format-queue.txt');
    fs.mkdirSync(path.dirname(q), { recursive: true });
    fs.appendFileSync(q, rel + '\n');
  }
  allow();
}

// H12 — format queued Kotlin files once per batch
function postBatch() {
  input();
  const cfg = config.load();
  const q = path.join(cfg.root, '.keel', 'format-queue.txt');
  if (!fs.existsSync(q)) return allow();
  const files = Array.from(new Set(fs.readFileSync(q, 'utf8').split('\n').filter(Boolean)));
  fs.unlinkSync(q);
  if (!files.length) return allow();
  run(`ktlint --format ${files.map((f) => JSON.stringify(f)).join(' ')}`, { cwd: cfg.root, timeout: 60000 });
  allow();
}

// H13 — remember what failed
function postFailure() {
  const inp = input();
  const { cfg } = ctx(inp);
  const out = (inp.tool_response && (inp.tool_response.stderr || inp.tool_response.stdout)) || inp.error || '';
  const cmd = (inp.tool_input && inp.tool_input.command) || '';
  st.update(cfg, (s) => {
    s.last_failure = `${cmd}: ${String(out).split('\n')[0] || 'failed'}`.slice(0, 300);
  });
  allow();
}

// H7 — change-aware stop gate
function stop() {
  const inp = input();
  const { cfg, state } = ctx(inp);
  if (!cfg.stop_gate.enabled || !st.active(state)) return allow();
  if (inp.stop_hook_active && state.stop_blocks >= cfg.stop_gate.max_blocks_per_turn) {
    st.update(cfg, (s) => { s.stop_blocks = 0; });
    return allow();
  }
  const files = verify.changedFiles(cfg);
  const hash = require('crypto').createHash('sha1').update(files.map((f) => {
    try { return f + fs.statSync(path.join(cfg.root, f)).mtimeMs; } catch (e) { return f; }
  }).join('|')).digest('hex');
  const marker = path.join(cfg.root, '.keel', 'last-fast-check');
  const previous = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  if (!files.length || hash === previous) return allow();

  const res = verify.fast(cfg);
  if (res.ok) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, hash);
    st.clearStall(cfg);
    return allow();
  }
  st.recordFailure(cfg, res.raw, res.fingerprint);
  st.update(cfg, (s) => { s.stop_blocks = (s.stop_blocks || 0) + 1; });
  const stalledNow = st.stalled(cfg, st.read(cfg));
  stopBlock(res.report + (stalledNow ? '\n\nThis is the same failure 3 times in a row. Re-read the failure, then ask keel:investigator for a fresh-context diagnosis before trying again.' : ''));
}

// H15 — brief each subagent
function subagentStart() {
  const inp = input();
  const { cfg, state } = ctx(inp);
  const agent = inp.agent_type || inp.subagent_type || '';
  if (!/^keel[:\-]/.test(agent) && !/keel/.test(agent)) return allow();
  if (!st.active(state)) return allow();
  // Record it as running so `keel board` can say what is in flight. Only a start timestamp:
  // the payload carries no instance id, so there is nothing else to key on.
  try { st.agentStart(cfg, agent); } catch (e) { /* the brief matters more than the bookkeeping */ }
  const frozen = {
    red: 'production code (write tests only)',
    green: 'all test files (write production code only)',
    'bug-investigate': 'everything (read-only until Gate F)',
    'hunt-sweep': 'everything — you propose candidates, you never change code',
    'hunt-prove': 'everything but .keel/hunt/ — you prove the finding, you never fix it',
  }[state.phase] || 'files outside this phase';
  const required = (CONTRACTS[agent] || {}).label || 'a single result line';
  // A subagent does not inherit the parent's loaded skills, so the brief names what to
  // load — otherwise the per-phase resolution only ever reaches the main session.
  say([`keel brief: phase ${state.phase}, AC ${state.current || '-'}${state.spec ? ', spec ' + state.spec : ''}`,
    `frozen: ${frozen}`,
    skillLine(cfg, state),
    `finish with: ${required}`].filter(Boolean).join('\n'));
}

// One table, holding the label an agent is told to finish with and the pattern the stop hook
// looks for. These used to be two objects that had to agree, with nothing asserting they did —
// and three agents fell out of the second one without anything noticing, so
// keel:security-auditor, keel:dependency-triager and keel:reproducer each declared a result
// line in their body that no hook ever asked for. A scenario now checks the table against the
// agent files, so the class of bug is gone rather than this instance of it.
const CONTRACTS = {
  'keel:reviewer': { label: 'BLOCKING: yes|no', re: /BLOCKING:\s*(yes|no)/i },
  'keel:investigator': { label: 'ROOT-CAUSE: confirmed|unconfirmed', re: /ROOT-CAUSE:\s*(confirmed|unconfirmed)/i },
  'keel:e2e-author': { label: 'E2E-RESULT: pass|fail', re: /E2E-RESULT:\s*(pass|fail)/i },
  'keel:implementer': { label: 'GREEN-RESULT: pass|stalled', re: /GREEN-RESULT:\s*(pass|stalled)/i },
  'keel:test-author': { label: 'RED-RESULT: failing|unexpected-pass', re: /RED-RESULT:\s*(failing|unexpected-pass)/i },
  'keel:lane-runner': { label: 'LANE-RESULT: done|stopped', re: /LANE-RESULT:\s*(done|stopped)/i },
  'keel:explorer': { label: 'MAP-END', re: /MAP-END/ },
  'keel:setup-doctor': { label: 'DIAGNOSIS: fixable|needs-you|unknown', re: /DIAGNOSIS:\s*(fixable|needs-you|unknown)/i },
  'keel:arch-surveyor': { label: 'ARCH: <style> <confidence>', re: /ARCH:\s*\w+/i },
  'keel:security-auditor': { label: 'SECURITY: clean|findings', re: /SECURITY:\s*(clean|findings)/i },
  'keel:dependency-triager': { label: 'DEPS: clean|findings', re: /DEPS:\s*(clean|findings)/i },
  'keel:reproducer': { label: 'REPRO: confirmed|not-reproducible', re: /REPRO:\s*(confirmed|not-reproducible)/i },
};

// H8 — subagent result contract
function subagentStop() {
  const inp = input();
  const agent = inp.agent_type || inp.subagent_type || '';
  // This hook never resolved cwd before, so it could not reach state at all. It needs to
  // now: an agent that starts and never clears would be reported as running forever.
  try {
    if (agent) st.agentStop(ctx(inp).cfg, agent);
  } catch (e) { /* the result contract below still applies */ }
  const contract = CONTRACTS[agent];
  if (!contract) return allow();
  // Both sources, never the first truthy one. `last_message` can be a tool-use turn or a
  // truncated value, and short-circuiting on it made the block unescapable: the agent wrote
  // its result line every turn and the hook never looked at the transcript that held it.
  const text = [inp.last_message || '', lastAssistant(inp.transcript_path) || ''].join('\n');
  if (contract.re.test(text)) return allow();
  // Advice, not `decision: block`. A block is satisfied most cheaply by replying with the
  // marker alone — and that reply REPLACES the agent's result, so enforcing the contract
  // destroyed the very findings it was protecting. A missing marker is a formatting miss;
  // a lost review is not a fair price for it.
  say([`keel: ${agent} should end with its result line (${contract.label}).`,
    'Repeat your full findings, then end with that line — this reply replaces your result,',
    'so anything you leave out is lost.'].join('\n'));
}
function lastAssistant(p) {
  if (!p || !fs.existsSync(p)) return '';
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const e = JSON.parse(lines[i]);
      const content = e && e.message && e.message.content;
      if (e.type === 'assistant' && content) {
        // Keep scanning. A tool-use-only turn is a non-empty array, so the old truthiness
        // guard returned '' from it and never reached the turn that held the result line —
        // which blocked agents that had complied, and cost them their findings.
        const t = (Array.isArray(content) ? content : [content]).map((c) => c.text || '').join('\n');
        if (t.trim()) return t;
      }
    }
  } catch (e) { /* ignore */ }
  return '';
}

// H14 — a frozen test file changed on disk by any route
function fileChanged() {
  const inp = input();
  const { cfg, state } = ctx(inp);
  if (!st.active(state)) return allow();
  const files = inp.files || (inp.file_path ? [inp.file_path] : []);
  const offending = [];
  for (const f of files) {
    const v = guards.checkEdit(cfg, state, f);
    if (!v.ok) offending.push(v.reason);
  }
  if (!offending.length) return allow();
  st.update(cfg, (s) => { s.last_failure = 'frozen file changed: ' + offending[0].slice(0, 200); });
  block(['a file that is frozen in this phase changed on disk:', ...offending.slice(0, 5),
    'Revert it, or change phase deliberately. `keel commit` will refuse it either way.'].join('\n'));
}

// H9 — desktop notification when keel is waiting for the user
function notify() {
  const inp = input();
  const { cfg, state } = ctx(inp);
  if (!(cfg.notify && cfg.notify.enabled)) return allow();
  const message = String(inp.message || 'Claude is waiting').replace(/"/g, "'").slice(0, 120);
  const title = `keel: ${state.phase || 'idle'}`;
  if (process.platform === 'darwin') {
    run(`osascript -e 'display notification "${message}" with title "${title}"'`, { timeout: 3000 });
  } else {
    run(`notify-send ${JSON.stringify(title)} ${JSON.stringify(message)}`, { timeout: 3000 });
  }
  allow();
}

function dispatch(event) {
  switch (event) {
    case 'session-start': return sessionStart();
    case 'pre-tool': return preTool();
    case 'post-tool': return postTool();
    case 'post-batch': return postBatch();
    case 'post-failure': return postFailure();
    case 'stop': return stop();
    case 'subagent-start': return subagentStart();
    case 'subagent-stop': return subagentStop();
    case 'file-changed': return fileChanged();
    case 'notify': return notify();
    default: return allow();
  }
}

// nextStep is exported for the board: it is the one line the user acts on, and it was
// module-private, so only the session brief could ever show it.
module.exports = { dispatch, matchesAnyCommand, nextStep, CONTRACTS };
