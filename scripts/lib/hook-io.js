'use strict';

// Shared stdin/JSON plumbing for guardian hooks. Every hook receives the
// harness payload as JSON on stdin, exposes run(inputOrRaw) for in-process
// execution via run-with-flags, and needs identical standalone behavior.

const { MAX_STDIN, exitOnTruncatedInput, readHookStdin } = require('./hook-stdin');

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

function runStandalone(run, { echoInput = true, blockExitCode = 2 } = {}) {
  readHookStdin(({ raw, truncated }) => {
    exitOnTruncatedInput(truncated, 0);
    const result = run(raw) || {};
    if (result.stderr) process.stderr.write(result.stderr + '\n');
    if (result.exitCode === blockExitCode) process.exit(blockExitCode);
    if (typeof result.stdout === 'string') {
      if (result.stdout) process.stdout.write(result.stdout + '\n');
    } else if (echoInput) {
      process.stdout.write(raw);
    }
    process.exit(0);
  });
}

module.exports = { MAX_STDIN, parseInput, runStandalone, readHookStdin };
