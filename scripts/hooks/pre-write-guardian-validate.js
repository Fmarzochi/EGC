#!/usr/bin/env node
/**
 * Guardian Write Enforcement Hook
 *
 * Validates the target path of every Write/Edit/MultiEdit with the
 * egc-guardian validator before the write executes. Blocks writes to
 * protected paths (credential stores, key files, system directories).
 *
 * Fails open silently: if the guardian CLI is missing or errors, the
 * write is allowed. Run egc doctor to diagnose a missing validator.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block
 */

'use strict';

const { resolveGuardianCli, callGuardian } = require('../lib/guardian-bin');

const MAX_STDIN = 1024 * 1024;
const VALIDATE_TIMEOUT_MS = 4000;

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

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const filePath = input?.tool_input?.file_path || input?.tool_input?.file || '';
  if (!filePath || typeof filePath !== 'string') return { exitCode: 0 };

  const cli = resolveGuardianCli();
  if (!cli) {
    return { exitCode: 0 };
  }

  const verdict = callGuardian(cli, ['write'], filePath, VALIDATE_TIMEOUT_MS);
  if (!verdict) return { exitCode: 0 };

  if (verdict.allowed === false) {
    return {
      exitCode: 2,
      stderr:
        `EGC Guardian BLOCKED this write: ${verdict.reason || 'denied by policy'}. ` +
        'Writes to protected paths are not permitted.',
    };
  }

  return { exitCode: 0 };
}

module.exports = { run };

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
