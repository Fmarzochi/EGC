/**
 * Tests for the shared hook stdin reader (scripts/lib/hook-stdin.js).
 * Validates limit enforcement, truncation behavior, empty input,
 * stream errors, and Promise/callback interfaces.
 */
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  readHookStdin,
  readHookStdinAsync,
  readHookInput,
  MAX_HOOK_INPUT_BYTES,
  MAX_STDIN,
} = require('../../scripts/lib/hook-stdin');

function test(name, fn) {
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res
        .then(() => {
          console.log(`  ✓ ${name}`);
          return true;
        })
        .catch(error => {
          console.log(`  ✗ ${name}`);
          console.log(`    Error: ${error.message}`);
          return false;
        });
    }
    console.log(`  ✓ ${name}`);
    return Promise.resolve(true);
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return Promise.resolve(false);
  }
}

async function runTests() {
  console.log('\n=== Testing Shared Hook Stdin Reader ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => (ok ? passed++ : failed++);

  // Constants
  record(await test('constants export 1 MiB limits', () => {
    assert.strictEqual(MAX_HOOK_INPUT_BYTES, 1024 * 1024);
    assert.strictEqual(MAX_STDIN, 1024 * 1024);
    assert.strictEqual(readHookInput, readHookStdin);
  }));

  // Empty input
  record(await test('empty input produces empty raw string without truncation', async () => {
    const stream = new EventEmitter();
    const resultPromise = readHookStdinAsync(stream);
    stream.emit('end');
    const result = await resultPromise;
    assert.deepStrictEqual(result, { raw: '', truncated: false });
  }));

  // Callback interface with empty input
  record(await test('callback receives empty input on immediate end', () => new Promise(resolve => {
    const stream = new EventEmitter();
    readHookStdin(result => {
      assert.deepStrictEqual(result, { raw: '', truncated: false });
      resolve();
    }, stream);
    stream.emit('end');
  })));

  // Under limit
  record(await test('input under limit is read completely without truncation', async () => {
    const stream = new EventEmitter();
    const resultPromise = readHookStdinAsync(stream);
    stream.emit('data', Buffer.from('{"hello": "world"}'));
    stream.emit('end');
    const result = await resultPromise;
    assert.deepStrictEqual(result, { raw: '{"hello": "world"}', truncated: false });
  }));

  // Exact limit
  record(await test('input of exactly 1 MiB is read whole without truncation', async () => {
    const stream = new EventEmitter();
    const resultPromise = readHookStdinAsync(stream);
    const chunk1 = Buffer.alloc(MAX_HOOK_INPUT_BYTES - 4, 0x61); // 'a'
    const chunk2 = Buffer.from('test');
    stream.emit('data', chunk1);
    stream.emit('data', chunk2);
    stream.emit('end');
    const result = await resultPromise;
    assert.strictEqual(Buffer.byteLength(result.raw), MAX_HOOK_INPUT_BYTES);
    assert.strictEqual(result.truncated, false);
    assert.ok(result.raw.endsWith('test'));
  }));

  // Limit exceeded (truncation)
  record(await test('input exceeding limit is capped at 1 MiB and marked truncated', async () => {
    const stream = new EventEmitter();
    const resultPromise = readHookStdinAsync(stream);
    const chunk1 = Buffer.alloc(MAX_HOOK_INPUT_BYTES, 0x61);
    const chunk2 = Buffer.from('overflow');
    stream.emit('data', chunk1);
    stream.emit('data', chunk2);
    stream.emit('end');
    const result = await resultPromise;
    assert.strictEqual(Buffer.byteLength(result.raw), MAX_HOOK_INPUT_BYTES);
    assert.strictEqual(result.truncated, true);
  }));

  // Multibyte characters boundary truncation
  record(await test('multibyte characters past limit are capped by bytes and marked truncated', async () => {
    const stream = new EventEmitter();
    const resultPromise = readHookStdinAsync(stream);
    stream.emit('data', Buffer.alloc(MAX_HOOK_INPUT_BYTES - 1, 0x61));
    stream.emit('data', 'é'); // 2 bytes in utf8
    stream.emit('end');
    const result = await resultPromise;
    assert.strictEqual(result.truncated, true);
    // Buffer should have received only MAX_HOOK_INPUT_BYTES - 1 bytes
    assert.strictEqual(Buffer.byteLength(result.raw.replace(/\uFFFD$/, '')), MAX_HOOK_INPUT_BYTES - 1);
  }));

  // Stream error marks truncated and does not throw uncaught error
  record(await test('stream error finishes safely with truncated=true', async () => {
    const stream = new EventEmitter();
    const resultPromise = readHookStdinAsync(stream);
    stream.emit('data', Buffer.from('{"partial": true'));
    stream.emit('error', new Error('premature close'));
    const result = await resultPromise;
    assert.deepStrictEqual(result, { raw: '{"partial": true', truncated: true });
  }));

  // Custom maxBytes option
  record(await test('custom maxBytes option limits reading to specified byte limit', async () => {
    const stream = new EventEmitter();
    const resultPromise = readHookStdinAsync({ stream, maxBytes: 10 });
    stream.emit('data', Buffer.from('0123456789extra'));
    stream.emit('end');
    const result = await resultPromise;
    assert.strictEqual(result.raw, '0123456789');
    assert.strictEqual(result.truncated, true);
  }));

  // Double end or error after end is a no-op
  record(await test('subsequent end or error events after finish are ignored', async () => {
    const stream = new EventEmitter();
    let callCount = 0;
    readHookStdin(() => {
      callCount++;
    }, stream);
    stream.emit('data', Buffer.from('data'));
    stream.emit('end');
    stream.emit('end');
    stream.emit('error', new Error('late error'));
    assert.strictEqual(callCount, 1);
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
