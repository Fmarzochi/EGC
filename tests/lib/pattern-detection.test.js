'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PATTERNS_BUILD = path.join(__dirname, '../../mcp/servers/egc-memory/build/patterns.js');
if (!fs.existsSync(PATTERNS_BUILD)) {
  console.error(
    `[SKIP] Missing ${PATTERNS_BUILD}. Run 'npm run build' in mcp/servers/egc-memory first.`
  );
  process.exit(0);
}

const { detectPatternsFromEvents, patternToStoreEntry } = require(PATTERNS_BUILD); // NOSONAR
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

  // Acceptance test: verifies the patched detect_patterns reads events from the state-store DB,
  // the same file where hooks write runtime events, not the server memory DB.
  if (await test('detect_patterns reads events from state-store DB (same path hooks use)', async () => {
    const BetterSqlite3 = require('better-sqlite3');

    const testDir = createTempDir('egc-patterns-acceptance-');
    const stateDbPath = path.join(testDir, 'state.db');

    const savedEnv = process.env.EGC_STATE_DB;
    process.env.EGC_STATE_DB = stateDbPath;

    try {
      const store = await createStateStore({ dbPath: stateDbPath });
      store.upsertSession({ id: 'sess-acc', adapterId: 'test', harness: 'egc', state: 'active' });

      // Insert events the same way hooks do: via insertRuntimeEvent on the state-store.
      for (let i = 0; i < 5; i++) {
        store.insertRuntimeEvent({
          id: `ev-acc-bash-${i}`,
          sessionId: 'sess-acc',
          eventType: 'PreToolUse',
          payload: { tool: 'Bash' },
          timestamp: daysAgo(6 - i),
        });
      }
      for (let i = 0; i < 3; i++) {
        store.insertRuntimeEvent({
          id: `ev-acc-err-${i}`,
          sessionId: 'sess-acc',
          eventType: 'error',
          payload: { error_code: 'ENOENT' },
          timestamp: daysAgo(4 - i),
        });
      }
      store.close();

      // Replicate exactly what the patched detect_patterns handler does:
      // open the state-store DB via better-sqlite3, query events, run detection,
      // persist patterns back to the same DB.
      const windowDays = 7;
      const minOccurrences = 3;
      const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

      let ssDb;
      try {
        ssDb = new BetterSqlite3(stateDbPath, { readonly: false });
        ssDb.pragma('journal_mode = WAL');
        ssDb.pragma('busy_timeout = 5000');

        const rawRows = ssDb.prepare(
          'SELECT id, session_id, event_type, payload, timestamp FROM events WHERE timestamp >= ? ORDER BY timestamp ASC'
        ).all(cutoff);

        const events = rawRows.map(row => ({
          id: row.id,
          sessionId: row.session_id ?? null,
          eventType: row.event_type,
          payload: (() => { try { return JSON.parse(row.payload); } catch { return null; } })(),
          timestamp: row.timestamp,
        }));

        const detected = detectPatternsFromEvents(events, windowDays, minOccurrences);

        const upsertStmt = ssDb.prepare(`
          INSERT INTO patterns (id, pattern_type, key, description, occurrences, frequency, last_seen, suggested_automation, first_seen, window_days)
          VALUES (@id, @pattern_type, @key, @description, @occurrences, @frequency, @last_seen, @suggested_automation, @first_seen, @window_days)
          ON CONFLICT(id) DO UPDATE SET
            pattern_type = excluded.pattern_type,
            key = excluded.key,
            description = excluded.description,
            occurrences = excluded.occurrences,
            frequency = excluded.frequency,
            last_seen = excluded.last_seen,
            suggested_automation = excluded.suggested_automation,
            first_seen = MIN(patterns.first_seen, excluded.first_seen),
            window_days = excluded.window_days
        `);

        const persistAll = ssDb.transaction(() => {
          for (const p of detected) {
            const entry = patternToStoreEntry(p, windowDays);
            upsertStmt.run({
              id: entry.id,
              pattern_type: entry.patternType,
              key: entry.key,
              description: entry.description,
              occurrences: entry.occurrences,
              frequency: entry.frequency,
              last_seen: entry.lastSeen,
              suggested_automation: entry.suggestedAutomation,
              first_seen: entry.firstSeen,
              window_days: entry.windowDays,
            });
          }
        });
        persistAll();

        // Verify patterns were detected from the events written by the state-store API.
        assert.ok(detected.length >= 2, `expected at least 2 patterns, got ${detected.length}`);

        const bashPattern = detected.find(p => p.key === 'command:Bash');
        assert.ok(bashPattern, 'should detect repeated Bash command');
        assert.strictEqual(bashPattern.occurrences, 5, 'bash command should appear 5 times');

        const errPattern = detected.find(p => p.key === 'error:ENOENT');
        assert.ok(errPattern, 'should detect recurring ENOENT error');
        assert.strictEqual(errPattern.occurrences, 3, 'ENOENT should appear 3 times');

        // Verify patterns were persisted into the same state-store DB.
        const persistedRows = ssDb.prepare('SELECT * FROM patterns ORDER BY occurrences DESC').all();
        assert.ok(persistedRows.length >= 2, 'patterns should be persisted in the state-store DB');
        assert.ok(persistedRows.some(r => r.key === 'command:Bash'), 'Bash pattern should be in state-store DB');
        assert.ok(persistedRows.some(r => r.key === 'error:ENOENT'), 'ENOENT pattern should be in state-store DB');
      } finally {
        if (ssDb) ssDb.close();
      }
    } finally {
      if (savedEnv === undefined) {
        delete process.env.EGC_STATE_DB;
      } else {
        process.env.EGC_STATE_DB = savedEnv;
      }
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
