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
  if (explicit?.trim() && fs.existsSync(explicit.trim())) return explicit.trim();
  return null;
}

function fromPackageLayout() {
  const candidate = path.join(
    __dirname, '..', '..',
    'mcp', 'servers', 'egc-guardian', 'build', 'guardian-cli.js',
  );
  return fs.existsSync(candidate) ? candidate : null;
}

// A repo-local .mcp.json is untrusted content: it travels with whatever
// repository the user happens to have open, so a malicious repo could ship
// one that points egc-guardian's entry at a payload script it also ships,
// which fromMcpConfigs() would then execute as this process's own security
// validator (RCE). Only ~/.claude.json and ~/.gemini/settings.json are
// trusted here, because writes to those two files are already denied by
// validate_write's PROTECTED_FILE_PATTERNS/DENIED_PATHS — a repo cannot get
// content into them just by being cloned. A project's own .mcp.json is
// deliberately never consulted for this resolution.
function fromMcpConfigs() {
  const configPaths = [
    path.join(os.homedir(), '.claude.json'),
    // Gemini CLI's real MCP registration file (confirmed against
    // scripts/lib/mcp-register.js's "Gemini CLI" target and live on disk,
    // 2026-07-27 audit) — NOT ~/.gemini/settings.json, which Gemini CLI
    // does not use for MCP server config at all. Without this fix, a
    // Gemini-CLI-only install (no ~/.claude.json alongside it) had no
    // working fallback here and failed open silently.
    path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json'),
    // Antigravity CLI's own MCP registration file — a SEPARATE file from
    // Gemini CLI's above despite sharing the ~/.gemini home root (see
    // scripts/lib/mcp-register.js's "Antigravity CLI" target). Multica
    // squad audit (EGC-460/461, 2026-07-27) confirmed a pure-Antigravity
    // install (no Claude Code, no Gemini CLI alongside it) had no working
    // fallback here either, for the same fail-open reason as Gemini CLI
    // above.
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'mcp_config.json'),
    // OpenCode's real MCP registration file (scripts/lib/mcp-register.js's
    // "OpenCode" target) — same audit, same fail-open gap for a
    // pure-OpenCode install.
    path.join(os.homedir(), '.config', 'opencode', 'config.json'),
  ];

  // Resolved candidates must live under the user's home directory. This
  // blocks a tampered home config from pointing at a script planted in the
  // current project (or /tmp, or anywhere else reachable by whatever
  // repository is open) even if the config file itself were ever
  // compromised by some other means.
  const home = path.resolve(os.homedir());

  for (const configPath of configPaths) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const server = data?.mcpServers?.['egc-guardian'];
      const args = Array.isArray(server?.args) ? server.args : [];
      // Compare against a fixed forward-slash suffix instead of building it
      // with path.join(), which bakes in the *running* OS's separator
      // ('\' on Windows). A config value stored with '/' (common even in
      // Windows configs, and how a config synced from another OS would
      // read) would never match a '\'-joined suffix, silently disabling
      // this whole fallback on Windows. Normalizing the candidate's own
      // separators before comparing means either style in the config matches.
      const indexJs = [server?.command, ...args].find(
        a => typeof a === 'string' && a.replaceAll('\\', '/').endsWith('egc-guardian/build/index.js'),
      );
      if (!indexJs) continue;
      const candidate = path.resolve(path.dirname(indexJs), 'guardian-cli.js');
      if (candidate !== home && !candidate.startsWith(home + path.sep)) continue;
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { /* ignore: unreadable or malformed config, safely fallback to trying the next one */ } // NOSONAR
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

module.exports = { resolveGuardianCli, callGuardian, fromEnv, fromPackageLayout, fromMcpConfigs };
