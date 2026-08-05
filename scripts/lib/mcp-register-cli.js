#!/usr/bin/env node
'use strict';

// CLI face of mcp-register.js for the shell installers.
//
// install.sh and install.ps1 used to carry their own hand-written copy of
// the registration list, and the three copies had already drifted: the
// shells never registered Continue.dev or Zed, install.ps1 pointed OpenCode
// at a different directory than everything else, and only the shells gated
// Gemini CLI on Antigravity being absent. Whoever installed through the
// shell silently got fewer tools wired up than whoever ran `egc init`.
// There is one list now, and all three paths read it from here.
//
// Usage:
//   node scripts/lib/mcp-register-cli.js <guardianBin> <memoryBin>
//
// A project .mcp.json is picked up from the working directory this runs in,
// which the shell installers set to the directory the person invoked them
// from. It is only ever merged when it already exists: creating a project
// config in a directory nobody asked about is litter, and the package's own
// bundled .mcp.json is nobody's project.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { registerMcpServers, registerJson } = require('./mcp-register');

const [, , guardianBin, memoryBin] = process.argv;

if (!guardianBin || !memoryBin) {
  console.error('mcp-register-cli: guardian and memory bin paths are required');
  process.exit(2);
}

const bins = { guardianBin, memoryBin };
// Git for Windows sets HOME to the MSYS home, which is not where the tools
// this registers keep their config. On Windows the profile the installer
// itself uses is USERPROFILE, so that wins there; everywhere else HOME is
// the answer.
const homeDir = process.platform === 'win32'
  ? (process.env.USERPROFILE || process.env.HOME || os.homedir())
  : (process.env.HOME || process.env.USERPROFILE || os.homedir());

registerMcpServers(homeDir, bins, {
  onRegister: (target) => console.log(`  ✓ registered in ${target.name} (${target.path})`),
  onWarn: (target, err) => console.log(`  note: skipped ${target.name} (${target.path}): ${err.message}`),
});

// The filename is fixed here rather than accepted from the caller, and the
// directory is the process's own working directory, so no argument can turn
// this into a writer of arbitrary files. The package's own bundled config
// is excluded: it is nobody's project.
// Compared physically and, on Windows, case-insensitively: reaching the
// package root through a junction or a differently-cased path would
// otherwise read as somebody's project and rewrite the bundled config.
function canonical(dir) {
  let resolved;
  try {
    resolved = fs.realpathSync.native(dir);
  } catch {
    resolved = path.resolve(dir);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const packageRoot = path.resolve(__dirname, '..', '..');
const projectMcp = path.join(process.cwd(), '.mcp.json');

if (canonical(path.dirname(projectMcp)) !== canonical(packageRoot) && fs.existsSync(projectMcp)) {
  try {
    if (registerJson(projectMcp, bins)) {
      console.log(`  ✓ registered in Claude Code (project .mcp.json) (${projectMcp})`);
    }
  } catch (err) {
    console.log(`  note: skipped project .mcp.json (${projectMcp}): ${err.message}`);
  }
}
