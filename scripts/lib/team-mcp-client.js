'use strict';

/**
 * One MCP session with the memory server over stdio, for the commands and
 * hooks that call a single tool and leave: initialize, its answer, the
 * initialized notification, the tools/call, and the answer that carries the
 * call's id. Stdin stays open until that answer arrives, the server exits
 * when stdin closes, and the promise settles only once the server has
 * exited, so no caller goes on while the server still holds the memory
 * database.
 *
 * A failure names its cause. A tool that refuses rejects with the refusal
 * and `isToolError`. A server that exits before answering rejects with its
 * exit code, and one that does not answer within the budget rejects with
 * `isTimeout`; both carry the last lines the server wrote to stderr, so a
 * store it could not open or a git remote that stopped to ask a question is
 * in the message instead of a bare "no response".
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const PACKAGE_VERSION = require('../../package.json').version;
const DEFAULT_SERVER_SCRIPT = path.join(__dirname, '..', '..', 'mcp', 'servers', 'egc-memory', 'build', 'index.js');
const MCP_PROTOCOL_VERSION = '2024-11-05';
const MCP_INITIALIZE_ID = 1;
const MCP_CALL_ID = 2;
const DEFAULT_TIMEOUT_MS = 60000;
// A server that ignores the end of its stdin and the first signal is killed
// this long after the budget ran out.
const KILL_GRACE_MS = 2000;
// How much of the server's stderr is kept, and how many of its last lines
// a failure message quotes.
const STDERR_TAIL_CHARS = 4000;
const STDERR_TAIL_LINES = 3;

function parseJsonOrRaw(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Parse one line of the server's stdout as a JSON-RPC message. Anything that
 * is not a JSON object (log noise, a bare value, an array) is skipped.
 */
function parseJsonRpcLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

/**
 * The value of a tools/call answer: its first text content, parsed as JSON
 * when it is JSON. Throws on a JSON-RPC error, on a tool result flagged
 * isError, and on an answer with no text.
 */
function toolCallValue(toolName, message) {
  // An error the server answered with is marked apart from the server
  // being away: the caller treats the first as a refusal of the request.
  if (message.error) {
    throw Object.assign(new Error(message.error.message || 'MCP tool call failed'), { isToolError: true });
  }
  const content = Array.isArray(message.result?.content) ? message.result.content : [];
  const text = content.find(item => item.type === 'text');
  if (message.result?.isError) {
    throw Object.assign(new Error(text ? text.text : 'MCP tool call failed'), { isToolError: true });
  }
  if (!text) {
    throw new Error(`The memory server answered ${toolName} without a text result`);
  }
  return parseJsonOrRaw(text.text);
}

// The last lines the server wrote to stderr, as a clause of a failure
// message, or nothing when it wrote nothing.
function stderrClause(stderr) {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-STDERR_TAIL_LINES);
  return lines.length === 0 ? '' : `; the server wrote: ${lines.join(' | ')}`;
}

function describeExit(code, signal) {
  return signal ? `was stopped by ${signal}` : `exited with code ${code}`;
}

/**
 * Calls one tool of the memory server and resolves with its value.
 *
 * options.serverScript  the server entry point (the built one by default)
 * options.timeoutMs     how long the whole session may take (60 s by default)
 * options.env           the server's environment (this process's by default)
 * options.clientName    the client name of the MCP handshake
 */
function callMcpTool(toolName, args, options = {}) {
  const serverScript = options.serverScript ?? DEFAULT_SERVER_SCRIPT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clientName = options.clientName ?? 'egc-team';

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    });
    let initialized = false;
    let outcome = null;
    let buffer = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;

    const record = (error, value) => {
      if (outcome) return;
      outcome = { error, value };
      child.stdin.end();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      record(new Error('timed out'));
      child.kill();
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, KILL_GRACE_MS);
      if (killTimer.unref) killTimer.unref();
    }, timeoutMs);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');

    const onMessage = message => {
      if (!initialized && message.id === MCP_INITIALIZE_ID) {
        if (message.error) {
          record(new Error(message.error.message || 'MCP initialize failed'));
          return;
        }
        initialized = true;
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: MCP_CALL_ID, method: 'tools/call', params: { name: toolName, arguments: args } });
        return;
      }
      if (message.id === MCP_CALL_ID) {
        try {
          record(null, toolCallValue(toolName, message));
        } catch (error) {
          record(error);
        }
      }
    };

    // A server that exits before reading closes the pipe under the client;
    // the close handler names that exit.
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', chunk => {
      const lines = (buffer + chunk).split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (outcome) break;
        const message = parseJsonRpcLine(line);
        if (message) onMessage(message);
      }
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('error', error => record(error));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (outcome && outcome.error === null) {
        resolve(outcome.value);
        return;
      }
      if (outcome && !timedOut) {
        reject(outcome.error);
        return;
      }
      const tail = stderrClause(stderr);
      if (timedOut) {
        reject(Object.assign(
          new Error(`The memory server did not answer ${toolName} within ${timeoutMs / 1000} s${tail}`),
          { isTimeout: true },
        ));
        return;
      }
      reject(Object.assign(
        new Error(`The memory server ${describeExit(code, signal)} before answering ${toolName}${tail}`),
        { exitCode: code, signal },
      ));
    });

    send({
      jsonrpc: '2.0',
      id: MCP_INITIALIZE_ID,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clientName, version: PACKAGE_VERSION },
      },
    });
  });
}

module.exports = { callMcpTool, DEFAULT_SERVER_SCRIPT, DEFAULT_TIMEOUT_MS };
