'use strict';

/**
 * scripts/lib/operations/mcp-bridge.js
 *
 * Calls one egc-memory MCP tool by spawning the server over stdio. Used by
 * the session bus operations in session-bus.js.
 */

// ---------------------------------------------------------------------------
// Session bus operations (slice 3, #1238)
//
// The session bus lives in the egc-memory MCP server, not in scripts/lib.
// The access pattern mirrors callMcpTool() in scripts/team.js: spawn the MCP
// server over stdio for each call and call its tools as a subprocess.
//
// BUG-08 (documented per the issue's acceptance criteria): the MCP server
// opens ~/.egc/memory/state.db while the CLI state store uses
// ~/.egc/egc/state.db. Do not fix here; this slice works with the bus where
// it lives today.
// ---------------------------------------------------------------------------

// EGC_BUS_STUB (gated on NODE_ENV=test) is the test escape hatch for
// _callBusTool; tests no longer need to patch child_process.spawn.
const MEMORY_SERVER_SCRIPT = require('node:path').join(
  __dirname, '..', '..', '..', 'mcp', 'servers', 'egc-memory', 'build', 'index.js'
);

/**
 * Parse one JSONL line of MCP output.
 * Returns { value } when the line holds a text result, null to skip,
 * throws when the line carries an MCP error payload.
 * (Pattern lifted verbatim from scripts/team.js callMcpTool.)
 */
function _extractMcpLineResult(line) {
  let parsed;
  try { parsed = JSON.parse(line); } catch { return null; }
  // Only process the tools/call response (id === 1).  The initialize response
  // (id === 0) and server-emitted notifications (no id) are skipped so a
  // notification that happens to carry a 'content' array never shadows the
  // real tool result.
  if (parsed.id !== 1) return null;
  if (parsed.result?.isError) {
    const message = parsed.result.content?.find(content => content.type === 'text')?.text;
    throw new Error(message || 'MCP tool call failed');
  }
  if (parsed.result?.content) {
    for (const content of parsed.result.content) {
      if (content.type === 'text') {
        let value;
        try { value = JSON.parse(content.text); } catch { value = content.text; }
        return { value };
      }
    }
  }
  if (parsed.error) {
    throw new Error(parsed.error.message || 'MCP tool call failed');
  }
  return null;
}

function _parseMcpResponse(stdout) {
  const lines = stdout.split('\n').filter(Boolean);

  // First pass: look for the tools/call response (id: 1 with content).
  for (const line of lines) {
    const result = _extractMcpLineResult(line);
    if (result) return result.value;
  }

  // Second pass: if any line looks like a JSONRPC message but none matched id:1,
  // the server did not emit a tools/call response.  Returning raw stdout here
  // would silently hand garbled JSONRPC text to the callers (which accept any
  // string and parse it as "no peers" / "no events").  Fail loudly instead.
  const hasJsonrpc = lines.some(line => {
    try { const p = JSON.parse(line); return p && typeof p === 'object' && p.jsonrpc; }
    catch { return false; } // a non-JSON line is simply not a JSON-RPC frame
  });
  if (hasJsonrpc) {
    throw new Error('egc-memory server did not return a tools/call response (id 1)');
  }

  // No JSONRPC lines at all — the output is plain text (non-SDK server path,
  // unit-test stub, etc.).  Return it as-is for the text parsers.
  const trimmed = stdout.trim();
  if (trimmed) return trimmed;

  throw new Error('No response from memory server');
}

/**
 * Spawn the egc-memory MCP server over stdio and call a single tool.
 * Returns the parsed result (a plain JS value, already converted from the
 * MCP tool's text output by _parseMcpResponse).
 *
 * Protocol: the MCP SDK's StdioServerTransport requires a proper initialize /
 * notifications/initialized handshake before it will process tool calls.  We
 * send all three messages as JSONL (newline-separated) in one async spawn
 * write, then scan every output line for the tools/call response (id === 1).
 *
 * Test hook: set EGC_BUS_STUB to a JSON-encoded value to short-circuit the
 * spawn entirely.  EGC_BUS_STUB=__NOT_BUILT__ simulates the binary being
 * absent.  This is more reliable than patching cp.spawnSync whose behaviour
 * varies across Node.js versions and OS configurations.
 */
// How long (ms) we wait for the egc-memory server to respond before giving up.
// Must be short enough not to stall the dashboard (30-s refresh cadence) if
// the server hangs, but long enough for a cold DB open + migration on slow
// disks. 10 s is the same ceiling team.js relies on implicitly.
const BUS_TOOL_TIMEOUT_MS = 10_000;

/**
 * Spawn the egc-memory MCP server and send `input` to its stdin.
 * Returns a Promise that resolves with the full stdout string.
 * Extracted from _callBusTool to keep each function under the complexity limit.
 */
function _spawnMcpProcess(input) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MEMORY_SERVER_SCRIPT], {
      env:   { ...process.env, EGC_CLI_MODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '', err = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });

    // Kill the child if it doesn't finish within BUS_TOOL_TIMEOUT_MS.
    // Store the escalation timer so close() can cancel it and prevent the
    // handle from keeping the event loop alive after the child has gone.
    let escalationTimer = null;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      // Escalate to SIGKILL if the server traps SIGTERM, but unref() the
      // handle so it does not block the event loop if the child already exited.
      escalationTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_e) { /* already gone */ }
      }, 2000);
      if (escalationTimer.unref) escalationTimer.unref();
      reject(new Error(`egc-memory server timed out after ${BUS_TOOL_TIMEOUT_MS / 1000}s`));
    }, BUS_TOOL_TIMEOUT_MS);

    child.on('error', e => { clearTimeout(timer); clearTimeout(escalationTimer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      if (!out && err) {
        const nl = err.indexOf('\n');
        reject(new Error('egc-memory server error: ' + (nl >= 0 ? err.slice(0, nl) : err).trim()));
      } else if (code !== 0 && code !== null && !out) {
        reject(new Error('egc-memory server exited with code ' + code));
      } else {
        resolve(out);
      }
    });

    // Guard stdin against EPIPE when the server exits before reading.
    child.stdin.on('error', () => { /* EPIPE swallowed; close handler rejects */ });
    child.stdin.end(input, 'utf-8');
  });
}

async function _callBusTool(toolName, args) {
  // Test-only escape hatch: gated on NODE_ENV=test so production dashboard
  // processes cannot be fooled by a stray environment variable.
  if (process.env.NODE_ENV === 'test' && process.env.EGC_BUS_STUB !== undefined) {
    const stub = process.env.EGC_BUS_STUB;
    if (stub === '__NOT_BUILT__') {
      throw Object.assign(
        new Error('egc-memory server not built. Run npm run build in mcp/servers/egc-memory/'),
        { code: 'MCP_NOT_BUILT' }
      );
    }
    try { return JSON.parse(stub); } catch {
      throw new Error('EGC_BUS_STUB is not valid JSON: ' + stub);
    }
  }

  if (!require('node:fs').existsSync(MEMORY_SERVER_SCRIPT)) {
    throw Object.assign(
      new Error('egc-memory server not built. Run npm run build in mcp/servers/egc-memory/'),
      { code: 'MCP_NOT_BUILT' }
    );
  }

  // Send the MCP initialize handshake then the tools/call request in one write.
  // Use async spawn (not spawnSync) so the dashboard event loop is not blocked.
  // Response parsing happens in _parseMcpResponse; the initialize response
  // (id: 0) is filtered out by _extractMcpLineResult (id !== 1 check).
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'egc-dashboard', version: '1.0.0' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: toolName, arguments: args } }),
  ].join('\n') + '\n';

  const stdout = await _spawnMcpProcess(input);
  return _parseMcpResponse(stdout || '');
}

module.exports = {
  _callBusTool,
  // _extractMcpLineResult is exported test-only: EGC_BUS_STUB short-circuits
  // _callBusTool above the raw MCP JSON-RPC line level, so the isError check
  // (#1797) is otherwise unreachable from a test.
  _extractMcpLineResult,
};
