#!/usr/bin/env node
'use strict';

const { run: runBashGuardian } = require('./pre-bash-guardian-validate');
const { run: runWriteGuardian } = require('./pre-write-guardian-validate');
const { decideGuardianAdapterEvent, runJsonEnvelopeGuardianAdapter } = require('../lib/adapter-stdin-json');

// Kimi Code CLI names the shell tool Bash (legacy Shell) and the file tools
// Write and Edit (legacy WriteFile and StrReplaceFile); a hook blocks a call
// by exiting 2 with the reason on stderr.
const SHELL_TOOL_RE = /^(bash|shell)$/i;
const WRITE_TOOL_RE = /^(write|edit|writefile|strreplacefile)$/i;
const TRUNCATED_REASON = 'EGC Guardian BLOCKED this tool call: the event payload exceeded the size '
  + 'this validator can safely read, so it could not be parsed or validated.';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildGuardianInput(event) {
  if (!isPlainObject(event) || typeof event.tool_name !== 'string') return null;
  const toolName = event.tool_name.trim();
  const toolInput = isPlainObject(event.tool_input) ? { ...event.tool_input } : {};
  const cwd = typeof event.cwd === 'string' ? { cwd: event.cwd } : {};
  if (SHELL_TOOL_RE.test(toolName)) {
    if (typeof toolInput.command !== 'string') return null;
    return { kind: 'bash', input: { tool_name: 'Bash', tool_input: toolInput, ...cwd } };
  }
  if (WRITE_TOOL_RE.test(toolName)) {
    const target = toolInput.path || toolInput.file_path;
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
  process.stderr.write(`${reason}\n`);
  process.exitCode = 2;
}

function runKimiGuardianAdapter(eventOrRaw, options = {}) {
  return decideGuardianAdapterEvent(eventOrRaw, options, {
    buildGuardianInput,
    runGuardian,
    truncatedReason: TRUNCATED_REASON,
  });
}

if (require.main === module) {
  runJsonEnvelopeGuardianAdapter(buildGuardianInput, target => runGuardian(target), respond);
}

module.exports = { buildGuardianInput, runKimiGuardianAdapter };
