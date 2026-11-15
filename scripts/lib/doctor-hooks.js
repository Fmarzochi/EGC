'use strict';
// The hook half of `egc doctor`: for every Guardian hook script an install
// recorded, run the script the tool runs, with a command the Guardian always
// refuses, in that tool's own event shape, and check that the answer is the
// Guardian's refusal. The Guardian of Amp and OpenCode runs as a plugin inside
// the tool, not as a script a config names, and is not probed here.
// A hook entry can sit in the tool's config and still protect nothing: the
// script gone, an adapter that no longer reads the tool's payload, a Guardian
// CLI it cannot find from where it was copied (and a missing CLI allows).
// Only running the hook shows it. Nothing here runs the probe command: a hook
// judges a command, it never executes it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readInstallState } = require('./install-state');

const PROBE_COMMAND = 'rm -rf /';
const DEFAULT_HOOK_PROBE_TIMEOUT_MS = 15000;
const STDERR_TAIL_CHARS = 300;
// What every answer of the Guardian carries: in the stderr of the hooks that
// exit 2, and in the reason of the adapters' JSON. A refusal without it came
// from another hook in the chain (the fact gate, the verification gate) and
// says nothing about the Guardian, which may be off.
const GUARDIAN_SIGNATURE = /EGC Guardian/;

const SHELL_PROBE = `the command ${JSON.stringify(PROBE_COMMAND)}`;
const WRITE_PROBE = 'a write to ~/.ssh/id_rsa';
const shell = event => ({ what: SHELL_PROBE, event: () => event });
const bashEvent = extra => ({ tool_name: 'Bash', tool_input: { command: PROBE_COMMAND }, ...extra });

// One entry per Guardian hook script EGC installs, keyed by file name: the
// event its tool sends before a shell command, in that tool's wire shape
// (the shape each adapter's own test drives). The write validator gets a
// write to a key file instead, the call it exists to refuse.
const HOOK_PROBES = {
  'pre-bash-guardian-validate.js': shell(bashEvent()),
  'bash-hook-dispatcher.js': shell(bashEvent({ hook_event_name: 'PreToolUse' })),
  'pre-write-guardian-validate.js': {
    what: WRITE_PROBE,
    event: homeDir => ({
      tool_name: 'Write',
      tool_input: { file_path: path.join(homeDir, '.ssh', 'id_rsa'), content: 'egc doctor probe' },
    }),
  },
  'antigravity-guardian-adapter.js': shell({ toolCall: { name: 'run_command', args: { CommandLine: PROBE_COMMAND } } }),
  'cline-guardian-adapter.js': shell({
    hookName: 'tool_call',
    tool_call: { id: 'egc-doctor-probe', name: 'run_commands', input: { commands: [PROBE_COMMAND] } },
    preToolUse: { toolName: 'run_commands', parameters: { commands: JSON.stringify([PROBE_COMMAND]) } },
  }),
  'crush-guardian-adapter.js': shell({ tool_name: 'bash', tool_input: { command: PROBE_COMMAND } }),
  'cursor-guardian-adapter.js': shell({ command: PROBE_COMMAND }),
  'goose-guardian-adapter.js': shell({ event: 'PreToolUse', tool_name: 'developer__shell', tool_input: { command: PROBE_COMMAND } }),
  'grok-guardian-adapter.js': shell({ hookEventName: 'PreToolUse', toolName: 'Bash', toolInput: { command: PROBE_COMMAND } }),
  'junie-guardian-adapter.js': shell(bashEvent({ hook_event_name: 'PreToolUse' })),
  'kimi-guardian-adapter.js': shell(bashEvent({ hook_event_name: 'PreToolUse' })),
  'kiro-guardian-adapter.js': shell({ hook_event_name: 'preToolUse', tool_name: 'execute_bash', tool_input: { command: PROBE_COMMAND } }),
  'openhands-guardian-adapter.js': shell({ event_type: 'pre_tool_use', tool_name: 'terminal', tool_input: { command: PROBE_COMMAND } }),
  'vibe-guardian-adapter.js': shell({ tool_name: 'bash', tool_input: { command: PROBE_COMMAND } }),
  'windsurf-guardian-adapter.js': shell({ agent_action_name: 'pre_run_command', tool_info: { command_line: PROBE_COMMAND } }),
};

// The last JSON object a hook printed, when it printed one.
function lastJsonObject(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // not this line
    }
  }
  return null;
}

// Every refusal the supported tools read: exit code 2, or a JSON answer that
// says deny or block in the field that tool reads.
function isRefusal(result) {
  if (result.status === 2) return true;
  const answer = lastJsonObject(result.stdout);
  if (!answer) return false;
  const specific = answer.hookSpecificOutput;
  return answer.decision === 'deny'
    || answer.decision === 'block'
    || answer.permission === 'deny'
    || answer.permissionDecision === 'deny'
    || answer.cancel === true
    || (typeof specific === 'object' && specific !== null && specific.permissionDecision === 'deny');
}

// A refusal that is the Guardian's own, by its signature in the answer.
function isGuardianRefusal(result) {
  return isRefusal(result) && GUARDIAN_SIGNATURE.test(`${result.stderr || ''}\n${result.stdout || ''}`);
}

function clipLine(line) {
  return line.length > STDERR_TAIL_CHARS ? `${line.slice(0, STDERR_TAIL_CHARS)}...` : line;
}

// The first line of the reason a refusal gave, from the field its tool reads
// or from stderr.
function refusalLine(result) {
  const answer = lastJsonObject(result.stdout) || {};
  const text = answer.hookSpecificOutput?.permissionDecisionReason
    ?? answer.permissionDecisionReason
    ?? answer.reason
    ?? answer.user_message
    ?? result.stderr
    ?? '';
  return clipLine(String(text).split(/\r?\n/).map(line => line.trim()).find(Boolean) || '');
}

// One line of what the hook printed on stderr: the first that names an
// error (a crash leads with "Error: Cannot find module ..."), or the last.
function stderrLine(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return clipLine(lines.find(entry => /\berror\b/i.test(entry)) || lines.at(-1) || '');
}

function probeHook(scriptPath, event, { timeoutMs, env, cwd, what = SHELL_PROBE }) {
  if (!fs.existsSync(scriptPath)) {
    return { status: 'error', reason: 'missing', detail: 'the script the hook entry runs is not there' };
  }
  const result = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env,
    cwd,
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    return {
      status: 'error',
      reason: timedOut ? 'timeout' : 'spawn',
      detail: timedOut ? `did not answer within ${timeoutMs} ms` : result.error.message,
    };
  }
  if (isGuardianRefusal(result)) {
    return { status: 'ok', reason: 'refused', detail: `refuses ${what} (exit ${result.status})` };
  }
  if (isRefusal(result)) {
    const line = refusalLine(result);
    return {
      status: 'error',
      reason: 'other-gate',
      detail: `refuses ${what}, but not through the Guardian: another hook answered (exit ${result.status}${line ? ': ' + line : ''}); the Guardian is off or never ran`,
    };
  }
  const stderr = stderrLine(result.stderr);
  return {
    status: 'error',
    reason: 'allowed',
    detail: `let ${what} through, which the Guardian always refuses (exit ${result.status})${stderr ? ': ' + stderr : ''}`,
  };
}

// The Guardian hooks an install recorded: one per script, the file name in
// HOOK_PROBES. A state that cannot be read is the install check's to
// report, not this one's.
function recordedGuardianHooks(installStatePath) {
  let state;
  try {
    state = readInstallState(installStatePath);
  } catch {
    return [];
  }
  const seen = new Set();
  const hooks = [];
  for (const operation of Array.isArray(state.operations) ? state.operations : []) {
    const scriptPath = typeof operation?.hookScriptPath === 'string' ? operation.hookScriptPath : '';
    const script = path.basename(scriptPath);
    if (!scriptPath || !Object.hasOwn(HOOK_PROBES, script) || seen.has(scriptPath)) continue;
    seen.add(scriptPath);
    hooks.push({ scriptPath, script });
  }
  return hooks;
}

// `results` are the install results egc doctor already found: the adapter id
// and the install-state path of every installed target.
function buildHookReport(results, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const timeoutMs = options.timeoutMs || DEFAULT_HOOK_PROBE_TIMEOUT_MS;
  const env = options.env || process.env;
  const probes = [];
  for (const result of Array.isArray(results) ? results : []) {
    if (!result?.installStatePath || !fs.existsSync(result.installStatePath)) continue;
    for (const hook of recordedGuardianHooks(result.installStatePath)) {
      const probe = HOOK_PROBES[hook.script];
      probes.push({
        target: result.adapter?.id || 'unknown',
        script: hook.script,
        scriptPath: hook.scriptPath,
        what: probe.what,
        ...probeHook(hook.scriptPath, probe.event(homeDir), { timeoutMs, env, cwd: homeDir, what: probe.what }),
      });
    }
  }
  return {
    probes,
    refusing: probes.filter(probe => probe.status === 'ok').length,
    errorCount: probes.filter(probe => probe.status === 'error').length,
  };
}

module.exports = {
  DEFAULT_HOOK_PROBE_TIMEOUT_MS,
  HOOK_PROBES,
  PROBE_COMMAND,
  GUARDIAN_SIGNATURE,
  buildHookReport,
  isGuardianRefusal,
  isRefusal,
  probeHook,
  recordedGuardianHooks,
};
