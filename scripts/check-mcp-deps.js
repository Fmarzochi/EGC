#!/usr/bin/env node
'use strict';

// Confirms that every runtime dependency an MCP server package declares is
// present in a node_modules directory Node would search from the server
// directory (its own, then each ancestor's). The installers call this when
// the server directory is read-only (a root-owned global npm prefix after
// `sudo npm install -g`, then `egc install` as the regular user): `npm ci`
// cannot write node_modules there, but the published package root already
// carries the same dependencies one level up. Presence is checked on disk
// rather than through require.resolve because packages such as the MCP SDK
// export only subpaths, so resolving their bare name fails even when they
// are installed. Exit 0 when everything is present, 1 with the list of
// missing packages otherwise.

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function missingDependencies(serverDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
  const searchPaths = Module._nodeModulePaths(serverDir);
  const missing = [];
  for (const name of Object.keys(pkg.dependencies || {})) {
    const found = searchPaths.some(dir => fs.existsSync(path.join(dir, name, 'package.json')));
    if (!found) missing.push(name);
  }
  return missing;
}

// The check only makes sense for a server directory shipped inside this
// package, so the CLI argument is confined to the package root before use.
function resolveServerDir(argument) {
  // Both sides are canonicalized so a symlink or junction planted under
  // the package root cannot point the check at a directory outside it.
  let packageRoot;
  let serverDir;
  try {
    packageRoot = fs.realpathSync(path.resolve(__dirname, '..'));
    serverDir = fs.realpathSync(path.resolve(argument || process.cwd()));
  } catch {
    return null;
  }
  if (serverDir !== packageRoot && !serverDir.startsWith(packageRoot + path.sep)) {
    return null;
  }
  return serverDir;
}

function main() {
  const serverDir = resolveServerDir(process.argv[2]);
  if (!serverDir) {
    console.error(`check-mcp-deps: ${process.argv[2]} is outside the package root ${path.resolve(__dirname, '..')}`);
    process.exit(2);
  }
  let missing;
  try {
    missing = missingDependencies(serverDir);
  } catch (error) {
    console.error(`check-mcp-deps: cannot read ${serverDir}: ${error.message}`);
    process.exit(2);
  }
  if (missing.length > 0) {
    console.error(`check-mcp-deps: missing from every node_modules above ${serverDir}: ${missing.join(', ')}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { missingDependencies, resolveServerDir };
