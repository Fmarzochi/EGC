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

function readManifest(dir = shimDir()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return {};
  }
}

function pathEnvKey() {
  return Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
}

// Windows and default macOS (HFS+/APFS) filesystems are case-insensitive, so
// a PATH entry that differs from shimDir() only in casing would otherwise
// slip past the filter below and resolve back to the shim itself --
// structurally the exact infinite-recursion case this filter exists to rule
// out. Linux stays case-sensitive, matching its case-sensitive filesystem.
function normalizePathForCompare(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

// A HOME/USERPROFILE override moves what os.homedir() returns, so everything
// derived from shimDir() silently points somewhere else while the installed
// launcher files stay where they are. Identity comparisons therefore go
// through the filesystem's physical view of a path whenever the path exists;
// path.resolve alone would keep a symlinked PATH entry distinct from the
// shim directory it aliases.
function realpathOrResolve(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function excludedDirSet(extraExcludeDirs) {
  return new Set(
    [shimDir(), ...extraExcludeDirs].map(d => normalizePathForCompare(realpathOrResolve(d)))
  );
}

// Spawning whatever resolution returns is exactly how the shim once recursed
// into itself under a HOME override (each level a fresh node process, until
// the machine's OOM killer stepped in): a candidate that physically lives in
// a shim directory is never a "real" binary, no matter how it was found.
function isShimCandidate(candidate, excluded) {
  return excluded.has(normalizePathForCompare(path.dirname(realpathOrResolve(candidate))));
}

// Resolves the real binary on PATH with the shim directory filtered out, so
// this never just finds the shim itself (directly at install time, before
// any manifest exists, and as a fallback at dispatch time if the manifest is
// missing, stale, or its target no longer exists). shimDir() follows
// HOME/USERPROFILE, so callers that know a physical shim location the
// override would hide (the dispatcher knows its own launcher file) pass it
// via extraExcludeDirs; every candidate is also checked physically, since a
// PATH entry can reach the shim directory under a different spelling.
function resolveWithoutShim(name, extraExcludeDirs = []) {
  const excluded = excludedDirSet(extraExcludeDirs);
  const key = pathEnvKey();
  const filtered = (process.env[key] || '')
    .split(path.delimiter)
    .filter(p => p && !excluded.has(normalizePathForCompare(realpathOrResolve(p))));

  // `where` already lists every match; `which` needs -a for the same, so a
  // first hit that turns out to live in a shim directory is not the end of
  // the search.
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', process.platform === 'win32' ? [name] : ['-a', name], { // NOSONAR jssecurity:S8705 -- name is always a hardcoded SHIM_BINARY_NAMES entry or the launcher's own baked-in name, never untrusted input; array-form with no shell also rules out injection
    encoding: 'utf8',
    env: { ...process.env, [key]: filtered.join(path.delimiter) },
  });
  if (probe.status !== 0 || !probe.stdout) return null;
  const candidates = probe.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return candidates.find(c => !isShimCandidate(c, excluded)) || null;
}

// launcherPath is the physical launcher file of the invocation in progress
// (process.argv[1] at dispatch time). It anchors two things a HOME override
// would otherwise break: where the manifest actually lives (next to the
// launcher, not under the overridden home), and which directory must never
// be resolved back into.
function resolveRealBinary(name, launcherPath = null) {
  const launcherDir = launcherPath ? path.dirname(realpathOrResolve(launcherPath)) : null;
  const excludeDirs = launcherDir ? [launcherDir] : [];
  const excluded = excludedDirSet(excludeDirs);

  const manifestDirs = [...new Set([launcherDir, shimDir()].filter(Boolean))];
  for (const dir of manifestDirs) {
    const target = readManifest(dir)[name];
    if (target && fs.existsSync(target) && !isShimCandidate(target, excluded)) return target;
  }
  return resolveWithoutShim(name, excludeDirs);
}

module.exports = {
  SHIM_BINARY_NAMES,
  shimDir,
  manifestPath,
  readManifest,
  pathEnvKey,
  normalizePathForCompare,
  resolveWithoutShim,
  resolveRealBinary,
};
