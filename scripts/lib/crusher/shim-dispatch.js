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
//   - Resolution that would re-enter the shim itself (seen under HOME
//     overrides that hide the manifest) -> rejected up front by physical
//     path, and a child that still turns out to be the shim exits 127 at
//     depth 1 instead of recursing (see refuseDirectRecursion).

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeSync } = require('node:fs');
const { resolveRealBinary, realpathOrResolve } = require('./shim-paths');

const SPAWN_OPTIONS = {
  encoding: 'utf8',
  stdio: ['inherit', 'pipe', 'inherit'],
  maxBuffer: 64 * 1024 * 1024,
};

// npm, yarn, pnpm, corepack-shimmed bun etc. ship as .cmd/.bat wrappers on
// Windows, not native .exe binaries. Node's spawn/spawnSync cannot launch a
// .cmd/.bat directly without a shell (a well-documented Windows-only
// child_process gotcha) -- shell: true is the standard fix, same as the
// cross-spawn package uses for the same reason.
function needsShellOnWindows(binaryPath) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath);
}

// A child killed by a signal (Ctrl+C/SIGINT, SIGTERM, ...) has result.status
// === null and result.signal set. Re-raising the same signal on this
// process (rather than exiting with a made-up status code) makes it
// terminate the same way the real binary did, so a parent shell or process
// manager watching for that signal sees the standard 128+n convention
// instead of an opaque, unrelated exit code.
function exitLikeChild(result) {
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

// The physical directory of the launcher for this exact invocation, immune
// to HOME/USERPROFILE overrides -- which is what makes it a trustworthy
// "never resolve back into here" anchor, unlike anything derived from
// os.homedir() (see resolveRealBinary in shim-paths). On POSIX the shebang
// launcher require()s this module, so process.argv[1] is the launcher file.
// The Windows .cmd spawns `node shim-dispatch.js <name>` instead (argv[1]
// is this module, not the launcher), so the .cmd bakes its own directory
// into EGC_SHIM_LAUNCHER_DIR via %~dp0 -- that wins when present.
function launcherDir() {
  if (process.env.EGC_SHIM_LAUNCHER_DIR) return realpathOrResolve(process.env.EGC_SHIM_LAUNCHER_DIR);
  // realpath the launcher FILE before dirname: a launcher reached through a
  // symlink (say /usr/local/bin/npm -> ~/.egc/bin/npm) must anchor to the
  // physical shim directory, not to wherever the symlink happens to live.
  return process.argv[1] ? path.dirname(realpathOrResolve(process.argv[1])) : null;
}

// Last line of defense against the shim spawning itself: if resolution
// still handed back the shim, the child sees its own name recorded by its
// direct parent and stops at depth 1 instead of forking until the machine's
// OOM killer steps in. A legitimate nested invocation (an npm script
// running npm) never trips this: the pid recorded by the outer shim is the
// shim's own, not the real binary that spawned the inner one.
// Known limitation: on Windows the .cmd launcher interposes a cmd.exe hop,
// so process.ppid is the intermediate cmd.exe and the recorded pid never
// matches -- this breaker cannot fire there. The physical-anchor exclusion
// (launcherDir / EGC_SHIM_LAUNCHER_DIR) is the effective defense on that
// platform; bridging the pid chain across cmd.exe would need a per-call
// process walk that costs more than it protects.
function refuseDirectRecursion(name) {
  if (process.env.EGC_SHIM_PENDING !== `${name}:${process.ppid}`) return;
  process.stderr.write(
    `${name}: the EGC Token Crusher shim resolved to itself and refused to recurse ` +
    `(usually a HOME override hiding the shim's manifest). Re-run 'egc crusher-shim install' ` +
    `to rebuild the manifest, or drop the shim directory from PATH for this command.\n`
  );
  process.exit(127);
}

function childEnv(name) {
  return { ...process.env, EGC_SHIM_PENDING: `${name}:${process.pid}` };
}

function passthrough(name, realBinary, args) {
  const result = spawnSync(realBinary, args, { stdio: 'inherit', shell: needsShellOnWindows(realBinary), env: childEnv(name) });
  if (result.error) {
    process.stderr.write(`${path.basename(realBinary)}: ${result.error.message}\n`);
    process.exit(127);
  }
  exitLikeChild(result);
}

function loadCrusher() {
  try {
    return { ...require('./engine'), ...require('./metrics') };
  } catch {
    return null;
  }
}

function runShim(name, args) {
  refuseDirectRecursion(name);

  const realBinary = resolveRealBinary(name, launcherDir());
  if (!realBinary) {
    process.stderr.write(`${name}: command not found\n`);
    process.exit(127);
  }

  // Set by crush-run.js when the caller asked for `egc run --raw`: the outer
  // process already decided to skip compression, but the shim would resolve
  // and compress on its own otherwise, since it runs as an independent child
  // with no other visibility into that intent.
  if (process.env.EGC_CRUSHER_RAW === '1' || process.stdout.isTTY) {
    return passthrough(name, realBinary, args);
  }

  const crusher = loadCrusher();
  const commandLine = [name, ...args].join(' ');
  if (!crusher || crusher.commandKind(commandLine) === 'generic') {
    return passthrough(name, realBinary, args);
  }

  const result = spawnSync(realBinary, args, { ...SPAWN_OPTIONS, shell: needsShellOnWindows(realBinary), env: childEnv(name) });
  if (result.error) {
    // ENOBUFS (output exceeded maxBuffer) is not "command not found" -- exit
    // 127 there would be actively misleading to anything inspecting the
    // status code. The child was already killed mid-run by spawnSync itself
    // in this case, so there is nothing safe left to fall back to (retrying
    // via passthrough would re-execute whatever side effects the command
    // already had, possibly a second time).
    const isBufferOverflow = result.error.code === 'ENOBUFS' || /maxBuffer/i.test(result.error.message || '');
    process.stderr.write(`${name}: ${result.error.message}\n`);
    process.exit(isBufferOverflow ? 1 : 127);
  }

  const stdout = result.stdout || '';
  let crushed;
  try {
    crushed = crusher.crushOutput(commandLine, stdout);
  } catch {
    crushed = null;
  }

  // fs.writeSync(1, ...), not process.stdout.write(), matters here: stdout to
  // a pipe is asynchronous on POSIX, and exitLikeChild() below can call
  // process.exit() before a pending write flushes. That truncated the tail of
  // large output non-deterministically by OS and Node version (confirmed as
  // a real CI flake on macOS + Node 20.x, audit EGC-521). fs.writeSync is a
  // genuine blocking syscall, so nothing is left pending when this exits.
  if (crushed) {
    writeSync(1, crushed.crushed + '\n');
    crusher.record({
      cmd: name,
      kind: crushed.kind,
      bytesIn: crushed.bytesIn,
      bytesOut: crushed.bytesOut,
      tokensSaved: crushed.tokensSaved,
    });
  } else if (stdout) {
    writeSync(1, stdout);
  }

  exitLikeChild(result);
}

// Windows launchers (.cmd) cannot shebang directly into this file the way a
// POSIX launcher does, so they spawn `node shim-dispatch.js <name> <args...>`
// as a separate process instead of requiring runShim() in-process.
if (require.main === module) {
  runShim(process.argv[2], process.argv.slice(3));
}

module.exports = { runShim, needsShellOnWindows, exitLikeChild };
