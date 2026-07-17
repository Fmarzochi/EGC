#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const OBSERVE_RELATIVE_PATH = path.join('skills', 'ai', 'continuous-learning-v2', 'hooks', 'observe.sh');
const DEFAULT_TIMEOUT_MS = 9000;
const SAFE_SHELL_BASENAMES = new Set(['bash', 'bash.exe', 'sh', 'sh.exe']);

function getPluginRoot(options = {}) {
  if (options.pluginRoot && String(options.pluginRoot).trim()) {
    return String(options.pluginRoot).trim();
  }
  const root = process.env.EGC_PLUGIN_ROOT || process.env.ECC_PLUGIN_ROOT || process.env.GEMINI_PLUGIN_ROOT;
  if (root?.trim()) {
    return root.trim();
  }
  return path.resolve(__dirname, '..', '..');
}

function resolveTarget(rootDir, relPath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(rootDir, relPath);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(`Path traversal rejected: ${relPath}`);
  }
  return resolvedTarget;
}

function toShellPath(filePath) {
  const normalized = String(filePath || '');
  if (process.platform !== 'win32') {
    return normalized;
  }

  return normalized
    .replace(/^([A-Za-z]):[\\/]/, (_, driveLetter) => `/${driveLetter.toLowerCase()}/`)
    .replaceAll('\\', '/');
}

function findShellBinary() {
  const candidates = [];
  if (process.env.BASH?.trim()) {
    const trimmed = process.env.BASH.trim();
    if (SAFE_SHELL_BASENAMES.has(path.basename(trimmed).toLowerCase())) {
      candidates.push(trimmed);
    }
  }

  if (process.platform === 'win32') {
    candidates.push('bash.exe', 'bash', 'sh');
  } else {
    candidates.push('bash', 'sh');
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', ':'], {
      stdio: 'ignore',
      windowsHide: true
    });
    if (!probe.error) {
      return candidate;
    }
  }

  return null;
}

function getPhaseFromHookId(hookId) {
  const prefix = String(hookId || process.env.EGC_HOOK_ID || process.env.ECC_HOOK_ID || '')
    .split(':')[0]
    .toLowerCase();
  return prefix === 'pre' || prefix === 'post' ? prefix : null;
}

function getTimeoutMs() {
  const parsed = Number.parseInt(process.env.EGC_OBSERVE_RUNNER_TIMEOUT_MS || process.env.ECC_OBSERVE_RUNNER_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function combineStderr(stderr, message) {
  let prefix = '';
  if (typeof stderr === 'string' && stderr.length > 0) {
    prefix = stderr.endsWith('\n') ? stderr : `${stderr}\n`;
  }
  return `${prefix}${message}\n`;
}

/**
 * Resolve and validate the observe script path within the plugin root.
 * Returns the resolved path string on success, or an error result object on failure.
 *
 * @param {string} pluginRoot - Absolute path to the plugin root
 * @returns {string | { stderr: string, exitCode: number }}
 */
function resolveObservePath(pluginRoot) {
  let observePath;
  try {
    observePath = resolveTarget(pluginRoot, OBSERVE_RELATIVE_PATH);
  } catch (error) {
    return {
      stderr: `[Hook] observe runner path resolution failed: ${error.message}`,
      exitCode: 0
    };
  }

  if (!fs.existsSync(observePath)) {
    return {
      stderr: `[Hook] observe script not found: ${observePath}`,
      exitCode: 0
    };
  }

  try {
    const realScript = fs.realpathSync(observePath);
    const realRoot = fs.realpathSync(path.resolve(pluginRoot));
    const realRel = path.relative(realRoot, realScript);
    if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) {
      return {
        stderr: `[Hook] symlink traversal rejected: ${observePath}`,
        exitCode: 0
      };
    }
  } catch (_) { // NOSONAR: failure is converted into a structured hook error result
    return {
      stderr: `[Hook] path resolution failed: ${observePath}`,
      exitCode: 0
    };
  }

  return observePath;
}

/**
 * Build a normalized output object from a spawnSync result.
 *
 * @param {import('child_process').SpawnSyncReturns<string>} result
 * @returns {{ exitCode: number, stdout?: string, stderr?: string }}
 */
function buildSpawnResult(result) {
  const output = {
    exitCode: Number.isInteger(result.status) ? result.status : 0
  };

  if (typeof result.stdout === 'string' && result.stdout.length > 0) {
    output.stdout = result.stdout;
  }
  if (typeof result.stderr === 'string' && result.stderr.length > 0) {
    output.stderr = result.stderr;
  }

  if (result.error || result.signal || result.status === null) {
    let reason;
    if (result.error) {
      reason = result.error.message;
    } else if (result.signal) {
      reason = `terminated by signal ${result.signal}`;
    } else {
      reason = 'missing exit status';
    }
    output.stderr = combineStderr(output.stderr, `[Hook] observe runner failed: ${reason}`);
    output.exitCode = 0;
  }

  return output;
}

function run(raw, options = {}) {
  const input = typeof raw === 'string' ? raw : String(raw ?? '');
  const phase = getPhaseFromHookId(options.hookId);
  if (!phase) {
    return {
      stderr: '[Hook] observe runner received an unsupported hook id; skipping observation',
      exitCode: 0
    };
  }

  const pluginRoot = getPluginRoot(options);
  const resolvedPathOrError = resolveObservePath(pluginRoot);
  if (typeof resolvedPathOrError !== 'string') {
    return resolvedPathOrError;
  }
  const observePath = resolvedPathOrError;

  const shell = findShellBinary();
  if (!shell) {
    return {
      stderr: '[Hook] shell runtime unavailable; skipping continuous-learning observation',
      exitCode: 0
    };
  }

  const result = spawnSync(shell, [toShellPath(observePath), phase], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      GEMINI_PLUGIN_ROOT: pluginRoot,
      EGC_PLUGIN_ROOT: pluginRoot,
      ECC_PLUGIN_ROOT: pluginRoot
    },
    cwd: process.cwd(),
    timeout: getTimeoutMs(),
    windowsHide: true
  });

  return buildSpawnResult(result);
}

function emitHookResult(raw, output) {
  if (output && typeof output === 'object') {
    if (output.stderr) {
      process.stderr.write(String(output.stderr).endsWith('\n') ? String(output.stderr) : `${output.stderr}\n`);
    }
    if (Object.hasOwn(output, 'stdout')) {
      process.stdout.write(String(output.stdout ?? ''));
    } else if (!Number.isInteger(output.exitCode) || output.exitCode === 0) {
      process.stdout.write(raw);
    }
    return Number.isInteger(output.exitCode) ? output.exitCode : 0;
  }

  process.stdout.write(raw);
  return 0;
}

function teeEventToStateDb(raw) {
  if (!raw?.trim()) return;
  const writerPath = path.join(__dirname, 'state-db-writer.js');
  if (!fs.existsSync(writerPath)) return;
  try {
    const child = spawn(process.execPath, [writerPath], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    child.stdin.end(raw);
    child.unref();
  } catch (_) { // NOSONAR
    // Intentional: state-db tee is best-effort; runtime must not block on writer failures.
  }
}

if (require.main === module) {
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_error) { // NOSONAR: missing stdin is treated as empty input
    raw = '';
  }
  const output = run(raw, { hookId: process.argv[2] || process.env.EGC_HOOK_ID || process.env.ECC_HOOK_ID });
  teeEventToStateDb(raw);
  process.exit(emitHookResult(raw, output));
}

module.exports = {
  OBSERVE_RELATIVE_PATH,
  findShellBinary,
  getPhaseFromHookId,
  run,
  teeEventToStateDb,
  toShellPath
};
