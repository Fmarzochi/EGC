#!/usr/bin/env node
/**
 * Installed verbatim as .clinerules/hooks/PreToolUse (Unix, executable).
 *
 * Cline discovers this file by its exact filename, not by a require()'d
 * module, so it cannot live next to its own dependencies the way every
 * other EGC translation adapter does -- cline-guardian-adapter.js (with its
 * `./pre-bash-guardian-validate` and `../lib/adapter-stdin-json` requires)
 * is instead installed at the normal .clinerules/scripts/hooks/ location,
 * alongside its own copied dependencies, and this shim just spawns it,
 * relaying stdin in and stdout out.
 */

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
// NOT '../lib/adapter-stdin-json': this shim is installed at <root>/hooks/
// PreToolUse, a sibling of <root>/scripts/ (not inside it) -- unlike
// cline-guardian-adapter.js, which lives at <root>/scripts/hooks/ and so
// reaches the same file via '../lib/adapter-stdin-json'. Confirmed via a
// real isolated install; see cline-project.js's copy operation for this
// exact destination.
const { readAdapterStdinJson } = require('../scripts/lib/adapter-stdin-json');

function respond(cancel, errorMessage) {
  process.exitCode = cancel ? 1 : 0;
  process.stdout.write(JSON.stringify(errorMessage ? { cancel, errorMessage } : { cancel }));
}

// Validates the target's stdout the same way Cline's own validateHookOutput
// does: cancel must be present and boolean. typeof [] === 'object' in JS,
// so a bare object/array check isn't enough -- an array or a {}-with-no-
// cancel-field response would otherwise be relayed as-is and, since Cline
// treats a missing cancel as "no cancellation," silently turn into an
// allow (cubic-dev-ai finding, PR #1087).
function isUsableHookOutput(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof value.cancel === 'boolean';
}

readAdapterStdinJson(({ truncated, ok, value }) => {
  // Reuses the same 1 MiB cap every other EGC translation adapter enforces
  // on its own stdin, instead of this shim's own fs.readFileSync(0) buffering
  // an unbounded payload in full before the real adapter ever gets a chance
  // to apply that same guard (cubic-dev-ai finding, PR #1087).
  if (truncated) {
    respond(true, 'EGC Guardian BLOCKED this command: the event payload exceeded the size ' +
      'this validator can safely read, so it could not be parsed or validated. ' +
      'Simplify the command.');
    return;
  }

  // Re-serialized rather than relaying the raw bytes: readAdapterStdinJson
  // already fully consumed stdin above, so there is nothing left to pipe
  // through a second time. Malformed (ok: false) input becomes an empty
  // string, which the real adapter's own readAdapterStdinJson call treats
  // exactly the same way it would if invoked directly (fails open).
  const stdinPayload = ok ? JSON.stringify(value) : '';

  const target = path.join(__dirname, '..', 'scripts', 'hooks', 'cline-guardian-adapter.js');
  const result = spawnSync(process.execPath, [target], { input: stdinPayload, encoding: 'utf8' });

  // The real failure mode this guards against (cubic-dev-ai P0 finding,
  // PR #1087) isn't just "spawn couldn't launch node at all" (result.error),
  // it's node launching fine and then crashing before printing anything
  // (missing/broken target file, a MODULE_NOT_FOUND from a partial install,
  // ...): with stdio: 'inherit' that would leave stdout genuinely empty
  // with some exit code, which Cline treats as an unconditional ALLOW ("no
  // JSON response found" -> no cancellation) -- the Guardian would silently
  // stop protecting anything. So the child's stdout is captured and
  // validated before being passed through; anything else (empty,
  // malformed, wrong shape, a crash) falls back to an explicit
  // {cancel: true} emitted by this shim itself, since Guardian is a
  // security boundary and an infra failure must fail CLOSED here, the same
  // policy as every other infra-crash path in this repo
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

  if (isUsableHookOutput(parsed)) {
    process.stdout.write(stdout);
    process.exitCode = 0;
    return;
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  const reason = result.error
    ? result.error.message
    : `the validator exited without a usable response (code ${result.status ?? 'unknown'})`;
  respond(true, `EGC Guardian could not run: ${reason}.`);
});
