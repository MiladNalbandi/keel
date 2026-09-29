'use strict';
// The database schema, read out of the migration files in the order they are applied.
//
// Migrations are the only schema keel can read without connecting to anything, and `keel map` must
// never connect. So the model here is "what the migrations say the schema became", not "what is in
// the database" — a project whose tables come from an ORM's ddl-auto, or from a Liquibase XML
// changelog, gets nothing and is told so rather than shown an empty diagram.
const fs = require('fs');
const path = require('path');

const RE = {
  create: /create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?(?:\w+\.)?(\w+)["`]?\s*\(/i,
  alterAdd: /alter\s+table\s+["`]?(?:\w+\.)?(\w+)["`]?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?["`]?(\w+)["`]?\s+([^,;]+)/i,
  alterFk: /alter\s+table\s+["`]?(?:\w+\.)?(\w+)["`]?\s+add\s+constraint\s+\w+\s+foreign\s+key\s*\(\s*["`]?(\w+)["`]?\s*\)\s*references\s+["`]?(?:\w+\.)?(\w+)["`]?/i,
  drop: /drop\s+table\s+(?:if\s+exists\s+)?["`]?(?:\w+\.)?(\w+)["`]?/i,
  column: /^["`]?(\w+)["`]?\s+(.+)$/,
  references: /references\s+["`]?(?:\w+\.)?(\w+)["`]?\s*(?:\(\s*["`]?(\w+)["`]?\s*\))?/i,
};

const NOT_A_COLUMN = /^(primary|foreign|unique|constraint|check|key|index|exclude)\b/i;

function migrationDir(cfg) {
  return path.join(cfg.root, cfg.backend.dir || '', cfg.backend.migrations || '');
}

function files(cfg) {
  const dir = migrationDir(cfg);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /\.sql$/i.test(f)); } catch (e) { return []; }
  // Applied in name order, which is what every migration tool this targets does.
  return names.sort().map((f) => ({ name: f, abs: path.join(dir, f) }));
}

// One column per line is the shape every migration this reads is written in. Two columns declared
// on one line are missed, and that is in the stated limits rather than worked around: guessing
// where one declaration ends and the next begins needs a SQL parser.
function columnsOf(body, table, fks) {
  const cols = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/,$/, '');
    if (!line || line.startsWith('--')) continue;
    if (NOT_A_COLUMN.test(line)) {
      const pk = line.match(/primary\s+key\s*\(\s*["`]?(\w+)["`]?/i);
      if (pk) { const c = cols.find((x) => x.name === pk[1]); if (c) c.pk = true; }
      const fk = line.match(/foreign\s+key\s*\(\s*["`]?(\w+)["`]?\s*\)\s*references\s+["`]?(?:\w+\.)?(\w+)["`]?/i);
      if (fk) fks.push({ from: table, column: fk[1], to: fk[2] });
      continue;
    }
    const m = line.match(RE.column);
    if (!m) continue;
    const rest = m[2];
    const col = { name: m[1], type: rest.split(/\s+/)[0], pk: /primary\s+key/i.test(rest), fk: null };
    const ref = rest.match(RE.references);
    if (ref) { col.fk = ref[1]; fks.push({ from: table, column: col.name, to: ref[1] }); }
    cols.push(col);
  }
  return cols;
}

// Split a `create table x ( … );` body off the text, counting parens so a `numeric(10,2)` or a
// nested check constraint does not end the table early.
function bodyAt(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  return '';
}

function tables(cfg) {
  const out = { dir: path.join(cfg.backend.dir || '', cfg.backend.migrations || ''), tables: [], files: [], skipped: [] };
  const list = files(cfg);
  if (!list.length) {
    out.skipped.push(`no .sql migrations under ${out.dir || 'the configured migrations directory'}`);
    return out;
  }
  const byName = new Map();
  for (const f of list) {
    out.files.push(path.relative(cfg.root, f.abs));
    let text = '';
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch (e) { continue; }
    const rel = path.relative(cfg.root, f.abs);
    const lines = text.split('\n');

    // CREATE TABLE, with the line it is declared on so the node can cite it.
    let idx = 0;
    while (idx < text.length) {
      const slice = text.slice(idx);
      const m = slice.match(RE.create);
      if (!m) break;
      const at = idx + slice.indexOf(m[0]);
      const open = at + m[0].length - 1;
      const name = m[1];
      const line = text.slice(0, at).split('\n').length;
      const fks = [];
      const cols = columnsOf(bodyAt(text, open), name, fks);
      byName.set(name, { name, columns: cols, fks, cite: { rel, line } });
      idx = open + 1;
    }

    // ALTER TABLE, applied in file order so a later migration wins.
    for (let i = 0; i < lines.length; i++) {
      const add = lines[i].match(RE.alterAdd);
      if (add && byName.has(add[1])) {
        const t = byName.get(add[1]);
        if (!t.columns.some((c) => c.name === add[2])) {
          t.columns.push({ name: add[2], type: add[3].trim().split(/\s+/)[0], pk: false, fk: null });
        }
      }
      const fk = lines[i].match(RE.alterFk);
      if (fk && byName.has(fk[1])) byName.get(fk[1]).fks.push({ from: fk[1], column: fk[2], to: fk[3] });
      const gone = lines[i].match(RE.drop);
      if (gone) byName.delete(gone[1]);
    }
  }
  out.tables = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

module.exports = { tables, migrationDir };
