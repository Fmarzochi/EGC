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
// sh -c 'curl -u ...'), redacted in one left-to-right pass over shell words
// read the way the shell reads them; a separator (;, |, &, newline) starts a
// new command, and a value is touched only after curl appeared in that
// command. -u is an ordinary flag for rsync, sudo and others, so those keep
// theirs.
const COMMAND_SEPARATORS = new Set([';', '|', '&', '\n']);
const BACKSLASH_ESCAPES = process.platform !== 'win32';

// The body of a quoted run starting at its opening quote: single quotes are
// literal, double quotes keep their escapes for \ " $ and `.
function readQuoted(text, start) {
  const quote = text[start];
  let value = '';
  let i = start + 1;
  while (i < text.length && text[i] !== quote) {
    if (quote === '"' && text[i] === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) i += 1;
    value += text[i];
    i += 1;
  }
  return { value, end: Math.min(i + 1, text.length) };
}

// One shell word starting at `start`, read the way the shell reads it; a
// backslash outside quotes escapes the next character (on Windows it is a
// path separator instead). `raw` is the text as typed, `value` the word the
// program receives.
function readShellWord(text, start) {
  let value = '';
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(text, i);
      value += quoted.value;
      i = quoted.end;
    } else if (ch === '\\' && BACKSLASH_ESCAPES && i + 1 < text.length) {
      value += text[i + 1];
      i += 2;
    } else if (COMMAND_SEPARATORS.has(ch) || /\s/.test(ch)) {
      break;
    } else {
      value += ch;
      i += 1;
    }
  }
  return { raw: text.slice(start, i), value, end: i };
}

// curl by basename, with or without a Windows executable suffix, also when
// the word opens a substitution ($(curl, `curl, {curl).
function isCurlWord(value) {
  return /^curl(?:\.exe|\.cmd|\.bat)?$/i.test(value.replace(/^[$(`{]+/, '').split(/[\\/]/).pop());
}

// A quoted word that holds a whole command line (sh -c '...') is redacted
// inside its quotes.
function redactQuotedBody(raw) {
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw.length < 2 || !raw.endsWith(quote)) return null;
  const body = raw.slice(1, -1);
  return /\s/.test(body) ? `${quote}${redactCurlBasicAuth(body)}${quote}` : null;
}

function redactCredentialWord(word) {
  const colon = word.indexOf(':');
  if (colon === -1) return word;
  const quote = word[0] === '"' || word[0] === "'" ? word[0] : '';
  const closingQuote = quote && word.length > 1 && word.endsWith(quote) ? quote : '';
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

function redactCurlBasicAuth(text) {
  let out = '';
  let i = 0;
  let sawCurl = false;
  let valueNext = false;
  while (i < text.length) {
    const ch = text[i];
    if (COMMAND_SEPARATORS.has(ch) || /\s/.test(ch)) {
      if (COMMAND_SEPARATORS.has(ch)) {
        sawCurl = false;
        valueNext = false;
      }
      out += ch;
      i += 1;
      continue;
    }
    const word = readShellWord(text, i);
    i = word.end;
    const nested = valueNext ? null : redactQuotedBody(word.raw);
    if (nested !== null) {
      out += nested;
    } else if (valueNext) {
      valueNext = false;
      out += redactCredentialWord(word.raw);
    } else if (isCurlWord(word.value)) {
      sawCurl = true;
      out += word.raw;
    } else if (!sawCurl) {
      out += word.raw;
    } else if (word.value === '-u' || word.value === '--user') {
      valueNext = true;
      out += word.raw;
    } else {
      const glued = gluedUserFlagLength(word.raw);
      out += glued ? `${word.raw.slice(0, glued)}${redactCredentialWord(word.raw.slice(glued))}` : word.raw;
    }
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
