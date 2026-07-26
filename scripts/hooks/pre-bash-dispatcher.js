#!/usr/bin/env node
'use strict';

const { runPreBash, resolvePreOutput, failClosedOutput } = require('./bash-hook-dispatcher');

let raw = '';
const MAX_STDIN = 1024 * 1024;

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) {
    const remaining = MAX_STDIN - raw.length;
    raw += chunk.substring(0, remaining);
  }
});

process.stdin.on('end', () => {
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
