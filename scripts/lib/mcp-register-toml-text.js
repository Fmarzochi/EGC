'use strict';

let TOML = null;
try {
  TOML = require('@iarna/toml');
} catch {
  // Handled per-call below: falls back to the substring check.
}

// A line that opens a table. Every key after it belongs to that table, and
// TOML offers no way back to the root, so the root-table scan below stops
// here. The key follows TOML's own grammar: dotted parts, each either bare
// or quoted, and a quoted part may hold any character at all (a table named
// after a URL, say). A line like `[1, 2],` inside a multi-line array is not
// a header, because of the comma between its elements.
const TOML_TABLE_HEADER_SHAPE = /^\[\[?(.+?)\]\]?\s*(?:#.*)?$/;
const TOML_KEY_PART = /^(?:"(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)$/;

// Splits a dotted key on the dots that sit outside quotes, so a quoted part
// keeps its own dots (a table named after a URL, say).
function splitDottedKey(key) {
  const parts = [''];
  let quote = null;
  let escaped = false;
  for (const char of key) {
    if (!quote && char === '.') {
      parts.push('');
      continue;
    }
    parts[parts.length - 1] += char;
    if (escaped) {
      escaped = false;
    } else if (quote === '"' && char === '\\') {
      escaped = true;
    } else if (quote && char === quote) {
      quote = null;
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
    }
  }
  return parts;
}

function isTomlTableHeader(line) {
  const shape = TOML_TABLE_HEADER_SHAPE.exec(line);
  return shape !== null && splitDottedKey(shape[1]).every(part => TOML_KEY_PART.test(part.trim()));
}

// The same root key in its three legal spellings: bare, basic-quoted and
// literal-quoted all name `mcp_servers`.
const INLINE_MCP_SERVERS_KEY = /^(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*=\s*\[/;

// Everything from the first `#` onwards is a comment. Cutting there before
// looking for the closing `]` keeps a bracket inside a comment from ending
// the array early: `mcp_servers = [ # ]` with the real bracket on the next
// line is a valid empty array, and stopping at the commented one would
// remove only half of it and leave an orphan `]` behind. A `#` inside a
// quoted string can only occur in an array that has content, and a
// non-empty array never reaches the deletion path, so this can never turn a
// populated array into an apparently empty one.
function stripTomlComment(line) {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

const MULTILINE_DELIMITERS = ['"""', "'''"];

// The delimiter still holding a multi-line string open at the end of this
// line, or null when the line ends outside one. Counting delimiters cannot
// do this: only the delimiter that opened a string closes it, so a `"""`
// inside a `'''` string is content, and a lone `'''` inside a single-line
// basic string opens nothing. Outside a string a `#` starts a comment,
// which is free to mention a delimiter; inside one the same characters are
// content, so the text is only cut where a comment can actually begin.
function multilineDelimiterAfter(line, openDelimiter) {
  let open = openDelimiter;
  let text = open ? line : stripTomlComment(line);
  let from = 0;
  for (;;) {
    if (open) {
      const close = text.indexOf(open, from);
      if (close === -1) return open;
      from = close + open.length;
      open = null;
      text = text.slice(0, from) + stripTomlComment(text.slice(from));
      continue;
    }
    const next = MULTILINE_DELIMITERS
      .map(delimiter => ({ delimiter, at: text.indexOf(delimiter, from) }))
      .filter(candidate => candidate.at !== -1)
      .sort((a, b) => a.at - b.at)[0];
    if (!next) return null;
    open = next.delimiter;
    from = next.at + open.length;
  }
}

// TOML spells `mcp_servers` two ways that cannot be mixed: an array of
// tables ([[mcp_servers]], what registerToml appends) and an inline array
// (mcp_servers = [...]). Once the key exists as an inline array, appending
// an [[mcp_servers]] table makes the whole document invalid — "Cannot mutate
// immutable namespace" — and the tool refuses to start on its next launch.
//
// The distinction only survives in the raw text: @iarna/toml parses both
// forms into a plain JS array, so tomlHasActiveServer cannot see it either
// way.
//
// Mistral Vibe reaches this state on its own: `vibe mcp remove <name>` on
// the last server rewrites the file with `mcp_servers = []` left behind. A
// hand-edited Codex config can reach it too, so the guard is shared.
//
// The scan reads the root table only, skips lines inside a multi-line
// string, accepts the quoted spellings of the key and cuts comments before
// seeking the closing bracket, so what it finds is the real root key and
// nothing that merely looks like one.
//
// A line-based scan has corners whatever it covers, so it is not the last
// word: registerToml re-parses before writing and refuses to turn a file
// that parsed into one that does not.
//
// Returns null when the root key is not an inline array — the normal case,
// including [[mcp_servers]] tables and a file that has no mcp_servers at
// all. Otherwise { start, end, isEmpty }, as inclusive line indices into
// the split content. Anything that cannot be read with confidence is
// reported as non-empty: refusing to touch a file is always safe, appending
// to one that turns out to be occupied is not.
function findInlineMcpServersArray(content) {
  const lines = content.split('\n');
  let openDelimiter = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // A line that opens or closes a multi-line string is itself part of that
    // value, so the state is read as it stood before this line was walked.
    const wasInsideString = openDelimiter !== null;
    openDelimiter = multilineDelimiterAfter(raw, openDelimiter);
    if (wasInsideString) continue;

    const trimmed = raw.trim();
    if (trimmed.startsWith('#')) continue;
    // Past the first table header nothing belongs to the root table any more.
    if (isTomlTableHeader(trimmed)) break;
    const opening = INLINE_MCP_SERVERS_KEY.exec(trimmed);
    if (!opening) continue;

    // Collect forward until the closing bracket: TOML allows the inline
    // array to span lines. A nested `]` (an args array inside an inline
    // table) closes early here, which only ever reports the array as
    // occupied — the conservative answer, and the correct one, since a
    // nested array means the outer one is not empty.
    let body = stripTomlComment(trimmed.slice(opening[0].length));
    let end = i;
    let close = body.indexOf(']');
    while (close === -1 && end + 1 < lines.length) {
      end += 1;
      body += '\n' + stripTomlComment(lines[end]);
      close = body.indexOf(']');
    }
    if (close === -1) {
      // Unterminated: no way to tell what is in there.
      return { start: i, end: lines.length - 1, isEmpty: false };
    }

    const inner = body.slice(0, close);
    const compact = inner.split('\n').map(part => part.trim()).filter(Boolean).join('');
    return { start: i, end, isEmpty: compact === '' };
  }

  return null;
}

// Whether an active (uncommented, correctly-tabled) mcp_servers entry with
// the given name already exists. A plain string search matches commented-out
// lines too (`# name = "egc-guardian"` still contains the substring), which
// would make registerToml believe the server is registered when the user
// disabled it, and skip restoring it on the next `egc init`. Parsing catches
// that; if the file doesn't parse (mid-edit, genuinely malformed), fall back
// to the substring check rather than block registration entirely.
function tomlHasActiveServer(content, serverName) {
  if (TOML) {
    try {
      const parsed = TOML.parse(content);
      const servers = Array.isArray(parsed.mcp_servers) ? parsed.mcp_servers : [];
      return servers.some(server => server && server.name === serverName);
    } catch {
      // Fall through to the substring check below.
    }
  }
  return content.includes(`"${serverName}"`) || content.includes(`'${serverName}'`);
}

function tomlHasTableServer(content, serverName) {
  if (TOML) {
    try {
      const parsed = TOML.parse(content);
      if (parsed.mcp_servers && typeof parsed.mcp_servers === 'object' && !Array.isArray(parsed.mcp_servers)) {
        return Boolean(parsed.mcp_servers[serverName]);
      }
      return false;
    } catch {
      // Fall through to substring check below.
    }
  }
  return content.includes(`[mcp_servers.${serverName}]`);
}

const MCP_SERVERS_KEY = '(?:mcp_servers|"mcp_servers"|\'mcp_servers\')';
const LEGACY_ARRAY_HEADER = new RegExp(String.raw`^\s*\[\[\s*${MCP_SERVERS_KEY}\s*\]\]`);
const LEGACY_CHILD_HEADER = new RegExp(String.raw`^\s*\[{1,2}\s*${MCP_SERVERS_KEY}\s*\.`);
const ANY_TABLE_HEADER = /^\s*\[[^\]]+\]/;
const LEGACY_NAME_LINE = /^\s*name\s*=\s*["']([^"']+)["']/;

// A dotted header such as [mcp_servers.env] that follows an [[mcp_servers]]
// entry is TOML for a child of that entry, so it stays in the entry's block.
function classifyLegacyHeader(line) {
  if (LEGACY_ARRAY_HEADER.test(line)) return 'array';
  if (LEGACY_CHILD_HEADER.test(line)) return 'child';
  if (ANY_TABLE_HEADER.test(line)) return 'other';
  return null;
}

// Tracks whether a line ends inside a multi-line string, so a header or a
// name = "..." written inside the string is never read as TOML structure.
function advanceMultilineState(state, line) {
  let current = state;
  let rest = line;
  while (rest.length > 0) {
    if (current) {
      const close = rest.indexOf(current);
      if (close === -1) return current;
      rest = rest.slice(close + 3);
      current = null;
      continue;
    }
    const basic = rest.indexOf('"""');
    const literal = rest.indexOf("'''");
    if (basic === -1 && literal === -1) return null;
    const open = basic === -1 || (literal !== -1 && literal < basic) ? literal : basic;
    current = rest.slice(open, open + 3);
    rest = rest.slice(open + 3);
  }
  return current;
}

function legacyNameOf(line) {
  const hash = line.indexOf('#');
  const match = (hash === -1 ? line : line.slice(0, hash)).match(LEGACY_NAME_LINE);
  return match ? match[1] : null;
}

// Every [[mcp_servers]] entry as { start, end, names }: the line range it
// owns (children included) and the name = "..." values of its own keys.
function scanLegacyBlocks(lines) {
  const blocks = [];
  let current = null;
  let inChild = false;
  let multiline = null;
  lines.forEach((line, index) => {
    const insideString = multiline !== null;
    multiline = advanceMultilineState(multiline, line);
    if (insideString) return;
    const kind = classifyLegacyHeader(line);
    if (kind === 'array') {
      if (current) {
        current.end = index;
        blocks.push(current);
      }
      current = { start: index, end: lines.length, names: [] };
      inChild = false;
      return;
    }
    if (!current) return;
    if (kind === 'other') {
      current.end = index;
      blocks.push(current);
      current = null;
      return;
    }
    if (kind === 'child') inChild = true;
    const name = inChild ? null : legacyNameOf(line);
    if (name) current.names.push(name);
  });
  if (current) blocks.push(current);
  return blocks;
}

function removeLegacyTomlServer(content, serverName) {
  const lines = content.split('\n');
  const doomed = new Set();
  for (const block of scanLegacyBlocks(lines)) {
    if (!block.names.includes(serverName)) continue;
    for (let i = block.start; i < block.end; i++) doomed.add(i);
  }
  return lines.filter((_, index) => !doomed.has(index)).join('\n');
}

function findRemainingLegacyMcpServers(content) {
  return scanLegacyBlocks(content.split('\n')).map(block => block.names[block.names.length - 1] || 'unnamed');
}

function appendTableServer(content, id, bin) {
  const separator = content.endsWith('\n') || content.length === 0 ? '' : '\n';
  return `${content}${separator}\n[mcp_servers.${id}]\ncommand = "node"\nargs = ["${tomlEscape(bin)}"]\n`;
}

// The escapes TOML spells with a single letter. Any other control character
// is written as \uXXXX, and guardian-bin.js reads both forms back.
const TOML_SHORT_ESCAPES = {
  '\\': String.raw`\\`,
  '"': String.raw`\"`,
  '\b': String.raw`\b`,
  '\t': String.raw`\t`,
  '\n': String.raw`\n`,
  '\f': String.raw`\f`,
  '\r': String.raw`\r`,
};

/**
 * Escapes a path for use inside a TOML basic (double-quoted) string.
 * Three kinds of character can occur in a real filesystem path and break the
 * string: a backslash (TOML reserves "\U" for an 8-hex-digit Unicode escape,
 * so a raw Windows path like C:\Users\... silently corrupts the file the
 * moment a backslash precedes a hex-ish character), a double quote (legal in
 * a POSIX directory name, and it would terminate the string early) and a
 * control character such as a line break (just as legal there, and a basic
 * string cannot hold one raw). All of them are replaced in one pass, so the
 * backslash an escape adds is never escaped again.
 */
function tomlEscape(p) {
  return p.replaceAll(/["\\\p{Cc}]/gu, (ch) => TOML_SHORT_ESCAPES[ch]
    ?? String.raw`\u${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

// Whether the text is a TOML document a parser accepts. @iarna/toml is a
// runtime dependency (D31 C29), but the require() above still guards it: if
// it is ever unavailable (a corrupted install, for instance) there is
// nothing to check with, so the answer is true and the guard below behaves
// exactly as the code did before it existed, rather than refusing every
// write it cannot verify.

module.exports = {
  findInlineMcpServersArray,
  tomlHasActiveServer,
  tomlHasTableServer,
  removeLegacyTomlServer,
  findRemainingLegacyMcpServers,
  appendTableServer,
  tomlEscape,
};
