#!/usr/bin/env node
'use strict';

const { runPostBash } = require('./bash-hook-dispatcher');

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
    const result = runPostBash(raw);
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
