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
  // Buffered as raw bytes (no setEncoding) and only decoded to a UTF-8
  // string once, in the 'end' handler. String.prototype.length counts
  // UTF-16 code units, not bytes, so accumulating into a string and
  // capping on .length let multibyte payloads exceed the stated 1 MiB byte
  // cap without ever being marked truncated (EGC-539 / cubic review on
  // PR #1135). truncated is only set when a chunk is actually cut short or
  // more data arrives after the cap is already reached -- a payload that
  // lands exactly at MAX_STDIN bytes with nothing discarded stays untruncated.
  const chunks = [];
  let totalBytes = 0;
  let truncated = false;
  let done = false;
  const complete = result => {
    if (done) return;
    done = true;
    onComplete(result);
  };

  process.stdin.on('data', chunk => {
    if (totalBytes >= MAX_STDIN) {
      truncated = true;
      return;
    }
    const remaining = MAX_STDIN - totalBytes;
    if (chunk.length <= remaining) {
      chunks.push(chunk);
      totalBytes += chunk.length;
    } else {
      chunks.push(chunk.subarray(0, remaining));
      totalBytes += remaining;
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
    const raw = Buffer.concat(chunks).toString('utf8');
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
      // process.exitCode (not process.exit()) so Node drains stderr
      // naturally: on POSIX a forced exit can race the pipe write and
      // truncate the diagnostic message before the host reads it -- the
      // same cubic-dev-ai finding already applied to the JSON-envelope
      // contract (see cursor-guardian-adapter.js's respond()), now applied
      // here for the plain-exit-code contract's 5 hosts (EGC-539 audit).
      // The exit code (the actual security decision) was never at risk --
      // Node still delivers it synchronously either way -- only the
      // stderr diagnostic could race and truncate under process.exit().
      process.exitCode = 2;
      return;
    }
    if (!ok) {
      process.exitCode = 0;
      return;
    }

    const guardianInput = buildGuardianInput(value);
    if (!guardianInput) {
      process.exitCode = 0;
      return;
    }

    const result = runGuardian(guardianInput);
    if (result.exitCode === 2) {
      const reason = result.stderr || 'Blocked by the EGC Guardian.';
      process.stderr.write(reason.endsWith('\n') ? reason : `${reason}\n`);
      process.exitCode = 2;
      return;
    }

    process.exitCode = 0;
  });
}

// Shared entrypoint for the plain-exit-code adapters (Amazon Q, Goose,
// OpenHands, Kiro, Windsurf): collapses each adapter's identical "run when
// invoked directly, always export buildGuardianInput for tests" boilerplate
// into one call, so those near-identical translation scripts stop
// duplicating it verbatim. Each host keeps its own buildGuardianInput (their
// wire contracts differ), only the wiring around it is shared.
function bootstrapPlainExitCodeAdapter({ isMain, buildGuardianInput, runGuardian }) {
  if (isMain) {
    runPlainExitCodeGuardianAdapter(buildGuardianInput, runGuardian);
  }
  return { buildGuardianInput };
}

// Shared main() body for host adapters that need a JSON envelope on stdout
// (not a plain exit code) -- Cline ({cancel, errorMessage}), Junie
// ({decision, reason}), Cursor ({permission, user_message, agent_message}).
// Each host's own translation differs only in buildGuardianInput (event ->
// Guardian input) and respond (blocked: boolean, message?: string) -> writes
// its own envelope shape. The truncation/ok/blocked control flow itself was
// duplicated three times before this (EGC-539 audit, Finding 3).
function runJsonEnvelopeGuardianAdapter(buildGuardianInput, runGuardian, respond) {
  readAdapterStdinJson(({ ok, truncated, value }) => {
    // Checked before `ok`, unconditionally: a capped-length prefix can still
    // happen to be syntactically valid JSON, so a truncated payload always
    // fails closed regardless of whether JSON.parse happened to succeed on
    // what remained.
    if (truncated) {
      respond(true, 'EGC Guardian BLOCKED this command: the event payload exceeded the size ' +
        'this validator can safely read, so it could not be parsed or validated. ' +
        'Simplify the command.');
      return;
    }
    if (!ok) {
      respond(false);
      return;
    }

    const guardianInput = buildGuardianInput(value);
    if (!guardianInput) {
      respond(false);
      return;
    }

    const result = runGuardian(guardianInput);
    if (result.exitCode === 2) {
      respond(true, result.stderr || 'Blocked by the EGC Guardian.');
      return;
    }

    respond(false);
  });
}

// Amazon Q, Goose, and OpenHands all deliver {tool_name, tool_input:
// {command}, <cwdKey>} on stdin for their shell tool, differing only in
// the shell tool's name and which top-level field carries the working
// directory -- this builds the translation function each adapter exports
// as buildGuardianInput, instead of every host repeating the same four
// guard checks with different literals.
function createBashToolGuardianInputMapper({ shellToolName, cwdKey }) {
  return function buildGuardianInput(event) {
    if (!event || typeof event !== 'object') {
      return null;
    }
    if (event.tool_name !== shellToolName) {
      return null;
    }
    const command = event.tool_input?.command;
    if (!command || typeof command !== 'string') {
      return null;
    }
    const input = { tool_name: 'Bash', tool_input: { command } };
    const cwdValue = event[cwdKey];
    if (typeof cwdValue === 'string') {
      input.cwd = cwdValue;
    }
    return input;
  };
}

module.exports = {
  MAX_STDIN,
  bootstrapPlainExitCodeAdapter,
  createBashToolGuardianInputMapper,
  readAdapterStdinJson,
  runJsonEnvelopeGuardianAdapter,
  runPlainExitCodeGuardianAdapter,
};
