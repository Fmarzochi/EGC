'use strict';

/**
 * STRESS TEST: scripts/lib/state-store
 * Tests beyond the standard test suite:
 * - High-volume sequential inserts
 * - Repeated open/close cycles (memory leak detection)
 * - Large payload handling
 * - Boundary conditions (empty strings, nulls, max sizes)
 * - Transaction rollback integrity
 * - Schema constraint enforcement
 * - SQL injection resilience
 * - Unicode / adversarial field values
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStateStore } = require('../../scripts/lib/state-store');

// ─── helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeSession(overrides = {}) {
  return {
    id: uid(),
    adapterId: 'stress-adapter',
    harness: 'gemini',
    state: 'active',
    repoRoot: '/stress/repo',
    startedAt: new Date().toISOString(),
    snapshot: {},
    ...overrides,
  };
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-stress-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

// ─── tests ──────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n=== STRESS TEST: state-store ===\n');

  // ── 1. High-volume sequential inserts ──────────────────────────────────────
  await test('insert 500 sessions sequentially without error', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      for (let i = 0; i < 500; i++) {
        store.upsertSession(makeSession({ id: `session-${i}` }));
      }
      const { sessions, totalCount } = store.listRecentSessions({ limit: 1000 });
      assert.strictEqual(totalCount, 500);
      assert.strictEqual(sessions.length, 500);
    } finally {
      store.close();
    }
  });

  // ── 2. High-volume skill_runs ──────────────────────────────────────────────
  await test('insert 1000 skill_runs across 10 sessions', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      const sessionIds = [];
      for (let i = 0; i < 10; i++) {
        const s = makeSession({ id: `bulk-session-${i}` });
        store.upsertSession(s);
        sessionIds.push(s.id);
      }
      for (let i = 0; i < 1000; i++) {
        store.insertSkillRun({
          id: `run-${i}`,
          skillId: `skill-${i % 20}`,
          skillVersion: '1.0.0',
          sessionId: sessionIds[i % 10],
          taskDescription: `Task ${i}`,
          outcome: i % 3 === 0 ? 'failure' : 'success',
          tokensUsed: crypto.randomInt(0, 10000),
          durationMs: crypto.randomInt(0, 5000),
          createdAt: new Date().toISOString(),
        });
      }
      const detail = store.getSessionDetail(sessionIds[0]);
      assert.ok(detail !== undefined, 'Session detail should be retrievable');
    } finally {
      store.close();
    }
  });

  // ── 3. Repeated open/close cycles (memory leak probe) ─────────────────────
  await test('100 open/close cycles on the same file do not leak', async () => {
    const tmpDir = createTempDir();
    const dbPath = path.join(tmpDir, 'state.db');
    try {
      const memBefore = process.memoryUsage().heapUsed;
      for (let i = 0; i < 100; i++) {
        const store = await createStateStore({ dbPath });
        store.upsertSession(makeSession({ id: `cycle-${i}` }));
        store.close();
      }
      const memAfter = process.memoryUsage().heapUsed;
      const growthMb = (memAfter - memBefore) / 1024 / 1024;
      assert.ok(growthMb < 50, `Memory grew by ${growthMb.toFixed(1)} MB — possible leak`);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 4. Large payload in snapshot ──────────────────────────────────────────
  await test('snapshot with 100KB of nested JSON survives round-trip', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      const bigSnapshot = {
        workers: Array.from({ length: 500 }, (_, i) => ({
          id: `worker-${i}`,
          data: 'x'.repeat(100),
          nested: { level: 3, value: i },
        })),
      };
      const sessionId = uid();
      store.upsertSession(makeSession({ id: sessionId, snapshot: bigSnapshot }));
      const { sessions } = store.listRecentSessions({ limit: 1 });
      assert.ok(sessions[0].snapshot.workers.length === 500);
    } finally {
      store.close();
    }
  });

  // ── 5. Null / empty boundary values ───────────────────────────────────────
  await test('session with null repoRoot and empty snapshot survives', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      store.upsertSession(makeSession({ repoRoot: null, snapshot: {} }));
      const { sessions } = store.listRecentSessions({ limit: 1 });
      assert.ok(sessions.length === 1);
      assert.strictEqual(sessions[0].repoRoot, null);
    } finally {
      store.close();
    }
  });

  // ── 6. Very long string fields ─────────────────────────────────────────────
  await test('session id of 1000 chars is stored and retrieved correctly', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      const longId = 'a'.repeat(1000);
      store.upsertSession(makeSession({ id: longId }));
      const { sessions } = store.listRecentSessions({ limit: 1 });
      assert.strictEqual(sessions[0].id, longId);
    } finally {
      store.close();
    }
  });

  // ── 7. Transaction rollback integrity ─────────────────────────────────────
  await test('failed FK insert leaves DB in consistent state', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      store.upsertSession(makeSession({ id: 'before-bad-tx' }));
      try {
        store.insertSkillRun({
          id: uid(),
          skillId: 'sk-1',
          skillVersion: '1.0',
          sessionId: 'DOES-NOT-EXIST',
          taskDescription: 'bad',
          outcome: 'success',
          createdAt: new Date().toISOString(),
        });
      } catch (_) { /* expected FK violation */ }

      const { sessions } = store.listRecentSessions({ limit: 10 });
      assert.ok(sessions.some(s => s.id === 'before-bad-tx'), 'Session should still be there');
    } finally {
      store.close();
    }
  });

  // ── 8. Idempotent upserts (no duplicate PK crashes) ───────────────────────
  await test('1000 upserts with the same ID replace rather than duplicate', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      const id = uid();
      for (let i = 0; i < 1000; i++) {
        store.upsertSession(makeSession({ id, state: i % 2 === 0 ? 'active' : 'idle' }));
      }
      const { totalCount } = store.listRecentSessions({ limit: 100 });
      assert.strictEqual(totalCount, 1, 'Expected exactly 1 session after 1000 upserts');
    } finally {
      store.close();
    }
  });

  // ── 9. listRecentSessions limit=0 boundary ────────────────────────────────
  await test('listRecentSessions with limit=0 throws or returns empty', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      for (let i = 0; i < 5; i++) store.upsertSession(makeSession({ id: `p-${i}` }));
      let threw = false;
      let result;
      try {
        result = store.listRecentSessions({ limit: 0 });
      } catch (_) {
        threw = true;
      }
      if (!threw) {
        const count = result.sessions ? result.sessions.length : 0;
        assert.ok(count === 0, 'limit:0 should not return all rows');
      }
    } finally {
      store.close();
    }
  });

  // ── 10. Instincts high-volume with confidence boundary values ─────────────
  await test('insert 500 instincts with confidence 0 and 1 boundary values', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      for (let i = 0; i < 250; i++) {
        store.upsertInstinct({
          id: `inst-zero-${i}`,
          projectId: 'stress-proj',
          trigger: `trigger-zero-${i}`,
          content: `content-${i}`,
          confidence: 0,
          createdAt: new Date().toISOString(),
        });
      }
      for (let i = 0; i < 250; i++) {
        store.upsertInstinct({
          id: `inst-one-${i}`,
          projectId: 'stress-proj',
          trigger: `trigger-one-${i}`,
          content: `content-${i}`,
          confidence: 1,
          createdAt: new Date().toISOString(),
        });
      }
      const { instincts, totalCount } = store.listInstincts({ projectId: 'stress-proj' });
      assert.ok(Array.isArray(instincts), 'instincts should be an array');
      // listInstincts is paginated by confidence DESC — verify via totalCount
      assert.strictEqual(totalCount, 500, `Expected 500 instincts, got ${totalCount}`);
    } finally {
      store.close();
    }
  });

  // ── 11. Lessons archiving at scale ────────────────────────────────────────
  await test('archive 500 lessons and list only active/archived separately', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      for (let i = 0; i < 500; i++) {
        store.upsertLesson({
          id: `lesson-${i}`,
          content: `Content ${i}`,
          context: 'stress-test',
          confidence: 0.5 + (i % 5) * 0.1,
          createdAt: new Date().toISOString(),
          archived: i < 250 ? 1 : 0,
        });
      }
      const active = store.listLessons({ archived: false });
      const archived = store.listLessons({ archived: true });
      assert.ok(active.length > 0, 'Expected active lessons');
      assert.ok(archived.length > 0, 'Expected archived lessons');
    } finally {
      store.close();
    }
  });

  // ── 12. Rapid persist to disk under load ──────────────────────────────────
  await test('persist 200 writes to disk file without corruption', async () => {
    const tmpDir = createTempDir();
    const dbPath = path.join(tmpDir, 'stress.db');
    try {
      const store = await createStateStore({ dbPath });
      for (let i = 0; i < 200; i++) {
        store.upsertSession(makeSession({ id: `disk-${i}` }));
      }
      store.close();

      const store2 = await createStateStore({ dbPath });
      const { totalCount } = store2.listRecentSessions({ limit: 500 });
      store2.close();
      assert.strictEqual(totalCount, 200);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 13. Unicode and special chars in fields ────────────────────────────────
  await test('unicode emoji, CJK, RTL, and control chars stored correctly', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      const weirdStrings = [
        '🔥💡🚀 emoji',
        '中文日本語한국어',
        'مرحبا بالعالم',
        'Ёжик в тумане',
        'line\nbreak\ttab',
        '<script>alert(1)</script>',
        '"; DROP TABLE sessions; --',
        '\u200B\u200C\u200D zero-width chars',
      ];
      for (let i = 0; i < weirdStrings.length; i++) {
        store.upsertSession(makeSession({ id: `unicode-${i}`, repoRoot: weirdStrings[i] }));
      }
      const { totalCount } = store.listRecentSessions({ limit: 20 });
      assert.strictEqual(totalCount, weirdStrings.length);
    } finally {
      store.close();
    }
  });

  // ── 14. SQL injection via session fields ───────────────────────────────────
  await test('SQL injection attempts in repoRoot do not corrupt DB', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      const injections = [
        "'; DROP TABLE sessions; --",
        "' OR '1'='1",
        "1; DELETE FROM sessions WHERE 1=1; --",
        "UNION SELECT * FROM sqlite_master --",
      ];
      for (let i = 0; i < injections.length; i++) {
        store.upsertSession(makeSession({ id: `inject-${i}`, repoRoot: injections[i] }));
      }
      const { totalCount } = store.listRecentSessions({ limit: 10 });
      assert.strictEqual(totalCount, injections.length, 'All sessions stored safely');
    } finally {
      store.close();
    }
  });

  // ── 15. Parallel independent in-memory stores ─────────────────────────────
  await test('5 independent in-memory stores initialised in parallel', async () => {
    const stores = await Promise.all(
      Array.from({ length: 5 }, () => createStateStore({ dbPath: ':memory:' }))
    );
    try {
      await Promise.all(stores.map(async (store, idx) => {
        for (let i = 0; i < 50; i++) {
          store.upsertSession(makeSession({ id: `parallel-${idx}-${i}` }));
        }
        const { totalCount } = store.listRecentSessions({ limit: 100 });
        assert.strictEqual(totalCount, 50);
      }));
    } finally {
      stores.forEach(s => s.close());
    }
  });

  // ─── summary ────────────────────────────────────────────────────────────────
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  ✗ ${f.name}: ${f.error}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Unexpected runner error:', err);
  process.exit(1);
});
