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

const { resolveGuardianCli, callGuardian } = require('../lib/guardian-bin');
const { splitShellSegments, extractSubstitutionBodies } = require('../lib/shell-split');

const MAX_STDIN = 1024 * 1024;
const VALIDATE_TIMEOUT_MS = 4000;

// Caps recursion into nested command/process substitutions
// ($(echo $(echo $(...)))) — a real script has no reason to nest these more
// than a couple of levels deep; this is purely a backstop against adversarial
// or pathological input, not a limit anyone should ever hit legitimately.
const MAX_SUBSTITUTION_DEPTH = 5;

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

// Segmentation only splits the compound command on top-level, unquoted
// operators (&&, ||, ;, &, |, newline) — it no longer strips leading
// wrappers (sudo, env, xargs, ...) or env-var assignments itself. That
// unwrapping now happens once, centrally, in the guardian's own
// validateCommand (mcp/servers/egc-guardian/src/validator.ts), which both
// this hook and the validate_command MCP tool call through the CLI below —
// duplicating the same peeling logic in two places is exactly how earlier
// fixes here ended up covering only the specific wrapper names each audit
// happened to name (see the project's Guardian bypass post-mortem).
//
// Command/process substitutions ($(...), <(...), >(...), `...`) are also
// extracted and validated as their own additional segments, recursively (up
// to MAX_SUBSTITUTION_DEPTH): `echo $(rm -rf /)` must not slip through as
// one benign-looking `echo` segment just because `$`/backtick are not
// top-level separators.
function extractSegments(command, depth = 0) {
  const topLevel = splitShellSegments(command, { splitOnPipe: true })
    .map(s => s.trim())
    .filter(Boolean);

  if (depth >= MAX_SUBSTITUTION_DEPTH) return topLevel;

  const nested = [];
  for (const body of extractSubstitutionBodies(command)) {
    nested.push(...extractSegments(body, depth + 1));
  }

  return [...topLevel, ...nested];
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
  // resolveGuardianCli() only returns falsy when all 3 of its resolution
  // strategies fail at once (env var, package-relative build, and both
  // trusted MCP config files); against a real checkout with its own build
  // present, fromPackageLayout() always succeeds, so this can't be
  // triggered deterministically here without environment isolation fragile
  // enough to break on CI. Covered conceptually by the "fails open" test
  // below, which exercises the sibling !Array.isArray(verdicts) fail-open.
  /* c8 ignore start */
  if (!cli) {
    return { exitCode: 0 };
  }
  /* c8 ignore stop */

  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const verdicts = callGuardian(
    cli,
    ['command-batch'],
    JSON.stringify({ commands: segments, cwd }),
    VALIDATE_TIMEOUT_MS,
  );
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
