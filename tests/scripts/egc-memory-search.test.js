/**
 * Tests for the egc-memory BM25 search module (SQLite FTS5).
 *
 * Imports the compiled CommonJS build and the sqlite driver bundled with the
 * server. Skips with a clear message when the server has not been built yet.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '../../mcp/servers/egc-memory');
const SEARCH_PATH = path.join(SERVER_ROOT, 'build', 'search.js');
const SQLITE3_PATH = path.join(SERVER_ROOT, 'node_modules', 'sqlite3');
const SQLITE_PATH = path.join(SERVER_ROOT, 'node_modules', 'sqlite');

if (!fs.existsSync(SEARCH_PATH) || !fs.existsSync(SQLITE3_PATH) || !fs.existsSync(SQLITE_PATH)) {
  console.error(
    `[SKIP] Missing ${SEARCH_PATH} or server dependencies. Run 'npm ci && npm run build' in mcp/servers/egc-memory first.`
  );
  process.exit(0);
}

const {
  sanitizeFtsQuery,
  rankResults,
  createSearchIndex,
  rebuildSearchIndex,
  searchDecisions,
} = require(SEARCH_PATH);

const sqlite3 = require(SQLITE3_PATH);
const { open } = require(SQLITE_PATH);

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function openMemoryDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(
    'CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context TEXT, decision TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)'
  );
  return db;
}

async function insertDecision(db, context, decision) {
  await db.run('INSERT INTO decisions (context, decision) VALUES (?, ?)', [context, decision]);
}

async function seedDecisions(db) {
  await insertDecision(db, 'architecture', 'Chose JWT over server sessions for authentication because the API is stateless');
  await insertDecision(db, 'architecture', 'Auth middleware handles refresh tokens via a rotating JWT secret');
  await insertDecision(db, 'database', 'Use SQLite WAL mode to allow concurrent readers during writes');
  await insertDecision(db, 'tooling', 'Adopt eslint flat config and drop the legacy rc format');
}

async function runTests() {
  console.log('\n=== Testing egc-memory search (FTS5 BM25) ===\n');

  let passed = 0;
  let failed = 0;

  if (await test('sanitizeFtsQuery quotes tokens and joins them with OR', async () => {
    assert.strictEqual(sanitizeFtsQuery('authentication jwt'), '"authentication" OR "jwt"');
    assert.strictEqual(sanitizeFtsQuery('sqlite'), '"sqlite"');
  })) passed += 1; else failed += 1;

  if (await test('sanitizeFtsQuery neutralizes FTS5 operators and punctuation', async () => {
    assert.strictEqual(sanitizeFtsQuery('auth* AND (jwt NEAR token)'), '"auth" OR "AND" OR "jwt" OR "NEAR" OR "token"');
    assert.strictEqual(sanitizeFtsQuery('"quoted" -minus ^caret'), '"quoted" OR "minus" OR "caret"');
    assert.strictEqual(sanitizeFtsQuery('auth-token'), '"auth" OR "token"');
  })) passed += 1; else failed += 1;

  if (await test('sanitizeFtsQuery returns empty string when no tokens remain', async () => {
    assert.strictEqual(sanitizeFtsQuery('   '), '');
    assert.strictEqual(sanitizeFtsQuery('*** ()) --'), '');
  })) passed += 1; else failed += 1;

  if (await test('rankResults normalizes the best match to 1 and preserves order', async () => {
    const ranked = rankResults([
      { id: 1, content: 'a', context: 'x', date: 'd1', rawScore: -2.0 },
      { id: 2, content: 'b', context: 'y', date: 'd2', rawScore: -1.0 },
    ]);
    assert.strictEqual(ranked.length, 2);
    assert.strictEqual(ranked[0].id, 1);
    assert.strictEqual(ranked[0].score, 1);
    assert.strictEqual(ranked[1].score, 0.5);
    assert.deepStrictEqual(rankResults([]), []);
  })) passed += 1; else failed += 1;

  if (await test('rebuild backfills decisions stored before the index existed', async () => {
    const db = await openMemoryDb();
    try {
      await seedDecisions(db);
      await createSearchIndex(db);
      await rebuildSearchIndex(db);

      const results = await searchDecisions(db, 'jwt authentication');
      assert.ok(results.length >= 2);
      assert.ok(results[0].content.includes('JWT'));
      assert.strictEqual(results[0].score, 1);
      for (const result of results) {
        assert.strictEqual(typeof result.id, 'number');
        assert.strictEqual(typeof result.content, 'string');
        assert.strictEqual(typeof result.context, 'string');
        assert.ok(result.date);
        assert.ok(result.score >= 0 && result.score <= 1);
      }
    } finally {
      await db.close();
    }
  })) passed += 1; else failed += 1;

  if (await test('results are ordered by descending relevance', async () => {
    const db = await openMemoryDb();
    try {
      await createSearchIndex(db);
      await seedDecisions(db);

      const results = await searchDecisions(db, 'jwt refresh tokens');
      assert.ok(results.length >= 2);
      for (let i = 1; i < results.length; i += 1) {
        assert.ok(results[i - 1].score >= results[i].score);
      }
      assert.ok(results[0].content.includes('refresh tokens'));
    } finally {
      await db.close();
    }
  })) passed += 1; else failed += 1;

  if (await test('triggers index new decisions incrementally without a rebuild', async () => {
    const db = await openMemoryDb();
    try {
      await createSearchIndex(db);
      await insertDecision(db, 'deployment', 'Ship the worker as a systemd unit instead of a cron job');

      const results = await searchDecisions(db, 'systemd');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].context, 'deployment');
    } finally {
      await db.close();
    }
  })) passed += 1; else failed += 1;

  if (await test('triggers keep the index in sync on update and delete', async () => {
    const db = await openMemoryDb();
    try {
      await createSearchIndex(db);
      await insertDecision(db, 'cache', 'Use redis for the hot path cache');

      await db.run('UPDATE decisions SET decision = ? WHERE context = ?', ['Use memcached for the hot path cache', 'cache']);
      assert.strictEqual((await searchDecisions(db, 'redis')).length, 0);
      assert.strictEqual((await searchDecisions(db, 'memcached')).length, 1);

      await db.run('DELETE FROM decisions WHERE context = ?', ['cache']);
      assert.strictEqual((await searchDecisions(db, 'memcached')).length, 0);
    } finally {
      await db.close();
    }
  })) passed += 1; else failed += 1;

  if (await test('respects the limit option', async () => {
    const db = await openMemoryDb();
    try {
      await createSearchIndex(db);
      await seedDecisions(db);

      const results = await searchDecisions(db, 'jwt authentication tokens', { limit: 1 });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].score, 1);
    } finally {
      await db.close();
    }
  })) passed += 1; else failed += 1;

  if (await test('filters weak matches below min_score', async () => {
    const db = await openMemoryDb();
    try {
      await createSearchIndex(db);
      await seedDecisions(db);

      const all = await searchDecisions(db, 'jwt refresh tokens');
      const strong = await searchDecisions(db, 'jwt refresh tokens', { minScore: 0.99 });
      assert.ok(strong.length < all.length);
      assert.ok(strong.every(result => result.score >= 0.99));
    } finally {
      await db.close();
    }
  })) passed += 1; else failed += 1;

  if (await test('returns an empty list for no matches or token-free queries', async () => {
    const db = await openMemoryDb();
    try {
      await createSearchIndex(db);
      await seedDecisions(db);

      assert.deepStrictEqual(await searchDecisions(db, 'kubernetes'), []);
      assert.deepStrictEqual(await searchDecisions(db, '*** ()'), []);
    } finally {
      await db.close();
    }
  })) passed += 1; else failed += 1;

  if (await test('createSearchIndex is idempotent across reopens', async () => {
    const db = await openMemoryDb();
    try {
      await createSearchIndex(db);
      await createSearchIndex(db);
      await insertDecision(db, 'idempotency', 'Index creation must be safe to run on every boot');

      const results = await searchDecisions(db, 'idempotency boot');
      assert.strictEqual(results.length, 1);
    } finally {
      await db.close();
    }
  })) passed += 1; else failed += 1;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
