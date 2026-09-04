#!/usr/bin/env node
/**
 * Guardian Write Enforcement Hook
 *
 * Validates every Write/Edit/MultiEdit with the egc-guardian validator
 * before the write executes: the target path (protected paths, credential
 * stores, key files, system directories) and, for shell scripts, the
 * content the file will hold afterwards, judged segment by segment with
 * the same validator and the same segmentation the Bash hook uses.
 *
 * Fails open silently: if the guardian CLI is missing or errors, the
 * write is allowed. Run egc doctor to diagnose a missing validator.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveGuardianCli, callGuardian } = require('../lib/guardian-bin');

const MAX_STDIN = 1024 * 1024;
const VALIDATE_TIMEOUT_MS = 4000;
const MAX_SCRIPT_BYTES = 512 * 1024;

// The Bash guardian ships next to this hook wherever the Guardian is
// installed; its segmentation (quotes, heredocs, line continuations, command
// substitutions) is what turns a script's lines into the same commands the
// Bash hook would judge. Without it the content check is skipped, the way a
// missing CLI skips the path check.
let bashGuardian = null;
try {
  bashGuardian = require('./pre-bash-guardian-validate');
} catch {
  bashGuardian = null;
}

// Only POSIX shells: their lines are commands the validator understands.
// PowerShell, batch or Python content would be judged with the wrong
// grammar and is left to those runtimes' own protections.
const SHELL_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.ksh']);
const SHELL_SHEBANG_RE = /^#![^\n]*\b(?:sh|bash|zsh|ksh|dash|ash)\b/;

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
// path (Gemini CLI), TargetFile (Antigravity), and a MultiEdit may carry a
// path per edit. Every distinct target is validated.
function targetOf(tool) {
  const filePath = tool?.file_path || tool?.file || tool?.path || tool?.TargetFile || '';
  return typeof filePath === 'string' ? filePath : '';
}

function writeTargetsOf(tool) {
  const targets = [targetOf(tool)];
  for (const edit of Array.isArray(tool?.edits) ? tool.edits : []) targets.push(targetOf(edit));
  return [...new Set(targets.filter(Boolean))];
}

function editsFor(tool, filePath) {
  const primary = targetOf(tool);
  const edits = Array.isArray(tool?.edits) ? tool.edits : [];
  if (edits.length === 0) {
    return typeof tool?.new_string === 'string' && primary === filePath ? [tool] : [];
  }
  return edits.filter(edit => typeof edit?.new_string === 'string' && (targetOf(edit) || primary) === filePath);
}

function isShellScript(filePath, content) {
  return SHELL_SHEBANG_RE.test(content) || SHELL_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function readExisting(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function applyEdit(content, edit) {
  const oldString = typeof edit.old_string === 'string' ? edit.old_string : '';
  if (content === null || !oldString || !content.includes(oldString)) return null;
  return edit.replace_all
    ? content.split(oldString).join(edit.new_string)
    : content.replace(oldString, () => edit.new_string);
}

// The content the file holds once the tool has run: a Write brings it
// whole; an Edit or MultiEdit is applied to the current file. When an edit
// cannot be applied (file absent, anchor missing) the inserted text itself
// is judged, so a denied command never slips through as a fragment.
function resultingContent(tool, filePath) {
  if (typeof tool?.content === 'string' && targetOf(tool) === filePath) return tool.content;
  const edits = editsFor(tool, filePath);
  if (edits.length === 0) return null;
  let content = readExisting(filePath);
  for (const edit of edits) {
    content = content === null ? null : applyEdit(content, edit);
  }
  return content ?? edits.map(edit => edit.new_string).join('\n');
}

function blocked(reason) {
  return { exitCode: 2, stderr: `EGC Guardian BLOCKED this write: ${reason}` };
}

function blockedPath(cli, filePath) {
  const verdict = callGuardian(cli, ['write'], filePath, VALIDATE_TIMEOUT_MS);
  if (!verdict || verdict.allowed !== false) return null;
  return blocked(`${verdict.reason || 'denied by policy'}. Writes to protected paths are not permitted.`);
}

function scriptSegments(content) {
  if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) {
    return { error: 'the script is too large to analyze. Split it so every command can be validated.' };
  }
  const segments = bashGuardian.extractSegments(content);
  if (segments === null) {
    return { error: 'nested command/process substitutions in the script go deeper than this validator can safely unwrap and analyze.' };
  }
  return { segments };
}

function blockedScript(cli, input, filePath) {
  if (!bashGuardian) return null;
  const content = resultingContent(input?.tool_input, filePath);
  if (!content || !isShellScript(filePath, content)) return null;
  const { segments, error } = scriptSegments(content);
  if (error) return blocked(error);
  if (segments.length === 0) return null;
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const verdicts = callGuardian(cli, ['command-batch'], JSON.stringify({ commands: segments, cwd }), VALIDATE_TIMEOUT_MS);
  if (!Array.isArray(verdicts)) return null;
  const index = verdicts.findIndex(verdict => verdict?.allowed === false && !bashGuardian.isAdvisory(verdict));
  if (index < 0) return null;
  return blocked(
    `the script runs a denied command (${verdicts[index].reason || 'denied by policy'}; segment: ${segments[index]}). ` +
    'Writing a script that runs a denied command is not permitted.'
  );
}

function firstBlocked(cli, input, targets) {
  for (const filePath of targets) {
    const result = blockedPath(cli, filePath) || blockedScript(cli, input, filePath);
    if (result) return result;
  }
  return null;
}

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const targets = writeTargetsOf(input?.tool_input);
  if (targets.length === 0) return { exitCode: 0 };

  const cli = resolveGuardianCli();
  if (!cli) {
    return { exitCode: 0 };
  }

  return firstBlocked(cli, input, targets) || { exitCode: 0 };
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
