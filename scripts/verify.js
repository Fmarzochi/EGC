#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { writeReceipt, receiptPath } = require('./lib/verify-receipt');

const LOG_TAIL_LIMIT = 4000;

function showHelp(exitCode = 0) {
  console.log(`
Usage: egc verify [--json] [-- <command> [args...]]

Runs the project's verification command and records a receipt bound to
the current working tree. The verification gate hook consults this
receipt before git commit and git push.

Command resolution:
  1. Everything after "--" is executed as-is.
  2. Otherwise, if package.json defines a "test" script, "npm test" runs.

Options:
  --json      Emit the written receipt as JSON
  --help, -h  Show this help
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = { json: false, help: false, command: null };
  const separatorIndex = args.indexOf('--');

  const ownArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
  if (separatorIndex !== -1) {
    const commandArgs = args.slice(separatorIndex + 1);
    if (commandArgs.length === 0) {
      throw new Error('No command provided after "--"');
    }
    parsed.command = commandArgs;
  }

  for (const arg of ownArgs) {
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function resolveDefaultCommand(projectPath) {
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (typeof manifest?.scripts?.test === 'string') {
        return ['npm', 'test'];
      }
    } catch {
      // Fall through to the guidance error below.
    }
  }
  return null;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  if (options.help) {
    showHelp(0);
  }

  const projectPath = process.cwd();
  const command = options.command || resolveDefaultCommand(projectPath);
  if (!command) {
    console.error('Error: no verification command found.');
    console.error('Pass one explicitly: egc verify -- <command> [args...]');
    process.exit(1);
  }

  const startedAt = Date.now();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: projectPath,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }

  const exitCode = result.error ? 1 : (result.status ?? 1);
  const errorSuffix = result.error ? `\n${result.error.message}` : '';
  const combined = stdout + stderr + errorSuffix;
  const receipt = writeReceipt(projectPath, {
    command: command.join(' '),
    exitCode,
    durationMs: Date.now() - startedAt,
    logTail: exitCode === 0 ? undefined : combined.slice(-LOG_TAIL_LIMIT),
  });

  if (options.json) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    const label = exitCode === 0 ? 'PASS' : `FAIL (exit ${exitCode})`;
    console.error(`\n[egc verify] ${label}: receipt written to ${receiptPath(projectPath)}`);
  }

  process.exit(exitCode);
}

main();
