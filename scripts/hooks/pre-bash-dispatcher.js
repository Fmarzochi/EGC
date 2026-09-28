#!/usr/bin/env node
'use strict';

const { runPreBash, resolvePreOutput, failClosedOutput, overLimitOutput } = require('./bash-hook-dispatcher');
const { readHookInput } = require('../lib/guardian-bin');

readHookInput(({ raw, truncated }) => {
  if (truncated) {
    process.stdout.write(overLimitOutput());
    process.exitCode = 0;
    return;
  }
  try {
    const result = runPreBash(raw);
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.stdout.write(resolvePreOutput(raw, result));
    process.exitCode = result.exitCode;
  } catch (error) {
    // Pre mode gates security: a dispatcher crash must fail closed (deny),
    // never silently allow the command.
    process.stderr.write(`[Hook] pre-bash-dispatcher failed: ${error.message}\n`);
    process.stdout.write(failClosedOutput('pre'));
    process.exitCode = 0;
  }
});
