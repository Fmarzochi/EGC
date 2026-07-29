'use strict';

// PreToolUse rewrite for the Token Crusher: routes crushable commands through
// `egc run` so noisy output is compressed before it reaches the model. Fail-open
// everywhere: no engine, no egc CLI, complex shell syntax or an already-wrapped
// command all pass through untouched. Disable with
// EGC_DISABLED_HOOKS=pre:bash:crusher-rewrite.

const { spawnSync } = require('node:child_process');

function tryRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}

// Repo layout first, flattened install layout second.
const engine = tryRequire('../lib/crusher/engine') || tryRequire('../lib/crusher-engine');

// EGC_CRUSHER_SKIP_PREFIXES lists extra command prefixes (comma-separated)
// that mean the command is already handled by another local CLI proxy.
function wrappedRe() {
  const extra = (process.env.EGC_CRUSHER_SKIP_PREFIXES || '')
    .split(',')
    .map(p => p.trim())
    .filter(p => /^[\w.-]+$/.test(p));
  const prefixes = ['egc', ...extra].join('|');
  return new RegExp(`(?:^\\s*(?:${prefixes})\\s)|(?:--raw\\b)`);
}
// A command with none of these characters runs through `egc run <cmd>` with no
// shell. One that has them keeps its exact semantics only when re-parsed by
// bash, so it goes through `egc run --shell '<cmd>'` when safe (see run()).
const COMPLEX_SHELL_RE = /[|&;<>$`()\n]/;

// Backgrounding detaches the process, so spawnSync would not capture its output;
// redirection sends stdout elsewhere, leaving nothing to crush. Neither is ever
// wrapped. A lone `&` (not part of `&&`) means backgrounding.
function hasBackgrounding(cmd) {
  return cmd.replace(/&&/g, '').includes('&');
}

function hasRedirection(cmd) {
  return /[<>]/.test(cmd);
}

// POSIX single-quote escaping: wrap in single quotes and replace every embedded
// single quote with '\'' so bash -c re-parses the exact original command.
function shSingleQuote(cmd) {
  return `'${cmd.replace(/'/g, `'\\''`)}'`;
}

let egcAvailable = null;
function hasEgcCli() {
  if (process.env.EGC_ASSUME_EGC_CLI === '1') return true;
  if (process.env.EGC_ASSUME_EGC_CLI === '0') return false;
  if (egcAvailable === null) {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['egc'], { encoding: 'utf8' });
    egcAvailable = probe.status === 0;
  }
  return egcAvailable;
}

function run(rawInput) {
  try {
    const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
    const cmd = input.tool_input?.command || '';

    if (
      !engine
      || !cmd
      || wrappedRe().test(cmd)
      || engine.commandKind(cmd) === 'generic'
      || !hasEgcCli()
    ) {
      return JSON.stringify(input);
    }

    let command;
    if (!COMPLEX_SHELL_RE.test(cmd)) {
      command = `egc run ${cmd}`;
    } else if (process.platform !== 'win32' && !hasBackgrounding(cmd) && !hasRedirection(cmd)) {
      // shSingleQuote is POSIX escaping; cmd.exe does not treat single quotes as
      // quoting, so on Windows a pipeline is left untouched (fail-open) rather
      // than risking a mangled command.
      command = `egc run --shell ${shSingleQuote(cmd)}`;
    } else {
      return JSON.stringify(input);
    }

    return JSON.stringify({
      ...input,
      tool_input: {
        ...input.tool_input,
        command,
      },
    });
  } catch {
    return typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
  }
}

// Shared by every host-specific translation adapter that needs the rewrite
// decision for a single command string, without Claude Code's own
// {tool_input: {command}} envelope round-trip (Cursor, Junie -- cubic-dev-ai
// duplication finding, PR #1081: both adapters had grown their own near-
// identical JSON.parse(run(JSON.stringify(...))) wrapper). Returns the
// rewritten command, or null when nothing should change (no CLI, no engine,
// already wrapped, or a generic/non-crushable command).
//
// No try/catch here: run()'s own contract (see its header comment) is to
// fail open on any internal error by echoing back the exact JSON string it
// was given, so JSON.parse can never fail on run()'s output -- it is always
// either the rewritten object or the same valid JSON this function just
// built. A defensive catch around that would be unreachable dead code
// (confirmed: Codecov flagged it as uncovered on this exact PR).
function computeCrushedCommand(command) {
  if (!command) return null;
  const result = JSON.parse(run(JSON.stringify({ tool_input: { command } })));
  const rewritten = result?.tool_input?.command;
  return typeof rewritten === 'string' && rewritten !== command ? rewritten : null;
}

module.exports = { run, computeCrushedCommand };
