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

// Secrets embedded in a shell command: header and flag values, key=value
// assignments, URL credentials, well-known token prefixes and JWTs. Each
// pattern is anchored on a literal and consumes one run of non-space
// characters, so none of them backtracks. Mirrors the Guardian's own audit
// redaction (mcp/servers/egc-guardian/src/audit-log.ts).
const SECRET_PATTERNS = [
  /(authorization\s*:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi,
  /(--?(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|private[-_]?key|auth)(?:=|\s+))[^\s"']+/gi,
  /(\b[a-z_]*(?:token|password|passwd|secret|api[-_]?key|apikey)[a-z_]*\s*=\s*)[^\s"'&;]+/gi,
  /(:\/\/[^\s/:@]+:)[^\s@]+(?=@)/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

function sanitizeCommand(command) {
  let out = String(command || '').replaceAll('\n', ' ');
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix) => (typeof prefix === 'string' ? `${prefix}<REDACTED>` : '<REDACTED>'));
  }
  return out;
}

// The log holds every command the agent ran; it is created private to the
// user and an older world-readable copy is tightened on the next write.
function appendLine(filePath, line) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
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
