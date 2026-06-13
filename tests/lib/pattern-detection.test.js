'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectPatternsFromEvents } = require('../../mcp/servers/egc-memory/build/patterns.js');
const { createStateStore } = require('../../scripts/lib/state-store');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

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

function makeEvent(id, eventType, payload, timestamp) {
  return {
    id,
    sessionId: 'session-test',
    eventType,
    payload,
    timestamp: timestamp || new Date().toISOString(),
  };
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

async function runTests() {
  console.log('\n=== Testing pattern-detection ===\n');

  let passed = 0;
  let failed = 0;

  if (await test('detects repeated_command when a command appears above min_occurrences', async () => {
    const events = [
      makeEvent('e1', 'PreToolUse', { tool: 'Bash' }, daysAgo(6)),
      makeEvent('e2', 'PreToolUse', { tool: 'Bash' }, daysAgo(5)),
      makeEvent('e3', 'PreToolUse', { tool: 'Bash' }, daysAgo(4)),
      makeEvent('e4', 'PreToolUse', { tool: 'Bash' }, daysAgo(3)),
    ];

    const patterns = detectPatternsFromEvents(events, 7, 3);
    const cmd = patterns.find(p => p.type === 'repeated_command' && p.key === 'command:Bash');

    assert.ok(cmd, 'should detect repeated Bash command');
    assert.strictEqual(cmd.occurrences, 4);
    assert.ok(typeof cmd.suggestion === 'string' && cmd.suggestion.length > 0, 'should have a suggestion');
    assert.ok(cmd.frequency > 0, 'should have positive frequency');
  })) passed += 1; else failed += 1;

  if (await test('does not report commands below min_occurrences', async () => {
    const events = [
      makeEvent('e1', 'PreToolUse', { tool: 'Read' }, daysAgo(3)),
      makeEvent('e2', 'PreToolUse', { tool: 'Read' }, daysAgo(2)),
    ];

    const patterns = detectPatternsFromEvents(events, 7, 3);
    const cmd = patterns.find(p => p.key === 'command:Read');
    assert.ok(!cmd, 'should not surface command with only 2 occurrences when min is 3');
  })) passed += 1; else failed += 1;

  if (await test('detects recurring_error from error eventType with errorCode', async () => {
    const events = [
      makeEvent('e1', 'error', { error_code: 'TS2345', message: 'argument type mismatch' }, daysAgo(5)),
      makeEvent('e2', 'error', { error_code: 'TS2345', message: 'argument type mismatch' }, daysAgo(4)),
      makeEvent('e3', 'error', { error_code: 'TS2345', message: 'argument type mismatch' }, daysAgo(2)),
    ];

    const patterns = detectPatternsFromEvents(events, 7, 3);
    const err = patterns.find(p => p.type === 'recurring_error' && p.key === 'error:TS2345');

    assert.ok(err, 'should detect recurring TS2345 error');
    assert.strictEqual(err.occurrences, 3);
    assert.ok(err.suggestion.includes('TS2345'), 'suggestion should reference the error code');
  })) passed += 1; else failed += 1;

  if (await test('detects recurring_error from TS code in error message string', async () => {
    const events = [
      makeEvent('e1', 'ToolError', { message: 'Type error TS2322: string not assignable to number' }, daysAgo(6)),
      makeEvent('e2', 'ToolError', { message: 'Type error TS2322: string not assignable to number' }, daysAgo(4)),
      makeEvent('e3', 'ToolError', { message: 'Type error TS2322 appeared again' }, daysAgo(2)),
    ];

    const patterns = detectPatternsFromEvents(events, 7, 3);
    const err = patterns.find(p => p.type === 'recurring_error' && p.key === 'error:TS2322');

    assert.ok(err, 'should detect TS2322 from message text');
    assert.strictEqual(err.occurrences, 3);
  })) passed += 1; else failed += 1;

  if (await test('does not report errors below min_occurrences threshold', async () => {
    const events = [
      makeEvent('e1', 'error', { error_code: 'ENOENT' }, daysAgo(3)),
      makeEvent('e2', 'error', { error_code: 'ENOENT' }, daysAgo(1)),
    ];

    const patterns = detectPatternsFromEvents(events, 7, 3);
    const err = patterns.find(p => p.key === 'error:ENOENT');
    assert.ok(!err, 'should not surface error with only 2 occurrences when min is 3');
  })) passed += 1; else failed += 1;

  if (await test('returns empty array when no events are provided', async () => {
    const patterns = detectPatternsFromEvents([], 7, 3);
    assert.deepStrictEqual(patterns, []);
  })) passed += 1; else failed += 1;

  if (await test('returns empty array when all events are below min_occurrences', async () => {
    const events = [
      makeEvent('e1', 'PreToolUse', { tool: 'Edit' }, daysAgo(3)),
      makeEvent('e2', 'PreToolUse', { tool: 'Write' }, daysAgo(2)),
    ];

    const patterns = detectPatternsFromEvents(events, 7, 5);
    assert.deepStrictEqual(patterns, []);
  })) passed += 1; else failed += 1;

  if (await test('orders patterns by occurrences descending', async () => {
    const events = [
      makeEvent('e1', 'PreToolUse', { tool: 'Bash' }, daysAgo(6)),
      makeEvent('e2', 'PreToolUse', { tool: 'Bash' }, daysAgo(5)),
      makeEvent('e3', 'PreToolUse', { tool: 'Bash' }, daysAgo(4)),
      makeEvent('e4', 'PreToolUse', { tool: 'Bash' }, daysAgo(3)),
      makeEvent('e5', 'PreToolUse', { tool: 'Read' }, daysAgo(2)),
      makeEvent('e6', 'PreToolUse', { tool: 'Read' }, daysAgo(1)),
      makeEvent('e7', 'PreToolUse', { tool: 'Read' }, daysAgo(0)),
    ];

    const patterns = detectPatternsFromEvents(events, 7, 3);
    assert.strictEqual(patterns[0].key, 'command:Bash', 'highest count should come first');
    assert.strictEqual(patterns[0].occurrences, 4);
    assert.strictEqual(patterns[1].occurrences, 3);
  })) passed += 1; else failed += 1;

  if (await test('records firstSeen and lastSeen timestamps correctly', async () => {
    const t1 = daysAgo(6);
    const t2 = daysAgo(3);
    const t3 = daysAgo(1);
    const events = [
      makeEvent('e1', 'PreToolUse', { tool: 'Bash' }, t1),
      makeEvent('e2', 'PreToolUse', { tool: 'Bash' }, t2),
      makeEvent('e3', 'PreToolUse', { tool: 'Bash' }, t3),
    ];

    const patterns = detectPatternsFromEvents(events, 7, 3);
    const p = patterns.find(x => x.key === 'command:Bash');

    assert.ok(p, 'pattern should exist');
    assert.strictEqual(p.firstSeen, t1, 'firstSeen should be the earliest timestamp');
    assert.strictEqual(p.lastSeen, t3, 'lastSeen should be the latest timestamp');
  })) passed += 1; else failed += 1;

  if (await test('patterns table is created by migration 3 and upsertPattern persists data', async () => {
    const testDir = createTempDir('egc-patterns-store-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      const store = await createStateStore({ dbPath });
      const migrations = store.getAppliedMigrations();

      assert.ok(migrations.length >= 3, 'should have at least 3 migrations applied');
      assert.ok(migrations.some(m => m.version === 3), 'migration version 3 should be present');

      store.upsertPattern({
        id: 'pat-test-1',
        patternType: 'repeated_command',
        key: 'command:npm',
        description: 'npm invoked 5 times',
        occurrences: 5,
        frequency: 0.71,
        lastSeen: new Date().toISOString(),
        suggestedAutomation: null,
        firstSeen: daysAgo(6),
        windowDays: 7,
      });

      const patterns = store.listPatterns({ limit: 10 });
      store.close();

      assert.strictEqual(patterns.length, 1);
      assert.strictEqual(patterns[0].key, 'command:npm');
      assert.strictEqual(patterns[0].occurrences, 5);
      assert.strictEqual(patterns[0].patternType, 'repeated_command');
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('listEventsInWindow returns only events at or after the cutoff', async () => {
    const testDir = createTempDir('egc-patterns-window-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      const store = await createStateStore({ dbPath });

      store.upsertSession({ id: 'sess-w', adapterId: 'test', harness: 'egc', state: 'active' });

      store.insertRuntimeEvent({ id: 'ev-old', sessionId: 'sess-w', eventType: 'PreToolUse', payload: { tool: 'Edit' }, timestamp: daysAgo(10) });
      store.insertRuntimeEvent({ id: 'ev-new', sessionId: 'sess-w', eventType: 'PreToolUse', payload: { tool: 'Bash' }, timestamp: daysAgo(3) });

      const cutoff = daysAgo(7);
      const events = store.listEventsInWindow(cutoff);
      store.close();

      assert.strictEqual(events.length, 1, 'only the recent event should be in the window');
      assert.strictEqual(events[0].id, 'ev-new');
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
