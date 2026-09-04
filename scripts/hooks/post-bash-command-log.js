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
// --user name:pw, --user=name:pw, -u ":pw", -u 'a b:c'), redacted in one
// left-to-right pass over shell words: quotes and backslashes are read the
// way the shell reads them, a separator (;, |, &, newline) starts a new
// command, and a value is touched only after curl appeared in that command.
// -u is an ordinary flag for rsync, sudo and others, so those keep theirs.
const COMMAND_SEPARATORS = new Set([';', '|', '&', '\n']);

function shellWordEnd(text, start) {
  let quote = null;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === '\\') {
      i += 1;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (COMMAND_SEPARATORS.has(ch) || /\s/.test(ch)) {
      break;
    }
    i += 1;
  }
  return Math.min(i, text.length);
}

function bareWord(word) {
  return word.replace(/\\(.)/g, '$1').replace(/["']/g, '');
}

function redactCredentialWord(word) {
  const colon = word.indexOf(':');
  if (colon === -1) return word;
  const quote = word[0] === '"' || word[0] === "'" ? word[0] : '';
  const closing = quote && word.length > 1 && word.endsWith(quote) ? quote : '';
  return `${word.slice(0, colon + 1)}${REDACTED}${closing}`;
}

// The length of the flag glued in front of a credential (-u, -u=, --user=),
// or 0 when the word is not such a flag.
function gluedUserFlagLength(word) {
  if (word.startsWith('--user=')) return '--user='.length;
  if (word.startsWith('-u=')) return 3;
  if (word.startsWith('-u') && word.length > 2) return 2;
  return 0;
}

// curl by basename, with or without a Windows executable suffix; the raw
// word is split so a backslash in a Windows path is a separator, not an
// escape.
function isCurlWord(word) {
  return /^curl(?:\.exe|\.cmd|\.bat)?$/i.test(word.replace(/["']/g, '').split(/[\\/]/).pop());
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
    const end = shellWordEnd(text, i);
    const word = text.slice(i, end);
    const bare = bareWord(word);
    i = end;
    if (valueNext) {
      valueNext = false;
      out += redactCredentialWord(word);
    } else if (isCurlWord(word)) {
      sawCurl = true;
      out += word;
    } else if (!sawCurl) {
      out += word;
    } else if (bare === '-u' || bare === '--user') {
      valueNext = true;
      out += word;
    } else {
      const glued = gluedUserFlagLength(word);
      out += glued ? `${word.slice(0, glued)}${redactCredentialWord(word.slice(glued))}` : word;
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
