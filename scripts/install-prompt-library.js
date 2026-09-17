#!/usr/bin/env node
/**
 * Adds the prompt library (agents, skills, commands, rules) to every tool
 * detected on this machine: the full profile for each home target through
 * install-apply.js, then the shell scripts of the tools that still have one.
 * Called by install.sh and install.ps1 when the person opts into the library.
 */

const os = require('node:os');
const path = require('node:path');

const { runPromptLibraryInstall } = require('./lib/install/prompt-library');

function main() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const result = runPromptLibraryInstall({
    repoRoot: path.join(__dirname, '..'),
    homeDir,
  });

  if (result.installed.length > 0) {
    console.log(`  prompt library installed to: ${result.installed.join(', ')}`);
  }
  if (result.failed.length > 0) {
    console.error(`  prompt library not installed to: ${result.failed.join(', ')}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
