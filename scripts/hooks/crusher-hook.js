#!/usr/bin/env node
'use strict';

// Standalone Token Crusher hook for hosts other than Claude Code that support
// PreToolUse command rewriting through hooks.json (Codex, CodeBuddy, ...).
// Claude Code runs the crusher inside the full bash-hook-dispatcher chain; the
// other hosts install only this single hook. It reuses the shared rewrite
// decision (pre-bash-crusher-rewrite) and the hookSpecificOutput.updatedInput
// envelope so a crushable command is routed through `egc run` before it runs.
// Fail-open: anything not rewritten (or any error) passes through untouched, so
// a host that ignores updatedInput simply runs the original command.

const { run: runCrusherRewrite } = require('./pre-bash-crusher-rewrite');
const { toPreToolUseOutput } = require('./pretooluse-output');
const { exitOnTruncatedInput, readHookStdin } = require('../lib/hook-stdin');

function run(rawInput) {
  try {
    return toPreToolUseOutput(rawInput, runCrusherRewrite(rawInput));
  } catch {
    return typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
  }
}

function main() {
  readHookStdin(({ raw, truncated }) => {
    exitOnTruncatedInput(truncated, 0);
    process.stdout.write(run(raw));
    process.exit(0);
  });
}

if (require.main === module) {
  main();
}

module.exports = { run };
