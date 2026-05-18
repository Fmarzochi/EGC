#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_ID = 'egc-session-bridge';
const DEFAULT_TIMEOUT_MS = 5000;

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function resolvePluginRoot() {
  const fromEnv = process.env.EGC_PLUGIN_ROOT || process.env.ECC_PLUGIN_ROOT || process.env.GEMINI_PLUGIN_ROOT;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return path.resolve(__dirname, '..', '..');
}

function resolvePythonBin(pluginRoot) {
  const fromEnv = process.env.EGC_PYTHON_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
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

  const pluginRoot = resolvePluginRoot();
  const bridgePy = path.join(pluginRoot, 'scripts', 'runtime', 'session_bridge.py');
  if (!fs.existsSync(bridgePy)) return 0;

  const python = resolvePythonBin(pluginRoot);
  const env = Object.assign({}, process.env);
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
    process.stderr.write(`[${HOOK_ID}] soft-fail: ${result.error.message}\n`);
    return 0;
  }
  if ((result.stderr || '').trim()) {
    process.stderr.write(`[${HOOK_ID}] ${String(result.stderr).trim().split('\n').pop()}\n`);
  }
  return 0;
}

if (require.main === module) {
  process.exit(run());
}

module.exports = { run };
