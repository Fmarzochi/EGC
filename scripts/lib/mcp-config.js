'use strict';

const path = require('node:path');

// What a merged MCP entry may ask a harness to run. Every server EGC ships
// starts through a package runner or an interpreter; a bare shell, an
// absolute path or anything with shell metacharacters is refused before it
// reaches a live config, whether the entry comes from the repository, an
// install-state replay or a hand-edited source.
const MCP_COMMAND_ALLOWLIST = new Set(['node', 'npx', 'npm', 'uv', 'uvx', 'python', 'python3']);
const SHELL_META_RE = /[;&|<>`$\r\n]/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ARG_LENGTH = 512;

function isMcpConfigPath(filePath) {
  const basename = path.basename(String(filePath || ''));
  return basename === '.mcp.json' || basename === 'mcp.json';
}

function describeUnsafeCommand(server) {
  if (server.command === undefined) return null;
  if (typeof server.command !== 'string' || !MCP_COMMAND_ALLOWLIST.has(server.command)) {
    return `uses command ${JSON.stringify(server.command)}, which is not in the MCP command allowlist (${[...MCP_COMMAND_ALLOWLIST].join(', ')})`;
  }
  if (server.args !== undefined) {
    if (!Array.isArray(server.args)) return 'has args that are not an array';
    const bad = server.args.find(arg => typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || SHELL_META_RE.test(arg));
    if (bad !== undefined) return `has an argument with shell metacharacters or an invalid shape: ${JSON.stringify(bad)}`;
  }
  return null;
}

function describeUnsafeEnv(server) {
  if (server.env === undefined) return null;
  if (!server.env || typeof server.env !== 'object' || Array.isArray(server.env)) return 'has env that is not an object';
  for (const [key, value] of Object.entries(server.env)) {
    if (!ENV_KEY_RE.test(key)) return `has an invalid env name ${JSON.stringify(key)}`;
    if (typeof value !== 'string' || /[\r\n]/.test(value)) return `has an env value for ${key} that is not a single-line string`;
  }
  return null;
}

function describeUnsafeUrl(server) {
  if (server.url === undefined) return null;
  if (typeof server.url !== 'string') return 'has a url that is not a string';
  let parsed;
  try {
    parsed = new URL(server.url);
  } catch {
    return `has an unparseable url ${JSON.stringify(server.url)}`;
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) return null;
  return `has a url that is neither https nor loopback: ${server.url}`;
}

// Returns why the entry is unsafe, or null when it passes.
function describeUnsafeMcpServer(server) {
  if (!server || typeof server !== 'object' || Array.isArray(server)) return 'is not an object';
  if (server.command === undefined && server.url === undefined) return 'has neither command nor url';
  return describeUnsafeCommand(server) || describeUnsafeEnv(server) || describeUnsafeUrl(server);
}

function assertSafeMcpConfig(config, label) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${label}: MCP config must be a JSON object`);
  }
  const servers = config.mcpServers;
  if (servers === undefined) return;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`${label}: mcpServers must be an object`);
  }
  for (const [name, server] of Object.entries(servers)) {
    const reason = describeUnsafeMcpServer(server);
    if (reason) throw new Error(`${label}: MCP server '${name}' ${reason}`);
  }
}

function parseDisabledMcpServers(value) {
  return [...new Set(
    String(value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  )];
}

function filterMcpConfig(config, disabledServerNames = []) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('MCP config must be a JSON object');
  }

  const servers = config.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('MCP config must include an mcpServers object');
  }

  const disabled = new Set(parseDisabledMcpServers(disabledServerNames));
  if (disabled.size === 0) {
    return {
      config: {
        ...config,
        mcpServers: { ...servers },
      },
      removed: [],
    };
  }

  const nextServers = {};
  const removed = [];

  for (const [name, serverConfig] of Object.entries(servers)) {
    if (disabled.has(name)) {
      removed.push(name);
      continue;
    }
    nextServers[name] = serverConfig;
  }

  return {
    config: {
      ...config,
      mcpServers: nextServers,
    },
    removed,
  };
}

module.exports = {
  MCP_COMMAND_ALLOWLIST,
  assertSafeMcpConfig,
  describeUnsafeMcpServer,
  filterMcpConfig,
  isMcpConfigPath,
  parseDisabledMcpServers,
};
