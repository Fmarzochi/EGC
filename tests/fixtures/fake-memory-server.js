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
 *   chatty-exit     thirty long lines on stderr, then exit 2 before answering
 *   orphan          a grandchild that inherits the pipes and lives on, then
 *                   exit 4 before answering
 *   self-kill       stopped by its own SIGTERM before answering (not Windows)
 *   hangs           a line on stderr, then no answer
 *   hangs-deaf      like hangs, and the first signal is ignored
 *   hangs-handshake a line on stderr, then no answer to initialize
 *
 * When EGC_FAKE_EXIT_STAMP names a file, the modes that exit on their own
 * write the moment they leave to it, so a test can place the exit in time.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const readline = require('node:readline');

const mode = process.env.EGC_FAKE_MODE || 'answers';
const staysUp = mode === 'hangs' || mode === 'hangs-deaf' || mode === 'hangs-handshake' || mode === 'answers-linger';
const reply = message => process.stdout.write(JSON.stringify(message) + '\n');
const result = (id, content, extra = {}) => reply({ jsonrpc: '2.0', id, result: { content, ...extra } });
const leave = code => {
  if (process.env.EGC_FAKE_EXIT_STAMP) fs.writeFileSync(process.env.EGC_FAKE_EXIT_STAMP, String(Date.now()));
  process.exit(code);
};

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
    if (mode === 'hangs-handshake') {
      process.stderr.write('[memory] opening the store\n');
      setInterval(() => {}, 1000);
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
      process.stderr.write('[memory] store: cannot open /nowhere/state.db\n', () => leave(3));
      break;
    case 'chatty-exit': {
      // Thirty lines of two hundred characters: more than the client keeps,
      // so the tail it quotes is cut by lines, not by characters.
      const lines = Array.from({ length: 30 }, (_, index) => `[memory] line ${index + 1} ${'x'.repeat(180)}\n`).join('');
      process.stderr.write(lines, () => leave(2));
      break;
    }
    case 'orphan': {
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit', detached: true });
      grandchild.unref();
      process.stderr.write('[memory] leaving a grandchild on the pipes\n', () => leave(4));
      break;
    }
    case 'self-kill':
      process.stderr.write('[memory] stopped by a signal\n', () => process.kill(process.pid, 'SIGTERM'));
      break;
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
