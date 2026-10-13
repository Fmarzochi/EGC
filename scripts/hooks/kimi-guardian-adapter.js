#!/usr/bin/env node
'use strict';

const { createShellEditGuardianAdapter } = require('../lib/shell-edit-guardian-adapter');
const { decideGuardianAdapterEvent, runJsonEnvelopeGuardianAdapter } = require('../lib/adapter-stdin-json');

// Kimi Code CLI names the shell tool Bash (legacy Shell) and the file tools
// Write and Edit (legacy WriteFile and StrReplaceFile); a hook blocks a call
// by exiting 2 with the reason on stderr.
const SHELL_TOOL_RE = /^(bash|shell)$/i;
const WRITE_TOOL_RE = /^(write|edit|writefile|strreplacefile)$/i;
const TRUNCATED_REASON = 'EGC Guardian BLOCKED this tool call: the event payload exceeded the size '
  + 'this validator can safely read, so it could not be parsed or validated.';

const { buildGuardianInput, runGuardian } = createShellEditGuardianAdapter({
  shellToolRe: SHELL_TOOL_RE,
  writeToolRe: WRITE_TOOL_RE,
  pathKeys: ['path', 'file_path'],
});

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
