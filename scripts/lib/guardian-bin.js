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

// Codex CLI (~/.codex/config.toml) is the only supported target that
// registers MCP servers in TOML, not JSON (scripts/lib/mcp-register.js's
// registerToml()). @iarna/toml is a devDependency only -- it never ships in
// the published package -- and this file is copied standalone into install
// targets with no node_modules of its own (createBashGuardianScriptCopyOperations),
// so it cannot require() any TOML library. This is a minimal, hand-rolled
// reader scoped to exactly the shape registerToml() writes: repeated
// [[mcp_servers]] blocks with name/command/args keys. It is not a general
// TOML parser -- unrecognized syntax is simply skipped, never thrown, so a
// config file with other tables/features registerToml() doesn't touch still
// resolves fine.

// Reverses tomlEscape() in scripts/lib/mcp-register.js: backslash-escaped
// backslash and double-quote are the only two escapes that function ever
// produces, but \n and \t are handled too since they're valid in a TOML
// basic string and a hand-edited file could contain them. A lookup table
// (rather than a chain of if/else on each recognized escape) keeps this
// under SonarCloud's cognitive-complexity ceiling.
const TOML_ESCAPES = { '\\': '\\', '"': '"', n: '\n', t: '\t' };

function tomlUnescapeBasicString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = ch === '\\' ? raw[i + 1] : undefined;
    const mapped = next !== undefined ? TOML_ESCAPES[next] : undefined;
    if (mapped !== undefined) {
      out += mapped;
      i++; // consumed the escape char too
    } else {
      out += ch; // not an escape, or an unrecognized one: keep verbatim
    }
  }
  return out;
}

// Extracts the value of a TOML basic (double-quoted) string, or null if the
// trimmed text isn't one -- e.g. a literal string ('...'), a bare value, or
// an already-consumed array element boundary.
function tomlBasicStringValue(text) {
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(text.trim());
  return match ? tomlUnescapeBasicString(match[1]) : null;
}

function tomlStringArrayValue(inner) {
  return inner
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(tomlBasicStringValue)
    .filter(item => item !== null);
}

function isMcpServersHeaderLine(line) {
  return /^\[\[\s*mcp_servers\s*\]\]$/.test(line);
}

// Parses "key = value" (no interior '=' ambiguity: TOML bare keys can't
// contain '='). Splitting on the first '=' instead of a single
// \s*=\s*(.+)$ regex avoids SonarCloud's superlinear-backtracking flag on
// that combined quantifier shape, and is just as correct here.
function parseKeyValueLine(line) {
  const eqIndex = line.indexOf('=');
  if (eqIndex === -1) return null;
  const key = line.slice(0, eqIndex).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return null;
  return { key, value: line.slice(eqIndex + 1).trim() };
}

// Continues a multi-line `args = [ ... ]` array started on a prior line.
// Returns the still-open pendingArray, or null once the closing ']' lands
// (at which point current[key] has been set).
function consumeArrayContinuationLine(current, pendingArray, line) {
  const closeIndex = line.indexOf(']');
  if (closeIndex === -1) {
    pendingArray.raw += ` ${line}`;
    return pendingArray;
  }
  pendingArray.raw += ` ${line.slice(0, closeIndex)}`;
  current[pendingArray.key] = tomlStringArrayValue(pendingArray.raw);
  return null;
}

// Parses a "key = value" line within an open [[mcp_servers]] block. Returns
// a pendingArray descriptor if the value opens a multi-line array, else null
// (the value -- string or single-line array -- was already assigned).
function consumeKeyValueLine(current, line) {
  const kv = parseKeyValueLine(line);
  if (!kv) return null;
  const { key, value } = kv;

  if (!value.startsWith('[')) {
    const str = tomlBasicStringValue(value);
    if (str !== null) current[key] = str;
    return null;
  }

  const inner = value.slice(1);
  const closeIndex = inner.indexOf(']');
  if (closeIndex === -1) return { key, raw: inner };
  current[key] = tomlStringArrayValue(inner.slice(0, closeIndex));
  return null;
}

// Scans for [[mcp_servers]] blocks and returns each as a plain object of its
// string/string-array keys. Any other table header ([foo] or [[foo]] with a
// different name) closes the current block without being parsed itself --
// registerToml() never writes anything else, but a hand-edited file might.
function parseCodexMcpServers(content) {
  const servers = [];
  let current = null;
  let pendingArray = null; // { key, raw } while a multi-line array is open

  const closeBlock = () => {
    if (current) servers.push(current);
    current = null;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (pendingArray) {
      pendingArray = consumeArrayContinuationLine(current, pendingArray, line);
      continue;
    }
    if (isMcpServersHeaderLine(line)) {
      closeBlock();
      current = {};
      continue;
    }
    if (line.startsWith('[')) {
      closeBlock();
      continue;
    }
    if (!current) continue;

    pendingArray = consumeKeyValueLine(current, line);
  }
  closeBlock();
  return servers;
}

function fromCodexToml() {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  let content;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }

  let servers;
  try {
    servers = parseCodexMcpServers(content);
  } catch {
    return null;
  }

  const server = servers.find(s => s.name === 'egc-guardian');
  if (!server) return null;
  const args = Array.isArray(server.args) ? server.args : [];
  const indexJs = [server.command, ...args].find(
    a => typeof a === 'string' && a.replaceAll('\\', '/').endsWith('egc-guardian/build/index.js'),
  );
  if (!indexJs) return null;

  // Same home-scoping guard as fromMcpConfigs(): a resolved path must live
  // under the user's home directory, closing off the same RCE shape (a
  // tampered/synced config pointing resolution at an attacker-controlled
  // script elsewhere).
  const home = path.resolve(os.homedir());
  const candidate = path.resolve(path.dirname(indexJs), 'guardian-cli.js');
  if (candidate !== home && !candidate.startsWith(home + path.sep)) return null;
  return fs.existsSync(candidate) ? candidate : null;
}

// Last-resort strategy for installs with no MCP config file of their own to
// trust (Copilot, CodeBuddy: guardian-bin.js is copied standalone into
// their tree with no fixed path relationship back to the original package,
// unlike fromPackageLayout()'s repo/npm-install case). scripts/lib/install/
// apply.js's writeGuardianCliMarker() records the real package root here on
// every install/repair, so any standalone copy can read it back.
//
// 2026-07-27 Multica design review (EGC-465): deliberately does NOT require
// the resolved candidate to live under the user's home directory, unlike
// fromMcpConfigs()/fromCodexToml() above. Those two guard against a
// synced/tampered CONFIG FILE pointing resolution somewhere attacker-
// controlled. Here the marker file itself is the trust boundary (protected
// in PROTECTED_FILE_PATTERNS, only ever written by this package's own
// installer) -- its packageRoot value is expected to legitimately point
// outside $HOME for a system-wide Node install with no version manager
// (`apt install nodejs` + `sudo npm install -g`, common in CI runners and
// containers, puts `npm root -g` under /usr/lib/node_modules). Restricting
// the marker's content to $HOME would silently defeat this fix for exactly
// the deployment shape it exists to cover.
function fromEgcHomeMarker() {
  const markerPath = path.join(os.homedir(), '.egc', 'guardian-cli-path.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return null;
  }

  const packageRoot = parsed?.packageRoot;
  if (typeof packageRoot !== 'string' || !packageRoot.trim()) return null;

  const candidate = path.join(packageRoot, 'mcp', 'servers', 'egc-guardian', 'build', 'guardian-cli.js');
  return fs.existsSync(candidate) ? candidate : null;
}

function resolveGuardianCli() {
  return fromEnv() || fromPackageLayout() || fromMcpConfigs() || fromCodexToml() || fromEgcHomeMarker();
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

module.exports = {
  resolveGuardianCli,
  callGuardian,
  fromEnv,
  fromPackageLayout,
  fromMcpConfigs,
  fromCodexToml,
  fromEgcHomeMarker,
};
