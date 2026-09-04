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

// Secrets embedded in a shell command. A value is a quoted run or a bare
// run of non-space characters; each pattern is anchored on a literal and
// short enough to read on its own. Mirrors the Guardian's own audit
// redaction (mcp/servers/egc-guardian/src/audit-log.ts).
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'&;]+)`;
const SECRET_PATTERNS = [
  new RegExp(String.raw`(authorization\s*:\s*(?:bearer|basic|token)\s+)[^\s"']+`, 'gi'),
  new RegExp(String.raw`((?:x-)?(?:api[-_]?key|api[-_]?secret|auth[-_]?token|access[-_]?token|secret[-_]?key|private[-_]?token)\s*:\s*)[^\s"']+`, 'gi'),
  new RegExp(String.raw`(--?u(?:ser)?(?:=|\s+)["']?[^\s:"']+:)[^\s"']+`, 'gi'),
  new RegExp(String.raw`(--?(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|private[-_]?key|auth|credentials?)(?:=|\s+))` + VALUE, 'gi'),
  new RegExp(String.raw`\b((?:[a-z_]*(?:token|password|passwd|secret|api[-_]?key|apikey|private[-_]?key|access[-_]?key)[a-z_]*|auth|authorization|credentials?)\s*=\s*)` + VALUE, 'gi'),
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
