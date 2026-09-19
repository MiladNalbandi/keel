'use strict';
// Secret detection. Deliberately narrow: this runs on every Edit and Write, so it has to
// be cheap, and a guard that cries wolf gets switched off. High-signal patterns first,
// entropy only as a backstop on assignment-looking lines.
const PATTERNS = [
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bASIA[0-9A-Z]{16}\b/, 'an AWS temporary access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'an API secret key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, 'a private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, 'a JWT'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/\bpostgres(?:ql)?:\/\/[^\s:@]+:[^\s:@]+@/, 'a database URL with a password in it'],
  [/\bmongodb(?:\+srv)?:\/\/[^\s:@]+:[^\s:@]+@/, 'a MongoDB URL with a password in it'],
];

// A value that looks assigned to a secret-ish name, long enough and mixed enough to be a
// real credential rather than a placeholder.
const ASSIGNMENT = /\b(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|credential|access[_-]?key)\b\s*[:=]\s*["'`]([^"'`\n]{12,})["'`]/i;

const PLACEHOLDER = /^(?:\$\{|\{\{|<|x{3,}|\*{3,}|changeme|placeholder|your[_-]|example|dummy|redacted|todo|null|none|test)/i;

function entropy(s) {
  const counts = {};
  for (const ch of s) counts[ch] = (counts[ch] || 0) + 1;
  let h = 0;
  for (const n of Object.values(counts)) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// Returns [{ line, why }] for content that should not be committed.
function scan(text, opts = {}) {
  const max = opts.maxBytes || 512 * 1024;
  const body = String(text || '');
  if (body.length > max) return [];
  const hits = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 500) continue;
    // An explicit allow marker is how a fixture or a doc keeps a realistic-looking value.
    if (/keel:allow-secret/.test(line)) continue;

    let matched = null;
    for (const [re, why] of PATTERNS) if (re.test(line)) { matched = why; break; }
    if (!matched) {
      const m = line.match(ASSIGNMENT);
      if (m && !PLACEHOLDER.test(m[1]) && entropy(m[1]) > 3.2) {
        matched = 'a high-entropy value assigned to a secret-looking name';
      }
    }
    if (matched) hits.push({ line: i + 1, why: matched });
  }
  return hits;
}

module.exports = { scan, entropy, PATTERNS };
