#!/usr/bin/env node
'use strict';

const { readHookStdin } = require('../lib/hook-stdin');

function run(rawInput) {
  const passthrough = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
  try {
    const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
    const cmd = String(input.tool_input?.command || '');
    if (/\bgit\s+push\b/.test(cmd)) {
      return {
        stdout: passthrough,
        stderr: [
          '[Hook] Review changes before push...',
          '[Hook] Continuing with push (remove this hook to add interactive review)',
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
  readHookStdin(({ raw }) => {
    const result = run(raw);
    if (result.stderr) {
      process.stderr.write(`${result.stderr}\n`);
    }
    process.stdout.write(String(result.stdout || ''));
    process.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 0;
  });
}

module.exports = { run };
