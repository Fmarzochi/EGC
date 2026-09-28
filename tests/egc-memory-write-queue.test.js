/**
 * The egc-memory write queue (mcp/servers/egc-memory/src/write-queue.ts): one
 * write at a time, and a write that meets another process's lock waits its
 * backoff without holding up the writes behind it.
 *
 * Run with: node tests/egc-memory-write-queue.test.js
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'write-queue.js');
if (!fs.existsSync(buildPath)) {
  console.log(`[SKIP] ${buildPath} not found. Run 'npm run build' in mcp/servers/egc-memory first.`);
  process.exit(0);
}
const { SQLiteArbitrationQueue } = require(buildPath);

// A write that never settles leaves nothing for the event loop, and Node
// would exit cleanly mid-test; only the end of the run clears this.
process.exitCode = 1;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.stack}`);
    failed++;
  }
}

const busy = () => Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' });
const within = (ms, promise) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms)),
]);

async function runTests() {
  console.log('\n=== Testing the egc-memory write queue ===\n');

  await test('a write behind one that meets a lock goes on without waiting for its backoff', async () => {
    const queue = new SQLiteArbitrationQueue({ baseBackoffMs: 400 });
    let attempts = 0;
    const locked = queue.enqueue(async () => {
      attempts += 1;
      if (attempts === 1) throw busy();
      return 'locked-done';
    });
    const behind = queue.enqueue(async () => 'behind-done');
    assert.strictEqual(await within(200, behind), 'behind-done');
    assert.strictEqual(await within(2000, locked), 'locked-done');
    assert.strictEqual(attempts, 2);
  });

  await test('a backoff never runs past its cap, and a lock reported only as "database is locked" is retried too', async () => {
    const queue = new SQLiteArbitrationQueue({ baseBackoffMs: 1000, maxBackoffMs: 5 });
    let attempts = 0;
    const write = queue.enqueue(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('database is locked');
      return 'done';
    });
    assert.strictEqual(await within(300, write), 'done');
    assert.strictEqual(attempts, 2);
  });

  await test('writes run one at a time', async () => {
    const queue = new SQLiteArbitrationQueue({ baseBackoffMs: 1 });
    let running = 0;
    let most = 0;
    let first = true;
    const write = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running -= 1;
      if (first) {
        first = false;
        throw busy();
      }
    };
    await within(2000, Promise.all(Array.from({ length: 5 }, () => queue.enqueue(write))));
    assert.strictEqual(most, 1);
  });

  await test('an error that is not a lock rejects at once, without a retry', async () => {
    const queue = new SQLiteArbitrationQueue({ baseBackoffMs: 1 });
    let attempts = 0;
    await assert.rejects(queue.enqueue(async () => {
      attempts += 1;
      throw new Error('constraint failed');
    }), /constraint failed/);
    assert.strictEqual(attempts, 1);
  });

  await test('a write still locked after every retry is dead-lettered, and the lock is logged each time', async () => {
    const warnings = [];
    const queue = new SQLiteArbitrationQueue({ baseBackoffMs: 1, maxRetries: 2, log: level => warnings.push(level) });
    let attempts = 0;
    await assert.rejects(within(2000, queue.enqueue(async () => {
      attempts += 1;
      throw busy();
    })), /Arbitration Failed after 2 retries/);
    assert.strictEqual(attempts, 3);
    assert.deepStrictEqual(warnings, ['WARN', 'WARN', 'ERROR']);
  });

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
  process.exit();
}

runTests();
