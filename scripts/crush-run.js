#!/usr/bin/env node
'use strict';

// egc run <command...>: executes the command, crushes noisy output before it
// reaches the model, and records the savings locally. Exit code, stderr and
// small outputs pass through untouched. `egc run --raw <command...>` is the
// escape hatch that skips crushing entirely. `egc run --shell <command...>`
// runs the joined command through bash so pipelines and compound commands keep
// their exact semantics while their output still gets crushed.

const { spawnSync } = require('node:child_process');
const { crushOutput } = require('./lib/crusher/engine');
const { record } = require('./lib/crusher/metrics');

const SPAWN_OPTIONS = {
  encoding: 'utf8',
  stdio: ['inherit', 'pipe', 'inherit'],
  maxBuffer: 64 * 1024 * 1024,
};

function runCommand(commandArgs, shell) {
  if (shell) {
    // The rewrite hook passes the full command line as a single argument, so
    // bash -c re-parses it exactly as the original shell would have.
    return spawnSync(commandArgs.join(' '), { ...SPAWN_OPTIONS, shell: '/bin/bash' });
  }
  return spawnSync(commandArgs[0], commandArgs.slice(1), { ...SPAWN_OPTIONS, shell: false });
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

  const result = runCommand(commandArgs, shell);

  if (result.error) {
    console.error(`egc run: ${result.error.message}`);
    process.exit(127);
  }

  const stdout = result.stdout || '';
  const commandLine = commandArgs.join(' ');
  const crushed = raw ? null : crushOutput(commandLine, stdout);

  if (crushed) {
    process.stdout.write(crushed.crushed + '\n');
    record({
      cmd: commandLine.trim().split(/\s+/)[0],
      kind: crushed.kind,
      bytesIn: crushed.bytesIn,
      bytesOut: crushed.bytesOut,
      tokensSaved: crushed.tokensSaved,
    });
  } else if (stdout) {
    process.stdout.write(stdout);
  }

  process.exit(typeof result.status === 'number' ? result.status : 1);
}

main();
