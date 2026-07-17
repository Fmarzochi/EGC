#!/usr/bin/env node
'use strict';

const MAX_STDIN = 1024 * 1024;
let raw = '';

function run(rawInput) {
  const passthrough = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
  try {
    const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
    const cmd = String(input.tool_input?.command || '');

    if (/\bgh\s+pr\s+create\b/.test(cmd)) {
      const out = String(input.tool_output?.output || '');
      const match = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.exec(out);
      if (match) {
        const prUrl = match[0];
        const repo = prUrl.replace(/https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/, '$1');
        const prNum = prUrl.replace(/.+\/pull\/(\d+)/, '$1'); // NOSONAR: superlinear risk accepted: input is the local user's own command or CLI output
        return {
          stdout: passthrough,
          stderr: [
            `[Hook] PR created: ${prUrl}`,
            `[Hook] To review: gh pr review ${prNum} --repo ${repo}`,
          ].join('\n'),
          exitCode: 0,
        };
      }
    }
  } catch {
    // ignore parse errors and pass through
  }

  return { stdout: passthrough, stderr: '', exitCode: 0 };
}

if (require.main === module) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      const remaining = MAX_STDIN - raw.length;
      raw += chunk.substring(0, remaining);
    }
  });

  process.stdin.on('end', () => {
    const result = run(raw);
    if (result.stderr) {
      process.stderr.write(`${result.stderr}\n`);
    }
    process.stdout.write(String(result.stdout || ''));
    process.exit(Number.isInteger(result.exitCode) ? result.exitCode : 0);
  });
}

module.exports = { run };
