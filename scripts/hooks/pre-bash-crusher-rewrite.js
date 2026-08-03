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
//
// This scan is intentionally platform-uniform, not just POSIX: every host
// that wires this hook (Claude Code, Cursor, Junie, OpenCode, Amp) invokes
// its Bash-equivalent tool through a POSIX-compatible shell even on
// Windows (Git Bash/WSL), never raw cmd.exe -- confirmed by the test suite
// itself, which asserts identical quote-aware behavior on every platform
// for this exact function and is POSIX-gated only for the parts that are
// genuinely POSIX-only (pipelines, `--shell` wrapping). A platform branch
// here that special-cased cmd.exe quoting broke those cross-platform
// assertions on Windows CI and was reverted; if a host that actually
// shells out via cmd.exe is ever wired to this hook, that needs its own
// dedicated handling, not a blanket win32 check here.
const COMPLEX_SHELL_CHARS = new Set(['\n', '|', '&', ';', '<', '>', '$', '`', '(', ')']);

// Scans one character of hasComplexShellSyntax's quote-tracking pass.
// Returns `{ complex: true }` to short-circuit the whole scan, otherwise
// `{ nextIndex, quote }` for the caller to resume from.
function scanShellSyntaxChar(cmd, i, quote) {
  const ch = cmd[i];

  if (quote === "'") {
    return { nextIndex: i + 1, quote: ch === "'" ? null : quote };
  }
  if (quote === '"') {
    if (ch === '\\') return { nextIndex: i + 2, quote };
    if (ch === '"') return { nextIndex: i + 1, quote: null };
    if (ch === '$' || ch === '`') return { complex: true };
    return { nextIndex: i + 1, quote };
  }
  if (ch === '\\') return { nextIndex: i + 2, quote };
  if (ch === "'" || ch === '"') return { nextIndex: i + 1, quote: ch };
  if (COMPLEX_SHELL_CHARS.has(ch)) return { complex: true };
  return { nextIndex: i + 1, quote };
}

function hasComplexShellSyntax(cmd) {
  let quote = null;
  let i = 0;
  while (i < cmd.length) {
    const step = scanShellSyntaxChar(cmd, i, quote);
    if (step.complex) return true;
    i = step.nextIndex;
    quote = step.quote;
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
