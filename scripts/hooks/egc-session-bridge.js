#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_ID = 'egc-session-bridge';
// Python's cold start on Windows routinely costs several seconds (interpreter
// launch plus whatever scans the machine runs on a new process), and when the
// budget runs out mid-write the bridge records nothing while this hook still
// exits 0 by design. The result is a session whose events silently never land.
// The old 5s applied everywhere and was too tight for exactly that platform.
const DEFAULT_TIMEOUT_MS = process.platform === 'win32' ? 20000 : 5000;
const SAFE_PYTHON_BASENAMES = new Set(['python3', 'python3.exe', 'python', 'python.exe']);

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch (_) { // NOSONAR: missing stdin means no payload to bridge
    return '';
  }
}

function parsePayload(raw) {
  if (!raw?.trim()) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; } // NOSONAR: malformed payload is treated as empty
}

// The plugin root: the environment when it names an existing directory,
// otherwise the package this hook ships in. A root set in the environment
// that does not exist is reported, never silently replaced.
function resolvePluginRoot() {
  const fromEnv = process.env.EGC_PLUGIN_ROOT || process.env.ECC_PLUGIN_ROOT || process.env.GEMINI_PLUGIN_ROOT;
  if (!fromEnv) return { root: path.resolve(__dirname, '..', '..'), error: null };
  if (fs.existsSync(fromEnv)) return { root: fromEnv, error: null };
  return { root: null, error: `plugin root ${fromEnv} does not exist` };
}

// A bridge that cannot be found does not run, and the session must not
// look as if it had been bridged: the refusal is returned in the shape the
// hook runner honours (an exit code with the reason on stderr), so a
// broken install is seen instead of silently losing every session event,
// whether the hook runs directly or through run-with-flags.
function refuse(reason) {
  return {
    exitCode: 1,
    stderr: `[${HOOK_ID}] refused: ${reason}; set EGC_PLUGIN_ROOT to the EGC install directory or reinstall with egc install --target gemini\n`,
  };
}

function resolvePythonBin(pluginRoot) {
  const fromEnv = process.env.EGC_PYTHON_BIN;
  if (fromEnv?.trim() && SAFE_PYTHON_BASENAMES.has(path.basename(fromEnv.trim()).toLowerCase()) && fs.existsSync(fromEnv.trim())) return fromEnv.trim();
  const venvBin = os.platform() === 'win32'
    ? path.join(pluginRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(pluginRoot, '.venv', 'bin', 'python3');
  if (fs.existsSync(venvBin)) return venvBin;
  return os.platform() === 'win32' ? 'python.exe' : 'python3';
}

function disabled() {
  const flag = process.env.EGC_SESSION_BRIDGE;
  if (!flag) return false;
  return ['0', 'false', 'off', 'no'].includes(String(flag).toLowerCase());
}

function deriveEventName(payload) {
  const fromEnv = process.env.HOOK_EVENT_NAME || process.env.EGC_HOOK_EVENT;
  if (fromEnv) return String(fromEnv).toLowerCase();
  if (payload && typeof payload.hook_event_name === 'string') return payload.hook_event_name.toLowerCase();
  if (payload && typeof payload.event === 'string') return payload.event.toLowerCase();
  return 'sessionstart';
}

function run() {
  if (disabled()) return 0;

  const raw = readStdin();
  const payload = parsePayload(raw);
  const event = deriveEventName(payload);
  const sessionId = payload.session_id || process.env.EGC_SESSION_ID || process.env.ECC_SESSION_ID
    || `egc-${Date.now()}`;

  const { root: pluginRoot, error: rootError } = resolvePluginRoot();
  if (rootError) return refuse(rootError);
  const bridgePy = path.join(pluginRoot, 'scripts', 'runtime', 'session_bridge.py');
  if (!fs.existsSync(bridgePy)) return refuse(`bridge ${bridgePy} is missing under plugin root ${pluginRoot}`);

  const python = resolvePythonBin(pluginRoot);
  const env = { ...process.env };
  env.EGC_SESSION_ID = sessionId;
  env.ECC_SESSION_ID = sessionId;
  env.EGC_PLUGIN_ROOT = pluginRoot;
  env.PROJECT_ROOT = env.PROJECT_ROOT || process.cwd();

  const result = spawnSync(python, [bridgePy, event, sessionId], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: DEFAULT_TIMEOUT_MS,
    encoding: 'utf8',
  });

  if (result.error) {
    // ETIMEDOUT arrives here too, and it is the failure worth naming: it
    // means the bridge was killed before it could record anything.
    const detail = result.error.code === 'ETIMEDOUT'
      ? `timed out after ${DEFAULT_TIMEOUT_MS}ms`
      : result.error.message;
    process.stderr.write(`[${HOOK_ID}] soft-fail: ${detail}\n`);
    return 0;
  }
  if ((result.stderr || '').trim()) {
    process.stderr.write(`[${HOOK_ID}] ${String(result.stderr).trim().split('\n').pop()}\n`);
  }
  return 0;
}

if (require.main === module) {
  const outcome = run();
  if (outcome && typeof outcome === 'object') {
    if (outcome.stderr) process.stderr.write(outcome.stderr);
    process.exit(Number.isInteger(outcome.exitCode) ? outcome.exitCode : 0);
  }
  process.exit(outcome);
}

module.exports = { run };
