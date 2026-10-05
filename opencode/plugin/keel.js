// keel's enforcement, for OpenCode.
//
// keel's guards were never coupled to Claude Code. `keel hook pre-tool` reads a JSON object on
// stdin and answers with an exit code — 0 allows, 2 denies and puts the reason on stderr. That is
// the whole contract, so this file is a translator and nothing more: it renames OpenCode's tool
// and argument names to the ones the hook already understands, and turns exit 2 into the thrown
// error OpenCode uses to refuse a call. No rule lives here. A rule that lived in two harnesses
// would drift, and the copy the user is being judged by would be the wrong one.

import { spawnSync } from 'node:child_process';

// OpenCode's tool names, mapped to the ones `keel hook pre-tool` already branches on. Tools absent
// from this table are not guarded by keel in any harness (grep, glob, webfetch, todowrite) and are
// passed through untouched rather than guessed at.
const TOOL = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  apply_patch: 'Edit',
  bash: 'Bash',
};

// Seven of keel's eighteen agents can write. OpenCode's `tool.execute.before` does not fire for
// tool calls made *by* a subagent (open upstream against 1.0.182), so a write that happens inside
// one is unguarded — the single guarantee keel exists to make, gone. The `task` call itself is made
// by the primary agent, so this hook *does* see it, and refusing it here is what keeps every write
// on the agent the guards can still reach.
const WRITERS = new Set([
  'e2e-author', 'implementer', 'lane-runner', 'librarian', 'prover', 'reproducer', 'test-author',
  'ticket-reviewer',
]);

// Split on whitespace: KEEL_BIN is as likely to be `bun run keel` or `node /path/to/bin/keel` as a
// bare executable, and spawnSync takes the whole string as one filename — which fails ENOENT, and
// this adapter then refuses every call because an unrunnable keel is not an allowance.
function keelCmd(extra) {
  const parts = String(process.env.KEEL_BIN || 'keel').trim().split(/\s+/).filter(Boolean);
  return { bin: parts[0], args: parts.slice(1).concat(extra) };
}

// A file path per patch stanza. Both spellings are here because OpenCode's apply_patch has used
// the `*** Update File:` envelope and plain unified-diff headers; parsing only one would silently
// return nothing for the other, and nothing means "no file to check".
function patchPaths(patchText) {
  const out = new Set();
  for (const line of String(patchText || '').split('\n')) {
    let m = line.match(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/);
    if (m) { out.add(m[1]); continue; }
    m = line.match(/^\+\+\+\s+(?:b\/)?(.+?)\s*$/);
    if (m && m[1] !== '/dev/null') out.add(m[1]);
  }
  return [...out];
}

// One hook invocation. Returns null when the call is allowed, or the reason it is not.
function ask(toolName, toolInput, cwd) {
  const c = keelCmd(['hook', 'pre-tool']);
  const r = spawnSync(c.bin, c.args, {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }),
    encoding: 'utf8',
  });
  // keel not installed, or not on PATH. Failing open here would be the worst of both worlds: the
  // flow would look enforced and not be. Say which it is and stop.
  if (r.error || r.status === null) {
    return `keel could not be run (${r.error ? r.error.message : 'no exit status'}).\n`
      + 'The guards are not enforced until this is fixed. Install keel, or set KEEL_BIN to its path.';
  }
  if (r.status === 2) return (r.stderr || '').replace(/^keel:\s*/, '').trim() || 'refused by keel';
  // Any other non-zero is a fault in the hook, not a verdict. Same reasoning as above.
  if (r.status !== 0) {
    return `keel hook exited ${r.status}: ${(r.stderr || r.stdout || '').trim()}\n`
      + 'Treated as a refusal because an unreadable verdict is not an allowance.';
  }
  return null;
}

function flowActive(cwd) {
  const c = keelCmd(['state', 'show']);
  const r = spawnSync(c.bin, c.args, { encoding: 'utf8', cwd });
  if (r.status !== 0) return null;
  try {
    const s = JSON.parse(r.stdout);
    return s && s.flow ? s : null;
  } catch (e) { return null; }
}

export const keel = async ({ directory, worktree }) => {
  const cwd = worktree || directory || process.cwd();

  return {
    'tool.execute.before': async (input, output) => {
      const tool = String(input && input.tool || '');
      const args = (output && output.args) || {};

      // Keep every write on the primary agent, where the guards still reach it.
      if (tool === 'task') {
        const wanted = String(args.subagent_type || args.agent || args.subagentType || '');
        const name = wanted.replace(/^keel[:/-]/, '');
        if (WRITERS.has(name) && flowActive(cwd)) {
          throw new Error(
            `keel: ${name} writes files, and OpenCode does not run keel's guards inside a subagent — `
            + 'so its writes would not be checked against the phase.\n'
            + 'Do this work on the primary agent instead. Read-only keel agents (explorer, reviewer, '
            + 'investigator, hunter, security-auditor, arch-surveyor, code-reviewer, ac-reviewer, '
            + 'dependency-triager, setup-doctor, bulk-reader) are fine to spawn.'
          );
        }
        return;
      }

      const mapped = TOOL[tool];
      if (!mapped) return;

      // apply_patch names its files inside the patch body. If none can be read out, keel has
      // nothing to check — and a phase keel cannot check is one it refuses, the same way a phase
      // with no row in the guard matrix fails closed rather than falling back to allow-all.
      if (tool === 'apply_patch') {
        const paths = patchPaths(args.patchText);
        if (!paths.length) {
          throw new Error(
            'keel: no file path could be read out of this patch, so it cannot be checked against '
            + 'the current phase.\nUse the edit or write tool, which name their file directly.'
          );
        }
        for (const file of paths) {
          const reason = ask('Edit', { file_path: file }, cwd);
          if (reason) throw new Error(`keel: ${reason}`);
        }
        return;
      }

      const toolInput = mapped === 'Bash'
        ? { command: args.command }
        : { file_path: args.filePath || args.path };

      // Nothing to identify means nothing to check; the hook itself allows this case.
      if (mapped !== 'Bash' && !toolInput.file_path) return;

      const reason = ask(mapped, toolInput, cwd);
      if (reason) throw new Error(`keel: ${reason}`);
    },

    // The same journal the Claude Code side writes, so `keel board` and the dashboard read one
    // timeline whichever harness produced it.
    'tool.execute.after': async (input, output) => {
      const tool = String(input && input.tool || '');
      const args = (output && output.args) || {};
      if (!TOOL[tool]) return;
      const c = keelCmd(['hook', 'log-tool']);
      spawnSync(c.bin, c.args, {
        input: JSON.stringify({
          tool_name: TOOL[tool],
          tool_input: tool === 'bash' ? { command: args.command } : { file_path: args.filePath },
          cwd,
        }),
        encoding: 'utf8',
      });
    },
  };
};
