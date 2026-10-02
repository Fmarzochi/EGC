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
 * A missing guardian CLI allows the write, as the Bash hook allows a
 * command then; run egc doctor to diagnose it. A validator that is there
 * but gives no verdict (it stops, times out or answers something
 * unreadable) blocks the write, as it blocks the command there.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveGuardianCli, callGuardianVerdict, guardianFailureReason, readHookInput } = require('../lib/guardian-bin');

// An input cut at the size the hook reads is not the write that happens: the path or the
// content it names could lie in what was cut, so it is refused.
const OVER_LIMIT = 'EGC Guardian BLOCKED this write: the hook input is larger than the 1 MiB this validator reads, so the write was not validated. Write the file in smaller parts.';
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
// path (the retired Gemini CLI's name, kept by the hook loop the Antigravity
// CLI inherited), TargetFile (Antigravity), and a MultiEdit may carry a
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
function resultingContent(tool, filePath, readPath = filePath) {
  if (typeof tool?.content === 'string' && targetOf(tool) === filePath) return tool.content;
  const edits = editsFor(tool, filePath);
  if (edits.length === 0) return null;
  let content = readExisting(readPath);
  for (const edit of edits) {
    content = content === null ? null : applyEdit(content, edit);
  }
  return content ?? edits.map(edit => edit.new_string).join('\n');
}

function blocked(reason) {
  return { exitCode: 2, stderr: `EGC Guardian BLOCKED this write: ${reason}` };
}

function withoutVerdict(failure) {
  return {
    exitCode: 2,
    stderr: `EGC Guardian could not validate this write, so it was not made: ${guardianFailureReason(failure, VALIDATE_TIMEOUT_MS)}. Try the write again; if this keeps happening, run 'egc doctor' to check the Guardian build.`,
  };
}

function isVerdict(entry) {
  return entry !== null && typeof entry === 'object' && typeof entry.allowed === 'boolean';
}

function blockedPath(cli, filePath) {
  const answer = callGuardianVerdict(cli, ['write'], filePath, VALIDATE_TIMEOUT_MS);
  if (!answer.ok) return withoutVerdict(answer);
  const verdict = answer.value;
  if (!isVerdict(verdict)) return withoutVerdict({ kind: 'unreadable', detail: 'something that is not a verdict' });
  if (verdict.allowed) return null;
  return blocked(`${verdict.reason || 'denied by policy'}. Writes to protected paths are not permitted.`);
}

function scriptSegments(content) {
  if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) {
    return { error: 'the script is too large to analyze. Split it so every command can be validated.' };
  }
  let segments;
  try {
    segments = bashGuardian.extractSegments(content);
  } catch (error) {
    if (error?.name === 'ProgramUnreadable') return { error: `${error.message}.` };
    throw error;
  }
  if (segments === null) {
    return { error: 'nested command/process substitutions in the script go deeper than this validator can safely unwrap and analyze.' };
  }
  return { segments };
}

// A relative target is what the tool will write relative to the hook's cwd,
// not to the directory this process happens to run in.
function resolveTarget(input, filePath) {
  const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
  const home = filePath === '~' || filePath.startsWith('~/') || (process.platform === 'win32' && filePath.startsWith('~\\'));

  const expanded = home ? path.join(os.homedir(), filePath.slice(1)) : filePath;
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

// The commands of the version of the file committed at HEAD, counted: that
// version went through review, writing those commands again runs nothing,
// and running the script is judged by the Bash hook. A file outside a
// repository, never committed, or unreadable there has none. git is run
// the way the Bash hook runs it to read: nothing the repository configures
// starts.
function committedSegmentCounts(target) {
  const counts = new Map();
  const committed = bashGuardian.gitIn(path.dirname(target), ['cat-file', 'blob', `HEAD:./${path.basename(target)}`]);
  if (committed === null) return counts;
  let segments;
  try {
    segments = bashGuardian.extractSegments(committed);
  } catch {
    return counts;
  }
  for (const segment of segments || []) counts.set(lineKey(segment), (counts.get(lineKey(segment)) || 0) + 1);
  return counts;
}

// A checkout that writes CRLF (core.autocrlf on Windows) holds the committed
// LF lines with a carriage return added; they are the same commands. A
// carriage return anywhere else is part of the command.
function lineKey(segment) {
  const lines = segment.replaceAll('\r\n', '\n');
  return lines.endsWith('\r') ? lines.slice(0, -1) : lines;
}

// What the write would hold that the commit does not: the commands it adds
// or changes, and any that reached the file without a commit. A command
// that appears more often than in the commit is judged for each extra copy.
function uncommittedSegments(segments, target) {
  const counts = committedSegmentCounts(target);
  return segments.filter(segment => {
    const left = counts.get(lineKey(segment)) || 0;
    if (left === 0) return true;
    counts.set(lineKey(segment), left - 1);
    return false;
  });
}

function blockedScript(cli, input, filePath) {
  if (!bashGuardian) return null;
  const target = resolveTarget(input, filePath);
  const content = resultingContent(input?.tool_input, filePath, target);
  if (!content || !isShellScript(filePath, content)) return null;
  const { segments: written, error } = scriptSegments(content);
  if (error) return blocked(error);
  const segments = uncommittedSegments(written, target);
  if (segments.length === 0) return null;
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const answer = callGuardianVerdict(cli, ['command-batch'], JSON.stringify({ commands: segments, cwd }), VALIDATE_TIMEOUT_MS);
  if (!answer.ok) return withoutVerdict(answer);
  const verdicts = answer.value;
  if (!Array.isArray(verdicts) || verdicts.length !== segments.length || !verdicts.every(isVerdict)) {
    return withoutVerdict({ kind: 'unreadable', detail: 'something that is not one verdict per command' });
  }
  const index = verdicts.findIndex(verdict => verdict?.allowed === false && !bashGuardian.isAdvisory(verdict));
  if (index < 0) return null;
  return blocked(
    `the script runs a denied command (${verdicts[index].reason || 'denied by policy'}; segment: ${segments[index]}). ` +
    'Writing a script that runs a denied command is not permitted.'
  );
}

function firstBlocked(cli, input, targets) {
  for (const filePath of targets) {
    const result = blockedPath(cli, resolveTarget(input, filePath)) || blockedScript(cli, input, filePath);
    if (result) return result;
  }
  return null;
}

// `options.truncated`: the input was cut at the size the caller reads, as
// run-with-flags reports it.
function run(inputOrRaw, options = {}) {
  if (options.truncated) return { exitCode: 2, stderr: OVER_LIMIT };
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
  readHookInput(({ raw, truncated }) => {
    const result = run(raw, { truncated });
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.stdout.write(raw);
    process.exitCode = result.exitCode === 2 ? 2 : 0;
  });
}
