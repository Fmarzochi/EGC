#!/usr/bin/env node
/**
 * Charmbracelet Crush hooks adapter for the EGC Guardian.
 *
 * Crush executes PreToolUse hooks defined in crush.json with a flat structure:
 * {
 *   "hooks": {
 *     "PreToolUse": [
 *       {
 *         "matcher": "^(bash|edit|write|multiedit)$",
 *         "command": "\"node\" \"/abs/path/to/crush-guardian-adapter.js\""
 *       }
 *     ]
 *   }
 * }
 *
 * Crush delivers the tool call event as JSON on stdin. The event specifies the
 * tool name (e.g. bash, edit, write, multiedit) and its arguments (tool_input or input).
 *
 * This adapter routes:
 *   - bash -> pre-bash-guardian-validate
 *   - edit, write, multiedit -> pre-write-guardian-validate
 *
 * Exits with code 2 on block (writing reason to stderr), and code 0 on allow.
 */

'use strict';

const { run: runBashGuardian } = require('./pre-bash-guardian-validate');
const { run: runWriteGuardian } = require('./pre-write-guardian-validate');
const { readAdapterStdinJson } = require('../lib/adapter-stdin-json');

const BASH_TOOL_RE = /^bash$/i;
const WRITE_TOOL_RE = /^(edit|write|multiedit)$/i;

/**
 * Checks whether a value is a non-null, non-array object.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extracts the working directory from a Crush tool event.
 * @param {Record<string, unknown>} crushEvent
 * @returns {string|undefined}
 */
function extractCwd(crushEvent) {
  if (typeof crushEvent.cwd === 'string') return crushEvent.cwd;
  if (typeof crushEvent.working_dir === 'string') return crushEvent.working_dir;
  return undefined;
}

/**
 * Extracts the raw tool input object from a Crush event payload.
 * @param {Record<string, unknown>} crushEvent
 * @returns {Record<string, unknown>}
 */
function extractRawInput(crushEvent) {
  if (isPlainObject(crushEvent.tool_input)) return crushEvent.tool_input;
  if (isPlainObject(crushEvent.input)) return crushEvent.input;
  return {};
}

/**
 * Builds the canonical Guardian event payload for Bash tool invocations.
 * @param {Record<string, unknown>} rawInput
 * @param {string|undefined} cwd
 * @param {Record<string, unknown>} crushEvent
 * @returns {{kind: 'bash', input: {tool_name: 'Bash', tool_input: Record<string, unknown>, cwd?: string}}}
 */
function buildBashGuardianEvent(rawInput, cwd, crushEvent) {
  const toolInput = { ...rawInput };
  if (typeof toolInput.command !== 'string' && typeof crushEvent.command === 'string') {
    toolInput.command = crushEvent.command;
  }
  return {
    kind: 'bash',
    input: {
      tool_name: 'Bash',
      tool_input: toolInput,
      ...(cwd ? { cwd } : {}),
    },
  };
}

/**
 * Normalizes tool name string to standard EGC Write/Edit/MultiEdit identifier.
 * @param {string} toolName
 * @returns {'Write'|'MultiEdit'|'Edit'}
 */
function resolveWriteToolName(toolName) {
  const lower = toolName.toLowerCase();
  if (lower === 'write') return 'Write';
  if (lower === 'multiedit') return 'MultiEdit';
  return 'Edit';
}

/**
 * Builds the canonical Guardian event payload for file Write/Edit tool invocations.
 * @param {string} toolName
 * @param {Record<string, unknown>} rawInput
 * @param {string|undefined} cwd
 * @param {Record<string, unknown>} crushEvent
 * @returns {{kind: 'write', input: {tool_name: string, tool_input: Record<string, unknown>, cwd?: string}}}
 */
function buildWriteGuardianEvent(toolName, rawInput, cwd, crushEvent) {
  const toolInput = { ...rawInput };
  const mappedToolName = resolveWriteToolName(toolName);
  const target = toolInput.file_path || toolInput.path || toolInput.file || toolInput.TargetFile || crushEvent.path || crushEvent.file_path;
  if (target) {
    toolInput.path = target;
    toolInput.file_path = target;
  }
  return {
    kind: 'write',
    input: {
      tool_name: mappedToolName,
      tool_input: toolInput,
      ...(cwd ? { cwd } : {}),
    },
  };
}

/**
 * Parses and maps a raw Crush tool event into an EGC Guardian validation target.
 * @param {Record<string, unknown>} crushEvent
 * @returns {{kind: 'bash'|'write', input: Record<string, unknown>}|null}
 */
function buildGuardianEvent(crushEvent) {
  if (!isPlainObject(crushEvent)) {
    return null;
  }
  const rawTool = crushEvent.tool_name || crushEvent.tool;
  if (typeof rawTool !== 'string') {
    return null;
  }
  const toolName = rawTool.trim();
  const cwd = extractCwd(crushEvent);
  const rawInput = extractRawInput(crushEvent);

  if (BASH_TOOL_RE.test(toolName)) {
    return buildBashGuardianEvent(rawInput, cwd, crushEvent);
  }

  if (WRITE_TOOL_RE.test(toolName)) {
    return buildWriteGuardianEvent(toolName, rawInput, cwd, crushEvent);
  }

  return null;
}

/**
 * Runs the Crush Guardian adapter logic for an event object or JSON string.
 * @param {Record<string, unknown>|string} eventOrRaw
 * @param {Record<string, unknown>} [options]
 * @returns {{exitCode: number, stderr?: string}}
 */
function runCrushGuardianAdapter(eventOrRaw, options = {}) {
  if (options.truncated) {
    return {
      exitCode: 2,
      stderr: 'EGC Guardian BLOCKED this tool call: the event payload exceeded the size this validator can safely read, so it could not be parsed or validated.\n',
    };
  }
  let event = eventOrRaw;
  if (typeof event === 'string') {
    try {
      event = JSON.parse(event);
    } catch {
      return { exitCode: 0 };
    }
  }
  const target = buildGuardianEvent(event);
  if (!target) {
    return { exitCode: 0 };
  }
  if (target.kind === 'bash') {
    return runBashGuardian(target.input, options);
  }
  if (target.kind === 'write') {
    return runWriteGuardian(target.input, options);
  }
  return { exitCode: 0 };
}

/**
 * Main CLI entrypoint reading JSON from stdin and enforcing Guardian validation.
 */
function main() {
  readAdapterStdinJson(({ ok, truncated, value }) => {
    if (truncated) {
      process.stderr.write(
        'EGC Guardian BLOCKED this tool call: the event payload exceeded the size ' +
        'this validator can safely read, so it could not be parsed or validated.\n'
      );
      process.exitCode = 2;
      return;
    }
    if (!ok) {
      process.exitCode = 0;
      return;
    }
    const target = buildGuardianEvent(value);
    if (!target) {
      process.exitCode = 0;
      return;
    }
    const result = target.kind === 'bash'
      ? runBashGuardian(target.input)
      : runWriteGuardian(target.input);

    if (result?.exitCode === 2) {
      const reason = result.stderr || 'Blocked by the EGC Guardian.';
      process.stderr.write(reason.endsWith('\n') ? reason : `${reason}\n`);
      process.exitCode = 2;
      return;
    }
    process.exitCode = 0;
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  buildGuardianEvent,
  runCrushGuardianAdapter,
};
