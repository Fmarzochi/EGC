#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SAFE_SHELL_BASENAMES = new Set(['bash', 'bash.exe', 'sh', 'sh.exe']);

function readStdinRaw() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_error) { // NOSONAR: missing stdin is treated as empty input
    return '';
  }
}

function writeStderr(stderr) {
  if (typeof stderr === 'string' && stderr.length > 0) {
    process.stderr.write(stderr);
  }
}

function passthrough(raw, result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  if (stdout) {
    process.stdout.write(stdout);
    return;
  }

  if (!Number.isInteger(result?.status) || result.status === 0) {
    process.stdout.write(raw);
  }
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
  if (!fs.existsSync(resolvedTarget)) {
    throw new Error(`hook script missing: ${resolvedTarget}; the EGC install under ${resolvedRoot} is incomplete`);
  }
  return resolvedTarget;
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
    candidates.push('bash.exe', 'bash');
  } else {
    candidates.push('bash', 'sh');
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', ':'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (!probe.error) {
      return candidate;
    }
  }

  return null;
}

function spawnNode(rootDir, relPath, raw, args) {
  return spawnSync(process.execPath, [resolveTarget(rootDir, relPath), ...sanitizeArgs(args)], { // NOSONAR jssecurity:S8705
    input: raw,
    encoding: 'utf8',
    env: {
      ...process.env,
      GEMINI_PLUGIN_ROOT: rootDir,
      EGC_PLUGIN_ROOT: rootDir,
      ECC_PLUGIN_ROOT: rootDir,
    },
    cwd: process.cwd(),
    timeout: 30000,
    windowsHide: true,
  });
}

function spawnShell(rootDir, relPath, raw, args) {
  // The target is resolved and checked before the runtime question, so a
  // missing hook is refused whether or not a shell is available.
  const target = resolveTarget(rootDir, relPath);
  const shell = findShellBinary();
  if (!shell) {
    return {
      status: 0,
      stdout: '',
      stderr: '[Hook] shell runtime unavailable; skipping shell-backed hook\n',
    };
  }

  return spawnSync(shell, [target, ...sanitizeArgs(args)], { // NOSONAR jssecurity:S8705
    input: raw,
    encoding: 'utf8',
    env: {
      ...process.env,
      GEMINI_PLUGIN_ROOT: rootDir,
      EGC_PLUGIN_ROOT: rootDir,
      ECC_PLUGIN_ROOT: rootDir,
    },
    cwd: process.cwd(),
    timeout: 30000,
    windowsHide: true,
  });
}

const { trace } = require('../lib/utils');

function sanitizeArgs(args) {
  return args.filter(a => typeof a === 'string' && !a.includes('\0'));
}

// A hook that cannot be resolved does not run, and a hook that does not run
// must not look as if it had: the call is refused with the blocking status
// every harness honours and the reason on stderr, so a broken install is
// seen the first time instead of leaving the session silently unguarded.
const REFUSED_STATUS = 2;
const INSTALL_HINT = 'set EGC_PLUGIN_ROOT to the EGC install directory, or reinstall with egc install --target gemini';

function refuse(reason) {
  writeStderr(`[Hook] ${reason}; ${INSTALL_HINT}\n`);
  process.exit(REFUSED_STATUS);
}

function refuseUnlessResolvable(mode, relPath, rootDir) {
  if (!mode || !relPath) {
    refuse(`bootstrap called without a mode or a target script (mode: ${mode || 'none'}, target: ${relPath || 'none'}); check the hook registration`);
  }
  if (!rootDir) {
    refuse('EGC plugin root not resolved');
  }
  if (!fs.existsSync(rootDir)) {
    refuse(`EGC plugin root ${rootDir} does not exist`);
  }
}

function runTarget(mode, rootDir, relPath, raw, args) {
  try {
    if (mode === 'node') return spawnNode(rootDir, relPath, raw, args);
    if (mode === 'shell') return spawnShell(rootDir, relPath, raw, args);
    return refuse(`unknown bootstrap mode: ${mode}`);
  } catch (error) {
    return refuse(`bootstrap resolution failed: ${error.message}`);
  }
}

function main() {
  const [, , mode, relPath, ...args] = process.argv;
  const raw = readStdinRaw();
  const rootDir = process.env.EGC_PLUGIN_ROOT || process.env.ECC_PLUGIN_ROOT || process.env.GEMINI_PLUGIN_ROOT;

  trace('hook:bootstrap:entry', { mode, relPath, args, rootDir });
  refuseUnlessResolvable(mode, relPath, rootDir);
  const result = runTarget(mode, rootDir, relPath, raw, args);

  passthrough(raw, result);
  writeStderr(result.stderr);

  if (result.error || result.signal || result.status === null) {
    let reason;
    if (result.error) {
      reason = result.error.message;
    } else if (result.signal) {
      reason = `terminated by signal ${result.signal}`;
    } else {
      reason = 'missing exit status';
    }
    writeStderr(`[Hook] bootstrap execution failed: ${reason}\n`);
    process.exit(0);
  }

  process.exit(Number.isInteger(result.status) ? result.status : 0);
}

main();
