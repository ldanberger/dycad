// ddl.js — Data Modeling's DDL import/export: a hand-written parser/generator for a
// deliberately SCOPED subset of SQL DDL (MySQL/Postgres-flavored `CREATE TABLE`), not a
// general SQL grammar. No npm packages are allowed in this project (see CLAUDE.md), so
// this is a small recursive-descent-ish parser built directly on string scanning —
// intentionally simple over exhaustive: anything outside the supported subset is
// reported back as a genuine parse error (per this project's "name the specific rule"
// convention for rejection messages), not silently dropped or guessed at.
//
// Supported subset, per statement (one `CREATE TABLE ... ;` per table):
//   CREATE TABLE [IF NOT EXISTS] name (
//     col_name TYPE[(args)] [NOT NULL] [PRIMARY KEY],
//     ...,
//     [CONSTRAINT constraint_name] PRIMARY KEY (col[, col...]),
//     [CONSTRAINT constraint_name] FOREIGN KEY (col) REFERENCES other_table(other_col)
//   );
// Table/column names may be unquoted, double-quoted, backtick-quoted, or
// square-bracket-quoted (covers Postgres/MySQL/SQL Server's own quoting conventions).
// `--` line comments and `/* */` block comments are stripped before parsing. Anything
// else at the top level (CREATE INDEX, ALTER TABLE, etc.) is skipped, not an error —
// only a malformed CREATE TABLE body is reported as one.

/** Strips `--`-style line comments and slash-star-delimited block comments. */
function stripComments(text) {
  return text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Removes surrounding quote characters (double-quote, backtick, or square brackets)
 * from an identifier, if present. */
function unquoteIdent(raw) {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('`') && s.endsWith('`'))) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1);
  return s;
}

/** Splits `str` on `delimiter` characters that sit at PAREN DEPTH ZERO only — so a
 * column list like "id INT, price DECIMAL(10,2), FOREIGN KEY (a) REFERENCES b(c)"
 * splits into exactly 3 column/constraint entries, not fragments broken apart by the
 * commas INSIDE DECIMAL(10,2) or REFERENCES b(c). Also respects quote characters so a
 * comma inside a quoted identifier isn't treated as a delimiter either. */
function splitTopLevel(str, delimiter) {
  const parts = [];
  let depth = 0, current = '', quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }
    if (ch === delimiter && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\]\w.]+)\s*\(([\s\S]*)\)\s*$/i;
const PRIMARY_KEY_ENTRY_RE = /^(?:CONSTRAINT\s+[`"[\]\w]+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i;
const FOREIGN_KEY_ENTRY_RE = /^(?:CONSTRAINT\s+[`"[\]\w]+\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([`"[\]\w.]+)\s*\(([^)]*)\)/i;
const COLUMN_ENTRY_RE = /^([`"[\]\w]+)\s+([\w]+(?:\s*\([^)]*\))?)(.*)$/i;

/** Parses one `CREATE TABLE` statement's already-comment-stripped body (everything
 * between the outer parens) into { columns, foreignKeys }. Throws with a specific
 * message (naming the exact entry that didn't parse) rather than silently skipping —
 * per this project's rejection-message convention, a person fixing their DDL needs to
 * know WHICH line is the problem, not just that import produced fewer tables than
 * expected. */
function parseTableBody(tableName, body) {
  const columns = [];
  const foreignKeys = [];
  for (const entry of splitTopLevel(body, ',')) {
    const pk = entry.match(PRIMARY_KEY_ENTRY_RE);
    if (pk) {
      const pkCols = pk[1].split(',').map((c) => unquoteIdent(c));
      for (const col of columns) if (pkCols.some((c) => c.toLowerCase() === col.name.toLowerCase())) col.isPrimaryKey = true;
      continue;
    }
    const fk = entry.match(FOREIGN_KEY_ENTRY_RE);
    if (fk) {
      const fromColumn = unquoteIdent(fk[1].split(',')[0]); // single-column FKs only (this subset's scope)
      foreignKeys.push({ fromTable: tableName, fromColumn, toTable: unquoteIdent(fk[2]), toColumn: unquoteIdent(fk[3].split(',')[0]) });
      continue;
    }
    const col = entry.match(COLUMN_ENTRY_RE);
    if (!col) throw new Error(`Table "${tableName}": could not parse column/constraint entry: "${entry.trim()}"`);
    const rest = col[3].toUpperCase();
    columns.push({
      name: unquoteIdent(col[1]),
      dataType: col[2].replace(/\s+/g, ''),
      nullable: !/\bNOT\s+NULL\b/.test(rest),
      isPrimaryKey: /\bPRIMARY\s+KEY\b/.test(rest),
    });
  }
  return { columns, foreignKeys };
}

/** Parses DDL text into { tables: [{name, columns}], foreignKeys: [{fromTable,
 * fromColumn, toTable, toColumn}] } (table-level and inline column-level PRIMARY KEYs
 * both collapse into each column's own `isPrimaryKey`; FOREIGN KEYs are collected
 * globally across all tables since they can only be resolved once every table's own
 * columns are known). Throws Error on the first statement outside the supported
 * subset, with a message identifying which table/entry -- never silently drops or
 * guesses at malformed input. */
function parseDDL(text) {
  const cleaned = stripComments(text);
  const statements = splitTopLevel(cleaned, ';');
  const tables = [];
  const foreignKeys = [];
  for (const stmt of statements) {
    const m = stmt.match(CREATE_TABLE_RE);
    if (!m) continue; // not a CREATE TABLE statement -- silently skipped (in-scope: CREATE INDEX, ALTER TABLE, etc.)
    const tableName = unquoteIdent(m[1]);
    if (tables.some((t) => t.name.toLowerCase() === tableName.toLowerCase())) {
      throw new Error(`Duplicate table name "${tableName}" -- each CREATE TABLE must have a unique name`);
    }
    const { columns, foreignKeys: tableFks } = parseTableBody(tableName, m[2]);
    if (columns.length === 0) throw new Error(`Table "${tableName}": no columns found`);
    tables.push({ name: tableName, columns });
    foreignKeys.push(...tableFks);
  }
  if (tables.length === 0) throw new Error('No CREATE TABLE statements found in the given text.');
  return { tables, foreignKeys };
}

/** Quotes an identifier only if it needs it (contains a space or isn't a plain
 * word) -- keeps generated DDL readable for the common case. */
function quoteIdentIfNeeded(name) {
  return /^\w+$/.test(name) ? name : `"${name}"`;
}

/** Generates DDL text from a set of DataEntityDetails parts (each with its own
 * `.attributes`) and the 'd' connectors between them -- the reverse of parseDDL.
 * `parts` and `conns` are already-filtered arrays (the caller decides scope: current
 * view vs whole model), keeping this function itself scope-agnostic. Column order
 * within each table matches the order attributes are stored in (the same order shown
 * in the attribute-list editor), and PRIMARY KEY / FOREIGN KEY are emitted as
 * table-level constraints (clearer to read back than inline column modifiers once a
 * table has more than one of either). */
function generateDDL(parts, conns) {
  const partById = new Map(parts.map((p) => [p.id, p]));
  const lines = [];
  for (const part of parts) {
    const tableName = quoteIdentIfNeeded(part.label);
    const attrs = part.attributes || [];
    const columnLines = attrs.map((a) => {
      const notNull = a.nullable ? '' : ' NOT NULL';
      return `  ${quoteIdentIfNeeded(a.name || '(unnamed)')} ${a.dataType || 'TEXT'}${notNull}`;
    });
    const pkCols = attrs.filter((a) => a.isPrimaryKey).map((a) => quoteIdentIfNeeded(a.name || '(unnamed)'));
    if (pkCols.length) columnLines.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
    for (const conn of conns) {
      if (conn.connectorType !== 'd' || conn.from !== part.id || !conn.fromAttribute) continue;
      const toPart = partById.get(conn.to);
      const fromAttr = attrs.find((a) => a.id === conn.fromAttribute);
      const toAttr = toPart ? (toPart.attributes || []).find((a) => a.id === conn.toAttribute) : null;
      if (!fromAttr || !toPart || !toAttr) continue; // dangling reference (edited/deleted since the connector was made) -- skipped, not fabricated
      columnLines.push(`  FOREIGN KEY (${quoteIdentIfNeeded(fromAttr.name)}) REFERENCES ${quoteIdentIfNeeded(toPart.label)}(${quoteIdentIfNeeded(toAttr.name)})`);
    }
    lines.push(`CREATE TABLE ${tableName} (\n${columnLines.join(',\n')}\n);`);
  }
  return lines.join('\n\n');
}

export { parseDDL, generateDDL, splitTopLevel };
