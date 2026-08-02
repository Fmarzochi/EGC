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
// A command with none of these characters *active* runs through `egc run
// <cmd>` with no shell. One that has active shell syntax keeps its exact
// semantics only when re-parsed by bash, so it goes through
// `egc run --shell '<cmd>'` when safe (see run()).
//
// "Active" means outside single quotes, and -- inside double quotes -- one
// of the characters double quotes actually leave live. This mirrors POSIX
// quoting: single quotes make every character literal with no escaping at
// all; double quotes keep `$` and backtick able to expand but leave
// |&;<>() as plain text; outside any quote, a backslash escapes the very
// next character. Ignoring all of that (a plain character-class regex) was
// EGC-512: it flagged e.g. `git commit -m "fix: a & b"` as needing the
// --shell wrap purely because of the quoted `&`, when the harness's own
// shell already parses that quoting correctly with no wrap needed.
function hasComplexShellSyntax(cmd) {
  // cmd.exe does not treat single quotes as quoting (confirmed by shSingleQuote's
  // own POSIX-escaping caveat below), so the quote-aware scan below would treat a
  // Windows metacharacter sitting inside single quotes as inert when cmd.exe would
  // still see it as live. Windows stays on the old conservative character-class
  // check instead, matching the platform's real quoting rules.
  if (process.platform === 'win32') {
    return /[|&;<>$`()\n]/.test(cmd);
  }
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') { quote = null; continue; }
      if (ch === '$' || ch === '`') return true;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '\n' || ch === '|' || ch === '&' || ch === ';' || ch === '<' || ch === '>' || ch === '$' || ch === '`' || ch === '(' || ch === ')') {
      return true;
    }
  }
  // An unterminated quote masks whatever follows it from this scan; treat
  // that as complex rather than silently trusting the no-shell fast path.
  return quote !== null;
}

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
    if (!hasComplexShellSyntax(cmd)) {
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
