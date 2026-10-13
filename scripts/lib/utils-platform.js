/**
 * Platform detection and shell command execution for EGC hooks and scripts.
 * Works on Windows, macOS, and Linux.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Platform detection
const isWindows = process.platform === 'win32';
const isMacOS = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

/**
 * Check if a command exists in PATH
 * Uses execFileSync to prevent command injection
 */
function commandExists(cmd) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(cmd)) {
    return false;
  }

  try {
    if (process.platform === 'win32') {
      const result = spawnSync(`where ${cmd}`, { stdio: 'pipe', shell: true });
      if (result.status === 0) return true;
    } else {
      const result = spawnSync('which', [cmd], { stdio: 'pipe' });
      if (result.status === 0) return true;
    }
  } catch {
    // Fall through to the manual scan below.
  }

  return existsOnPath(cmd);
}

function pathDirectories(rawPath, onWindows) {
  const emptyEntryMeans = onWindows ? null : '.';
  return rawPath
    .split(path.delimiter)
    .map(entry => (entry === '' ? emptyEntryMeans : entry))
    .filter(entry => entry !== null)
    .map(entry => (onWindows ? entry.replace(/^"(.*)"$/, '$1') : entry));
}

function pathExtensions(cmd, onWindows) {
  if (!onWindows || path.extname(cmd)) return [''];
  return (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
}

function isExecutableFile(candidate, onWindows) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (onWindows) return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function existsOnPath(cmd) {
  const rawPath = process.env.PATH;
  if (!rawPath) return false;

  const onWindows = process.platform === 'win32';
  const directories = pathDirectories(rawPath, onWindows);
  const extensions = pathExtensions(cmd, onWindows);

  for (const directory of directories) {
    for (const extension of extensions) {
      if (isExecutableFile(path.join(directory, cmd + extension), onWindows)) return true;
    }
  }
  return false;
}

/**
 * Run a command and return output
 *
 * SECURITY NOTE: This function executes commands via spawnSync with
 * shell:false (no shell is spawned). Only use with trusted, hardcoded
 * commands. Never pass user-controlled input directly.
 */
function runCommand(cmd, options = {}) {
  const allowedPrefixes = ['git ', 'node ', 'npx ', 'which ', 'where '];
  if (!allowedPrefixes.some(prefix => cmd.startsWith(prefix))) {
    return { success: false, output: 'runCommand blocked: unrecognized command prefix' };
  }

  const unquoted = cmd.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
  if (/[;|&\n\r<>()]/.test(unquoted) || /[`$]/.test(cmd)) {
    return { success: false, output: 'runCommand blocked: shell metacharacters not allowed' };
  }

  const tokenRegex = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  const args = [];
  let match;
  while ((match = tokenRegex.exec(cmd)) !== null) {
    if (match[1] !== undefined) {
      args.push(match[1].replace(/\\(["\\])/g, '$1'));
    } else if (match[2] !== undefined) {
      args.push(match[2].replace(/\\(['\\])/g, '$1'));
    } else {
      args.push(match[3]);
    }
  }
  const [program, ...progArgs] = args;

  const needsShell = isWindows && program === 'npx';

  try {
    const result = spawnSync(program, progArgs, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell,
      ...options
    });
    if (result.error) {
      return { success: false, output: result.error.message };
    }
    if (result.status !== 0) {
      return { success: false, output: result.stderr || result.stdout || `Command failed with exit code ${result.status}` };
    }
    return { success: true, output: (result.stdout || '').trim() };
  } catch (err) {
    return { success: false, output: err.message };
  }
}

/**
 * Check if current directory is a git repository
 */
function isGitRepo() {
  return runCommand('git rev-parse --git-dir').success;
}

/**
 * Get git modified files, optionally filtered by regex patterns
 * @param {string[]} patterns - Array of regex pattern strings to filter files.
 *   Invalid patterns are silently skipped.
 * @returns {string[]} Array of modified file paths
 */
function getGitModifiedFiles(patterns = []) {
  if (!isGitRepo()) return [];

  const result = runCommand('git diff --name-only HEAD');
  if (!result.success) return [];

  let files = result.output.split('\n').filter(Boolean);

  if (patterns.length > 0) {
    const compiled = [];
    for (const pattern of patterns) {
      if (typeof pattern !== 'string' || pattern.length === 0) continue;
      try {
        compiled.push(new RegExp(pattern));
      } catch {
        // Skip invalid regex patterns
      }
    }
    if (compiled.length > 0) {
      files = files.filter(file => compiled.some(regex => regex.test(file)));
    }
  }

  return files;
}

module.exports = {
  isWindows,
  isMacOS,
  isLinux,
  commandExists,
  runCommand,
  isGitRepo,
  getGitModifiedFiles,
};
