'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// Locates the compiled guardian CLI so hooks can enforce validation without
// the MCP server running. Resolution order: explicit env override, the
// package-relative layout (repo checkout and npm install share it), then the
// egc-guardian entry in the MCP configs the user already registered.

function fromEnv() {
  const explicit = process.env.EGC_GUARDIAN_CLI;
  if (explicit && explicit.trim() && fs.existsSync(explicit.trim())) return explicit.trim();
  return null;
}

function fromPackageLayout() {
  const candidate = path.join(
    __dirname, '..', '..',
    'mcp', 'servers', 'egc-guardian', 'build', 'guardian-cli.js',
  );
  return fs.existsSync(candidate) ? candidate : null;
}

function fromMcpConfigs() {
  const configPaths = [
    path.join(process.env.PWD || process.cwd(), '.mcp.json'),
    path.join(os.homedir(), '.claude.json'),
    path.join(os.homedir(), '.gemini', 'settings.json'),
  ];

  for (const configPath of configPaths) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const server = data?.mcpServers?.['egc-guardian'];
      const args = Array.isArray(server?.args) ? server.args : [];
      const indexJs = [server?.command, ...args].find(
        a => typeof a === 'string' && a.endsWith(path.join('egc-guardian', 'build', 'index.js')),
      );
      if (!indexJs) continue;
      const candidate = path.join(path.dirname(indexJs), 'guardian-cli.js');
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { /* unreadable or malformed config: try the next one */ }
  }

  return null;
}

function resolveGuardianCli() {
  return fromEnv() || fromPackageLayout() || fromMcpConfigs();
}

// Invokes the guardian CLI with the payload on stdin, never in argv.
// Untrusted content (prompts, commands, paths) must not travel as command
// arguments where a leading dash could be parsed as a flag. argv carries
// only the fixed mode and literal flags. Returns parsed JSON, or null on
// any failure so callers fail open.
function callGuardian(cli, args, input, timeoutMs) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    input: input == null ? '' : String(input),
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.error || result.status !== 0 || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

module.exports = { resolveGuardianCli, callGuardian };
