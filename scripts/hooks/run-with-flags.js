#!/usr/bin/env node
/**
 * Executes a hook script only when enabled by EGC hook profile flags.
 *
 * Usage:
 *   node run-with-flags.js <hookId> <scriptRelativePath> [profilesCsv]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isHookEnabled } = require('../lib/hook-flags');

const MAX_STDIN = 1024 * 1024;

function readStdinRaw() {
  return new Promise(resolve => {
    let raw = '';
    let truncated = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      if (raw.length < MAX_STDIN) {
        const remaining = MAX_STDIN - raw.length;
        raw += chunk.substring(0, remaining);
        if (chunk.length > remaining) {
          truncated = true;
        }
      } else {
        truncated = true;
      }
    });
    process.stdin.on('end', () => resolve({ raw, truncated }));
    process.stdin.on('error', () => resolve({ raw, truncated }));
  });
}

function writeStderr(stderr) {
  if (typeof stderr !== 'string' || stderr.length === 0) {
    return;
  }

  process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
}

function emitHookResult(raw, output) {
  if (typeof output === 'string' || Buffer.isBuffer(output)) {
    process.stdout.write(String(output));
    return 0;
  }

  if (output && typeof output === 'object') {
    writeStderr(output.stderr);

    if (Object.prototype.hasOwnProperty.call(output, 'stdout')) {
      process.stdout.write(String(output.stdout ?? ''));
    } else if (!Number.isInteger(output.exitCode) || output.exitCode === 0) {
      process.stdout.write(raw);
    }

    return Number.isInteger(output.exitCode) ? output.exitCode : 0;
  }

  process.stdout.write(raw);
  return 0;
}

function writeLegacySpawnOutput(raw, result) {
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  if (stdout) {
    process.stdout.write(stdout);
    return;
  }

  if (Number.isInteger(result.status) && result.status === 0) {
    process.stdout.write(raw);
  }
}

function getPluginRoot() {
  const root = process.env.EGC_PLUGIN_ROOT || process.env.ECC_PLUGIN_ROOT || process.env.GEMINI_PLUGIN_ROOT;
  if (root && root.trim()) {
    return root.trim();
  }
  return path.resolve(__dirname, '..', '..');
}

/**
 * Validates that `scriptPath` is safely contained within `resolvedRoot`,
 * checks existence, and re-validates after resolving symlinks to prevent
 * symlink escape attacks. Throws an Error with a descriptive message if any
 * check fails; callers must handle the error and allow the hook to pass through.
 */
function assertSafeScriptPath(hookId, scriptPath, resolvedRoot) {
  const relPath = path.relative(resolvedRoot, scriptPath);
  if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
    throw new Error(`[Hook] Path traversal rejected for ${hookId}: ${scriptPath}`);
  }

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`[Hook] Script not found for ${hookId}: ${scriptPath}`);
  }

  try {
    const realScript = fs.realpathSync(scriptPath);
    const realRoot = fs.realpathSync(resolvedRoot);
    const realRel = path.relative(realRoot, realScript);
    if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(`[Hook] Symlink traversal rejected for ${hookId}: ${scriptPath}`);
    }
  } catch (err) {
    if (err.message && err.message.startsWith('[Hook]')) throw err;
    throw new Error(`[Hook] Path resolution failed for ${hookId}: ${scriptPath}`, { cause: err });
  }
}

/**
 * Executes the hook at `scriptPath`. Prefers direct require() when the hook
 * exports run(); falls back to a legacy spawnSync child process otherwise.
 * Handles output emission and process.exit on all code paths.
 */
async function executeHook(hookId, scriptPath, pluginRoot, raw, truncated) {
  const resolvedRoot = path.resolve(pluginRoot);
  try {
    assertSafeScriptPath(hookId, scriptPath, resolvedRoot);
  } catch (pathErr) {
    process.stderr.write(`${pathErr.message}\n`);
    process.stdout.write(raw);
    process.exit(0);
  }

  // Prefer direct require() when the hook exports a run(rawInput) function.
  // This eliminates one Node.js process spawn (~50-100ms savings per hook).
  //
  // SAFETY: Only require() hooks that export run(). Legacy hooks execute
  // side effects at module scope (stdin listeners, process.exit, main() calls)
  // which would interfere with the parent process or cause double execution.
  let hookModule;
  const src = fs.readFileSync(scriptPath, 'utf8');
  const hasRunExport = /\bmodule\.exports\b/.test(src) && /\brun\b/.test(src);

  if (hasRunExport) {
    try {
      hookModule = require(scriptPath);
    } catch (requireErr) {
      process.stderr.write(`[Hook] require() failed for ${hookId}: ${requireErr.message}\n`);
    }
  }

  if (hookModule && typeof hookModule.run === 'function') {
    try {
      const output = hookModule.run(raw, {
        hookId,
        pluginRoot,
        scriptPath,
        truncated,
        maxStdin: MAX_STDIN
      });
      process.exit(emitHookResult(raw, output));
    } catch (runErr) {
      process.stderr.write(`[Hook] run() error for ${hookId}: ${runErr.message}\n`);
      process.stdout.write(raw);
    }
    process.exit(0);
  }

  // Legacy path: spawn a child Node process for hooks without run() export
  const result = spawnSync(process.execPath, [scriptPath], {
    input: raw,
    encoding: 'utf8',
    env: {
      ...process.env,
      GEMINI_PLUGIN_ROOT: pluginRoot,
      EGC_PLUGIN_ROOT: pluginRoot,
      ECC_PLUGIN_ROOT: pluginRoot,
      EGC_HOOK_ID: hookId,
      ECC_HOOK_ID: hookId,
      EGC_HOOK_INPUT_TRUNCATED: truncated ? '1' : '0',
      ECC_HOOK_INPUT_TRUNCATED: truncated ? '1' : '0',
      EGC_HOOK_INPUT_MAX_BYTES: String(MAX_STDIN),
      ECC_HOOK_INPUT_MAX_BYTES: String(MAX_STDIN)
    },
    cwd: process.cwd(),
    timeout: 30000
  });

  writeLegacySpawnOutput(raw, result);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error || result.signal || result.status === null) {
    const failureDetail = result.error
      ? result.error.message
      : result.signal
        ? `terminated by signal ${result.signal}`
        : 'missing exit status';
    writeStderr(`[Hook] legacy hook execution failed for ${hookId}: ${failureDetail}`);
    process.exit(1);
  }

  process.exit(Number.isInteger(result.status) ? result.status : 0);
}

async function main() {
  const [, , hookId, relScriptPath, profilesCsv] = process.argv;
  const { raw, truncated } = await readStdinRaw();

  if (!hookId || !relScriptPath) {
    process.stdout.write(raw);
    process.exit(0);
  }

  if (!isHookEnabled(hookId, { profiles: profilesCsv })) {
    process.stdout.write(raw);
    process.exit(0);
  }

  const pluginRoot = getPluginRoot();
  const resolvedRoot = path.resolve(pluginRoot);
  const scriptPath = path.resolve(pluginRoot, relScriptPath);

  try {
    assertSafeScriptPath(hookId, scriptPath, resolvedRoot);
  } catch (pathErr) {
    process.stderr.write(`${pathErr.message}\n`);
    process.stdout.write(raw);
    process.exit(0);
  }

  await executeHook(hookId, scriptPath, pluginRoot, raw, truncated);
}

main().catch(err => {
  process.stderr.write(`[Hook] run-with-flags error: ${err.message}\n`);
  process.exit(0);
});
