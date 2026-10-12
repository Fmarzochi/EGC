#!/usr/bin/env node
'use strict';

// Runs one lifecycle hook (PreCompact, Stop, SessionEnd) through run-with-flags.js.
// Arguments: hook id, target script, profiles, timeout in ms, exit status when the
// child reports none. The hook command in hooks.json finds this file with the
// shared resolver, so the EGC root is the one this file lives in.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [, , hookId, target, profiles, timeoutArg, fallbackArg] = process.argv;
const raw = fs.readFileSync(0, 'utf8');
const root = path.resolve(__dirname, '..', '..');
const runner = path.join(root, 'scripts', 'hooks', 'run-with-flags.js');

if (!fs.existsSync(runner)) {
  process.stdout.write(raw);
  process.exit(0);
}

const result = spawnSync(process.execPath, [runner, hookId, target, profiles], {
  input: raw,
  encoding: 'utf8',
  env: process.env,
  cwd: process.cwd(),
  timeout: Number(timeoutArg),
});

const stdout = typeof result.stdout === 'string' ? result.stdout : '';
process.stdout.write(stdout || raw);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) process.stderr.write(`[hook error] ${result.error.message}\n`);
process.exit(typeof result.status === 'number' ? result.status : Number(fallbackArg));
