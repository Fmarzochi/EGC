#!/usr/bin/env node
'use strict';

// egc run <command...>: executes the command, crushes noisy output before it
// reaches the model, and records the savings locally. Exit code, stderr and
// small outputs pass through untouched. `egc run --raw <command...>` is the
// escape hatch that skips crushing entirely. `egc run --shell <command...>`
// runs the joined command through bash so pipelines and compound commands keep
// their exact semantics while their output still gets crushed.

const { spawnSync } = require('node:child_process');
const { writeSync } = require('node:fs');
const { crushOutput } = require('./lib/crusher/engine');
const { record } = require('./lib/crusher/metrics');

const SPAWN_OPTIONS = {
  encoding: 'utf8',
  stdio: ['inherit', 'pipe', 'inherit'],
  maxBuffer: 64 * 1024 * 1024,
};

function runCommand(commandArgs, shell, raw) {
  // A command covered by the PATH-level binary shim (git, npm, ...) resolves
  // to the shim, not the real binary, regardless of this flag: the shim runs
  // as an independent child process and would compress the output itself
  // before crush-run.js ever sees it. EGC_CRUSHER_RAW tells the shim to
  // passthrough instead, so --raw actually reaches stdout raw end-to-end.
  const options = raw ? { ...SPAWN_OPTIONS, env: { ...process.env, EGC_CRUSHER_RAW: '1' } } : SPAWN_OPTIONS;
  if (shell) {
    // The rewrite hook passes the full command line as a single argument, so the
    // platform shell (/bin/sh on POSIX, cmd.exe on Windows) re-parses it exactly
    // as the caller's shell would have. shell: true keeps this portable instead
    // of hardcoding a bash path that does not exist on every OS.
    return spawnSync(commandArgs.join(' '), { ...options, shell: true });
  }
  return spawnSync(commandArgs[0], commandArgs.slice(1), { ...options, shell: false });
}

function main() {
  const args = process.argv.slice(2);
  const raw = args[0] === '--raw';
  const shell = args[0] === '--shell';
  const commandArgs = (raw || shell) ? args.slice(1) : args;

  if (commandArgs.length === 0 || commandArgs[0] === '--help') {
    console.log('Usage: egc run [--raw|--shell] <command> [args...]\n\nRuns the command and compresses noisy output before it reaches the model.\n--raw skips compression. --shell runs the command through bash (pipelines allowed).');
    process.exit(commandArgs.length === 0 ? 1 : 0);
  }

  const result = runCommand(commandArgs, shell, raw);

  if (result.error) {
    console.error(`egc run: ${result.error.message}`);
    process.exit(127);
  }

  const stdout = result.stdout || '';
  const commandLine = commandArgs.join(' ');
  const crushed = raw ? null : crushOutput(commandLine, stdout);

  // fs.writeSync(1, ...), not process.stdout.write(), matters here: stdout to
  // a pipe is asynchronous on POSIX, and the process.exit() a few lines below
  // does not wait for a pending write to flush. That truncated the tail of
  // large output non-deterministically by OS and Node version (confirmed as
  // a real CI flake on macOS + Node 20.x, audit EGC-521). fs.writeSync is a
  // genuine blocking syscall, so nothing is left pending when this exits.
  if (crushed) {
    writeSync(1, crushed.crushed + '\n');
    record({
      cmd: commandLine.trim().split(/\s+/)[0],
      kind: crushed.kind,
      bytesIn: crushed.bytesIn,
      bytesOut: crushed.bytesOut,
      tokensSaved: crushed.tokensSaved,
    });
  } else if (stdout) {
    writeSync(1, stdout);
  }

  process.exit(typeof result.status === 'number' ? result.status : 1);
}

main();
