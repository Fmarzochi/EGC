const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Where an install plan comes from: the source root, its versions and commit,
// and the state preview built from them.

function getSourceRoot() {
  return path.join(__dirname, '../../..');
}

function getPackageVersion(sourceRoot) {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')
    );
    return packageJson.version || null;
  } catch (_error) { // NOSONAR: unreadable package.json means unknown version
    return null;
  }
}

function getManifestVersion(sourceRoot) {
  try {
    const modulesManifest = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'manifests', 'install-modules.json'), 'utf8')
    );
    return modulesManifest.version || 1;
  } catch (_error) { // NOSONAR: missing manifest defaults to version 1
    return 1;
  }
}

function getRepoCommit(sourceRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sourceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch (_error) { // NOSONAR: git being unavailable yields null commit info
    return null;
  }
}

function createStatePreview(options) {
  const { createInstallState } = require('../install-state');
  return createInstallState(options);
}

module.exports = {
  createStatePreview,
  getManifestVersion,
  getPackageVersion,
  getRepoCommit,
  getSourceRoot,
};
