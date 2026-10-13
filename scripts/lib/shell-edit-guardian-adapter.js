'use strict';

const { run: runBashGuardian } = require('../hooks/pre-bash-guardian-validate');
const { run: runWriteGuardian } = require('../hooks/pre-write-guardian-validate');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function runGuardian(target, options) {
  const run = target.kind === 'bash' ? runBashGuardian : runWriteGuardian;
  return run(target.input, options);
}

// Hosts that send {tool_name, tool_input, cwd} and judge one shell tool and
// one edit tool. pathKeys lists, in order, the tool_input keys that can carry
// the file an edit targets.
function createShellEditGuardianAdapter({ shellToolRe, writeToolRe, pathKeys }) {
  function buildGuardianInput(event) {
    if (!isPlainObject(event) || typeof event.tool_name !== 'string') return null;
    const toolName = event.tool_name.trim();
    const toolInput = isPlainObject(event.tool_input) ? { ...event.tool_input } : {};
    const cwd = typeof event.cwd === 'string' ? { cwd: event.cwd } : {};
    if (shellToolRe.test(toolName)) {
      if (typeof toolInput.command !== 'string') return null;
      return { kind: 'bash', input: { tool_name: 'Bash', tool_input: toolInput, ...cwd } };
    }
    if (!writeToolRe.test(toolName)) return null;
    const target = pathKeys.map(key => toolInput[key]).find(Boolean);
    if (typeof target !== 'string') return null;
    const editInput = { ...toolInput, file_path: target, path: target };
    return { kind: 'write', input: { tool_name: 'Edit', tool_input: editInput, ...cwd } };
  }

  return { buildGuardianInput, runGuardian };
}

module.exports = { createShellEditGuardianAdapter };
