#!/usr/bin/env node
/**
 * PreToolUse Hook: Verification Gate
 *
 * Before git commit and git push commands, consults the egc verify
 * receipt for the current project. A missing, stale, or failed receipt
 * produces a warning by default and blocks the command when
 * EGC_VERIFY_GATE=block, feeding the failing verification output back
 * into the agent context so the failure can be fixed before landing.
 *
 * Modes (EGC_VERIFY_GATE): off | warn (default) | block
 *
 * Exit codes:
 *   0 - Allow (pass, warn mode, or gate not applicable)
 *   2 - Block (block mode with a missing, stale, or failed receipt)
 */

'use strict';

const { evaluateReceipt } = require('../lib/verify-receipt');

const MAX_STDIN = 1024 * 1024;
const GATE_MODE_ENV = 'EGC_VERIFY_GATE';
const TRIGGER_REGEX = /\bgit\b[^|;&\n]*\s(commit|push)\b/;

function gateMode() {
  const raw = String(process.env[GATE_MODE_ENV] || 'warn').trim().toLowerCase();
  return raw === 'off' || raw === 'block' ? raw : 'warn';
}

function buildMessage(evaluation, mode, action) {
  const prefix = mode === 'block' ? '[Hook] BLOCKED by verification gate' : '[Hook] Verification gate';
  const lines = [];

  if (evaluation.status === 'missing') {
    lines.push(`${prefix}: no verification receipt for this project before "git ${action}".`);
    lines.push('Run `egc verify` (defaults to npm test) or `egc verify -- <command>` first.');
  } else if (evaluation.status === 'stale') {
    lines.push(`${prefix}: the working tree changed after the last \`egc verify\` run.`);
    lines.push('Re-run `egc verify` to bind a fresh receipt before "git ' + action + '".');
  } else {
    const receipt = evaluation.receipt || {};
    lines.push(`${prefix}: the last \`egc verify\` run FAILED (exit ${receipt.exitCode}, command: ${receipt.command}).`);
    lines.push('Fix the failures and re-run `egc verify`. Last output:');
    if (receipt.logTail) {
      lines.push(String(receipt.logTail).trim());
    }
  }

  lines.push(`Set ${GATE_MODE_ENV}=off to disable this gate or ${GATE_MODE_ENV}=block to enforce it.`);
  return lines.join('\n');
}

function evaluate(rawInput) {
  const mode = gateMode();
  if (mode === 'off') {
    return { output: rawInput, exitCode: 0 };
  }

  let command;
  try {
    const input = JSON.parse(rawInput);
    command = input?.tool_input?.command || '';
  } catch {
    return { output: rawInput, exitCode: 0 };
  }

  const trigger = command.match(TRIGGER_REGEX);
  if (!trigger) {
    return { output: rawInput, exitCode: 0 };
  }

  let evaluation;
  try {
    evaluation = evaluateReceipt(process.cwd());
  } catch {
    return { output: rawInput, exitCode: 0 };
  }

  if (evaluation.status === 'ok' || evaluation.status === 'unbound') {
    return { output: rawInput, exitCode: 0 };
  }

  return {
    output: rawInput,
    stderr: buildMessage(evaluation, mode, trigger[1]),
    exitCode: mode === 'block' ? 2 : 0,
  };
}

function run(rawInput) {
  const result = evaluate(rawInput);
  return {
    stdout: result.output,
    stderr: result.stderr || '',
    exitCode: result.exitCode,
  };
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (data.length < MAX_STDIN) {
      data += chunk.substring(0, MAX_STDIN - data.length);
    }
  });
  process.stdin.on('end', () => {
    const result = evaluate(data);
    if (result.stderr) {
      process.stderr.write(`${result.stderr}\n`);
    }
    process.stdout.write(result.output);
    process.exit(result.exitCode);
  });
}

module.exports = { run, evaluate };
