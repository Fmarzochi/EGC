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
//   node scripts/lib/mcp-register-cli.js <guardianBin> <memoryBin> [projectMcpPath]
//
// projectMcpPath is optional and only merged when the file already exists:
// creating a project config in a directory the person did not ask about is
// litter, and the package's own bundled .mcp.json is nobody's project.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { registerMcpServers, registerJson } = require('./mcp-register');

const [, , guardianBin, memoryBin, projectMcpPath] = process.argv;

if (!guardianBin || !memoryBin) {
  console.error('mcp-register-cli: guardian and memory bin paths are required');
  process.exit(2);
}

const bins = { guardianBin, memoryBin };
const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();

registerMcpServers(homeDir, bins, {
  onRegister: (target) => console.log(`  ✓ registered in ${target.name} (${target.path})`),
  onWarn: (target, err) => console.log(`  note: skipped ${target.name} (${target.path}): ${err.message}`),
});

// The project path arrives as a command-line argument, so it is validated
// before any filesystem access: this flow may only ever touch a file named
// .mcp.json that already exists. A mistyped or malicious argument can
// therefore not turn the installer into a writer of arbitrary files.
function resolveProjectMcpPath(candidate) {
  const resolved = path.resolve(candidate);
  if (path.basename(resolved) !== '.mcp.json') return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

if (projectMcpPath) {
  const resolvedProjectMcp = resolveProjectMcpPath(projectMcpPath);
  if (resolvedProjectMcp) {
    try {
      if (registerJson(resolvedProjectMcp, bins)) {
        console.log(`  ✓ registered in Claude Code (project .mcp.json) (${resolvedProjectMcp})`);
      }
    } catch (err) {
      console.log(`  note: skipped project .mcp.json (${resolvedProjectMcp}): ${err.message}`);
    }
  }
}
