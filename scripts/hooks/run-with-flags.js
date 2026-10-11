#!/usr/bin/env node
/**
 * Executes a hook script only when enabled by EGC hook profile flags.
 *
 * Usage:
 *   node run-with-flags.js <hookId> <scriptRelativePath> [profilesCsv]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isHookEnabled } = require('../lib/hook-flags');
const { MAX_HOOK_INPUT_BYTES: MAX_STDIN, readHookInput } = require('../lib/guardian-bin');

function readStdinRaw() {
  return new Promise(resolve => readHookInput(resolve));
}

function writeStderr(stderr) {
  if (typeof stderr !== 'string' || stderr.length === 0) {
    return;
  }

  process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
}

// The text between the braces of the object literal whose `{` sits at
// openIndex, with nested brackets balanced and string literals skipped,
// or null when the literal never closes.
function objectLiteralBody(src, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{' || ch === '(' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) return src.slice(openIndex + 1, i);
    }
  }
  return null;
}

// The entries of an object literal body, split at the commas of its top
// level only.
function topLevelEntries(body) {
  const entries = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (i === body.length || (ch === ',' && depth === 0)) {
      entries.push(body.slice(start, i));
      start = i + 1;
    }
  }
  return entries;
}

// The property names at the top level of an object literal: `run`,
// `run: fn`, `run() {}`, `async run() {}`, `'run': fn`. A `run` nested in
// another property's value is not an export.
const ENTRY_KEY = /^\s*(?:async\s+)?['"]?([A-Za-z_$][\w$]*)['"]?\s*(?:[:(]|$)/;

function topLevelKeys(body) {
  const keys = [];
  for (const entry of topLevelEntries(body)) {
    const match = ENTRY_KEY.exec(entry);
    if (match) keys.push(match[1]);
  }
  return keys;
}

// A hook is required in-process only when its source exports run() as a
// top-level property of module.exports (or assigns module.exports.run or
// exports.run). A hook that merely mentions "run" in a comment, a helper
// name or a nested object would be required here, run its module scope,
// and then run it again in the child the legacy path spawns.
function exportsRun(src) {
  if (/\bmodule\.exports\.run\s*=/.test(src) || /\bexports\.run\s*=/.test(src)) return true;
  const open = /\bmodule\.exports\s*=\s*\{/.exec(src);
  if (!open) return false;
  const body = objectLiteralBody(src, open.index + open[0].length - 1);
  return body !== null && topLevelKeys(body).includes('run');
}

// The required module of a hook whose source exports run(), or null when it
// exports none or cannot be required.
function loadRunExport(hookId, scriptPath) {
  const src = fs.readFileSync(scriptPath, 'utf8'); // NOSONAR jssecurity:S8707
  if (!exportsRun(src)) return null;
  let hookModule;
  try {
    hookModule = require(scriptPath);
  } catch (requireErr) {
    process.stderr.write(`[Hook] require() failed for ${hookId}: ${requireErr.message}\n`);
    return null;
  }
  return hookModule && typeof hookModule.run === 'function' ? hookModule : null;
}

function emitHookResult(raw, output) {
  if (typeof output === 'string' || Buffer.isBuffer(output)) {
    process.stdout.write(String(output));
    return 0;
  }

  if (output && typeof output === 'object') {
    writeStderr(output.stderr);

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
  if (root?.trim()) {
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
    if (err.message?.startsWith('[Hook]')) throw err;
    throw new Error(`[Hook] Path resolution failed for ${hookId}: ${scriptPath}`, { cause: err });
  }
}

/**
 * Executes the hook at `scriptPath`. Prefers direct require() when the hook
 * exports run(); falls back to a legacy spawnSync child process otherwise.
 * Handles output emission and process.exit on all code paths.
 */
async function executeHook(hookId, scriptPath, pluginRoot, raw, truncated) { // NOSONAR: central hook executor keeps every exit path visible inline for security review
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
  const hookModule = loadRunExport(hookId, scriptPath);

  if (hookModule) {
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
  const result = spawnSync(process.execPath, [scriptPath], { // NOSONAR jssecurity:S8705
    input: raw,
    encoding: 'utf8',
    env: {
      ...process.env,
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
    let failureDetail;
    if (result.error) {
      failureDetail = result.error.message;
    } else if (result.signal) {
      failureDetail = `terminated by signal ${result.signal}`;
    } else {
      failureDetail = 'missing exit status';
    }
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
