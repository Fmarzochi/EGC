'use strict';

/**
 * Tests for the lessons confidence decay feature.
 * Covers: lesson_save, lesson_recall, lesson_reinforce, decay sweep, archival.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createStateStore,
} = require('../../scripts/lib/state-store');

const {
  REINFORCE_DELTA,
  DECAY_DELTA_PER_WEEK,
  DECAY_GRACE_DAYS,
  ARCHIVE_THRESHOLD,
} = require('../../scripts/lib/state-store/queries');

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    if (error.stack) {
      console.log(`    ${error.stack.split('\n').slice(1, 3).join('\n    ')}`);
    }
    return false;
  }
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

async function runUpsertTests(counter) {
  if (await test('upsertLesson stores and returns a lesson with defaults', async () => {
    const testDir = createTempDir('egc-lessons-basic-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const lesson = store.upsertLesson({
        id: 'lesson-1',
        content: 'Always run lint before commit',
        context: 'git workflow',
        confidence: 0.8,
      });
      store.close();

      assert.strictEqual(lesson.id, 'lesson-1');
      assert.strictEqual(lesson.content, 'Always run lint before commit');
      assert.strictEqual(lesson.context, 'git workflow');
      assert.strictEqual(lesson.confidence, 0.8);
      assert.strictEqual(lesson.lastReinforced, null);
      assert.strictEqual(lesson.lastRecalled, null);
      assert.strictEqual(lesson.tags, null);
      assert.strictEqual(lesson.archived, 0);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('upsertLesson clamps confidence to [0, 1]', async () => {
    const testDir = createTempDir('egc-lessons-clamp-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const high = store.upsertLesson({ id: 'l-high', content: 'x', context: 'c', confidence: 1.5 });
      const low = store.upsertLesson({ id: 'l-low', content: 'x', context: 'c', confidence: -0.3 });
      store.close();

      assert.strictEqual(high.confidence, 1);
      assert.strictEqual(low.confidence, 0);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('upsertLesson defaults confidence to 0.7', async () => {
    const testDir = createTempDir('egc-lessons-default-conf-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const lesson = store.upsertLesson({ id: 'l-def', content: 'x', context: 'c' });
      store.close();

      assert.strictEqual(lesson.confidence, 0.7);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('upsertLesson supports tags', async () => {
    const testDir = createTempDir('egc-lessons-tags-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const lesson = store.upsertLesson({
        id: 'l-tags',
        content: 'Use signed commits',
        context: 'git',
        tags: 'security,git,dco',
      });
      store.close();

      assert.strictEqual(lesson.tags, 'security,git,dco');
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('getLessonById returns null for unknown id', async () => {
    const testDir = createTempDir('egc-lessons-getbyid-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const result = store.getLessonById('no-such-lesson');
      store.close();

      assert.strictEqual(result, null);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('listLessons returns lessons above min_confidence, sorted by score', async () => {
    const testDir = createTempDir('egc-lessons-list-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      store.upsertLesson({ id: 'l-a', content: 'A', context: 'c', confidence: 0.9 });
      store.upsertLesson({ id: 'l-b', content: 'B', context: 'c', confidence: 0.5 });
      store.upsertLesson({ id: 'l-c', content: 'C', context: 'c', confidence: 0.1 });
      const results = store.listLessons({ minConfidence: 0.2, limit: 10 });
      store.close();

      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].id, 'l-a');
      assert.strictEqual(results[1].id, 'l-b');
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('listLessons excludes archived lessons', async () => {
    const testDir = createTempDir('egc-lessons-archived-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      store.upsertLesson({ id: 'l-active', content: 'active', context: 'c', confidence: 0.8 });
      store.upsertLesson({ id: 'l-arch', content: 'archived', context: 'c', confidence: 0.8, archived: 1 });
      const results = store.listLessons({ minConfidence: 0.0, limit: 10 });
      store.close();

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].id, 'l-active');
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('upsertLesson update preserves createdAt', async () => {
    const testDir = createTempDir('egc-lessons-update-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const originalDate = '2026-01-15T10:00:00.000Z';
      store.upsertLesson({ id: 'l-upd', content: 'v1', context: 'c', createdAt: originalDate });
      const updated = store.upsertLesson({ id: 'l-upd', content: 'v2', context: 'c', confidence: 0.9, createdAt: originalDate });
      store.close();

      assert.strictEqual(updated.content, 'v2');
      assert.strictEqual(updated.confidence, 0.9);
      assert.strictEqual(updated.createdAt, originalDate);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;
}

async function runReinforceTests(counter) {
  if (await test('reinforceLesson increases confidence by REINFORCE_DELTA, capped at 1', async () => {
    const testDir = createTempDir('egc-lessons-reinforce-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      store.upsertLesson({ id: 'l-r', content: 'x', context: 'c', confidence: 0.7 });
      const reinforced = store.reinforceLesson('l-r');
      store.close();

      assert.ok(reinforced !== null);
      assert.ok(Math.abs(reinforced.confidence - (0.7 + REINFORCE_DELTA)) < 0.0001);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('reinforceLesson caps confidence at 1.0', async () => {
    const testDir = createTempDir('egc-lessons-reinforce-cap-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      store.upsertLesson({ id: 'l-cap', content: 'x', context: 'c', confidence: 0.95 });
      const reinforced = store.reinforceLesson('l-cap');
      store.close();

      assert.strictEqual(reinforced.confidence, 1.0);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('reinforceLesson sets last_reinforced timestamp', async () => {
    const testDir = createTempDir('egc-lessons-reinforce-ts-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      store.upsertLesson({ id: 'l-ts', content: 'x', context: 'c', confidence: 0.5 });
      const reinforced = store.reinforceLesson('l-ts', '2026-06-13T12:00:00.000Z');
      store.close();

      assert.strictEqual(reinforced.lastReinforced, '2026-06-13T12:00:00.000Z');
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('reinforceLesson unarchives a previously archived lesson', async () => {
    const testDir = createTempDir('egc-lessons-reinforce-unarch-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      store.upsertLesson({ id: 'l-arch2', content: 'x', context: 'c', confidence: 0.1, archived: 1 });
      const reinforced = store.reinforceLesson('l-arch2');
      store.close();

      assert.strictEqual(reinforced.archived, 0);
      assert.ok(reinforced.confidence > 0.1);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('reinforceLesson returns null for unknown id', async () => {
    const testDir = createTempDir('egc-lessons-reinforce-null-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const result = store.reinforceLesson('no-such-id');
      store.close();

      assert.strictEqual(result, null);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;
}

async function runDecayTests(counter) {
  if (await test('applyDecaySweep does not decay lessons within the grace period', async () => {
    const testDir = createTempDir('egc-lessons-decay-grace-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const recentDate = daysAgo(10);
      store.upsertLesson({
        id: 'l-grace',
        content: 'x',
        context: 'c',
        confidence: 0.8,
        lastRecalled: recentDate,
        createdAt: recentDate,
      });
      const affected = store.applyDecaySweep(new Date().toISOString());
      const after = store.getLessonById('l-grace');
      store.close();

      assert.strictEqual(affected, 0);
      assert.strictEqual(after.confidence, 0.8);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('applyDecaySweep decays lessons past the grace period by DECAY_DELTA_PER_WEEK per week', async () => {
    const testDir = createTempDir('egc-lessons-decay-weeks-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const oldDate = daysAgo(DECAY_GRACE_DAYS + 14);
      store.upsertLesson({
        id: 'l-stale',
        content: 'x',
        context: 'c',
        confidence: 0.8,
        lastRecalled: oldDate,
        createdAt: oldDate,
      });
      store.applyDecaySweep(new Date().toISOString());
      const after = store.getLessonById('l-stale');
      store.close();

      const expectedDecay = 2 * DECAY_DELTA_PER_WEEK;
      assert.ok(Math.abs(after.confidence - (0.8 - expectedDecay)) < 0.001, `expected ${0.8 - expectedDecay} got ${after.confidence}`);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('applyDecaySweep archives lessons that drop below ARCHIVE_THRESHOLD', async () => {
    const testDir = createTempDir('egc-lessons-decay-archive-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const weeksNeeded = Math.ceil((0.25 - ARCHIVE_THRESHOLD) / DECAY_DELTA_PER_WEEK) + 1;
      const daysNeeded = DECAY_GRACE_DAYS + weeksNeeded * 7;
      const oldDate = daysAgo(daysNeeded);
      store.upsertLesson({
        id: 'l-fade',
        content: 'x',
        context: 'c',
        confidence: 0.25,
        createdAt: oldDate,
        lastRecalled: oldDate,
      });
      store.applyDecaySweep(new Date().toISOString());
      const after = store.getLessonById('l-fade');
      store.close();

      assert.strictEqual(after.archived, 1, `expected archived=1 but got archived=${after.archived}, confidence=${after.confidence}`);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('applyDecaySweep uses createdAt when lastRecalled is null', async () => {
    const testDir = createTempDir('egc-lessons-decay-created-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const oldDate = daysAgo(DECAY_GRACE_DAYS + 7);
      store.upsertLesson({
        id: 'l-norecall',
        content: 'x',
        context: 'c',
        confidence: 0.8,
        createdAt: oldDate,
      });
      const affected = store.applyDecaySweep(new Date().toISOString());
      const after = store.getLessonById('l-norecall');
      store.close();

      assert.strictEqual(affected, 1);
      assert.ok(after.confidence < 0.8, `confidence should have decayed, got ${after.confidence}`);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('applyDecaySweep skips already archived lessons', async () => {
    const testDir = createTempDir('egc-lessons-decay-skip-archived-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const oldDate = daysAgo(DECAY_GRACE_DAYS + 21);
      store.upsertLesson({
        id: 'l-already-arch',
        content: 'x',
        context: 'c',
        confidence: 0.1,
        createdAt: oldDate,
        archived: 1,
      });
      const affected = store.applyDecaySweep(new Date().toISOString());
      store.close();

      assert.strictEqual(affected, 0);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('applyDecaySweep returns count of affected lessons', async () => {
    const testDir = createTempDir('egc-lessons-decay-count-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const oldDate = daysAgo(DECAY_GRACE_DAYS + 8);
      const recentDate = daysAgo(5);
      store.upsertLesson({ id: 'l-old1', content: 'x', context: 'c', confidence: 0.9, createdAt: oldDate, lastRecalled: oldDate });
      store.upsertLesson({ id: 'l-old2', content: 'x', context: 'c', confidence: 0.7, createdAt: oldDate, lastRecalled: oldDate });
      store.upsertLesson({ id: 'l-new', content: 'x', context: 'c', confidence: 0.8, createdAt: recentDate, lastRecalled: recentDate });
      const affected = store.applyDecaySweep(new Date().toISOString());
      store.close();

      assert.strictEqual(affected, 2);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('applyDecaySweep with controlled now timestamp decays correctly', async () => {
    const testDir = createTempDir('egc-lessons-decay-controlled-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const baseDate = '2026-01-01T00:00:00.000Z';
      store.upsertLesson({
        id: 'l-ctrl',
        content: 'x',
        context: 'c',
        confidence: 0.7,
        createdAt: baseDate,
        lastRecalled: baseDate,
      });

      const gracePlusThreeWeeks = new Date(new Date(baseDate).getTime() + (DECAY_GRACE_DAYS + 21) * 24 * 60 * 60 * 1000).toISOString();
      store.applyDecaySweep(gracePlusThreeWeeks);
      const after = store.getLessonById('l-ctrl');
      store.close();

      const expectedConfidence = 0.7 - 3 * DECAY_DELTA_PER_WEEK;
      assert.ok(Math.abs(after.confidence - expectedConfidence) < 0.001, `expected ${expectedConfidence} got ${after.confidence}`);
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;

  if (await test('listLessons does not return lessons archived by decay', async () => {
    const testDir = createTempDir('egc-lessons-list-after-decay-');
    const dbPath = path.join(testDir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      const weeksNeeded = Math.ceil((0.22 - ARCHIVE_THRESHOLD) / DECAY_DELTA_PER_WEEK) + 1;
      const oldDate = daysAgo(DECAY_GRACE_DAYS + weeksNeeded * 7);
      store.upsertLesson({ id: 'l-will-fade', content: 'forgotten pattern', context: 'c', confidence: 0.22, createdAt: oldDate, lastRecalled: oldDate });
      store.upsertLesson({ id: 'l-stays', content: 'active pattern', context: 'c', confidence: 0.9 });
      store.applyDecaySweep(new Date().toISOString());
      const results = store.listLessons({ minConfidence: 0.0, limit: 10 });
      store.close();

      const ids = results.map(r => r.id);
      assert.ok(!ids.includes('l-will-fade'), `l-will-fade should be archived and excluded`);
      assert.ok(ids.includes('l-stays'));
    } finally {
      cleanupTempDir(testDir);
    }
  })) counter.passed += 1; else counter.failed += 1;
}

async function runTests() {
  const counter = { passed: 0, failed: 0 };

  await runUpsertTests(counter);
  await runReinforceTests(counter);
  await runDecayTests(counter);

  console.log(`\nResults: Passed: ${counter.passed}, Failed: ${counter.failed}`);
  process.exit(counter.failed > 0 ? 1 : 0);
}

runTests();
