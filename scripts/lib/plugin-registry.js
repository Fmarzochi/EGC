'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// The plugin store lives under the home directory the environment names, so
// a test (or a relocated home) never touches the real one.
function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
const PLUGINS_DIR = path.join(homeDir(), '.egc', 'plugins');
const PLUGINS_LOCK_PATH = path.join(PLUGINS_DIR, 'plugins.json');
const INSTALLED_DIR = path.join(PLUGINS_DIR, 'installed');

const PLUGIN_JSON_SCHEMA_KEYS = ['name', 'version', 'description', 'egcPeerVersion'];

// A plugin name is one directory segment under the store: letters, digits,
// dots, dashes and underscores, plus the npm scope form @scope/name (the
// scope becomes a parent segment). Anything else could name a path outside
// the store.
const PLUGIN_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function pluginNameSegments(name) {
  return name.startsWith('@') ? name.slice(1).split('/') : [name];
}

function pluginNameError(name) {
  if (typeof name !== 'string' || name.length === 0) return 'Plugin name is required';
  const segments = pluginNameSegments(name);
  if (segments.length > 2 || segments.some(segment => !PLUGIN_NAME_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    return `Invalid plugin name '${name}': use letters, digits, dots, dashes and underscores (optionally @scope/name)`;
  }
  return null;
}

function getInstalledDir() {
  return INSTALLED_DIR;
}

function getPluginDir(name) {
  const error = pluginNameError(name);
  if (error) throw new Error(error);
  return path.join(INSTALLED_DIR, ...pluginNameSegments(name));
}


function readLockFile() {
  try {
    if (fs.existsSync(PLUGINS_LOCK_PATH)) {
      return JSON.parse(fs.readFileSync(PLUGINS_LOCK_PATH, 'utf-8'));
    }
  } catch {
    // corrupt lock, reset
  }
  return { schemaVersion: 'egc.plugins.v1', installed: {} };
}

function writeLockFile(lock) {
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(PLUGINS_LOCK_PATH, JSON.stringify(lock, null, 2), 'utf-8');
}

function validatePluginJson(pluginJson) {
  const errors = [];
  for (const key of PLUGIN_JSON_SCHEMA_KEYS) {
    if (!pluginJson[key]) {
      errors.push(`Missing required field: ${key}`);
    }
  }
  if (pluginJson.egcPeerVersion && !/^>=\d+\.\d+\.\d+$/.test(pluginJson.egcPeerVersion)) {
    errors.push('egcPeerVersion must be a semver range like ">=1.1.0"');
  }
  return errors;
}

function validatePluginDir(pluginDir) {
  const pluginJsonPath = path.join(pluginDir, 'plugin.json');
  if (!fs.existsSync(pluginJsonPath)) {
    return { valid: false, errors: ['plugin.json not found'], pluginJson: null };
  }
  let pluginJson;
  try {
    pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
  } catch (e) {
    return { valid: false, errors: [`Invalid plugin.json: ${e.message}`], pluginJson: null };
  }
  const errors = validatePluginJson(pluginJson);
  const hasContent = (
    fs.existsSync(path.join(pluginDir, 'skills')) ||
    fs.existsSync(path.join(pluginDir, 'agents')) ||
    fs.existsSync(path.join(pluginDir, 'rules'))
  );
  if (!hasContent) {
    errors.push('Plugin must contain at least one of: skills/, agents/, rules/ directory');
  }
  return { valid: errors.length === 0, errors, pluginJson };
}

function installPluginFromDir(sourceDir, pluginName) {
  const nameError = pluginNameError(pluginName);
  if (nameError) return { success: false, errors: [nameError] };
  const validation = validatePluginDir(sourceDir);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }


  const lock = readLockFile();
  const pluginDir = getPluginDir(pluginName);
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
  fs.mkdirSync(pluginDir, { recursive: true });

  copyRecursive(sourceDir, pluginDir);

  const pluginJson = validation.pluginJson;
  lock.installed[pluginName] = {
    name: pluginName,
    version: pluginJson.version,
    description: pluginJson.description || '',
    egcPeerVersion: pluginJson.egcPeerVersion,
    installedAt: new Date().toISOString(),
    skills: listSubdirs(path.join(pluginDir, 'skills')),
    agents: listSubdirs(path.join(pluginDir, 'agents')),
    rules: listSubdirs(path.join(pluginDir, 'rules')),
  };
  writeLockFile(lock);

  return { success: true, plugin: lock.installed[pluginName] };
}

// The entries of a package archive, as tar lists them; null when the
// archive cannot be listed.
function listArchiveEntries(archivePath) {
  const listing = spawnSync('tar', ['-tzvf', archivePath], { // NOSONAR jssecurity:S8705
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 30000,
  });
  if (listing.status !== 0) return null;
  return listing.stdout.split('\n').filter(line => line.trim() !== '');
}

// Whether a listed archive entry stays inside the extraction directory and
// is a plain file or directory: an absolute name, a name that climbs, a
// symbolic or hard link, or a device would land or point outside it.
function archiveEntryError(line) {
  const type = line[0];
  if (type !== '-' && type !== 'd') return `archive entry is not a plain file or directory: ${line.slice(0, 80)}`;
  const name = line.replace(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+/, '');
  const normalized = name.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return `archive entry has an absolute name: ${name}`;
  if (normalized.split('/').includes('..')) return `archive entry climbs out of the package: ${name}`;
  return null;
}

// Every entry is inspected before anything is written: tar itself refuses
// absolute names and parent segments, but a link inside the archive would
// be created and then followed by the copy, so links are refused here.
function archiveInspectionErrors(archivePath) {
  const entries = listArchiveEntries(archivePath);
  if (entries === null) return ['Failed to list the plugin package'];
  const errors = [];
  for (const line of entries) {
    const error = archiveEntryError(line);
    if (error) errors.push(error);
  }
  return errors;
}

function installPluginFromNpm(npmPackage, pluginName) {
  const nameError = pluginNameError(pluginName);
  if (nameError) return { success: false, errors: [nameError] };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-plugin-'));
  try {


    const npmResult = spawnSync('npm', ['pack', npmPackage, '--pack-destination', tmpDir], { // NOSONAR jssecurity:S8705
      cwd: tmpDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 60000,
    });

    if (npmResult.status !== 0) {
      const err = npmResult.stderr || 'npm pack failed';
      return { success: false, errors: [`Failed to download plugin from npm: ${err.trim()}`] };
    }

    const tgzFile = fs.readdirSync(tmpDir).find(f => f.endsWith('.tgz'));
    if (!tgzFile) {
      return { success: false, errors: ['npm pack produced no .tgz file'] };
    }

    const archivePath = path.join(tmpDir, tgzFile);
    const inspection = archiveInspectionErrors(archivePath);
    if (inspection.length > 0) {
      return { success: false, errors: ['Plugin package refused', ...inspection] };
    }

    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    // Extracted as files owned by this user, with no permission bits or
    // ownership taken from the archive.
    const tarResult = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir, '--no-same-owner', '--no-same-permissions'], { // NOSONAR jssecurity:S8705
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 30000,
    });


    if (tarResult.status !== 0) {
      return { success: false, errors: ['Failed to extract plugin package'] };
    }

    const entries = fs.readdirSync(extractDir);
    const packageDir = entries.find(f => {
      try { return fs.lstatSync(path.join(extractDir, f)).isDirectory() && f.startsWith('package'); }
      catch { return false; }
    });


    if (!packageDir) {
      return { success: false, errors: ['Extracted package has no package/ directory'] };
    }

    const sourceDir = path.join(extractDir, packageDir);
    return installPluginFromDir(sourceDir, pluginName);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

function listInstalledPlugins() {
  const lock = readLockFile();
  return Object.values(lock.installed);
}

function getInstalledPlugin(name) {
  const lock = readLockFile();
  return lock.installed[name] || null;
}

function removePlugin(name) {
  const lock = readLockFile();
  if (!lock.installed[name]) {
    return { success: false, errors: [`Plugin "${name}" is not installed`] };
  }

  const pluginDir = getPluginDir(name);
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }

  delete lock.installed[name];
  writeLockFile(lock);

  return { success: true };
}

function updatePlugin(name) {
  const lock = readLockFile();
  const existing = lock.installed[name];
  if (!existing) {
    return { success: false, errors: [`Plugin "${name}" is not installed`] };
  }

  const pluginDir = getPluginDir(name);
  const pluginJsonPath = path.join(pluginDir, 'plugin.json');
  if (!fs.existsSync(pluginJsonPath)) {
    return { success: false, errors: [`Plugin "${name}" has no plugin.json; cannot determine source`] };
  }

  let pluginJson;
  try {
    pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
  } catch {
    return { success: false, errors: [`Cannot read plugin.json for "${name}"`] };
  }

  if (!pluginJson.name) {
    return { success: false, errors: [`plugin.json for "${name}" is missing name field`] };
  }

  return installPluginFromNpm(pluginJson.name, name);
}

function reinstallAllPlugins() {
  const lock = readLockFile();
  const names = Object.keys(lock.installed);
  const results = [];

  for (const name of names) {
    const pluginDir = getPluginDir(name);
    const pluginJsonPath = path.join(pluginDir, 'plugin.json');
    if (!fs.existsSync(pluginJsonPath)) {
      results.push({ name, success: false, errors: ['plugin.json missing; cannot reinstall'] });
      continue;
    }
    // installPluginFromDir wipes the destination before copying, and here the
    // destination is the plugin's own dir, so reinstalling in place would
    // erase it. Stage a copy in tmp and install from there.
    const stageDir = path.join(os.tmpdir(), `egc-plugin-reinstall-${name}-${Date.now()}`);
    try {
      fs.mkdirSync(stageDir, { recursive: true });
      copyRecursive(pluginDir, stageDir);
      const result = installPluginFromDir(stageDir, name);
      results.push({ name, ...result });
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true }); // NOSONAR jssecurity:S8707
    }
  }

  return results;
}

// Only plain files and directories are copied into the store: a link in a
// plugin (local directory or extracted package) is skipped, never followed.
function copyRecursive(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}


function listSubdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}

module.exports = {
  installPluginFromDir,
  installPluginFromNpm,
  listInstalledPlugins,
  getInstalledPlugin,
  removePlugin,
  updatePlugin,
  reinstallAllPlugins,
  validatePluginDir,
  getInstalledDir,
  PLUGINS_LOCK_PATH,
  archiveInspectionErrors,
  pluginNameError,
};
