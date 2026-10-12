#!/usr/bin/env node
'use strict';

const { runPostBash } = require('./bash-hook-dispatcher');
const { readHookStdin } = require('../lib/hook-stdin');

readHookStdin(async ({ raw }) => {
  try {
    const result = await runPostBash(raw);
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
  } catch (error) {
    // Post hooks are observational and cannot gate a command, so a crash is
    // safe to swallow (fail open) rather than surface a spurious failure.
    process.stderr.write(`[Hook] post-bash-dispatcher failed: ${error.message}\n`);
    process.exitCode = 0;
  }
});
