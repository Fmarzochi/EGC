#!/usr/bin/env node
'use strict';

/**
 * session-start-bootstrap.js
 *
 * Bootstrap loader for the EGC SessionStart hook.
 *
 * Problem this solves: the previous approach embedded this logic as an inline
 * `node -e "..."` string inside hooks.json. Characters like `!` (used in
 * `!org.isDirectory()`) can trigger bash history expansion or other shell
 * interpretation issues depending on the environment, causing
 * "SessionStart:startup hook error" to appear in the Claude Code CLI header.
 *
 * By extracting to a standalone file, the shell never sees the JavaScript
 * source and the `!` characters are safe. Behaviour is otherwise identical.
 *
 * How it works:
 *   1. Reads the raw JSON event from stdin (passed by Claude Code).
 *   2. Takes the EGC root it lives in: the hook command already found it
 *      with the shared resolver.
 *   3. Delegates to `scripts/hooks/run-with-flags.js` with the `session:start`
 *      event, which applies hook-profile gating and then runs session-start.js.
 *   4. Passes stdout/stderr through and forwards the child exit code.
 *   5. If the runner is missing from that root, emits a warning and passes stdin
 *      through unchanged so Claude Code can continue normally.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const raw = fs.readFileSync(0, 'utf8');

// Path (relative to plugin root) to the hook runner
const rel = path.join('scripts', 'hooks', 'run-with-flags.js');

// The hook command found this file under the EGC root with the shared
// resolver (scripts/lib/resolve-egc-root.js); the runner sits in that root.
const root = path.resolve(__dirname, '..', '..');
const script = path.join(root, rel);

if (fs.existsSync(script)) {
  const result = spawnSync(
    process.execPath,
    [script, 'session:start', 'scripts/hooks/session-start.js', 'minimal,standard,strict'],
    {
      input: raw,
      encoding: 'utf8',
      env: process.env,
      cwd: process.cwd(),
      timeout: 30000,
    }
  );

  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  if (stdout) {
    process.stdout.write(stdout);
  } else {
    process.stdout.write(raw);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error || result.status === null || result.signal) {
    let reason;
    if (result.error) {
      reason = result.error.message;
    } else if (result.signal) {
      reason = 'signal ' + result.signal;
    } else {
      reason = 'missing exit status';
    }
    process.stderr.write('[SessionStart] ERROR: session-start hook failed: ' + reason + '\n');
    process.exit(1);
  }

  process.exit(Number.isInteger(result.status) ? result.status : 0);
}

process.stderr.write(
  '[SessionStart] WARNING: could not resolve EGC plugin root; skipping session-start hook\n'
);
process.stdout.write(raw);
