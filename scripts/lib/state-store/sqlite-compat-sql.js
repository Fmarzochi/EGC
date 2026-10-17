'use strict';

// The SQL text helpers of the portable engine: how a text splits into
// statements, which statements write, which pragmas only the native engine
// understands, how parameters are bound and where a transaction begins and
// ends. Pure functions over strings, no engine involved.

// Pragmas that only mean something to the native engine (WAL, busy
// timeout, synchronous) are dropped from the text before sql.js sees it.
const SKIPPED_PRAGMA = /^PRAGMA[ \t]+(?:journal_mode|busy_timeout|synchronous)\b/i;
// A trimmed statement counts as a plain read only when it is a SELECT, an
// EXPLAIN, or a bare pragma from the allowlist of value-reporting pragmas.
// Everything else (writes, DDL, ANALYZE, VACUUM, value-setting pragmas,
// PRAGMA optimize, any CTE, any pragma not on the list) reaches the file; a
// read misclassified as a write costs one extra save and nothing more.
const REPORTING_PRAGMA = /^PRAGMA[ \t]+(?:user_version|schema_version|application_id|journal_mode|synchronous|foreign_keys|busy_timeout|page_size|page_count|freelist_count|integrity_check|quick_check|compile_options|database_list|table_list|collation_list|encoding)$/i;
const READ_ONLY_STATEMENT = /^(?:SELECT\b|EXPLAIN\b)/i;

const QUOTED_LITERAL = /'(?:[^']|'')*'|"(?:[^"]|"")*"/g;
const CREATE_TRIGGER = /\bCREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?TRIGGER\b/i;
const BLOCK_KEYWORD = /\b(?:BEGIN|CASE|END)\b/gi;

// A CREATE TRIGGER statement carries its own statements between BEGIN and
// END, each ended by a semicolon. The piece is still open while that block
// (and any CASE ... END inside it) has not been closed.
function triggerBodyOpen(piece) {
  const bare = piece.replace(QUOTED_LITERAL, ' ');
  if (!CREATE_TRIGGER.test(bare)) return false;
  let depth = 0;
  for (const word of bare.match(BLOCK_KEYWORD) || []) {
    depth += /^END$/i.test(word) ? -1 : 1;
  }
  return depth > 0;
}

// Splits SQL text into statements on the semicolons that sit outside
// single- and double-quoted literals and outside a trigger body, so a
// literal such as 'PRAGMA synchronous = NORMAL;' stays part of its SELECT
// and a CREATE TRIGGER ... BEGIN ...; ...; END stays one statement instead
// of ending in a bare END that reads as the end of a transaction. Joining
// the pieces back with ';' reproduces the original text exactly.
function splitStatements(sql) {
  const pieces = [];
  let start = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ';') {
      const piece = sql.slice(start, i);
      if (triggerBodyOpen(piece)) continue;
      pieces.push(piece);
      start = i + 1;
    }
  }
  pieces.push(sql.slice(start));
  return pieces;
}

function isReadOnly(statement) {
  const trimmed = statement.trim();
  return trimmed === '' || READ_ONLY_STATEMENT.test(trimmed) || REPORTING_PRAGMA.test(trimmed);
}

function mutates(sql) {
  return splitStatements(sql).some(statement => !isReadOnly(statement));
}

function withoutSkippedPragmas(sql) {
  return splitStatements(sql).filter(statement => !SKIPPED_PRAGMA.test(statement.trim())).join(';');
}

function namedKey(key) {
  return /^[$:@]/.test(key) ? key : `$${key}`;
}

function nullForUndefined(value) {
  return value ?? null;
}

// The `sqlite` package accepts (sql, a, b), (sql, [a, b]) and (sql, {name}).
// sql.js binds arrays positionally and objects by $name/:name/@name.
function normalizeParams(params) {
  if (params.length === 0) return undefined;
  if (params.length > 1) return params.map(nullForUndefined);
  const only = params[0];
  if (Array.isArray(only)) return only.map(nullForUndefined);
  if (only && typeof only === 'object' && !(only instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(only).map(([key, value]) => [namedKey(key), nullForUndefined(value)]));
  }
  return [nullForUndefined(only)];
}

function consumeQuotedLiteral(sql, start, len) {
  const q = sql[start];
  let res = q;
  let i = start + 1;
  while (i < len && sql[i] !== q) {
    res += sql[i];
    i += 1;
  }
  if (i < len) {
    res += sql[i];
    i += 1;
  }
  return { text: res, nextIndex: i };
}

function skipComment(sql, start) {
  if (sql[start] === '-' && sql[start + 1] === '-') {
    const nl = sql.indexOf('\n', start + 2);
    return nl === -1 ? sql.length : nl + 1;
  }
  if (sql[start] === '/' && sql[start + 1] === '*') {
    const end = sql.indexOf('*/', start + 2);
    return end === -1 ? sql.length : end + 2;
  }
  return -1;
}

function stripSqlComments(sql) {
  let res = '';
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const nextComment = skipComment(sql, i);
    if (nextComment !== -1) {
      if (nextComment >= len) break;
      i = nextComment;
    } else if (sql[i] === '\'' || sql[i] === '"') {
      const quoted = consumeQuotedLiteral(sql, i, len);
      res += quoted.text;
      i = quoted.nextIndex;
    } else {
      res += sql[i];
      i += 1;
    }
  }
  return res.replace(/\s+/g, ' ').trim();
}

function isBeginStatement(clean) {
  return /^BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?$/i.test(clean);
}

function isCommitStatement(clean) {
  return /^(?:COMMIT|END)(?:\s+(?:TRANSACTION|WORK))?$/i.test(clean);
}

function isRollbackStatement(clean) {
  return /^ROLLBACK(?:\s+(?:TRANSACTION|WORK))?$/i.test(clean);
}

function parseTransactionBounds(pieces) {
  const isBeginStmt = (s) => isBeginStatement(stripSqlComments(s));
  const isCommitStmt = (s) => isCommitStatement(stripSqlComments(s));
  const isRollbackStmt = (s) => isRollbackStatement(stripSqlComments(s));

  const firstStmt = pieces[0];
  const lastStmt = pieces[pieces.length - 1];

  return {
    isBeginFirst: isBeginStmt(firstStmt),
    hasCommitOrRollback: pieces.some(s => isCommitStmt(s) || isRollbackStmt(s)),
    isCommitLast: isCommitStmt(lastStmt),
    isRollbackLast: isRollbackStmt(lastStmt),
  };
}

module.exports = { splitStatements, mutates, withoutSkippedPragmas, normalizeParams, stripSqlComments, parseTransactionBounds };
