'use strict';

// Token Crusher binary shim dispatcher. A tiny per-binary launcher file
// (e.g. ~/.egc/bin/git) calls runShim(name, args) with its own hardcoded
// name. This runs completely independently of any AI harness's hook
// contract: it IS the binary that gets exec'd, via normal shell PATH
// resolution, so it works for a human's terminal, an AI tool's subprocess
// capture, a CI script, or anything else that shells out -- the exact gap
// left by the PreToolUse rewrite being silently ignored for assistant-issued
// Bash calls in Claude Code (see bootstrap-cognitive.js).
//
// Fails open at every step:
//   - Real binary not resolvable -> "command not found", same as no shim.
//   - stdout is a TTY (a human at an interactive terminal) -> full
//     passthrough, untouched. There is no model context to save there, and
//     buffering instead of streaming would break progress bars/prompts.
//   - Engine/metrics modules unavailable, or the command kind is 'generic'
//     -> full passthrough, zero capture, zero behavior change.
//   - Any unexpected error at any point -> full passthrough.

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveRealBinary } = require('./shim-paths');

const SPAWN_OPTIONS = {
  encoding: 'utf8',
  stdio: ['inherit', 'pipe', 'inherit'],
  maxBuffer: 64 * 1024 * 1024,
};

function passthrough(realBinary, args) {
  const result = spawnSync(realBinary, args, { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`${path.basename(realBinary)}: ${result.error.message}\n`);
    process.exit(127);
  }
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

function loadCrusher() {
  try {
    return { ...require('./engine'), ...require('./metrics') };
  } catch {
    return null;
  }
}

function runShim(name, args) {
  const realBinary = resolveRealBinary(name);
  if (!realBinary) {
    process.stderr.write(`${name}: command not found\n`);
    process.exit(127);
  }

  if (process.stdout.isTTY) {
    return passthrough(realBinary, args);
  }

  const crusher = loadCrusher();
  const commandLine = [name, ...args].join(' ');
  if (!crusher || crusher.commandKind(commandLine) === 'generic') {
    return passthrough(realBinary, args);
  }

  const result = spawnSync(realBinary, args, SPAWN_OPTIONS);
  if (result.error) {
    process.stderr.write(`${name}: ${result.error.message}\n`);
    process.exit(127);
  }

  const stdout = result.stdout || '';
  let crushed;
  try {
    crushed = crusher.crushOutput(commandLine, stdout);
  } catch {
    crushed = null;
  }

  if (crushed) {
    process.stdout.write(crushed.crushed + '\n');
    crusher.record({
      cmd: name,
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

// Windows launchers (.cmd) cannot shebang directly into this file the way a
// POSIX launcher does, so they spawn `node shim-dispatch.js <name> <args...>`
// as a separate process instead of requiring runShim() in-process.
if (require.main === module) {
  runShim(process.argv[2], process.argv.slice(3));
}

module.exports = { runShim };
