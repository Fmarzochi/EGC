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
const ANSI_ESCAPES = { n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', f: '\f', v: '\v', e: '\u001b', E: '\u001b', '\\': '\\', "'": "'", '"': '"', '?': '?' };

// One ANSI-C escape starting at the backslash inside $'...': the named ones,
// octal (\NNN), hex (\xHH), unicode (\uHHHH, \UHHHHHHHH) and control (\cX).
function ansiEscape(text, at) {
  const next = text[at + 1];
  const digits = { x: [/^[0-9a-fA-F]{1,2}/, 16], u: [/^[0-9a-fA-F]{1,4}/, 16], U: [/^[0-9a-fA-F]{1,8}/, 16] }[next];
  if (digits) {
    const run = digits[0].exec(text.slice(at + 2));
    if (run) return { value: String.fromCodePoint(Number.parseInt(run[0], digits[1])), end: at + 2 + run[0].length };
  }
  const octal = /^[0-7]{1,3}/.exec(text.slice(at + 1));
  if (octal) return { value: String.fromCharCode(Number.parseInt(octal[0], 8)), end: at + 1 + octal[0].length };
  if (next === 'c' && text[at + 2] !== undefined) return { value: String.fromCharCode(text[at + 2].toUpperCase().charCodeAt(0) ^ 0x40), end: at + 3 };
  if (Object.hasOwn(ANSI_ESCAPES, next)) return { value: ANSI_ESCAPES[next], end: at + 2 };
  return { value: `\\${next}`, end: at + 2 };
}

function isQuoteOpener(text, at) {
  const ch = text[at];
  return ch === '"' || ch === "'" || (ch === '$' && (text[at + 1] === '"' || text[at + 1] === "'"));
}

function isSubstitutionOpener(text, at) {
  return text[at] === '`' || ((text[at] === '$' || text[at] === '<' || text[at] === '>') && text[at + 1] === '(');
}

// The end (exclusive) of a $(...), <(...), >(...) or `...` substitution starting at `at`,
// balanced across nested substitutions and quotes; the text length when it
// never closes.
function substitutionEnd(text, at) {
  if (text[at] === '`') {
    const close = text.indexOf('`', at + 1);
    return close === -1 ? text.length : close + 1;
  }
  let depth = 0;
  let quote = null;
  let i = at + 1;
  while (i < text.length) {
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
    i += 1;
  }
  return text.length;
}

// The body of a quoted run starting at its opening quote (or at the $ of
// $'...' and $"..."): single quotes are literal, double quotes keep their
// escapes for \ " $ and `, drop a backslash-newline and still run the
// substitutions inside them, $'...' decodes the ANSI-C escapes. `raw` is
// the run as it will be logged, with any substitution inside redacted.
function readQuoted(text, start) {
  const ansi = text[start] === '$';
  const quote = ansi ? text[start + 1] : text[start];
  const decodes = quote === '"' || ansi;
  let value = '';
  let raw = text.slice(start, start + (ansi ? 2 : 1));
  let i = start + (ansi ? 2 : 1);
  while (i < text.length && text[i] !== quote) {
    const next = text[i + 1];
    if (quote === '"' && isSubstitutionOpener(text, i)) {
      const end = substitutionEnd(text, i);
      const inner = text.slice(i, end);
      value += inner;
      raw += redactSubstitution(inner);
      i = end;
      continue;
    }
    if (text[i] === '\\' && decodes && next !== undefined) {
      if (next === '\n') {
        i += 2;
        continue;
      }
      if (quote === "'") {
        const decoded = ansiEscape(text, i);
        value += decoded.value;
        raw += text.slice(i, decoded.end);
        i = decoded.end;
        continue;
      }
      if ('"\\$`'.includes(next)) {
        value += next;
        raw += text.slice(i, i + 2);
        i += 2;
        continue;
      }
    }
    value += text[i];
    raw += text[i];
    i += 1;
  }
  const end = Math.min(i + 1, text.length);
  raw += text.slice(i, end);
  return { value, raw, end };
}

// A substitution is a command line of its own: its inside is redacted on
// its own terms and the outer command never sees it as syntax.
function redactSubstitution(inner) {
  if (inner.startsWith('`')) {
    const closed = inner.endsWith('`') && inner.length > 1;
    const body = closed ? inner.slice(1, -1) : inner.slice(1);
    return `\`${redactCurlBasicAuth(body)}${closed ? '`' : ''}`;
  }
  const closed = inner.endsWith(')');
  const body = inner.slice(2, closed ? -1 : undefined);
  return `${inner.slice(0, 2)}${redactCurlBasicAuth(body)}${closed ? ')' : ''}`;
}

// One shell word starting at `start`, read the way the shell reads it: a
// backslash-newline is a continuation, a backslash outside quotes escapes
// the next character (on Windows it is a path separator instead), a
// substitution is one literal unit. `raw` is the word as it will be logged,
// `value` the word the program receives, `code` the same word with every
// literal character masked so syntax is only looked for where the shell
// would see it.
function readShellWord(text, start) {
  let value = '';
  let code = '';
  let raw = '';
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '\n') {
      i += 2;
    } else if (isSubstitutionOpener(text, i)) {
      const end = substitutionEnd(text, i);
      const inner = text.slice(i, end);
      value += inner;
      code += LITERAL.repeat(inner.length);
      raw += redactSubstitution(inner);
      i = end;
    } else if (isQuoteOpener(text, i)) {
      const quoted = readQuoted(text, i);
      value += quoted.value;
      code += LITERAL.repeat(quoted.value.length);
      raw += quoted.raw;
      i = quoted.end;
    } else if (ch === '\\' && BACKSLASH_ESCAPES && i + 1 < text.length) {
      value += text[i + 1];
      code += LITERAL;
      raw += text.slice(i, i + 2);
      i += 2;
    } else if (COMMAND_SEPARATORS.has(ch) || /\s/.test(ch)) {
      break;
    } else {
      value += ch;
      code += ch;
      raw += ch;
      i += 1;
    }
  }
  return { raw, value, code, end: i };
}

// curl by basename, with or without a Windows executable suffix, also
// behind a group opener the shell would execute ({curl, (curl); a
// substitution is a unit of its own and never names the outer command.
function isCurlWord(word) {
  const group = /^[({]+/.exec(word.code);
  const command = word.value.slice(group ? group[0].length : 0);
  return /^curl(?:\.exe|\.cmd|\.bat)?$/i.test(command.split(/[\\/]/).pop());
}

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'ash']);

function isShellWord(word) {
  return SHELL_NAMES.has(word.value.split(/[\\/]/).pop().toLowerCase());
}

// A quoted word that a shell runs as a command line (the operand of sh -c,
// bash -lc and the like) is redacted inside its quotes.
function redactQuotedBody(raw) {
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw.length < 2 || !raw.endsWith(quote)) return raw;
  return `${quote}${redactCurlBasicAuth(raw.slice(1, -1))}${quote}`;
}

function redactCredentialWord(word) {
  const colon = word.indexOf(':');
  if (colon === -1) return word;
  const quoteAt = word[0] === '$' ? 1 : 0;
  const quote = word[quoteAt] === '"' || word[quoteAt] === "'" ? word[quoteAt] : '';
  const closingQuote = quote && word.length > quoteAt + 1 && word.endsWith(quote) ? quote : '';
  const tail = closingQuote || (/[)`]+$/.exec(word) || [''])[0];
  return `${word.slice(0, colon + 1)}${REDACTED}${tail}`;
}

// The length of the flag glued in front of a credential (-u, -u=, --user=),
// or 0 when the word is not such a flag.
function gluedUserFlagLength(word) {
  if (word.startsWith('--user=')) return '--user='.length;
  if (word.startsWith('-u=')) return 3;
  if (word.startsWith('-u') && word.length > 2) return 2;
  return 0;
}

// One word of a command, with the state of the command it belongs to.
function redactWord(word, state) {
  if (state.bodyNext) {
    state.bodyNext = false;
    return redactQuotedBody(word.raw);
  }
  if (state.valueNext) {
    state.valueNext = false;
    return redactCredentialWord(word.raw);
  }
  if (isShellWord(word)) {
    state.sawShell = true;
  } else if (state.sawShell && /^-[a-z]*c[a-z]*$/i.test(word.value)) {
    state.bodyNext = true;
  } else if (isCurlWord(word)) {
    state.sawCurl = true;
  } else if (state.sawCurl && (word.value === '-u' || word.value === '--user')) {
    state.valueNext = true;
  } else if (state.sawCurl) {
    const glued = gluedUserFlagLength(word.raw);
    if (glued) return `${word.raw.slice(0, glued)}${redactCredentialWord(word.raw.slice(glued))}`;
  }
  return word.raw;
}

function redactCurlBasicAuth(text) {
  let out = '';
  let i = 0;
  let state = { sawCurl: false, sawShell: false, valueNext: false, bodyNext: false };
  while (i < text.length) {
    const ch = text[i];
    if (COMMAND_SEPARATORS.has(ch) || /\s/.test(ch)) {
      if (COMMAND_SEPARATORS.has(ch)) state = { sawCurl: false, sawShell: false, valueNext: false, bodyNext: false };
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
