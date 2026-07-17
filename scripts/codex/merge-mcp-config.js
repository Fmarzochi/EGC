#!/usr/bin/env node
'use strict';

/**
 * Merge EGC-recommended MCP servers into a Codex config.toml.
 *
 * Strategy: ADD-ONLY by default.
 *   - Parse the TOML to detect which mcp_servers.* sections exist.
 *   - Append raw TOML text for any missing servers (preserves existing file byte-for-byte).
 *   - Log warnings when an existing server's config differs from the EGC recommendation.
 *   - With --update-mcp, also replace existing EGC-managed servers.
 *
 * Uses the repo's package-manager abstraction (scripts/lib/package-manager.js)
 * so MCP launcher commands respect the user's configured package manager.
 *
 * Usage:
 *   node merge-mcp-config.js <config.toml> [--dry-run] [--update-mcp]
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseDisabledMcpServers } = require('../lib/mcp-config');

let TOML;
try {
  TOML = require('@iarna/toml');
} catch {
  console.error('[egc-mcp] Missing dependency: @iarna/toml');
  console.error('[egc-mcp] Run: npm install   (from the EGC repo root)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

let pmConfig;
try {
  const { getPackageManager } = require(path.join(__dirname, '..', 'lib', 'package-manager.js'));
  pmConfig = getPackageManager();
} catch {
  // Fallback: if package-manager.js isn't available, default to npx
  pmConfig = { name: 'npm', config: { name: 'npm', execCmd: 'npx' } };
}

// Yarn 1.x doesn't support `yarn dlx`: fall back to npx for classic Yarn.
let resolvedExecCmd = pmConfig.config.execCmd;
if (pmConfig.name === 'yarn' && resolvedExecCmd === 'yarn dlx') {
  try {
    const { execFileSync } = require('node:child_process');
    const ver = execFileSync('yarn', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (ver.startsWith('1.')) {
      resolvedExecCmd = 'npx';
    }
  } catch {
    // Can't detect version: keep yarn dlx and let it fail visibly
  }
}

const PM_NAME = pmConfig.config.name || pmConfig.name;
const PM_EXEC = resolvedExecCmd; // e.g. "pnpm dlx", "npx", "bunx", "yarn dlx"
const PM_EXEC_PARTS = PM_EXEC.split(/\s+/); // ["pnpm", "dlx"] or ["npx"] or ["bunx"]

// ---------------------------------------------------------------------------
// EGC-recommended MCP servers
// ---------------------------------------------------------------------------

// GitHub bootstrap uses bash for token forwarding: this is intentionally
// shell-based regardless of package manager, since Codex runs on macOS/Linux.
const GH_BOOTSTRAP = `token=$(gh auth token 2>/dev/null || true); if [ -n "$token" ]; then export GITHUB_PERSONAL_ACCESS_TOKEN="$token"; fi; exec ${PM_EXEC} @modelcontextprotocol/server-github`;

/**
 * Build a server spec with the detected package manager.
 * Returns { fields, toml } where fields is for drift detection and
 * toml is the raw text appended to the file.
 */
function dlxServer(name, pkg, extraFields, extraToml) {
  const args = [...PM_EXEC_PARTS.slice(1), pkg];
  const fields = { command: PM_EXEC_PARTS[0], args, ...extraFields };
  const argsStr = JSON.stringify(args).replaceAll(',', ', ');
  let toml = `[mcp_servers.${name}]\ncommand = "${PM_EXEC_PARTS[0]}"\nargs = ${argsStr}`;
  if (extraToml) toml += '\n' + extraToml;
  return { fields, toml };
}

/** Each entry: key = section name under mcp_servers, value = { toml, fields } */
const DEFAULT_MCP_STARTUP_TIMEOUT_SEC = 30;
const DEFAULT_MCP_STARTUP_TIMEOUT_TOML = `startup_timeout_sec = ${DEFAULT_MCP_STARTUP_TIMEOUT_SEC}`;

const EGC_SERVERS = {
  supabase: dlxServer('supabase', '@supabase/mcp-server-supabase@latest', { startup_timeout_sec: 20.0, tool_timeout_sec: 120.0 }, 'startup_timeout_sec = 20.0\ntool_timeout_sec = 120.0'),
  playwright: dlxServer('playwright', '@playwright/mcp@latest', { startup_timeout_sec: DEFAULT_MCP_STARTUP_TIMEOUT_SEC }, DEFAULT_MCP_STARTUP_TIMEOUT_TOML),
  context7: dlxServer('context7', '@upstash/context7-mcp@latest', { startup_timeout_sec: DEFAULT_MCP_STARTUP_TIMEOUT_SEC }, DEFAULT_MCP_STARTUP_TIMEOUT_TOML),
  exa: {
    fields: { url: 'https://mcp.exa.ai/mcp' },
    toml: `[mcp_servers.exa]\nurl = "https://mcp.exa.ai/mcp"`
  },
  github: {
    fields: { command: 'bash', args: ['-lc', GH_BOOTSTRAP], startup_timeout_sec: DEFAULT_MCP_STARTUP_TIMEOUT_SEC },
    toml: `[mcp_servers.github]\ncommand = "bash"\nargs = ["-lc", ${JSON.stringify(GH_BOOTSTRAP)}]\n${DEFAULT_MCP_STARTUP_TIMEOUT_TOML}`
  },
  memory: dlxServer('memory', '@modelcontextprotocol/server-memory', { startup_timeout_sec: DEFAULT_MCP_STARTUP_TIMEOUT_SEC }, DEFAULT_MCP_STARTUP_TIMEOUT_TOML),
  'sequential-thinking': dlxServer('sequential-thinking', '@modelcontextprotocol/server-sequential-thinking', { startup_timeout_sec: DEFAULT_MCP_STARTUP_TIMEOUT_SEC }, DEFAULT_MCP_STARTUP_TIMEOUT_TOML)
};

EGC_SERVERS.supabase.fields.args.push('--features=account,docs,database,debugging,development,functions,storage,branching');
EGC_SERVERS.supabase.toml = EGC_SERVERS.supabase.toml.replace(/^(args = \[.*)\]$/m, '$1, "--features=account,docs,database,debugging,development,functions,storage,branching"]');

// Legacy section names that should be treated as an existing EGC server.
// e.g. older configs shipped [mcp_servers.context7-mcp] instead of [mcp_servers.context7].
const LEGACY_ALIASES = {
  context7: ['context7-mcp']
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`[egc-mcp] ${msg}`);
}

function warn(msg) {
  console.warn(`[egc-mcp] WARNING: ${msg}`);
}

/** Shallow-compare two objects (one level deep, arrays by JSON). */
function configDiffers(existing, recommended) {
  for (const key of Object.keys(recommended)) {
    const a = existing[key];
    const b = recommended[key];
    if (Array.isArray(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) return true;
    } else if (a !== b) {
      return true;
    }
  }
  return false;
}

/**
 * Remove a TOML section and its key-value pairs from raw text.
 * Matches the section header even if followed by inline comments or whitespace
 * (e.g. `[mcp_servers.github] # comment`).
 * Returns the text with the section removed.
 */
function removeSectionFromText(text, sectionHeader) {
  const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerPattern = new RegExp(`^${escaped}(\\s*(#.*)?)?$`);
  const lines = text.split('\n');
  const result = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, '');
    if (headerPattern.test(trimmed)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\[/.test(trimmed)) {
      skipping = false;
    }
    if (!skipping) {
      result.push(line);
    }
  }
  return result.join('\n');
}

/**
 * Collect all TOML sub-section headers for a given server name.
 * @iarna/toml nests subtables, so `[mcp_servers.supabase.env]` appears as
 * `parsed.mcp_servers.supabase.env` (nested), NOT as a flat dotted key.
 * Walk the nested object to find sub-objects that represent TOML sub-tables.
 */
function findSubSections(serverObj, prefix) {
  const sections = [];
  if (!serverObj || typeof serverObj !== 'object') return sections;
  for (const key of Object.keys(serverObj)) {
    const val = serverObj[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const subPath = `${prefix}.${key}`;
      sections.push(subPath);
      sections.push(...findSubSections(val, subPath));
    }
  }
  return sections;
}

/**
 * Remove a server and all its sub-sections from raw TOML text.
 * Uses findSubSections to walk the parsed nested object (not flat keys).
 */
function removeServerFromText(raw, serverName, existing) {
  let result = removeSectionFromText(raw, `[mcp_servers.${serverName}]`);
  const serverObj = existing[serverName];
  if (serverObj) {
    for (const sub of findSubSections(serverObj, serverName)) {
      result = removeSectionFromText(result, `[mcp_servers.${sub}]`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function resolveServerEntry(name, existing) {
  const entry = existing[name];
  const aliases = LEGACY_ALIASES[name] || [];
  const legacyName = aliases.find(a => existing[a] && typeof existing[a].command === 'string');
  const hasCanonical = entry && typeof entry.command === 'string';
  let resolvedEntry;
  if (hasCanonical) {
    resolvedEntry = entry;
  } else if (legacyName) {
    resolvedEntry = existing[legacyName];
  } else {
    resolvedEntry = null;
  }
  const urlEntry = !resolvedEntry && entry && typeof entry.url === 'string' ? entry : null;
  return {
    finalEntry: resolvedEntry || urlEntry,
    resolvedLabel: hasCanonical ? name : legacyName || name,
    legacyName,
    hasCanonical,
  };
}

function processDisabledServer(name, resolved, raw, existing, toRemoveLog) {
  let updatedRaw = raw;
  if (resolved.finalEntry) {
    toRemoveLog.push(`mcp_servers.${resolved.resolvedLabel} (disabled)`);
    updatedRaw = removeServerFromText(updatedRaw, resolved.resolvedLabel, existing);
    if (resolved.resolvedLabel !== name) {
      updatedRaw = removeServerFromText(updatedRaw, name, existing);
    }
  }
  log(`  [skip] mcp_servers.${name} (disabled)`);
  return updatedRaw;
}

function processExistingServer(name, spec, resolved, updateMcp, raw, existing, toRemoveLog, toAppend) {
  let updatedRaw = raw;
  if (updateMcp) {
    toRemoveLog.push(`mcp_servers.${resolved.resolvedLabel}`);
    updatedRaw = removeServerFromText(updatedRaw, resolved.resolvedLabel, existing);
    if (resolved.resolvedLabel !== name) {
      updatedRaw = removeServerFromText(updatedRaw, name, existing);
    }
    if (resolved.legacyName && resolved.hasCanonical) {
      toRemoveLog.push(`mcp_servers.${resolved.legacyName}`);
      updatedRaw = removeServerFromText(updatedRaw, resolved.legacyName, existing);
    }
    toAppend.push(spec.toml);
  } else if (resolved.legacyName && !resolved.hasCanonical) {
    warn(`mcp_servers.${resolved.legacyName} is a legacy name for ${name} (run with --update-mcp to migrate)`);
  } else if (configDiffers(resolved.finalEntry, spec.fields)) {
    warn(`mcp_servers.${name} differs from EGC recommendation (run with --update-mcp to refresh)`);
  } else {
    log(`  [ok] mcp_servers.${name}`);
  }
  return updatedRaw;
}

function processServers(existing, disabledServers, updateMcp, rawInit) {
  let raw = rawInit;
  const toAppend = [];
  const toRemoveLog = [];

  for (const [name, spec] of Object.entries(EGC_SERVERS)) {
    const resolved = resolveServerEntry(name, existing);

    if (disabledServers.has(name)) {
      raw = processDisabledServer(name, resolved, raw, existing, toRemoveLog);
      continue;
    }

    if (resolved.finalEntry) {
      raw = processExistingServer(name, spec, resolved, updateMcp, raw, existing, toRemoveLog, toAppend);
    } else {
      log(`  [add] mcp_servers.${name}`);
      toAppend.push(spec.toml);
    }
  }

  return { raw, toAppend, toRemoveLog };
}

function applyChanges(configPath, raw, toAppend, toRemoveLog, dryRun, updateMcp) {
  const hasRemovals = toRemoveLog.length > 0;

  if (toAppend.length === 0 && !hasRemovals) {
    log('All EGC MCP servers already present. Nothing to do.');
    return;
  }

  const appendText = '\n' + toAppend.join('\n\n') + '\n';

  if (dryRun) {
    if (toRemoveLog.length > 0) {
      log('Dry run - would remove and re-add:');
      for (const label of toRemoveLog) log(`  [remove] ${label}`);
    }
    log('Dry run - would append:');
    console.log(appendText);
    return;
  }

  if (updateMcp || hasRemovals) {
    for (const label of toRemoveLog) log(`  [update] ${label}`);
    const cleaned = raw.replace(/\n+$/, '\n');
    fs.writeFileSync(configPath, cleaned + (toAppend.length > 0 ? appendText : ''), 'utf8');
  } else {
    fs.appendFileSync(configPath, appendText, 'utf8');
  }

  if (hasRemovals && toAppend.length === 0) {
    log(`Done. Removed ${toRemoveLog.length} disabled server(s).`);
    return;
  }

  log(`Done. ${toAppend.length} server(s) ${updateMcp ? 'updated' : 'added'}.`);
}

function main() {
  const args = process.argv.slice(2);
  const configPath = args.find(a => !a.startsWith('-'));
  const dryRun = args.includes('--dry-run');
  const updateMcp = args.includes('--update-mcp');
  const disabledServers = new Set(parseDisabledMcpServers(process.env.EGC_DISABLED_MCPS || process.env.ECC_DISABLED_MCPS));

  if (!configPath) {
    console.error('Usage: merge-mcp-config.js <config.toml> [--dry-run] [--update-mcp]');
    process.exit(1);
  }

  if (!fs.existsSync(configPath)) {
    console.error(`[egc-mcp] Config file not found: ${configPath}`);
    process.exit(1);
  }

  log(`Package manager: ${PM_NAME} (exec: ${PM_EXEC})`);
  if (disabledServers.size > 0) {
    const source = process.env.EGC_DISABLED_MCPS ? 'EGC_DISABLED_MCPS' : 'ECC_DISABLED_MCPS';
    log(`Disabled via ${source}: ${[...disabledServers].join(', ')}`);
  }

  let raw = fs.readFileSync(configPath, 'utf8');
  let parsed;
  try {
    parsed = TOML.parse(raw);
  } catch (err) {
    console.error(`[egc-mcp] Failed to parse ${configPath}: ${err.message}`);
    process.exit(1);
  }

  const existing = parsed.mcp_servers || {};
  const result = processServers(existing, disabledServers, updateMcp, raw);
  applyChanges(configPath, result.raw, result.toAppend, result.toRemoveLog, dryRun, updateMcp);
}

main();
