'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const PLUGINS_DIR = path.join(os.homedir(), '.egc', 'plugins');
const PLUGINS_LOCK_PATH = path.join(PLUGINS_DIR, 'plugins.json');
const INSTALLED_DIR = path.join(PLUGINS_DIR, 'installed');

const PLUGIN_JSON_SCHEMA_KEYS = ['name', 'version', 'description', 'egcPeerVersion'];

function getInstalledDir() {
  return INSTALLED_DIR;
}

function getPluginDir(name) {
  return path.join(INSTALLED_DIR, name);
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

function installPluginFromNpm(npmPackage, pluginName) {
  const tmpDir = path.join(os.tmpdir(), 'egc-plugin-tmp-' + Date.now());
  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    const npmResult = spawnSync('npm', ['pack', npmPackage, '--pack-destination', tmpDir], {
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

    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    const tarResult = spawnSync('tar', ['-xzf', path.join(tmpDir, tgzFile), '-C', extractDir], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 30000,
    });

    if (tarResult.status !== 0) {
      return { success: false, errors: ['Failed to extract plugin package'] };
    }

    const entries = fs.readdirSync(extractDir);
    const packageDir = entries.find(f => {
      try { return fs.statSync(path.join(extractDir, f)).isDirectory() && f.startsWith('package'); }
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
    const result = installPluginFromDir(pluginDir, name);
    results.push({ name, ...result });
  }

  return results;
}

function copyRecursive(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursive(srcPath, destPath);
    } else {
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
};
