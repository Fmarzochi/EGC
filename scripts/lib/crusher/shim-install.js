'use strict';

// Installs/removes the Token Crusher binary shim: a small launcher file per
// binary in ~/.egc/bin (git, npm, ...), a manifest recording each binary's
// real underlying path, and a PATH entry so the shim directory is found
// before the real binaries. This works for any tool that shells out --
// unlike the PreToolUse hook rewrite, it does not depend on any AI harness
// honoring a rewritten command.
//
// A new shell session is required for the PATH change to take effect; this
// module only edits config, it cannot change the PATH of the process that
// invoked it (or any already-running shell).

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  SHIM_BINARY_NAMES,
  shimDir,
  manifestPath,
  readManifest,
  readManifestRecord,
  pathEnvKey,
  resolveWithoutShim,
} = require('./shim-paths');

const DISPATCH_MODULE = path.join(__dirname, 'shim-dispatch.js');
const PACKAGE_JSON = path.join(__dirname, '..', '..', '..', 'package.json');

// Read on every call rather than cached at require time: egc auto-update
// pulls a git-clone install before it verifies the shim, and the version the
// module loaded with would be the one from before the pull.
function packageVersion() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version;
}

function sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function launcherPath(dir, name) {
  return process.platform === 'win32' ? path.join(dir, `${name}.cmd`) : path.join(dir, name);
}
const PATH_MARKER = 'EGC Token Crusher shim';
const RC_CANDIDATES = ['.bashrc', '.zshrc', '.bash_profile', '.profile'];

function launcherNotFoundMessage(name) {
  // The launcher hardcodes an absolute path back into this repo checkout
  // (there is nowhere else for it to point to). If that checkout is moved,
  // renamed, or deleted, require() throws MODULE_NOT_FOUND -- catching it
  // here trades Node's raw stack trace for a message that actually tells
  // the person what to do about it.
  return `${name}: the EGC Token Crusher shim can't find its own code (was the EGC checkout moved or deleted?). Run 'egc crusher-shim install' again from wherever it lives now, or 'egc crusher-shim uninstall' to remove this shim.`;
}

function posixLauncherSource(name) {
  return [
    '#!/usr/bin/env node',
    'try {',
    `  require(${JSON.stringify(DISPATCH_MODULE)}).runShim(${JSON.stringify(name)}, process.argv.slice(2));`,
    '} catch (e) {',
    String.raw`  if (e.code === 'MODULE_NOT_FOUND') { process.stderr.write(${JSON.stringify(launcherNotFoundMessage(name))} + '\n'); process.exit(127); }`,
    '  throw e;',
    '}',
    '',
  ].join('\n');
}

function windowsLauncherSource(name) {
  // cmd.exe/PowerShell resolve PATHEXT-listed extensions; a POSIX shebang
  // does not execute there, so this spawns node on shim-dispatch.js as a
  // separate process instead of requiring it in-process. Batch has no
  // exception handling, so the existence check happens up front instead of
  // catching node's own error after the fact (see posixLauncherSource for
  // why this check exists at all).
  // %~dp0 is the directory this .cmd physically lives in. The dispatcher
  // cannot learn that from process.argv[1] on Windows (it sees
  // shim-dispatch.js, not the launcher), and deriving it from USERPROFILE
  // breaks under profile overrides -- the exact recursion hole the POSIX
  // side closes via its shebang launcher path.
  return [
    '@echo off',
    `if not exist "${DISPATCH_MODULE}" (`,
    `  echo ${launcherNotFoundMessage(name)}`,
    '  exit /b 127',
    ')',
    'set "EGC_SHIM_LAUNCHER_DIR=%~dp0"',
    `node "${DISPATCH_MODULE}" ${name} %*`,
    '',
  ].join('\r\n');
}

function writeLauncher(dir, name) {
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, `${name}.cmd`), windowsLauncherSource(name));
    return;
  }
  const launcherPath = path.join(dir, name);
  fs.writeFileSync(launcherPath, posixLauncherSource(name));
  fs.chmodSync(launcherPath, 0o755); // NOSONAR javascript:S2612 -- rwxr-xr-x, the minimum needed to make this launcher executable; not group/other-writable
}

function removeLauncher(dir, name) {
  const launcherPath = process.platform === 'win32' ? path.join(dir, `${name}.cmd`) : path.join(dir, name);
  if (fs.existsSync(launcherPath)) {
    fs.unlinkSync(launcherPath);
    return true;
  }
  return false;
}

function addToRcFile(rcPath, dir) {
  if (!fs.existsSync(rcPath)) return { path: rcPath, changed: false, reason: 'does not exist' };
  const content = fs.readFileSync(rcPath, 'utf8');
  if (content.includes(PATH_MARKER)) return { path: rcPath, changed: false, reason: 'already installed' };
  const block = `\n# ${PATH_MARKER} (added by egc crusher-shim install)\nexport PATH="${dir}:$PATH"\n`;
  fs.appendFileSync(rcPath, block);
  return { path: rcPath, changed: true };
}

function removeFromRcFile(rcPath) {
  if (!fs.existsSync(rcPath)) return { path: rcPath, changed: false };
  const lines = fs.readFileSync(rcPath, 'utf8').split('\n');
  const markerIdx = lines.findIndex(l => l.includes(PATH_MARKER));
  if (markerIdx === -1) return { path: rcPath, changed: false };

  const toRemove = new Set([markerIdx]);
  if ((lines[markerIdx + 1] || '').trim().startsWith('export PATH=')) toRemove.add(markerIdx + 1);
  if (markerIdx > 0 && lines[markerIdx - 1].trim() === '') toRemove.add(markerIdx - 1);

  const kept = lines.filter((_, i) => !toRemove.has(i));
  fs.writeFileSync(rcPath, kept.join('\n'));
  return { path: rcPath, changed: true };
}

function installPosixPath(dir) {
  const home = os.homedir();
  return RC_CANDIDATES.map(name => addToRcFile(path.join(home, name), dir));
}

function uninstallPosixPath() {
  const home = os.homedir();
  return RC_CANDIDATES.map(name => removeFromRcFile(path.join(home, name)));
}

// PowerShell double-quoted strings ("...") interpolate $variables; single
// quotes ('...') do not. JSON.stringify() always emits double quotes, so
// embedding it directly would let a $ anywhere in the path (rare, but valid
// in a Windows username) be misread as a PowerShell variable reference.
// Single-quoting with '' as the escape for an embedded ' is the standard,
// safe way to embed an arbitrary string in a PowerShell script.
function powershellSingleQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }); // NOSONAR javascript:S4036 -- this IS the feature: prepending our own ~/.egc/bin (never user/attacker-writable beyond the local account already running this installer) ahead of the existing user PATH, read/written only through Windows's own SetEnvironmentVariable API
  if (result.error) {
    return { ok: false, stdout: '', error: result.error.message };
  }
  if (result.status !== 0) {
    // spawnSync only ever populates result.error for a failure to launch
    // powershell.exe itself; a script-level failure (bad syntax, denied
    // registry write, execution policy) instead surfaces as a non-zero
    // status with nothing in result.error, which the previous version of
    // this code silently treated as success.
    return { ok: false, stdout: result.stdout || '', error: (result.stderr || `powershell exited with status ${result.status}`).trim() };
  }
  return { ok: true, stdout: result.stdout || '', error: null };
}

// Best-effort: not exercised on real Windows by this repo's CI or by any
// test in this suite (process.platform !== 'win32' everywhere else here).
// Persisting a user env var on Windows has no direct Node API; this shells
// out to PowerShell, which every supported Windows version ships.
function installWindowsPath(dir) {
  const safeDir = powershellSingleQuote(dir);
  const script = `$dir = ${safeDir}; $current = [Environment]::GetEnvironmentVariable('Path','User'); if ($current -eq $null) { $current = '' }; $parts = ($current -split ';') | Where-Object { $_ }; if ($parts -notcontains $dir) { [Environment]::SetEnvironmentVariable('Path', (@($dir) + $parts -join ';'), 'User'); Write-Output 'changed' } else { Write-Output 'already-present' }`;
  const result = runPowerShell(script);
  return { changed: result.ok && /changed/.test(result.stdout), error: result.error };
}

function uninstallWindowsPath(dir) {
  const safeDir = powershellSingleQuote(dir);
  const script = `$dir = ${safeDir}; $current = [Environment]::GetEnvironmentVariable('Path','User'); if ($current -eq $null) { $current = '' }; $parts = ($current -split ';') | Where-Object { $_ }; if ($parts -contains $dir) { [Environment]::SetEnvironmentVariable('Path', (($parts | Where-Object { $_ -ne $dir }) -join ';'), 'User'); Write-Output 'changed' } else { Write-Output 'not-present' }`;
  const result = runPowerShell(script);
  return { changed: result.ok && /changed/.test(result.stdout), error: result.error };
}

function install() {
  // Without the dispatch hash the manifest could not be verified later, and a
  // shim whose launchers cannot load their module is worse than none.
  const dispatch = sha256File(DISPATCH_MODULE);
  if (!dispatch) throw new Error(`Token Crusher dispatch module unreadable at ${DISPATCH_MODULE}; the shim was not written`);
  const dir = shimDir();
  fs.mkdirSync(dir, { recursive: true });

  const binaries = {};
  const launchers = {};
  const installed = [];
  const skipped = [];

  for (const name of SHIM_BINARY_NAMES) {
    const realPath = resolveWithoutShim(name);
    if (!realPath) {
      skipped.push(name);
      continue;
    }
    binaries[name] = realPath;
    writeLauncher(dir, name);
    launchers[name] = sha256File(launcherPath(dir, name));
    installed.push(name);
  }

  // The version and the hashes pin the shim to this install: verify() tells a
  // launcher another version wrote, or one edited on disk, from a healthy one.
  const manifest = { version: packageVersion(), dispatch, binaries, launchers };
  fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2));
  const pathResult = process.platform === 'win32' ? installWindowsPath(dir) : installPosixPath(dir);

  return { dir, installed, skipped, pathResult };
}

function uninstall() {
  const dir = shimDir();
  const manifest = readManifest();
  const removed = Object.keys(manifest).filter(name => removeLauncher(dir, name));

  if (fs.existsSync(manifestPath())) fs.unlinkSync(manifestPath());
  const pathResult = process.platform === 'win32' ? uninstallWindowsPath(dir) : uninstallPosixPath();

  return { dir, removed, pathResult };
}

/**
 * Checks whether the shim directory PATH addition is persisted in the environment or RC files.
 *
 * @param {string} [dir] The shim directory to look for.
 * @returns {boolean} True if the PATH entry is persisted.
 */
function isPathPersisted(dir = shimDir()) {
  if (process.platform === 'win32') {
    const safeDir = powershellSingleQuote(dir);
    const script = `$dir = ${safeDir}; $current = [Environment]::GetEnvironmentVariable('Path','User'); if ($current -eq $null) { $current = '' }; $parts = ($current -split ';') | Where-Object { $_ }; if ($parts -contains $dir) { Write-Output 'present' } else { Write-Output 'not-present' }`;
    const result = runPowerShell(script);
    return result.ok && result.stdout.trim() === 'present';
  }
  const home = os.homedir();
  return RC_CANDIDATES.some(name => {
    const rcPath = path.join(home, name);
    try {
      if (!fs.existsSync(rcPath)) return false;
      const content = fs.readFileSync(rcPath, 'utf8');
      return content.split(/\r?\n/).some(line => line.trim() === `export PATH="${dir}:$PATH"`);
    } catch { // NOSONAR: inaccessible or unreadable RC file is treated as not persisted
      return false;
    }
  });
}

/**
 * Compares the shim on disk with what this package would write: the version
 * that wrote the manifest, the dispatch module hash and the hash of every
 * launcher. missing: nothing installed; legacy: a manifest from before the
 * pinning; stale: a manifest that cannot be read or lacks a hash, another
 * version or another dispatch module; altered: a launcher whose content
 * changed; ok: all of it matches. reason names which of those it was.
 *
 * @returns {{ installed: boolean, state: string, reason: string|null, version: string|null, expectedVersion: string, altered: string[], dir: string }}
 */
function verify(dir = shimDir()) {
  const expectedVersion = packageVersion();
  const record = readManifestRecord(dir);
  const base = { dir, expectedVersion, version: record ? record.version : null, altered: [], reason: null };
  if (!record) return { ...base, installed: false, state: 'missing' };
  if (record.corrupt) return { ...base, installed: true, state: 'stale', reason: 'corrupt' };
  if (record.legacy) return { ...base, installed: true, state: 'legacy', reason: 'legacy' };
  const names = Object.keys(record.binaries);
  if (!record.dispatch || names.some(name => typeof record.launchers[name] !== 'string')) {
    return { ...base, installed: true, state: 'stale', reason: 'incomplete' };
  }
  const altered = names.filter(name => record.launchers[name] !== sha256File(launcherPath(dir, name)));
  if (record.version !== expectedVersion) return { ...base, installed: true, state: 'stale', altered, reason: 'version' };
  if (record.dispatch !== sha256File(DISPATCH_MODULE)) return { ...base, installed: true, state: 'stale', altered, reason: 'dispatch' };
  if (altered.length > 0) return { ...base, installed: true, state: 'altered', altered, reason: 'launchers' };
  return { ...base, installed: true, state: 'ok' };
}

// One clause for egc init and egc doctor: why the shim on disk is not the one
// this package writes.
function describeVerification(report) {
  switch (report.reason) {
    case 'corrupt': return 'its manifest cannot be read';
    case 'legacy': return 'its manifest predates the version pinning';
    case 'incomplete': return 'its manifest lacks a hash';
    case 'version': return `it was written by EGC ${report.version}, this is ${report.expectedVersion}`;
    case 'dispatch': return 'the dispatch module changed since it was written';
    case 'launchers': return `a launcher changed on disk: ${report.altered.join(', ')}`;
    default: return '';
  }
}

/**
 * Inspects the current installation and PATH status of Token Crusher binary shims.
 *
 * @returns {{ dir: string, dirExists: boolean, shimmed: string[], activeInCurrentShell: boolean, pathPersisted: boolean, state: string, reason: string|null, version: string|null, expectedVersion: string, altered: string[] }}
 */
function status() {
  const dir = shimDir();
  const manifest = readManifest();
  const key = pathEnvKey();
  const activeInCurrentShell = (process.env[key] || '')
    .split(path.delimiter)
    .some(p => p && path.resolve(p) === path.resolve(dir));
  const pathPersisted = isPathPersisted(dir);
  const { state, reason, version, expectedVersion, altered } = verify(dir);

  return {
    dir,
    dirExists: fs.existsSync(dir),
    shimmed: Object.keys(manifest),
    activeInCurrentShell,
    pathPersisted,
    state,
    reason,
    version,
    expectedVersion,
    altered,
  };
}

module.exports = { install, uninstall, status, verify, describeVerification, isPathPersisted, SHIM_BINARY_NAMES, powershellSingleQuote, PATH_MARKER };
