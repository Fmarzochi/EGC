#!/usr/bin/env node
/**
 * Installed verbatim as .clinerules/hooks/PreToolUse (Unix, executable).
 *
 * Cline discovers this file by its exact filename, not by a require()'d
 * module, so it cannot live next to its own dependencies the way every
 * other EGC translation adapter does -- cline-guardian-adapter.js (with its
 * `./pre-bash-guardian-validate` and `../lib/adapter-stdin-json` requires)
 * is instead installed at the normal .clinerules/scripts/hooks/ location,
 * alongside its own copied dependencies, and this shim just spawns it with
 * stdin/stdout/stderr passed through unchanged.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Cline spawns this file with the PreToolUse event JSON on stdin. Read it
// fully upfront (synchronously -- this whole shim is a small, blocking
// relay) so it can be forwarded to the real adapter via spawnSync's `input`
// option below; a blank/unreadable stdin is passed through as an empty
// string and left for the adapter's own fail-open-on-malformed-input logic
// to handle, the same as if it had been invoked directly.
let stdin = '';
try {
  stdin = fs.readFileSync(0, 'utf8');
} catch {
  stdin = '';
}

const target = path.join(__dirname, '..', 'scripts', 'hooks', 'cline-guardian-adapter.js');
const result = spawnSync(process.execPath, [target], { input: stdin, encoding: 'utf8' });

// Deliberately NOT stdio: 'inherit' -- the real failure mode this guards
// against (cubic-dev-ai P0 finding, PR #1087) isn't just "spawn couldn't
// launch node at all" (result.error), it's node launching fine and then
// crashing before printing anything (missing/broken target file, a
// MODULE_NOT_FOUND from a partial install, ...): with stdio: 'inherit'
// that leaves stdout genuinely empty with some exit code, which Cline
// treats as an unconditional ALLOW ("no JSON response found" -> no
// cancellation) -- the Guardian would silently stop protecting anything.
// So the child's stdout is captured and validated as JSON before being
// passed through; anything else (empty, malformed, a crash) falls back to
// an explicit {cancel: true} emitted by this shim itself, since Guardian
// is a security boundary and an infra failure must fail CLOSED here, the
// same policy as every other infra-crash path in this repo
// (lesson-1785035260946).
const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
let parsed = null;
if (stdout) {
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
}

if (parsed && typeof parsed === 'object') {
  process.stdout.write(stdout);
  process.exitCode = 0;
} else {
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  const reason = result.error
    ? result.error.message
    : `the validator exited without a usable response (code ${result.status ?? 'unknown'})`;
  process.stdout.write(JSON.stringify({
    cancel: true,
    errorMessage: `EGC Guardian could not run: ${reason}.`,
  }));
  process.exitCode = 1;
}
