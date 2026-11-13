'use strict';

/**
 * A stand-in for the memory server over stdio, for the tests of the clients
 * that call one tool and leave. It answers the MCP handshake and then
 * behaves as EGC_FAKE_MODE says:
 *
 *   answers         a text result with the call, its arguments and EGC_TEST_MARK
 *   answers-linger  the same answer, then the server stays up after its stdin closes
 *   refuses         a result flagged isError
 *   rpc-error       a JSON-RPC error on the call
 *   init-error      a JSON-RPC error on initialize
 *   textless        a result with no text content
 *   raw-text        a text result that is not JSON
 *   noisy           log lines on stdout around the answer, the last one with
 *                   no trailing newline
 *   exits           a line on stderr, then exit 3 before answering
 *   chatty-exit     thirty lines on stderr, then exit 2 before answering
 *   hangs           a line on stderr, then no answer
 *   hangs-deaf      like hangs, and the first signal is ignored
 */

const readline = require('node:readline');

const mode = process.env.EGC_FAKE_MODE || 'answers';
const staysUp = mode === 'hangs' || mode === 'hangs-deaf' || mode === 'answers-linger';
const reply = message => process.stdout.write(JSON.stringify(message) + '\n');
const result = (id, content, extra = {}) => reply({ jsonrpc: '2.0', id, result: { content, ...extra } });

if (mode === 'hangs-deaf') {
  process.on('SIGTERM', () => {});
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') {
    if (mode === 'init-error') {
      reply({ jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'this server refuses the handshake' } });
      return;
    }
    reply({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } } });
    return;
  }
  if (request.method !== 'tools/call') return;
  const name = request.params.name;
  switch (mode) {
    case 'exits':
      // The exit waits for the write, so the client always reads the line.
      process.stderr.write('[memory] store: cannot open /nowhere/state.db\n', () => process.exit(3));
      break;
    case 'chatty-exit': {
      const lines = Array.from({ length: 30 }, (_, index) => `[memory] line ${index + 1}\n`).join('');
      process.stderr.write(lines, () => process.exit(2));
      break;
    }
    case 'hangs':
    case 'hangs-deaf':
      process.stderr.write('[memory] git: Host key verification pending\n');
      setInterval(() => {}, 1000);
      return;
    case 'refuses':
      result(request.id, [{ type: 'text', text: 'The remote x cannot be read: refused' }], { isError: true });
      return;
    case 'rpc-error':
      reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Tool not found: ${name}` } });
      return;
    case 'textless':
      result(request.id, [null, { type: 'image', data: '' }]);
      return;
    case 'raw-text':
      result(request.id, [{ type: 'text', text: 'plain words, not JSON' }]);
      return;
    case 'noisy':
      process.stdout.write('a log line that is not JSON\n[1,2,3]\n"a bare string"\n');
      result(request.id, [{ type: 'text', text: JSON.stringify({ ok: true, noisy: true }) }]);
      process.stdout.write('trailing words without a newline');
      return;
    default:
      process.stderr.write('[memory] a log line that is not a failure\n');
      result(request.id, [{ type: 'text', text: JSON.stringify({ ok: true, tool: name, args: request.params.arguments, mark: process.env.EGC_TEST_MARK ?? null }) }]);
      if (mode === 'answers-linger') setInterval(() => {}, 1000);
  }
});
// When stdin ends the server has nothing left to do and leaves once its
// last writes are flushed; the modes that stay up keep their interval.
rl.on('close', () => {
  if (!staysUp) process.exitCode = 0;
});
