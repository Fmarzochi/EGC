#!/usr/bin/env node
/**
 * Guardian Write Enforcement Hook
 *
 * Validates the target path of every Write/Edit/MultiEdit with the
 * egc-guardian validator before the write executes. Blocks writes to
 * protected paths (credential stores, key files, system directories).
 *
 * Fails open silently: if the guardian CLI is missing or errors, the
 * write is allowed. Run egc doctor to diagnose a missing validator.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block
 */

'use strict';

const path = require('node:path');
const { resolveGuardianCli, callGuardian } = require('../lib/guardian-bin');

// Script content is judged with the validator the Bash hook uses, so a
// script cannot be written with a command that hook would refuse and then
// started through an advisory-only `bash script.sh`.
const SHELL_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.ksh', '.ps1', '.bat', '.cmd']);

function scriptContentOf(input, filePath) {
  const tool = input?.tool_input || {};
  const pieces = [];
  if (typeof tool.content === 'string') pieces.push(tool.content);
  if (typeof tool.new_string === 'string') pieces.push(tool.new_string);
  if (Array.isArray(tool.edits)) {
    for (const edit of tool.edits) {
      if (typeof edit?.new_string === 'string') pieces.push(edit.new_string);
    }
  }
  const content = pieces.join('\n');
  if (!content) return null;
  const isScript = content.startsWith('#!') || SHELL_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  return isScript ? content : null;
}

const MAX_STDIN = 1024 * 1024;
const VALIDATE_TIMEOUT_MS = 4000;

function parseInput(inputOrRaw) {
  if (typeof inputOrRaw === 'string') {
    try {
      return inputOrRaw.trim() ? JSON.parse(inputOrRaw) : {};
    } catch {
      return {};
    }
  }
  return inputOrRaw && typeof inputOrRaw === 'object' ? inputOrRaw : {};
}

// Harnesses name the write target differently: file_path (Claude Code),
// path (Gemini CLI), TargetFile (Antigravity). Cover them all so a protected
// path is validated regardless of which harness issued the write.
function writeTargetOf(input) {
  const tool = input?.tool_input || {};
  const filePath = tool.file_path || tool.file || tool.path || tool.TargetFile || '';
  return typeof filePath === 'string' ? filePath : '';
}

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const filePath = writeTargetOf(input);
  if (!filePath) return { exitCode: 0 };

  const cli = resolveGuardianCli();
  if (!cli) {
    return { exitCode: 0 };
  }

  const verdict = callGuardian(cli, ['write'], filePath, VALIDATE_TIMEOUT_MS);
  if (!verdict) return { exitCode: 0 };

  if (verdict.allowed === false) {
    return {
      exitCode: 2,
      stderr:
        `EGC Guardian BLOCKED this write: ${verdict.reason || 'denied by policy'}. ` +
        'Writes to protected paths are not permitted.',
    };
  }

  return blockedScriptWrite(cli, input, filePath) || { exitCode: 0 };
}

function blockedScriptWrite(cli, input, filePath) {
  const script = scriptContentOf(input, filePath);
  if (!script) return null;
  const verdict = callGuardian(cli, ['script'], script, VALIDATE_TIMEOUT_MS);
  if (!verdict || verdict.allowed !== false) return null;
  return {
    exitCode: 2,
    stderr:
      `EGC Guardian BLOCKED this write: line ${verdict.line || '?'} of the script runs a denied command ` +
      `(${verdict.reason || 'denied by policy'}). Writing a script that runs a denied command is not permitted.`,
  };
}

module.exports = { run };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      raw += chunk.substring(0, MAX_STDIN - raw.length);
    }
  });
  process.stdin.on('end', () => {
    const result = run(raw);
    if (result.stderr) process.stderr.write(result.stderr + '\n');
    if (result.exitCode === 2) process.exit(2);
    process.stdout.write(raw);
  });
}
