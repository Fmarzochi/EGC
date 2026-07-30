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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  SHIM_BINARY_NAMES,
  shimDir,
  manifestPath,
  readManifest,
  pathEnvKey,
  resolveWithoutShim,
} = require('./shim-paths');

const DISPATCH_MODULE = path.join(__dirname, 'shim-dispatch.js');
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
  return [
    '@echo off',
    `if not exist "${DISPATCH_MODULE}" (`,
    `  echo ${launcherNotFoundMessage(name)}`,
    '  exit /b 127',
    ')',
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
  const dir = shimDir();
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {};
  const installed = [];
  const skipped = [];

  for (const name of SHIM_BINARY_NAMES) {
    const realPath = resolveWithoutShim(name);
    if (!realPath) {
      skipped.push(name);
      continue;
    }
    manifest[name] = realPath;
    writeLauncher(dir, name);
    installed.push(name);
  }

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

function status() {
  const dir = shimDir();
  const manifest = readManifest();
  const key = pathEnvKey();
  const activeInCurrentShell = (process.env[key] || '')
    .split(path.delimiter)
    .some(p => p && path.resolve(p) === path.resolve(dir));

  return {
    dir,
    dirExists: fs.existsSync(dir),
    shimmed: Object.keys(manifest),
    activeInCurrentShell,
  };
}

module.exports = { install, uninstall, status, SHIM_BINARY_NAMES, powershellSingleQuote };
