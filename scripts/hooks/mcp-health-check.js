#!/usr/bin/env node
'use strict';

/**
 * MCP health-check hook.
 *
 * Compatible with Gemini Code's existing hook events:
 * - PreToolUse: probe MCP server health before MCP tool execution
 * - PostToolUseFailure: mark unhealthy servers, attempt reconnect, and re-probe
 *
 * The hook persists health state outside the conversation context so it
 * survives compaction and later turns.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const MAX_STDIN = 1024 * 1024;
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
// The preflight HTTP probe only checks reachability; it does not have access to
// Gemini Code's stored OAuth bearer token. Treat auth-gated responses as
// reachable so the real MCP client can attempt the authenticated call.
const HEALTHY_HTTP_CODES = new Set([200, 201, 202, 204, 301, 302, 303, 304, 307, 308, 400, 401, 403, 405]);
const RECONNECT_STATUS_CODES = new Set([401, 403, 429, 503]);
const FAILURE_PATTERNS = [
  { code: 401, pattern: /\b401\b|unauthori[sz]ed|auth(?:entication)?\s+(?:failed|expired|invalid)/i },
  { code: 403, pattern: /\b403\b|forbidden|permission denied/i },
  { code: 429, pattern: /\b429\b|rate limit|too many requests/i },
  { code: 503, pattern: /\b503\b|service unavailable|overloaded|temporarily unavailable/i },
  { code: 'transport', pattern: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timed? out|socket hang up|connection (?:failed|lost|reset|closed)/i }
];

// Legacy-compat env resolution: EGC_* is the canonical namespace; ECC_* is the
// mandatory legacy bridge. EGC_* wins when both are set; ECC_* is consulted only
// when the canonical EGC_* value is unset/empty. Never removes ECC_* support.
function envValue(name) {
  const canonical = process.env[name];
  if (canonical !== undefined && canonical !== '') {
    return canonical;
  }
  if (name.startsWith('EGC_')) {
    return process.env['ECC_' + name.slice(4)];
  }
  return canonical;
}

function envNumber(name, fallback) {
  const value = Number(envValue(name));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stateFilePath() {
  const explicit = envValue('EGC_MCP_HEALTH_STATE_PATH');
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(os.homedir(), '.gemini', 'mcp-health-cache.json');
}

function configPaths() {
  const explicit = envValue('EGC_MCP_CONFIG_PATH');
  if (explicit) {
    return explicit
      .split(path.delimiter)
      .map(entry => entry.trim())
      .filter(Boolean)
      .map(entry => path.resolve(entry));
  }

  const cwd = process.cwd();
  const home = os.homedir();

  return [
    path.join(cwd, '.gemini.json'),
    path.join(cwd, '.gemini', 'settings.json'),
    path.join(home, '.gemini.json'),
    path.join(home, '.gemini', 'settings.json')
  ];
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadState(filePath) {
  const state = readJsonFile(filePath);
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { version: 1, servers: {} };
  }

  if (!state.servers || typeof state.servers !== 'object' || Array.isArray(state.servers)) {
    state.servers = {};
  }

  return state;
}

function saveState(filePath, state) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  } catch {
    // Never block the hook on state persistence errors.
  }
}

function readRawStdin() {
  return new Promise(resolve => {
    let raw = '';
    let truncated = /^(1|true|yes)$/i.test(String(envValue('EGC_HOOK_INPUT_TRUNCATED') || ''));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      if (raw.length < MAX_STDIN) {
        const remaining = MAX_STDIN - raw.length;
        raw += chunk.substring(0, remaining);
        if (chunk.length > remaining) {
          truncated = true;
        }
      } else {
        truncated = true;
      }
    });
    process.stdin.on('end', () => resolve({ raw, truncated }));
    process.stdin.on('error', () => resolve({ raw, truncated }));
  });
}

function safeParse(raw) {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function extractMcpTarget(input) {
  const toolName = String(input.tool_name || input.name || '');
  const explicitServer = input.server
    || input.mcp_server
    || input.tool_input?.server
    || input.tool_input?.mcp_server
    || input.tool_input?.connector
    || null;
  const explicitTool = input.tool
    || input.mcp_tool
    || input.tool_input?.tool
    || input.tool_input?.mcp_tool
    || null;

  if (explicitServer) {
    return {
      server: String(explicitServer),
      tool: explicitTool ? String(explicitTool) : toolName
    };
  }

  if (!toolName.startsWith('mcp__')) {
    return null;
  }

  const segments = toolName.slice(5).split('__');
  if (segments.length < 2 || !segments[0]) {
    return null;
  }

  return {
    server: segments[0],
    tool: segments.slice(1).join('__')
  };
}

function extractMcpTargetFromRaw(raw) {
  const toolNameMatch = raw.match(/"(?:tool_name|name)"\s*:\s*"([^"]+)"/);
  const serverMatch = raw.match(/"(?:server|mcp_server|connector)"\s*:\s*"([^"]+)"/);
  const toolMatch = raw.match(/"(?:tool|mcp_tool)"\s*:\s*"([^"]+)"/);

  return extractMcpTarget({
    tool_name: toolNameMatch ? toolNameMatch[1] : '',
    server: serverMatch ? serverMatch[1] : undefined,
    tool: toolMatch ? toolMatch[1] : undefined
  });
}

function resolveServerConfig(serverName) {
  for (const filePath of configPaths()) {
    const data = readJsonFile(filePath);
    const server = data?.mcpServers?.[serverName]
      || data?.mcp_servers?.[serverName]
      || null;

    if (server && typeof server === 'object' && !Array.isArray(server)) {
      return {
        config: server,
        source: filePath
      };
    }
  }

  return null;
}

function markHealthy(state, serverName, now, details = {}) {
  state.servers[serverName] = {
    status: 'healthy',
    checkedAt: now,
    expiresAt: now + envNumber('EGC_MCP_HEALTH_TTL_MS', DEFAULT_TTL_MS),
    failureCount: 0,
    lastError: null,
    lastFailureCode: null,
    nextRetryAt: now,
    lastRestoredAt: now,
    ...details
  };
}

function markUnhealthy(state, serverName, now, failureCode, errorMessage) {
  const previous = state.servers[serverName] || {};
  const failureCount = Number(previous.failureCount || 0) + 1;
  const backoffBase = envNumber('EGC_MCP_HEALTH_BACKOFF_MS', DEFAULT_BACKOFF_MS);
  const nextRetryDelay = Math.min(backoffBase * (2 ** Math.max(failureCount - 1, 0)), MAX_BACKOFF_MS);

  state.servers[serverName] = {
    status: 'unhealthy',
    checkedAt: now,
    expiresAt: now,
    failureCount,
    lastError: errorMessage || null,
    lastFailureCode: failureCode || null,
    nextRetryAt: now + nextRetryDelay,
    lastRestoredAt: previous.lastRestoredAt || null
  };
}

function failureSummary(input) {
  const output = input.tool_output;
  const pieces = [
    typeof input.error === 'string' ? input.error : '',
    typeof input.message === 'string' ? input.message : '',
    typeof input.tool_response === 'string' ? input.tool_response : '',
    typeof output === 'string' ? output : '',
    typeof output?.output === 'string' ? output.output : '',
    typeof output?.stderr === 'string' ? output.stderr : '',
    typeof input.tool_input?.error === 'string' ? input.tool_input.error : ''
  ].filter(Boolean);

  return pieces.join('\n');
}

function detectFailureCode(text) {
  const summary = String(text || '');
  for (const entry of FAILURE_PATTERNS) {
    if (entry.pattern.test(summary)) {
      return entry.code;
    }
  }
  return null;
}

function requestHttp(urlString, headers, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;

    const url = new URL(urlString);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(
      url,
      {
        method: 'GET',
        headers,
      },
      res => {
        if (settled) return;
        settled = true;
        res.resume();
        resolve({
          ok: HEALTHY_HTTP_CODES.has(res.statusCode),
          statusCode: res.statusCode,
          reason: `HTTP ${res.statusCode}`
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      timedOut = true;
      req.destroy(new Error('timeout'));
    });

    req.on('error', error => {
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        statusCode: null,
        reason: timedOut ? 'request timed out' : error.message
      });
    });

    req.end();
  });
}

function probeCommandServer(serverName, config) {
  return new Promise(resolve => {
    const command = config.command;
    const args = Array.isArray(config.args) ? config.args.map(arg => String(arg)) : [];
    const timeoutMs = envNumber('EGC_MCP_HEALTH_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    const mergedEnv = {
      ...process.env,
      ...(config.env && typeof config.env === 'object' && !Array.isArray(config.env) ? config.env : {})
    };

    let stderr = '';
    let done = false;
    let timer = null;
    let exited = false;

    function finish(result) {
      if (done) return;
      done = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(result);
    }

    let child;
    try {
      child = spawn(command, args, {
        env: mergedEnv,
        cwd: process.cwd(),
        stdio: ['pipe', 'ignore', 'pipe']
      });
    } catch (error) {
      finish({
        ok: false,
        statusCode: null,
        reason: error.message
      });
      return;
    }

    child.stderr.on('data', chunk => {
      if (stderr.length < 4000) {
        const remaining = 4000 - stderr.length;
        stderr += String(chunk).slice(0, remaining);
      }
    });

    child.on('error', error => {
      exited = true;
      finish({
        ok: false,
        statusCode: null,
        reason: error.message
      });
    });

    child.on('exit', (code, signal) => {
      exited = true;
      finish({
        ok: false,
        statusCode: code,
        reason: stderr.trim() || `process exited before handshake (${signal || code || 'unknown'})`
      });
    });

    timer = setTimeout(() => {
      // If the process already exited (exit event fired before timer), mark unhealthy.
      if (exited || child.exitCode !== null || child.signalCode !== null) {
        finish({
          ok: false,
          statusCode: child.exitCode,
          reason: stderr.trim() || `process exited before handshake (${child.signalCode || child.exitCode || 'unknown'})`
        });
        return;
      }

      // The process appears alive at timeout. On loaded machines or with slow-starting
      // runtimes (e.g. Node.js on cold CI), the process may still be in its startup
      // phase and about to exit with a non-zero code. Allow an additional grace window
      // equal to timeoutMs before declaring healthy: any non-zero exit during the
      // grace period is treated as an early failure, preserving correct classification
      // without blocking indefinitely.
      const graceTimer = setTimeout(() => {
        if (done) return;
        // Process survived the full grace window: healthy stdio server.
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 200).unref?.();
        finish({
          ok: true,
          statusCode: null,
          reason: `${serverName} accepted a new stdio process`
        });
      }, timeoutMs);

      if (typeof graceTimer.unref === 'function') {
        graceTimer.unref();
      }
    }, timeoutMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

async function probeServer(serverName, resolvedConfig) {
  const config = resolvedConfig.config;

  if (config.type === 'http' || config.url) {
    const result = await requestHttp(config.url, config.headers || {}, envNumber('EGC_MCP_HEALTH_TIMEOUT_MS', DEFAULT_TIMEOUT_MS));

    return {
      ok: result.ok,
      failureCode: RECONNECT_STATUS_CODES.has(result.statusCode) ? result.statusCode : null,
      reason: result.reason,
      source: resolvedConfig.source
    };
  }

  if (config.command) {
    const result = await probeCommandServer(serverName, config);

    return {
      ok: result.ok,
      failureCode: RECONNECT_STATUS_CODES.has(result.statusCode) ? result.statusCode : null,
      reason: result.reason,
      source: resolvedConfig.source
    };
  }

  return {
    ok: false,
    failureCode: null,
    reason: 'unsupported MCP server config',
    source: resolvedConfig.source
  };
}

function reconnectCommand(serverName) {
  const key = `EGC_MCP_RECONNECT_${String(serverName).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const command = envValue(key) || envValue('EGC_MCP_RECONNECT_COMMAND') || '';
  if (!command.trim()) {
    return null;
  }

  if (!command.includes('{server}')) {
    return command;
  }

  if (!/^[a-zA-Z0-9_\-.:]+$/.test(serverName)) {
    return null;
  }

  return command.replace(/\{server\}/g, serverName);
}

function attemptReconnect(serverName) {
  const command = reconnectCommand(serverName);
  if (!command) {
    return { attempted: false, success: false, reason: 'no reconnect command configured' };
  }

  const result = spawnSync(command, {
    shell: true,
    env: process.env,
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: envNumber('EGC_MCP_RECONNECT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
  });

  if (result.error) {
    return { attempted: true, success: false, reason: result.error.message };
  }

  if (result.status !== 0) {
    return {
      attempted: true,
      success: false,
      reason: (result.stderr || result.stdout || `reconnect exited ${result.status}`).trim()
    };
  }

  return { attempted: true, success: true, reason: 'reconnect command completed' };
}

function shouldFailOpen() {
  return /^(1|true|yes)$/i.test(String(envValue('EGC_MCP_HEALTH_FAIL_OPEN') || ''));
}

function emitLogs(logs) {
  for (const line of logs) {
    process.stderr.write(`${line}\n`);
  }
}

/**
 * Attempts to reconnect a server and re-probe it. Returns an object with:
 * - restored: true if the server is confirmed healthy after reconnect
 * - reconnect: the result from attemptReconnect (attempted, success, reason)
 * - reprobeReason: set when reconnect succeeded but the reprobe still failed
 *
 * On success, marks the server healthy and persists state before returning.
 */
async function attemptRecovery(serverName, resolvedConfig, state, statePathValue, now) {
  const reconnect = attemptReconnect(serverName);
  if (!reconnect.success) {
    return { restored: false, reconnect, reprobeReason: null };
  }

  const reprobe = await probeServer(serverName, resolvedConfig);
  if (reprobe.ok) {
    markHealthy(state, serverName, now, {
      source: resolvedConfig.source,
      restoredBy: 'reconnect-command'
    });
    saveState(statePathValue, state);
    return { restored: true, reconnect, reprobeReason: null };
  }

  return { restored: false, reconnect, reprobeReason: reprobe.reason };
}

async function handlePreToolUse(rawInput, input, target, statePathValue, now) {
  const logs = [];
  const state = loadState(statePathValue);
  const previous = state.servers[target.server] || {};

  if (previous.status === 'healthy' && Number(previous.expiresAt || 0) > now) {
    return { rawInput, exitCode: 0, logs };
  }

  if (previous.status === 'unhealthy' && Number(previous.nextRetryAt || 0) > now) {
    logs.push(
      `[MCPHealthCheck] ${target.server} is marked unhealthy until ${new Date(previous.nextRetryAt).toISOString()}; skipping ${target.tool || 'tool'}`
    );
    return { rawInput, exitCode: shouldFailOpen() ? 0 : 2, logs };
  }

  const resolvedConfig = resolveServerConfig(target.server);
  if (!resolvedConfig) {
    logs.push(`[MCPHealthCheck] No MCP config found for ${target.server}; skipping preflight probe`);
    return { rawInput, exitCode: 0, logs };
  }

  const probe = await probeServer(target.server, resolvedConfig);
  if (probe.ok) {
    markHealthy(state, target.server, now, { source: resolvedConfig.source });
    saveState(statePathValue, state);

    if (previous.status === 'unhealthy') {
      logs.push(`[MCPHealthCheck] ${target.server} connection restored`);
    }

    return { rawInput, exitCode: 0, logs };
  }

  let reconnect = { attempted: false, success: false, reason: 'probe failed' };
  if (probe.failureCode || previous.status === 'unhealthy') {
    const recovery = await attemptRecovery(target.server, resolvedConfig, state, statePathValue, now);
    if (recovery.restored) {
      logs.push(`[MCPHealthCheck] ${target.server} connection restored after reconnect`);
      return { rawInput, exitCode: 0, logs };
    }
    reconnect = recovery.reconnect;
    if (recovery.reprobeReason) {
      probe.reason = `${probe.reason}; reconnect reprobe failed: ${recovery.reprobeReason}`;
    }
  }

  markUnhealthy(state, target.server, now, probe.failureCode, probe.reason);
  saveState(statePathValue, state);

  const reconnectSuffix = reconnect.attempted
    ? ` Reconnect attempt: ${reconnect.success ? 'ok' : reconnect.reason}.`
    : '';
  logs.push(
    `[MCPHealthCheck] ${target.server} is unavailable (${probe.reason}). Blocking ${target.tool || 'tool'} so Gemini can fall back to non-MCP tools.${reconnectSuffix}`
  );

  return { rawInput, exitCode: shouldFailOpen() ? 0 : 2, logs };
}

async function handlePostToolUseFailure(rawInput, input, target, statePathValue, now) {
  const logs = [];
  const summary = failureSummary(input);
  const failureCode = detectFailureCode(summary);

  if (!failureCode) {
    return { rawInput, exitCode: 0, logs };
  }

  const state = loadState(statePathValue);
  markUnhealthy(state, target.server, now, failureCode, summary.slice(0, 500));
  saveState(statePathValue, state);

  logs.push(`[MCPHealthCheck] ${target.server} reported ${failureCode}; marking server unhealthy and attempting reconnect`);

  const reconnect = attemptReconnect(target.server);
  if (!reconnect.attempted) {
    logs.push(`[MCPHealthCheck] ${target.server} reconnect skipped: ${reconnect.reason}`);
    return { rawInput, exitCode: 0, logs };
  }

  if (!reconnect.success) {
    logs.push(`[MCPHealthCheck] ${target.server} reconnect failed: ${reconnect.reason}`);
    return { rawInput, exitCode: 0, logs };
  }

  const resolvedConfig = resolveServerConfig(target.server);
  if (!resolvedConfig) {
    logs.push(`[MCPHealthCheck] ${target.server} reconnect completed but no config was available for a follow-up probe`);
    return { rawInput, exitCode: 0, logs };
  }

  const reprobe = await probeServer(target.server, resolvedConfig);
  if (!reprobe.ok) {
    logs.push(`[MCPHealthCheck] ${target.server} reconnect command ran, but health probe still failed: ${reprobe.reason}`);
    return { rawInput, exitCode: 0, logs };
  }

  const refreshed = loadState(statePathValue);
  markHealthy(refreshed, target.server, now, {
    source: resolvedConfig.source,
    restoredBy: 'post-failure-reconnect'
  });
  saveState(statePathValue, refreshed);
  logs.push(`[MCPHealthCheck] ${target.server} connection restored`);
  return { rawInput, exitCode: 0, logs };
}

async function main() {
  const { raw: rawInput, truncated } = await readRawStdin();
  const input = safeParse(rawInput);
  const target = extractMcpTarget(input) || (truncated ? extractMcpTargetFromRaw(rawInput) : null);

  if (!target) {
    process.stdout.write(rawInput);
    process.exit(0);
    return;
  }

  if (truncated) {
    const limit = Number(envValue('EGC_HOOK_INPUT_MAX_BYTES')) || MAX_STDIN;
    const logs = [
      shouldFailOpen()
        ? `[MCPHealthCheck] Hook input exceeded ${limit} bytes while checking ${target.server}; allowing ${target.tool || 'tool'} because fail-open mode is enabled`
        : `[MCPHealthCheck] Hook input exceeded ${limit} bytes while checking ${target.server}; blocking ${target.tool || 'tool'} to avoid bypassing MCP health checks`
    ];
    emitLogs(logs);
    process.stdout.write(rawInput);
    process.exit(shouldFailOpen() ? 0 : 2);
    return;
  }

  const eventName = process.env.GEMINI_HOOK_EVENT_NAME || 'PreToolUse';
  const now = Date.now();
  const statePathValue = stateFilePath();

  const result = eventName === 'PostToolUseFailure'
    ? await handlePostToolUseFailure(rawInput, input, target, statePathValue, now)
    : await handlePreToolUse(rawInput, input, target, statePathValue, now);

  emitLogs(result.logs);
  process.stdout.write(result.rawInput);
  process.exit(result.exitCode);
}

main().catch(error => {
  process.stderr.write(`[MCPHealthCheck] Unexpected error: ${error.message}\n`);
  process.exit(0);
});
