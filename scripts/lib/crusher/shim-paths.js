'use strict';

// Shared paths and PATH-resolution helpers for the Token Crusher binary shim.
// Used by both shim-dispatch.js (runs on every shimmed invocation) and
// shim-install.js (install/uninstall/status), so the two never disagree on
// where things live or how a "real" binary is found.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Conservative v1 list: binaries whose subcommands the engine already
// classifies (see engine.js commandKind()) and that are not invoked so
// pervasively that a bug in resolution would be catastrophic. Deliberately
// excludes node, go, cargo, dotnet, mvn/gradle: each is either the runtime
// this very shim runs on, or invoked too broadly for a v1 blast radius.
const SHIM_BINARY_NAMES = [
  'git', 'npm', 'pnpm', 'yarn', 'bun',
  'pip', 'pip3', 'poetry', 'pipenv', 'uv',
  'composer', 'bundle', 'gh',
];

function shimDir() {
  return path.join(os.homedir(), '.egc', 'bin');
}

function manifestPath() {
  return path.join(shimDir(), 'manifest.json');
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  } catch {
    return {};
  }
}

function pathEnvKey() {
  return Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
}

// Resolves the real binary on PATH with the shim directory filtered out, so
// this never just finds the shim itself (directly at install time, before
// any manifest exists, and as a fallback at dispatch time if the manifest is
// missing, stale, or its target no longer exists).
function resolveWithoutShim(name) {
  const dir = shimDir();
  const key = pathEnvKey();
  const filtered = (process.env[key] || '')
    .split(path.delimiter)
    .filter(p => p && path.resolve(p) !== path.resolve(dir));

  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { // NOSONAR jssecurity:S8705 -- name is always a hardcoded SHIM_BINARY_NAMES entry or the launcher's own baked-in name, never untrusted input; array-form with no shell also rules out injection
    encoding: 'utf8',
    env: { ...process.env, [key]: filtered.join(path.delimiter) },
  });
  if (probe.status !== 0 || !probe.stdout) return null;
  const first = probe.stdout.split(/\r?\n/).map(l => l.trim()).find(Boolean);
  return first || null;
}

function resolveRealBinary(name) {
  const manifest = readManifest();
  const fromManifest = manifest[name];
  if (fromManifest && fs.existsSync(fromManifest)) return fromManifest;
  return resolveWithoutShim(name);
}

module.exports = {
  SHIM_BINARY_NAMES,
  shimDir,
  manifestPath,
  readManifest,
  pathEnvKey,
  resolveWithoutShim,
  resolveRealBinary,
};
