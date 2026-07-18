const assert = require('assert');
const { randomInt } = require('node:crypto');
async function getMockedDb() {
  const store = [];
  
  const db = {
    exec: async (_sql) => {
      // Mock table creation
      return true;
    },
    get: async (_sql) => {
      // Mock row count query
      return { count: store.length };
    }
  };

  let callCount = 0;
  db.run = async function(sql, ...params) {
    callCount++;
    // Mock SQLITE_BUSY for exactly 3 times globally to trigger the arbitration logic
    if (callCount <= 3) {
      const err = new Error('SQLITE_BUSY: database is locked');
      err.code = 'SQLITE_BUSY';
      throw err;
    }
    store.push({ sql, params });
    return true;
  };
  
  return db;
}

// Minimal port of SQLiteArbitrationQueue for the test environment
class SQLiteArbitrationQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.MAX_RETRIES = 12;
    this.BASE_BACKOFF_MS = 10;
    this.MAX_BACKOFF_MS = 50;
  }

  enqueue(operation) {
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, resolve, reject, retries: 0 });
      this.processNext();
    });
  }

  async processNext() {
    // SINGLE-THREADED INVARIANT:
    // In Node.js, async functions run to the first await synchronously.
    // This synchronous execution until the first await guarantees that 
    // checking and setting this.isProcessing is atomic and free of race conditions.
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const task = this.queue.shift();
    if (!task) {
      this.isProcessing = false;
      return;
    }

    try {
      const result = await task.operation();
      task.resolve(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.message && (error.message.includes('SQLITE_BUSY') || error.message.includes('database is locked'))) {
        if (task.retries < this.MAX_RETRIES) {
          task.retries++;
          let backoff = Math.pow(2, task.retries) * this.BASE_BACKOFF_MS;
          if (backoff > this.MAX_BACKOFF_MS) backoff = this.MAX_BACKOFF_MS;
          // Equal jitter, mirrors the production queue in egc-memory/src/index.ts
          const half = Math.floor(backoff / 2);
          backoff = half + randomInt(0, half + 1);

          setTimeout(() => {
            this.queue.push(task); // Requeue at the end
            this.processNext();
          }, backoff);

          this.isProcessing = false;
          return;
        } else {
          task.reject(new Error(`Arbitration Failed after ${this.MAX_RETRIES} retries: ` + error.message));
        }
      } else {
        task.reject(err);
      }
    }

    this.isProcessing = false;
    this.processNext();
  }
}

async function runTest() {
  console.log('--- Starting STR-03 SQLite Arbitration Queue Stress Test ---');
  
  const db = await getMockedDb();
  const queue = new SQLiteArbitrationQueue();
  
  let successes = 0;
  let failures = 0;
  
  const promises = [];
  
  // Fire 100 concurrent writes
  for (let i = 0; i < 100; i++) {
    promises.push(
      queue.enqueue(async () => {
        await db.run('INSERT INTO decisions (context, decision) VALUES (?, ?)', ['ctx' + i, 'dec' + i]);
        successes++;
      }).catch(err => {
        console.error('Failed to write:', err.message);
        failures++;
      })
    );
  }
  
  await Promise.all(promises);
  
  console.log(`Successes: ${successes}, Failures: ${failures}`);
  assert.strictEqual(successes, 100, 'All 100 concurrent writes should succeed after arbitration');
  assert.strictEqual(failures, 0, 'There should be 0 failures');
  
  const rowCount = await db.get('SELECT COUNT(*) as count FROM decisions');
  assert.strictEqual(rowCount.count, 100, 'Database should contain exactly 100 rows');
  
  console.log('[PASS] STR-03 Test passed: Arbitration queue handled SQLITE_BUSY concurrently without data loss.');
}

if (require.main === module) {
  runTest().catch(err => {
    console.error('[FAIL] Test failed:', err);
    process.exit(1);
  });
}
