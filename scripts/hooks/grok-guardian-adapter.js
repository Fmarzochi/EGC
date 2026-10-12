#!/usr/bin/env node
'use strict';

const { run: runBashGuardian } = require('./pre-bash-guardian-validate');
const { run: runWriteGuardian } = require('./pre-write-guardian-validate');
const { decideGuardianAdapterEvent, runJsonEnvelopeGuardianAdapter } = require('../lib/adapter-stdin-json');

const SHELL_TOOL_RE = /^(bash|run_terminal_command|monitor)$/i;
const WRITE_TOOL_RE = /^(edit|write|search_replace)$/i;
const TRUNCATED_REASON = 'EGC Guardian BLOCKED this tool call: the event payload exceeded the size '
  + 'this validator can safely read, so it could not be parsed or validated.';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function eventField(event, camel, snake) {
  return event[camel] === undefined ? event[snake] : event[camel];
}

function buildGuardianInput(event) {
  if (!isPlainObject(event)) return null;
  const toolName = eventField(event, 'toolName', 'tool_name');
  if (typeof toolName !== 'string') return null;
  const rawInput = eventField(event, 'toolInput', 'tool_input');
  const toolInput = isPlainObject(rawInput) ? { ...rawInput } : {};
  const cwd = typeof event.cwd === 'string' ? { cwd: event.cwd } : {};
  if (SHELL_TOOL_RE.test(toolName.trim())) {
    if (typeof toolInput.command !== 'string') return null;
    return { kind: 'bash', input: { tool_name: 'Bash', tool_input: toolInput, ...cwd } };
  }
  if (WRITE_TOOL_RE.test(toolName.trim())) {
    const target = toolInput.file_path || toolInput.filePath || toolInput.path;
    if (typeof target !== 'string') return null;
    return {
      kind: 'write',
      input: { tool_name: 'Edit', tool_input: { ...toolInput, file_path: target, path: target }, ...cwd },
    };
  }
  return null;
}

function runGuardian(target, options) {
  return target.kind === 'bash' ? runBashGuardian(target.input, options) : runWriteGuardian(target.input, options);
}

function respond(blocked, reason = 'Blocked by the EGC Guardian.') {
  if (!blocked) {
    process.exitCode = 0;
    return;
  }
  process.stdout.write(`${JSON.stringify({ decision: 'deny', reason })}\n`);
  process.stderr.write(`${reason}\n`);
  process.exitCode = 2;
}

function runGrokGuardianAdapter(eventOrRaw, options = {}) {
  return decideGuardianAdapterEvent(eventOrRaw, options, {
    buildGuardianInput,
    runGuardian,
    truncatedReason: TRUNCATED_REASON,
  });
}

if (require.main === module) {
  runJsonEnvelopeGuardianAdapter(buildGuardianInput, target => runGuardian(target), respond);
}

module.exports = { buildGuardianInput, runGrokGuardianAdapter };
