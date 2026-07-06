'use strict';

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
  const rand = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  return `${Date.now()}-${rand}`;
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
      assert.ok(detail, 'Session detail should be retrievable');
    } finally {
      store.close();
    }
  });

  // ── 3. Repeated open/close cycles (memory leak probe) ─────────────────────
  await test('100 open/close cycles on the same file do not leak', async () => {
    const tmpDir = createTempDir();
    const dbPath = path.join(tmpDir, 'state.db');
    try {
      // Force GC before measurement if available (run with --expose-gc to stabilize)
      if (global.gc) global.gc();
      const memBefore = process.memoryUsage().heapUsed;
      for (let i = 0; i < 100; i++) {
        const store = await createStateStore({ dbPath });
        store.upsertSession(makeSession({ id: `cycle-${i}` }));
        store.close();
      }
      if (global.gc) global.gc();
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
      assert.ok(sessions[0], 'expected session at index 0');
      assert.ok(sessions[0].snapshot, 'expected snapshot on session');
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
      assert.ok(sessions[0], 'expected session at index 0');
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
      assert.ok(sessions[0], 'expected session at index 0');
      assert.strictEqual(sessions[0].id, longId);
    } finally {
      store.close();
    }
  });

  // ── 7. FK violation is actually enforced ───────────────────────────────────
  await test('failed FK insert raises an error and leaves DB in consistent state', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      store.upsertSession(makeSession({ id: 'before-bad-tx' }));

      let fkThrew = false;
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
      } catch (_) {
        fkThrew = true;
      }

      // FK enforcement must have triggered a throw
      assert.ok(fkThrew, 'insertSkillRun with non-existent sessionId must throw (FK enforcement)');

      // DB is still usable and the original session is intact
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
        const count = result && result.sessions ? result.sessions.length : 0;
        assert.ok(count === 0, 'limit:0 should not return all rows');
      }
    } finally {
      store.close();
    }
  });

  // ── 10. Instincts high-volume with confidence boundary values ─────────────
  await test('insert 500 instincts and verify total count', async () => {
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
      // listInstincts is paginated by confidence DESC — validate via totalCount
      const { instincts, totalCount } = store.listInstincts({ projectId: 'stress-proj' });
      assert.ok(Array.isArray(instincts), 'instincts should be an array');
      assert.strictEqual(totalCount, 500, `Expected 500 instincts, got ${totalCount}`);
    } finally {
      store.close();
    }
  });

  // ── 11. Lessons: upsert and verify active vs archived via getLessonById ───
  await test('archive flag is persisted correctly and readable via getLessonById', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      store.upsertLesson({
        id: 'active-lesson',
        content: 'Active content',
        context: 'stress-test',
        confidence: 0.8,
        createdAt: new Date().toISOString(),
        archived: 0,
      });
      store.upsertLesson({
        id: 'archived-lesson',
        content: 'Archived content',
        context: 'stress-test',
        confidence: 0.3,
        createdAt: new Date().toISOString(),
        archived: 1,
      });

      const active = store.getLessonById('active-lesson');
      const archived = store.getLessonById('archived-lesson');

      assert.ok(active, 'Active lesson should exist');
      assert.strictEqual(active.archived, 0, 'Active lesson archived flag should be 0');

      assert.ok(archived, 'Archived lesson should exist');
      assert.strictEqual(archived.archived, 1, 'Archived lesson archived flag should be 1');
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

  // ── 13. Unicode round-trip: verify actual stored values ───────────────────
  await test('unicode CJK, RTL, and special chars are stored and retrieved correctly', async () => {
    const store = await createStateStore({ dbPath: ':memory:' });
    try {
      const weirdStrings = [
        'éñü latin-extended',
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
      const { sessions, totalCount } = store.listRecentSessions({ limit: 20 });
      assert.strictEqual(totalCount, weirdStrings.length);
      // Verify each value round-tripped correctly
      for (let i = 0; i < weirdStrings.length; i++) {
        const row = sessions.find(s => s.id === `unicode-${i}`);
        assert.ok(row, `Session unicode-${i} should exist`);
        assert.strictEqual(row.repoRoot, weirdStrings[i], `repoRoot mismatch for unicode-${i}`);
      }
    } finally {
      store.close();
    }
  });

  // ── 14. SQL injection round-trip: verify fields are stored literally ───────
  await test('SQL injection strings in repoRoot are stored literally without corruption', async () => {
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
      const { sessions, totalCount } = store.listRecentSessions({ limit: 10 });
      assert.strictEqual(totalCount, injections.length, 'All sessions must be stored');
      // Verify each injection string round-tripped literally (not executed)
      for (let i = 0; i < injections.length; i++) {
        const row = sessions.find(s => s.id === `inject-${i}`);
        assert.ok(row, `Session inject-${i} should exist`);
        assert.strictEqual(row.repoRoot, injections[i], `repoRoot mismatch for inject-${i}`);
      }
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
