'use strict';

// Shared truncation-aware stdin JSON reader for host-hook adapters
// (Windsurf, Cursor, and future hosts with the same "one JSON event object
// on stdin" contract). A parse failure caused by hitting the size cap is
// not the same as ordinary malformed input: an attacker can pad a command
// past MAX_STDIN specifically to land here and dodge validation. Callers
// get a `truncated` flag so they can fail closed on that case while still
// failing open on genuinely malformed (non-truncated) input, matching the
// policy every adapter using this module needs.

const MAX_STDIN = 1024 * 1024;

function readAdapterStdinJson(onComplete) {
  let raw = '';
  let truncated = false;
  let done = false;
  const complete = result => {
    if (done) return;
    done = true;
    onComplete(result);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      raw += chunk.substring(0, MAX_STDIN - raw.length);
    }
    if (raw.length >= MAX_STDIN) {
      truncated = true;
    }
  });
  // Without this, a stream error (e.g. the parent process closing the pipe
  // abruptly) leaves onComplete never called -- the adapter hangs, and since
  // stdin is an EventEmitter, an 'error' event with no listener throws an
  // uncaught exception by default. Fails open (ok: false), matching every
  // other unreadable-input path this reader already has.
  process.stdin.on('error', () => complete({ ok: false, truncated }));
  process.stdin.on('end', () => {
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      complete({ ok: false, truncated });
      return;
    }
    complete({ ok: true, truncated, value });
  });
}

// Shared main() body for host adapters that block with a plain exit-code-2-
// plus-stderr contract (Windsurf, Kiro) -- as opposed to Cursor, which also
// needs a {permission, ...} JSON envelope on stdout and so builds its own
// main() around readAdapterStdinJson directly instead of this helper.
// buildGuardianInput: (parsedEvent) => Guardian input object | null.
// runGuardian: pre-bash-guardian-validate.js's own run().
function runPlainExitCodeGuardianAdapter(buildGuardianInput, runGuardian) {
  readAdapterStdinJson(({ ok, truncated, value }) => {
    // Checked before `ok`, unconditionally: a capped-length prefix can
    // still happen to be syntactically valid JSON (e.g. the cut lands
    // exactly at the end of a complete value), which previously reached
    // the `ok: true` branch below with truncated data treated as trusted.
    // Any truncated payload is unanalyzable -- some of what the caller
    // sent was discarded -- so it always fails closed, regardless of
    // whether JSON.parse happened to succeed on what remained.
    if (truncated) {
      process.stderr.write(
        'EGC Guardian BLOCKED this command: the event payload exceeded the size ' +
        'this validator can safely read, so it could not be parsed or validated. ' +
        'Simplify the command.\n'
      );
      process.exit(2);
    }
    if (!ok) {
      process.exit(0);
    }

    const guardianInput = buildGuardianInput(value);
    if (!guardianInput) {
      process.exit(0);
    }

    const result = runGuardian(guardianInput);
    if (result.exitCode === 2) {
      const reason = result.stderr || 'Blocked by the EGC Guardian.';
      process.stderr.write(reason.endsWith('\n') ? reason : `${reason}\n`);
      process.exit(2);
    }

    process.exit(0);
  });
}

// Shared entrypoint for the plain-exit-code adapters (Amazon Q, Goose,
// OpenHands -- Kiro predates this helper and keeps its own inline copy):
// collapses each adapter's identical "run when invoked directly, always
// export buildGuardianInput for tests" boilerplate into one call, so those
// three near-identical translation scripts stop duplicating it verbatim.
function bootstrapPlainExitCodeAdapter({ isMain, buildGuardianInput, runGuardian }) {
  if (isMain) {
    runPlainExitCodeGuardianAdapter(buildGuardianInput, runGuardian);
  }
  return { buildGuardianInput };
}

module.exports = {
  MAX_STDIN,
  bootstrapPlainExitCodeAdapter,
  readAdapterStdinJson,
  runPlainExitCodeGuardianAdapter,
};
