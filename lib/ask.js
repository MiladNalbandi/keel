'use strict';
// Questions keel must not proceed past.
//
// Every other "approval" in keel is a token the model writes on its own initiative: `keel gate`
// never reads stdin, and no hook can observe an AskUserQuestion, so nothing here can prove a human
// answered. What this buys instead is that a question becomes a recorded artifact with
// consequences — unanswered blocks work, the answer is attributed and dated, and the runbook and
// the board report who answered. A self-answer is allowed and is visible as one. That is worth
// having; calling it human verification would not be.
//
// Storage is its own file, not setup.json and not state.json. `keel ladder` overwrites setup.json
// wholesale on every run, which would destroy the questions the ladder itself raised; `state start`
// resets state.json, and "is this a git repository" has to outlive a flow.
const path = require('path');
const { readJson, writeJson } = require('./util');

const BY = ['user', 'model', 'config'];

function file(cfg) { return path.join(cfg.root, '.keel', 'questions.json'); }
function read(cfg) { return readJson(file(cfg), { questions: {} }); }
function write(cfg, data) { writeJson(file(cfg), data); return data; }

function list(cfg) { return Object.values(read(cfg).questions || {}); }
function pending(cfg) { return list(cfg).filter((q) => q.answer === null || q.answer === undefined); }
// What refuses work: a question that is both blocking and unanswered.
function blockers(cfg) { return pending(cfg).filter((q) => q.blocking); }

// Raising is idempotent and never clears an answer: a rung that raises the same question on every
// run must not un-answer it, or the ladder would ask forever.
function raise(cfg, id, opts = {}) {
  if (!id) return { ok: false, out: 'usage: keel ask <id> --question "…" [--because "…"] [--blocking]', usage: true };
  if (!opts.question || opts.question === true) {
    return { ok: false, out: 'usage: keel ask <id> --question "…" [--because "…"] [--blocking]', usage: true };
  }
  const data = read(cfg);
  data.questions = data.questions || {};
  const existing = data.questions[id];
  if (existing && existing.answer) {
    return { ok: true, out: `${id} is already answered (${existing.answered_by}): ${existing.answer}`, already: true };
  }
  data.questions[id] = {
    id,
    question: String(opts.question),
    because: opts.because && opts.because !== true ? String(opts.because) : null,
    blocking: opts.blocking ? true : !!(existing && existing.blocking),
    raised_by: opts.by && opts.by !== true ? String(opts.by) : (existing && existing.raised_by) || 'unknown',
    raised_at: (existing && existing.raised_at) || new Date().toISOString(),
    answer: null, answered_at: null, answered_by: null,
  };
  write(cfg, data);
  const q = data.questions[id];
  return { ok: true, out: [`${q.blocking ? 'blocking question' : 'question'} ${id}: ${q.question}`,
    q.because ? `  because: ${q.because}` : null,
    `  answer it with: keel ask ${id} --answer "…" --by user`].filter(Boolean).join('\n') };
}

function answer(cfg, id, opts = {}) {
  if (!id || !opts.answer || opts.answer === true) {
    return { ok: false, out: 'usage: keel ask <id> --answer "…" [--by user|model]', usage: true };
  }
  const data = read(cfg);
  const q = (data.questions || {})[id];
  if (!q) return { ok: false, out: `no question "${id}". \`keel ask list\` shows them.` };
  const by = String(opts.by && opts.by !== true ? opts.by : 'model').toLowerCase();
  if (!BY.includes(by)) return { ok: false, out: `--by must be one of ${BY.join(', ')}.` };
  q.answer = String(opts.answer);
  q.answered_at = new Date().toISOString();
  q.answered_by = by;
  write(cfg, data);
  const left = blockers(cfg).length;
  return { ok: true, out: [`${id} answered${by === 'model' ? ' by the model itself — this is recorded as a self-answer' : ` by the ${by}`}: ${q.answer}`,
    left ? `${left} blocking question(s) still unanswered.` : 'nothing is blocked now.'].join('\n') };
}

function clear(cfg, id) {
  if (!id) return { ok: false, out: 'usage: keel ask clear <id>', usage: true };
  const data = read(cfg);
  if (!(data.questions || {})[id]) return { ok: false, out: `no question "${id}".` };
  delete data.questions[id];
  write(cfg, data);
  return { ok: true, out: `cleared ${id}.` };
}

function render(cfg, opts = {}) {
  const rows = opts.pending ? pending(cfg) : list(cfg);
  if (!rows.length) return { ok: true, out: opts.pending ? 'no questions pending.' : 'no questions recorded.' };
  const lines = [];
  for (const q of rows.sort((a, b) => (b.blocking - a.blocking) || a.id.localeCompare(b.id))) {
    lines.push(`${q.answer ? 'answered' : q.blocking ? 'BLOCKING' : 'open    '}  ${q.id}  ${q.question}`);
    if (q.because && !q.answer) lines.push(`          because: ${q.because}`);
    if (q.answer) lines.push(`          ${q.answered_by}: ${q.answer}`);
  }
  return { ok: true, out: lines.join('\n') };
}

// The refusal every gated command prints. One shape, so a blocked ladder and a blocked
// `memory update` read the same and name the same way out.
function refusal(cfg) {
  const b = blockers(cfg);
  if (!b.length) return null;
  const lines = [`${b.length} blocking question(s) must be answered first:`];
  for (const q of b) {
    lines.push('', `  ${q.id}: ${q.question}`);
    if (q.because) lines.push(`    because: ${q.because}`);
    lines.push(`    keel ask ${q.id} --answer "…" --by user`);
  }
  return lines.join('\n');
}

module.exports = { file, read, list, pending, blockers, raise, answer, clear, render, refusal, BY };
