#!/usr/bin/env node
'use strict';

// egc crusher-shim install|uninstall|status
//
// Installs a PATH-level binary shim (git, npm, ...) that compresses noisy
// output for any tool that shells out to run them -- not just the harnesses
// whose hooks support a PreToolUse command rewrite. See
// scripts/lib/crusher/shim-install.js for the implementation.

const { install, uninstall, status } = require('./lib/crusher/shim-install');

function toPathResultArray(rawPathResult) {
  if (Array.isArray(rawPathResult)) {
    return rawPathResult;
  }
  if (rawPathResult) {
    return [{
      ...rawPathResult,
      path: rawPathResult.path || 'Windows user PATH (registry)'
    }];
  }
  return [];
}

function printInstallResult(result) {
  console.log(`Shim directory: ${result.dir}`);
  if (result.installed.length) console.log(`Installed: ${result.installed.join(', ')}`);
  if (result.skipped.length) console.log(`Not found on this machine (skipped): ${result.skipped.join(', ')}`);
  const pathResultArray = toPathResultArray(result.pathResult);
  const changed = pathResultArray.filter(r => r && r.changed);
  if (changed.length) {
    console.log(`PATH updated in: ${changed.map(r => r.path).join(', ')}`);
    console.log('Open a new terminal (or `source` the file above) for it to take effect.');
  } else {
    console.log('PATH already configured, or no shell config file found to update.');
  }
}

function printUninstallResult(result) {
  console.log(`Shim directory: ${result.dir}`);
  console.log(result.removed.length ? `Removed: ${result.removed.join(', ')}` : 'Nothing to remove.');
  const pathResultArray = toPathResultArray(result.pathResult);
  const changed = pathResultArray.filter(r => r && r.changed);
  if (changed.length) console.log(`PATH entry removed from: ${changed.map(r => r.path).join(', ')}`);
}

function printStatus(result) {
  console.log(`Shim directory: ${result.dir} (${result.dirExists ? 'exists' : 'not created'})`);
  console.log(result.shimmed.length ? `Shimmed binaries: ${result.shimmed.join(', ')}` : 'No binaries shimmed.');
  console.log(`Active in this shell's PATH right now: ${result.activeInCurrentShell ? 'yes' : 'no'}`);
}

function main() {
  const action = process.argv[2];

  if (action === 'install') return printInstallResult(install());
  if (action === 'uninstall') return printUninstallResult(uninstall());
  if (action === 'status') return printStatus(status());

  console.log('Usage: egc crusher-shim <install|uninstall|status>');
  console.log('\nInstalls a PATH-level binary shim (git, npm, pip, gh, ...) that compresses');
  console.log('noisy output for any tool that shells out to run them, independent of any');
  console.log('AI harness\'s hook support. Requires a new shell session after install.');
  process.exit(action ? 1 : 0);
}

main();
