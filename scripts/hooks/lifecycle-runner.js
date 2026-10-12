#!/usr/bin/env node
'use strict';

// Runs one lifecycle hook (PreCompact, Stop, SessionEnd) through run-with-flags.js.
// Arguments: hook id and target script. Both only select and cross-check an entry of
// lifecycle-hooks.json; the profiles, timeout and the exit status used when the child
// reports none come from that table, so nothing taken from the command line ever
// reaches the spawned process.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, 'lifecycle-hooks.json'), 'utf8'));
const raw = fs.readFileSync(0, 'utf8');
const root = path.resolve(__dirname, '..', '..');
const runner = path.join(root, 'scripts', 'hooks', 'run-with-flags.js');

const hookId = Object.keys(hooks).find(id => id === process.argv[2]);
const entry = hookId && hooks[hookId].target === process.argv[3] ? hooks[hookId] : null;

if (!entry || !fs.existsSync(runner)) {
  if (!entry) process.stderr.write('[hook error] lifecycle-runner does not know this hook id and script\n');
  process.stdout.write(raw);
  process.exit(0);
}

const result = spawnSync(process.execPath, [runner, hookId, entry.target, entry.profiles], {
  input: raw,
  encoding: 'utf8',
  env: process.env,
  cwd: process.cwd(),
  timeout: entry.timeoutMs,
});

const stdout = typeof result.stdout === 'string' ? result.stdout : '';
process.stdout.write(stdout || raw);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) process.stderr.write(`[hook error] ${result.error.message}\n`);
process.exit(typeof result.status === 'number' ? result.status : entry.fallbackStatus);
