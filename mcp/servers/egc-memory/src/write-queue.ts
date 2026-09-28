import { randomInt } from 'node:crypto';

type Log = (level: 'WARN' | 'ERROR', msg: string, meta?: Record<string, unknown>) => void;

interface QueueTask<T> {
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  retries: number;
}

export interface WriteQueueOptions {
  log?: Log;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

// One write to the state database at a time. A write that meets a lock held
// by another process (SQLITE_BUSY) waits out a backoff and goes back to the
// end of the queue, while the writes behind it carry on.
export class SQLiteArbitrationQueue {
  private readonly queue: QueueTask<unknown>[] = [];
  private isProcessing = false;
  private readonly log: Log;
  private readonly MAX_RETRIES: number;
  private readonly BASE_BACKOFF_MS: number;
  private readonly MAX_BACKOFF_MS: number;

  constructor(options: WriteQueueOptions = {}) {
    this.log = options.log ?? (() => undefined);
    this.MAX_RETRIES = options.maxRetries ?? 12;
    this.BASE_BACKOFF_MS = options.baseBackoffMs ?? 50;
    this.MAX_BACKOFF_MS = options.maxBackoffMs ?? 5000;
  }

  async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, resolve: resolve as (value: unknown) => void, reject, retries: 0 });
      this.processNext();
    });
  }

  private async processNext() { // NOSONAR: queue processor keeps the single-threaded invariant and SQLITE_BUSY retry logic in one read
    // SINGLE-THREADED INVARIANT:
    // In Node.js, async functions run to the first await synchronously.
    // This synchronous execution until the first await guarantees that
    // checking and setting this.isProcessing is atomic and free of race conditions.
    // This makes it safe even under concurrent SQLITE_BUSY retries.
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
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(JSON.stringify(err));
      if (error.message && (error.message.includes('SQLITE_BUSY') || error.message.includes('database is locked'))) {
        if (task.retries < this.MAX_RETRIES) {
          task.retries++;
          let backoff = Math.pow(2, task.retries) * this.BASE_BACKOFF_MS;
          if (backoff > this.MAX_BACKOFF_MS) backoff = this.MAX_BACKOFF_MS;
          // Equal jitter: with N MCP server processes (one per IDE/CLI session)
          // colliding on the same ~/.egc database, deterministic backoff wakes
          // them all on the same tick and the collision repeats (thundering herd).
          const half = Math.floor(backoff / 2);
          backoff = half + randomInt(0, half + 1);
          this.log('WARN', `Write Collision Detected (SQLITE_BUSY). Arbitration retrying...`, {
            queue_depth: this.queue.length,
            retry_count: task.retries,
            backoff_ms: backoff
          });

          setTimeout(() => {
            this.queue.push(task); // Requeue at the end instead of unshift to prevent queue poisoning
            this.processNext();
          }, backoff);
        } else {
          this.log('ERROR', `Arbitration Failed. Write lock unrecoverable. Dead-lettering task.`, { retries: task.retries });
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
