#!/usr/bin/env node
/**
 * InsAIts Security Monitor — wrapper for run-with-flags compatibility.
 *
 * This thin wrapper receives stdin from the hooks infrastructure and
 * delegates to the Python-based insaits-security-monitor.py script.
 *
 * The wrapper exists because run-with-flags.js spawns child scripts
 * via `node`, so a JS entry point is needed to bridge to Python.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const MAX_STDIN = 1024 * 1024;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) {
    raw += chunk.substring(0, MAX_STDIN - raw.length);
  }
});

process.stdin.on('end', () => {
  const scriptDir = __dirname;
  const pyScript = path.join(scriptDir, 'insaits-security-monitor.py');

  // Try python3 first (macOS/Linux), fall back to python (Windows)
  const pythonCandidates = ['python3', 'python'];
  let result;

  for (const pythonBin of pythonCandidates) {
    result = spawnSync(pythonBin, [pyScript], {
      input: raw,
      encoding: 'utf8',
      env: process.env,
      cwd: process.cwd(),
      timeout: 14000,
    });

    // ENOENT means binary not found — try next candidate
    if (result.error && result.error.code === 'ENOENT') {
      continue;
    }
    break;
  }

  if (!result || (result.error && result.error.code === 'ENOENT')) {
    process.stderr.write('[InsAIts] python3/python not found. Install Python 3.9+ and: pip install insa-its\n');
    process.stdout.write(raw);
    process.exit(0);
  }

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const code = Number.isInteger(result.status) ? result.status : 0;
  process.exit(code);
});
