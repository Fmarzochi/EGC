#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_STDIN = 1024 * 1024;
let raw = '';

const MODE_CONFIG = {
  audit: {
    fileName: 'bash-commands.log',
    format: command => `[${new Date().toISOString()}] ${command}`,
  },
  cost: {
    fileName: 'cost-tracker.log',
    format: command => `[${new Date().toISOString()}] tool=Bash command=${command}`,
  },
};

// Secrets embedded inside free text such as a shell command. Each prefix
// pattern stops exactly where the secret value starts; the value itself
// (quoted, or a bare run up to whitespace) is consumed in code, which keeps
// every pattern short. The Guardian audit log (mcp/servers/egc-guardian/
// src/audit-log.ts) carries the same list: change both together.
const SECRET_VALUE_PREFIXES = [
  /authorization\s*:\s*(?:bearer|basic|token)\s+/gi,
  /(?:x-)?(?:api|secret|access|private|auth)[-_]?(?:key|secret|token)\s*:\s*/gi,
  // basic auth: --user=name:password anywhere; -u name:password only inside
  // a curl invocation, since -u is an ordinary flag for rsync, sudo and others
  /--user(?:=|\s+)["']?[^\s:"']+:/gi,
  /--?(?:token|password|passwd|secret|auth|credentials?)(?:=|\s+)/gi,
  /--?(?:api|access|private)[-_]?(?:key|secret)(?:=|\s+)/gi,
  /\b[\w-]*(?:token|password|passwd|secret|apikey)[\w-]*\s*=\s*/gi,
  /\b[\w-]*(?:api|access|private)[-_]?key[\w-]*\s*=\s*/gi,
  /\b(?:auth|authorization|credentials?)\s*=\s*/gi,
];
const SECRET_SHAPES = [
  /(:\/\/[^\s/:@]+:)[^\s@]+(?=@)/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_\w{20,}\b/g,
  /\bsk-[\w-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bglpat-[\w-]{20,}\b/g,
  /\bAIza[\w-]{35}\b/g,
  /\bey[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g,
];
const REDACTED = '<REDACTED>';

function secretValueEnd(text, start, attached) {
  const quote = text[start];
  // After a space-separated option a bare run that starts with '-' is the
  // next flag, not a value; a value attached with '=' or ':' is taken as is.
  if (!attached && quote === '-') return start;
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, start + 1);
    return close === -1 ? text.length : close + 1;
  }
  let end = start;
  while (end < text.length && !/[\s"'&;]/.test(text[end])) end += 1;
  return end;
}

// curl's -u name:password in any spelling (-u name:pw, -uname:pw, -u=name:pw,
// --user name:pw, --user=name:pw, -u ":pw", -u 'a b:c', $(curl -u ...),
// "$(curl -u ...)", sh -c 'curl -u ...'), redacted in one left-to-right pass
// over shell words read the way the shell reads them; a separator (;, |, &,
// newline) starts a new command, a substitution is redacted as a command
// line of its own, and a value is touched only after curl appeared in that
// command. -u is an ordinary flag for rsync, sudo and others, so those keep
// theirs.
const COMMAND_SEPARATORS = new Set([';', '|', '&', '\n']);
const BACKSLASH_ESCAPES = process.platform !== 'win32';

// A character that came from a quoted run, an escape or a substitution:
// literal text the outer command never treats as syntax.
const LITERAL = '\u0001';
const ANSI_NAMED = { n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', f: '\f', v: '\v', e: '\u001b', E: '\u001b', '\\': '\\', "'": "'", '"': '"', '?': '?' };
// Numeric ANSI-C escapes: the introducing letter (none for octal), the
// digit class, the longest run and the radix.
const ANSI_NUMERIC = [
  ['x', /[0-9a-fA-F]/, 2, 16],
  ['u', /[0-9a-fA-F]/, 4, 16],
  ['U', /[0-9a-fA-F]/, 8, 16],
  ['', /[0-7]/, 3, 8],
];

function digitRun(text, from, max, digit) {
  let end = from;
  while (end < text.length && end - from < max && digit.test(text[end])) end += 1;
  return text.slice(from, end);
}

// One ANSI-C escape starting at the backslash inside $'...'; an unknown
// escape keeps its backslash, as Bash does.
// A decoded code point, or the escape kept as typed when it is beyond what a
// string can hold (Bash would reject it; the log must not fail open).
function codePointPiece(point, text, at, end) {
  const raw = text.slice(at, end);
  return { value: point > 0x10ffff ? raw : String.fromCodePoint(point), raw, end };
}

function ansiEscape(text, at) {
  const next = text[at + 1];
  for (const [letter, digit, max, radix] of ANSI_NUMERIC) {
    if (letter && next !== letter) continue;
    const from = at + 1 + letter.length;
    const run = digitRun(text, from, max, digit);
    if (run) return codePointPiece(Number.parseInt(run, radix), text, at, from + run.length);

    if (letter) break;
  }
  if (next === 'c' && text[at + 2] !== undefined) {
    return { value: String.fromCodePoint(text[at + 2].toUpperCase().codePointAt(0) ^ 0x40), raw: text.slice(at, at + 3), end: at + 3 };
  }
  const value = Object.hasOwn(ANSI_NAMED, next) ? ANSI_NAMED[next] : `\\${next}`;
  return { value, raw: text.slice(at, at + 2), end: at + 2 };
}

function isQuoteOpener(text, at) {
  const ch = text[at];
  return ch === '"' || ch === "'" || (ch === '$' && (text[at + 1] === '"' || text[at + 1] === "'"));
}

function isSubstitutionOpener(text, at) {
  return text[at] === '`' || ((text[at] === '$' || text[at] === '<' || text[at] === '>') && text[at + 1] === '(');
}

// The end (exclusive) of a `...` substitution: an escaped backtick does
// not close it; the text length when it never closes.
function backtickEnd(text, at) {
  for (let i = at + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '`') return i + 1;
  }
  return text.length;
}

// The end (exclusive) of a $(...), <(...), >(...) or `...` substitution
// starting at `at`, balanced across nested substitutions and quotes; the
// text length when it never closes.
function substitutionEnd(text, at) {
  if (text[at] === '`') return backtickEnd(text, at);


  let depth = 0;
  let quote = null;
  for (let i = at + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '\\') {
      i += 1;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

// The escape at a backslash inside a decoding quote: a dropped
// backslash-newline, an ANSI-C escape in $'...', or one of \ " $ ` in double
// quotes; null when the backslash is literal there.
function quotedEscape(text, at, ansi) {
  const next = text[at + 1];
  if (next === undefined) return null;
  if (next === '\n') return { value: '', raw: '', end: at + 2 };
  if (ansi) return ansiEscape(text, at);
  return '"\\$`'.includes(next) ? { value: next, raw: text.slice(at, at + 2), end: at + 2 } : null;
}

// A substitution is a command line of its own: its inside is redacted on
// its own terms and the outer command never sees it as syntax.
function redactSubstitution(inner) {
  const backtick = inner.startsWith('`');
  const closed = backtick ? inner.endsWith('`') && inner.length > 1 : inner.endsWith(')');
  const opener = backtick ? '`' : inner.slice(0, 2);
  const body = inner.slice(opener.length, closed ? -1 : undefined);
  let closer = '';
  if (closed) closer = backtick ? '`' : ')';
  return `${opener}${redactCurlBasicAuth(body)}${closer}`;

}

// The body of a quoted run starting at its opening quote (or at the $ of
// $'...' and $"..."): single quotes are literal, double quotes decode their
// escapes and still run the substitutions inside them, $'...' decodes the
// ANSI-C escapes. `raw` is the run as it will be logged.
// A substitution at `at` as one literal unit, redacted inside.
function substitutionPiece(text, at) {
  const end = substitutionEnd(text, at);
  const inner = text.slice(at, end);
  return { value: inner, raw: redactSubstitution(inner), end };
}

function readQuoted(text, start) {
  const ansi = text[start] === '$';
  const quote = ansi ? text[start + 1] : text[start];
  const decodes = quote === '"' || ansi;
  let value = '';
  let raw = text.slice(start, start + (ansi ? 2 : 1));
  let i = start + (ansi ? 2 : 1);
  while (i < text.length && text[i] !== quote) {
    let piece = null;
    if (quote === '"' && isSubstitutionOpener(text, i)) piece = substitutionPiece(text, i);
    else if (text[i] === '\\' && decodes) piece = quotedEscape(text, i, quote === "'");
    piece ??= { value: text[i], raw: text[i], end: i + 1 };

    value += piece.value;
    raw += piece.raw;
    i = piece.end;
  }
  const end = Math.min(i + 1, text.length);
  raw += text.slice(i, end);
  return { value, raw, end };
}

// One piece of a word at `at`: a dropped continuation, a substitution (one
// literal unit, redacted inside), a quoted run, an escaped character or a
// plain one; null at a separator or blank.
function wordPiece(text, at) {
  const ch = text[at];
  if (ch === '\\' && text[at + 1] === '\n') return { value: '', code: '', raw: '', end: at + 2 };
  if (isSubstitutionOpener(text, at)) {
    const piece = substitutionPiece(text, at);
    return { value: piece.value, code: LITERAL.repeat(piece.value.length), raw: piece.raw, end: piece.end };
  }

  if (isQuoteOpener(text, at)) {
    const quoted = readQuoted(text, at);
    return { value: quoted.value, code: LITERAL.repeat(quoted.value.length), raw: quoted.raw, end: quoted.end };
  }
  if (ch === '\\' && BACKSLASH_ESCAPES && at + 1 < text.length) {
    return { value: text[at + 1], code: LITERAL, raw: text.slice(at, at + 2), end: at + 2 };
  }
  if (COMMAND_SEPARATORS.has(ch) || /\s/.test(ch)) return null;
  return { value: ch, code: ch, raw: ch, end: at + 1 };
}

// One shell word starting at `start`, read the way the shell reads it. `raw`
// is the word as it will be logged, `value` the word the program receives,
// `code` the same word with every literal character masked so syntax is
// only looked for where the shell would see it.
function readShellWord(text, start) {
  const word = { raw: '', value: '', code: '', end: start };
  while (word.end < text.length) {
    const piece = wordPiece(text, word.end);
    if (!piece) break;
    word.value += piece.value;
    word.code += piece.code;
    word.raw += piece.raw;
    word.end = piece.end;
  }
  return word;
}

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'ash']);
const CURL_NAME_RE = /^curl(?:\.exe|\.cmd|\.bat)?$/i;
const GLUED_USER_FLAGS = ['--user=', '-u=', '-u'];

function basename(value) {
  return value.split(/[\\/]/).pop();
}

// curl by basename, with or without a Windows executable suffix, also
// behind a group opener the shell would execute ({curl, (curl); a
// substitution is a unit of its own and never names the outer command.
function isCurlWord(word) {
  let skip = 0;
  while (skip < word.code.length && (word.code[skip] === '(' || word.code[skip] === '{')) skip += 1;
  return CURL_NAME_RE.test(basename(word.value.slice(skip)));
}

// Whether a shell's option word asks for a command string (-c, -lc, -ic).
function isCommandStringFlag(value) {
  if (!value.startsWith('-') || value.length < 2) return false;
  const letters = value.slice(1);
  return letters.toLowerCase().includes('c') && [...letters].every(ch => /[a-z]/i.test(ch));
}

// A quoted word that a shell runs as a command line (the operand of sh -c,
// bash -lc and the like) is redacted inside its quotes.
function redactQuotedBody(raw) {
  const prefix = raw.startsWith('$') ? 2 : 1;
  const quote = raw[prefix - 1];
  if ((quote !== '"' && quote !== "'") || raw.length < prefix + 1 || !raw.endsWith(quote)) return raw;
  return `${raw.slice(0, prefix)}${redactCurlBasicAuth(raw.slice(prefix, -1))}${quote}`;
}

// An ANSI-C quoted run may hide or shift the separator behind escapes:
// everything after the first separator goes, or the whole run; null when
// the credential has no such run.
function ansiCredential(raw, colon) {
  const ansiAt = raw.indexOf("$'");
  if (ansiAt === -1) return null;
  if (colon !== -1 && colon < ansiAt) return `${raw.slice(0, colon + 1)}${REDACTED}`;
  return `${raw.slice(0, ansiAt)}$'${REDACTED}'`;
}

// What follows the redacted password as typed: the closing quote of a
// quoted credential, or the delimiters that closed a substitution.
function credentialTail(raw, colon) {
  const quoteAt = raw.startsWith('$') ? 1 : 0;
  const quote = raw[quoteAt] === '"' || raw[quoteAt] === "'" ? raw[quoteAt] : '';
  if (quote && raw.length > quoteAt + 1 && raw.endsWith(quote)) return quote;
  let keep = raw.length;
  while (keep > colon + 1 && (raw[keep - 1] === ')' || raw[keep - 1] === '`')) keep -= 1;
  return raw.slice(keep);
}

// The credential as typed, with the password replaced.
function redactCredential(raw, value) {
  if (isSubstitutionOpener(raw, 0)) return redactedSubstitution(raw);
  const colon = raw.indexOf(':');
  const ansi = ansiCredential(raw, colon);
  if (ansi !== null) return ansi;
  if (colon === -1) return value.includes(':') ? REDACTED : raw;
  return `${raw.slice(0, colon + 1)}${REDACTED}${credentialTail(raw, colon)}`;
}

// A credential produced by a substitution: its command line is secret, so
// only the substitution's shape is kept.
function redactedSubstitution(raw) {
  const backtick = raw.startsWith('`');
  const closed = backtick ? raw.length > 1 && raw.endsWith('`') : raw.endsWith(')');
  let closer = '';
  if (closed) closer = backtick ? '`' : ')';
  return `${backtick ? '`' : raw.slice(0, 2)}${REDACTED}${closer}`;
}

// One word of a command, with the state of the command it belongs to.
function redactWord(word, state) {
  if (state.bodyNext) {
    state.bodyNext = false;
    return redactQuotedBody(word.raw);
  }
  if (state.valueNext) {
    state.valueNext = false;
    return redactCredential(word.raw, word.value);
  }
  if (SHELL_NAMES.has(basename(word.value).toLowerCase())) {
    state.sawShell = true;
  } else if (state.sawShell && isCommandStringFlag(word.value)) {
    state.bodyNext = true;
  } else if (isCurlWord(word)) {
    state.sawCurl = true;
  } else if (state.sawCurl && (word.value === '-u' || word.value === '--user')) {
    state.valueNext = true;
  } else if (state.sawCurl) {
    const glued = GLUED_USER_FLAGS.find(flag => word.raw.startsWith(flag) && word.raw.length > flag.length);
    if (glued) return `${glued}${redactCredential(word.raw.slice(glued.length), word.value.slice(glued.length))}`;
  }
  return word.raw;
}

function freshCurlState() {
  return { sawCurl: false, sawShell: false, valueNext: false, bodyNext: false };
}

function redactCurlBasicAuth(text) {
  let out = '';
  let i = 0;
  let state = freshCurlState();
  while (i < text.length) {
    const ch = text[i];
    if (COMMAND_SEPARATORS.has(ch) || /\s/.test(ch)) {
      if (COMMAND_SEPARATORS.has(ch)) state = freshCurlState();
      out += ch;
      i += 1;
      continue;
    }
    const word = readShellWord(text, i);
    i = word.end;
    out += redactWord(word, state);
  }
  return out;
}

function redactValuesAfter(text, prefixPattern) {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(prefixPattern)) {
    const start = match.index + match[0].length;
    if (start < last) continue;
    const end = secretValueEnd(text, start, /[=:]$/.test(match[0]));
    if (end === start) continue;
    out += `${text.slice(last, start)}${REDACTED}`;
    last = end;
  }
  return out + text.slice(last);
}

function sanitizeCommand(command) {
  // Redaction runs on the original text so a newline still separates
  // commands (curl on one line, rsync -u on the next); the log line is
  // flattened only afterwards.
  let out = String(command || '');
  for (const prefix of SECRET_VALUE_PREFIXES) out = redactValuesAfter(out, prefix);
  out = redactCurlBasicAuth(out);
  for (const shape of SECRET_SHAPES) out = out.replace(shape, (match, keep) => (typeof keep === 'string' ? `${keep}${REDACTED}` : REDACTED));
  return out.replaceAll('\n', ' ');
}

// The log holds every command the agent ran; it is created private to the
// user and an older world-readable copy is tightened on the next write.
function appendLine(filePath, line) {
  // mkdirSync only reports a directory it created itself: that one is made
  // private; a directory the user already had keeps the mode they chose.
  const created = fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    if (created) fs.chmodSync(created, 0o700);
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Permission bits are advisory on filesystems that do not carry them.
  }
}

function run(rawInput, mode = 'audit') {
  const config = MODE_CONFIG[mode];

  try {
    if (config) {
      const input = String(rawInput || '').trim() ? JSON.parse(String(rawInput)) : {};
      const command = sanitizeCommand(input.tool_input?.command || '?');
      appendLine(path.join(os.homedir(), '.gemini', config.fileName), config.format(command));
    }
  } catch {
    // Logging must never block the calling hook.
  }

  return typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
}

function main() {
  const mode = process.argv[2];

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      const remaining = MAX_STDIN - raw.length;
      raw += chunk.substring(0, remaining);
    }
  });

  process.stdin.on('end', () => {
    process.stdout.write(run(raw, mode));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  run,
  sanitizeCommand,
};
