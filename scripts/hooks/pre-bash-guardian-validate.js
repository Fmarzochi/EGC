#!/usr/bin/env node
/**
 * Guardian Command Enforcement Hook
 *
 * Validates every Bash command with the egc-guardian validator before it
 * executes. Compound commands are split into segments so destructive
 * commands cannot hide behind chaining or wrappers like sudo.
 *
 * Blocking policy: only hard denials block (destructive commands,
 * protected paths, forbidden git flags). Allowlist misses and shell
 * metacharacter denials are advisory and never block, otherwise any
 * command outside the guardian allowlist would break the session.
 *
 * Fails open: if the guardian CLI is missing or errors, the command is
 * allowed and a warning is emitted.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block
 */

'use strict';

const { spawnSync } = require('child_process');
const { resolveGuardianCli } = require('../lib/guardian-bin');

const MAX_STDIN = 1024 * 1024;
const VALIDATE_TIMEOUT_MS = 4000;

const SEGMENT_SEPARATORS = /[&|;<>$`\n\r]+/;
const LEADING_WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command']);

const ADVISORY_REASONS = [
  'Shell chaining/metacharacters are forbidden',
  'is not in the allowlist',
];

function parseInput(inputOrRaw) {
  if (typeof inputOrRaw === 'string') {
    try {
      return inputOrRaw.trim() ? JSON.parse(inputOrRaw) : {};
    } catch {
      return {};
    }
  }
  return inputOrRaw && typeof inputOrRaw === 'object' ? inputOrRaw : {};
}

function extractSegments(command) {
  const segments = [];
  for (const rawSegment of command.split(SEGMENT_SEPARATORS)) {
    let tokens = rawSegment.trim().split(/\s+/).filter(Boolean);
    while (tokens.length > 0 && (LEADING_WRAPPERS.has(tokens[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]))) {
      tokens = tokens.slice(1);
    }
    if (tokens.length > 0) segments.push(tokens.join(' '));
  }
  return segments;
}

function isAdvisory(verdict) {
  const reason = String(verdict.reason || '');
  return ADVISORY_REASONS.some(marker => reason.includes(marker));
}

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const command = input?.tool_input?.command;
  if (!command || typeof command !== 'string') return { exitCode: 0 };

  const segments = extractSegments(command);
  if (segments.length === 0) return { exitCode: 0 };

  const cli = resolveGuardianCli();
  if (!cli) {
    return {
      exitCode: 0,
      stderr: '[EGC Guardian] validator CLI not found; command allowed unchecked. Run egc doctor.',
    };
  }

  const result = spawnSync(
    process.execPath,
    [cli, 'command-batch', JSON.stringify(segments)],
    { encoding: 'utf8', timeout: VALIDATE_TIMEOUT_MS },
  );

  if (result.error || result.status !== 0 || !result.stdout) {
    return {
      exitCode: 0,
      stderr: '[EGC Guardian] validator unavailable; command allowed unchecked.',
    };
  }

  let verdicts;
  try {
    verdicts = JSON.parse(result.stdout);
  } catch {
    return {
      exitCode: 0,
      stderr: '[EGC Guardian] validator returned malformed output; command allowed unchecked.',
    };
  }
  if (!Array.isArray(verdicts)) return { exitCode: 0 };

  for (let i = 0; i < verdicts.length; i++) {
    const verdict = verdicts[i] || {};
    if (verdict.allowed === false && !isAdvisory(verdict)) {
      return {
        exitCode: 2,
        stderr:
          `EGC Guardian BLOCKED this command: ${verdict.reason || 'denied by policy'} ` +
          `(segment: ${segments[i]}). Adjust the command to comply with the project safety rules.`,
      };
    }
  }

  return { exitCode: 0 };
}

module.exports = { run, extractSegments };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      raw += chunk.substring(0, MAX_STDIN - raw.length);
    }
  });
  process.stdin.on('end', () => {
    const result = run(raw);
    if (result.stderr) process.stderr.write(result.stderr + '\n');
    if (result.exitCode === 2) process.exit(2);
    process.stdout.write(raw);
  });
}
