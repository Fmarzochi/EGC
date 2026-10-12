#!/usr/bin/env node
'use strict';

const { exitOnTruncatedInput, readHookStdin } = require('../lib/hook-stdin');

function run(rawInput) {
  const passthrough = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
  try {
    const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
    const cmd = String(input.tool_input?.command || '');

    if (
      process.platform !== 'win32' &&
      !process.env.TMUX &&
      /(npm (install|test)|pnpm (install|test)|yarn (install|test)?|bun (install|test)|cargo build|make\b|docker\b|pytest|vitest|playwright)/.test(cmd)
    ) {
      return {
        stdout: passthrough,
        stderr: [
          '[Hook] Consider running in tmux for session persistence',
          '[Hook] tmux new -s dev  |  tmux attach -t dev',
        ].join('\n'),
        exitCode: 0,
      };
    }
  } catch {
    // ignore parse errors and pass through
  }

  return { stdout: passthrough, stderr: '', exitCode: 0 };
}

if (require.main === module) {
  readHookStdin(({ raw, truncated }) => {
    exitOnTruncatedInput(truncated, 0);
    const result = run(raw);
    if (result.stderr) {
      process.stderr.write(`${result.stderr}\n`);
    }
    process.stdout.write(String(result.stdout || ''));
    process.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 0;
  });
}

module.exports = { run };
