/**
 * Tests for scripts/lib/session-manager.js
 *
 * Run with: node tests/lib/session-manager.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sessionManager = require('../../scripts/lib/session-manager');

// Test helper
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

// Create a temp directory for session tests
function createTempSessionDir() {
  const dir = path.join(os.tmpdir(), `ecc-test-sessions-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

function runTests() {
  console.log('\n=== Testing session-manager.js ===\n');

  let passed = 0;
  let failed = 0;

  // parseSessionFilename tests
  console.log('parseSessionFilename:');

  if (test('parses new format with short ID', () => {
    const result = sessionManager.parseSessionFilename('2026-02-01-a1b2c3d4-session.tmp');
    assert.ok(result);
    assert.strictEqual(result.shortId, 'a1b2c3d4');
    assert.strictEqual(result.date, '2026-02-01');
    assert.strictEqual(result.filename, '2026-02-01-a1b2c3d4-session.tmp');
  })) passed++; else failed++;

  if (test('parses old format without short ID', () => {
    const result = sessionManager.parseSessionFilename('2026-01-17-session.tmp');
    assert.ok(result);
    assert.strictEqual(result.shortId, 'no-id');
    assert.strictEqual(result.date, '2026-01-17');
  })) passed++; else failed++;

  if (test('returns null for invalid filename', () => {
    assert.strictEqual(sessionManager.parseSessionFilename('not-a-session.txt'), null);
    assert.strictEqual(sessionManager.parseSessionFilename(''), null);
    assert.strictEqual(sessionManager.parseSessionFilename('random.tmp'), null);
  })) passed++; else failed++;

  if (test('returns null for malformed date', () => {
    assert.strictEqual(sessionManager.parseSessionFilename('20260-01-17-session.tmp'), null);
    assert.strictEqual(sessionManager.parseSessionFilename('26-01-17-session.tmp'), null);
  })) passed++; else failed++;

  if (test('parses long short IDs (8+ chars)', () => {
    const result = sessionManager.parseSessionFilename('2026-02-01-abcdef12345678-session.tmp');
    assert.ok(result);
    assert.strictEqual(result.shortId, 'abcdef12345678');
  })) passed++; else failed++;

  if (test('rejects short IDs less than 8 chars', () => {
    const result = sessionManager.parseSessionFilename('2026-02-01-abc-session.tmp');
    assert.strictEqual(result, null);
  })) passed++; else failed++;

  // parseSessionMetadata tests
  console.log('\nparseSessionMetadata:');

  if (test('parses full session content', () => {
    const content = `# My Session Title

**Date:** 2026-02-01
**Started:** 10:30
**Last Updated:** 14:45

### Completed
- [x] Set up project
- [x] Write tests

### In Progress
- [ ] Fix bug

### Notes for Next Session
Remember to check the logs

### Context to Load
\`\`\`
src/main.ts
\`\`\``;
    const meta = sessionManager.parseSessionMetadata(content);
    assert.strictEqual(meta.title, 'My Session Title');
    assert.strictEqual(meta.date, '2026-02-01');
    assert.strictEqual(meta.started, '10:30');
    assert.strictEqual(meta.lastUpdated, '14:45');
    assert.strictEqual(meta.completed.length, 2);
    assert.strictEqual(meta.completed[0], 'Set up project');
    assert.strictEqual(meta.inProgress.length, 1);
    assert.strictEqual(meta.inProgress[0], 'Fix bug');
    assert.strictEqual(meta.notes, 'Remember to check the logs');
    assert.strictEqual(meta.context, 'src/main.ts');
  })) passed++; else failed++;

  if (test('handles null/undefined/empty content', () => {
    const meta1 = sessionManager.parseSessionMetadata(null);
    assert.strictEqual(meta1.title, null);
    assert.deepStrictEqual(meta1.completed, []);

    const meta2 = sessionManager.parseSessionMetadata(undefined);
    assert.strictEqual(meta2.title, null);

    const meta3 = sessionManager.parseSessionMetadata('');
    assert.strictEqual(meta3.title, null);
  })) passed++; else failed++;

  if (test('handles content with no sections', () => {
    const meta = sessionManager.parseSessionMetadata('Just some text');
    assert.strictEqual(meta.title, null);
    assert.deepStrictEqual(meta.completed, []);
    assert.deepStrictEqual(meta.inProgress, []);
  })) passed++; else failed++;

  // getSessionStats tests
  console.log('\ngetSessionStats:');

  if (test('calculates stats from content string', () => {
    const content = `# Test Session

### Completed
- [x] Task 1
- [x] Task 2

### In Progress
- [ ] Task 3
`;
    const stats = sessionManager.getSessionStats(content);
    assert.strictEqual(stats.totalItems, 3);
    assert.strictEqual(stats.completedItems, 2);
    assert.strictEqual(stats.inProgressItems, 1);
    assert.ok(stats.lineCount > 0);
  })) passed++; else failed++;

  if (test('handles empty content', () => {
    const stats = sessionManager.getSessionStats('');
    assert.strictEqual(stats.totalItems, 0);
    assert.strictEqual(stats.completedItems, 0);
    assert.strictEqual(stats.lineCount, 0);
  })) passed++; else failed++;

  if (test('does not treat non-absolute path as file path', () => {
    // This tests the bug fix: content that ends with .tmp but is not a path
    const stats = sessionManager.getSessionStats('Some content ending with test.tmp');
    assert.strictEqual(stats.totalItems, 0);
    assert.strictEqual(stats.lineCount, 1);
  })) passed++; else failed++;

  // File I/O tests
  console.log('\nSession CRUD:');

  if (test('writeSessionContent and getSessionContent round-trip', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, '2026-02-01-testid01-session.tmp');
      const content = '# Test Session\n\nHello world';

      const writeResult = sessionManager.writeSessionContent(sessionPath, content);
      assert.strictEqual(writeResult, true);

      const readContent = sessionManager.getSessionContent(sessionPath);
      assert.strictEqual(readContent, content);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('appendSessionContent appends to existing', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, '2026-02-01-testid02-session.tmp');
      sessionManager.writeSessionContent(sessionPath, 'Line 1\n');
      sessionManager.appendSessionContent(sessionPath, 'Line 2\n');

      const content = sessionManager.getSessionContent(sessionPath);
      assert.ok(content.includes('Line 1'));
      assert.ok(content.includes('Line 2'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('writeSessionContent returns false for invalid path', () => {
    const result = sessionManager.writeSessionContent('/nonexistent/deep/path/session.tmp', 'content');
    assert.strictEqual(result, false);
  })) passed++; else failed++;

  if (test('getSessionContent returns null for non-existent file', () => {
    const result = sessionManager.getSessionContent('/nonexistent/session.tmp');
    assert.strictEqual(result, null);
  })) passed++; else failed++;

  if (test('deleteSession removes file', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, 'test-session.tmp');
      fs.writeFileSync(sessionPath, 'content');
      assert.strictEqual(fs.existsSync(sessionPath), true);

      const result = sessionManager.deleteSession(sessionPath);
      assert.strictEqual(result, true);
      assert.strictEqual(fs.existsSync(sessionPath), false);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('deleteSession returns false for non-existent file', () => {
    const result = sessionManager.deleteSession('/nonexistent/session.tmp');
    assert.strictEqual(result, false);
  })) passed++; else failed++;

  if (test('sessionExists returns true for existing file', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, 'test.tmp');
      fs.writeFileSync(sessionPath, 'content');
      assert.strictEqual(sessionManager.sessionExists(sessionPath), true);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('sessionExists returns false for non-existent file', () => {
    assert.strictEqual(sessionManager.sessionExists('/nonexistent/path.tmp'), false);
  })) passed++; else failed++;

  if (test('sessionExists returns false for directory', () => {
    const dir = createTempSessionDir();
    try {
      assert.strictEqual(sessionManager.sessionExists(dir), false);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  // getSessionSize tests
  console.log('\ngetSessionSize:');

  if (test('returns human-readable size for existing file', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, 'sized.tmp');
      fs.writeFileSync(sessionPath, 'x'.repeat(2048));
      const size = sessionManager.getSessionSize(sessionPath);
      assert.ok(size.includes('KB'), `Expected KB, got: ${size}`);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('returns "0 B" for non-existent file', () => {
    const size = sessionManager.getSessionSize('/nonexistent/file.tmp');
    assert.strictEqual(size, '0 B');
  })) passed++; else failed++;

  if (test('returns bytes for small file', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, 'small.tmp');
      fs.writeFileSync(sessionPath, 'hi');
      const size = sessionManager.getSessionSize(sessionPath);
      assert.ok(size.includes('B'));
      assert.ok(!size.includes('KB'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  // getSessionTitle tests
  console.log('\ngetSessionTitle:');

  if (test('extracts title from session file', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, 'titled.tmp');
      fs.writeFileSync(sessionPath, '# My Great Session\n\nSome content');
      const title = sessionManager.getSessionTitle(sessionPath);
      assert.strictEqual(title, 'My Great Session');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('returns "Untitled Session" for empty content', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, 'empty.tmp');
      fs.writeFileSync(sessionPath, '');
      const title = sessionManager.getSessionTitle(sessionPath);
      assert.strictEqual(title, 'Untitled Session');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('returns "Untitled Session" for non-existent file', () => {
    const title = sessionManager.getSessionTitle('/nonexistent/file.tmp');
    assert.strictEqual(title, 'Untitled Session');
  })) passed++; else failed++;

  // getAllSessions tests
  console.log('\ngetAllSessions:');

  // Override HOME to a temp dir for isolated getAllSessions/getSessionById tests
  const tmpHome = path.join(os.tmpdir(), `ecc-session-mgr-test-${Date.now()}`);
  const tmpSessionsDir = path.join(tmpHome, '.claude', 'sessions');
  fs.mkdirSync(tmpSessionsDir, { recursive: true });
  const origHome = process.env.HOME;

  // Create test session files with controlled modification times
  const testSessions = [
    { name: '2026-01-15-abcd1234-session.tmp', content: '# Session 1' },
    { name: '2026-01-20-efgh5678-session.tmp', content: '# Session 2' },
    { name: '2026-02-01-ijkl9012-session.tmp', content: '# Session 3' },
    { name: '2026-02-01-mnop3456-session.tmp', content: '# Session 4' },
    { name: '2026-02-10-session.tmp', content: '# Old format session' },
  ];
  for (let i = 0; i < testSessions.length; i++) {
    const filePath = path.join(tmpSessionsDir, testSessions[i].name);
    fs.writeFileSync(filePath, testSessions[i].content);
    // Stagger modification times so sort order is deterministic
    const mtime = new Date(Date.now() - (testSessions.length - i) * 60000);
    fs.utimesSync(filePath, mtime, mtime);
  }

  process.env.HOME = tmpHome;

  if (test('getAllSessions returns all sessions', () => {
    const result = sessionManager.getAllSessions({ limit: 100 });
    assert.strictEqual(result.total, 5);
    assert.strictEqual(result.sessions.length, 5);
    assert.strictEqual(result.hasMore, false);
  })) passed++; else failed++;

  if (test('getAllSessions paginates correctly', () => {
    const page1 = sessionManager.getAllSessions({ limit: 2, offset: 0 });
    assert.strictEqual(page1.sessions.length, 2);
    assert.strictEqual(page1.hasMore, true);
    assert.strictEqual(page1.total, 5);

    const page2 = sessionManager.getAllSessions({ limit: 2, offset: 2 });
    assert.strictEqual(page2.sessions.length, 2);
    assert.strictEqual(page2.hasMore, true);

    const page3 = sessionManager.getAllSessions({ limit: 2, offset: 4 });
    assert.strictEqual(page3.sessions.length, 1);
    assert.strictEqual(page3.hasMore, false);
  })) passed++; else failed++;

  if (test('getAllSessions filters by date', () => {
    const result = sessionManager.getAllSessions({ date: '2026-02-01', limit: 100 });
    assert.strictEqual(result.total, 2);
    assert.ok(result.sessions.every(s => s.date === '2026-02-01'));
  })) passed++; else failed++;

  if (test('getAllSessions filters by search (short ID)', () => {
    const result = sessionManager.getAllSessions({ search: 'abcd', limit: 100 });
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.sessions[0].shortId, 'abcd1234');
  })) passed++; else failed++;

  if (test('getAllSessions returns sorted by newest first', () => {
    const result = sessionManager.getAllSessions({ limit: 100 });
    for (let i = 1; i < result.sessions.length; i++) {
      assert.ok(
        result.sessions[i - 1].modifiedTime >= result.sessions[i].modifiedTime,
        'Sessions should be sorted newest first'
      );
    }
  })) passed++; else failed++;

  if (test('getAllSessions handles offset beyond total', () => {
    const result = sessionManager.getAllSessions({ offset: 999, limit: 10 });
    assert.strictEqual(result.sessions.length, 0);
    assert.strictEqual(result.total, 5);
    assert.strictEqual(result.hasMore, false);
  })) passed++; else failed++;

  if (test('getAllSessions returns empty for non-existent date', () => {
    const result = sessionManager.getAllSessions({ date: '2099-12-31', limit: 100 });
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.sessions.length, 0);
  })) passed++; else failed++;

  if (test('getAllSessions ignores non-.tmp files', () => {
    fs.writeFileSync(path.join(tmpSessionsDir, 'notes.txt'), 'not a session');
    fs.writeFileSync(path.join(tmpSessionsDir, 'compaction-log.txt'), 'log');
    const result = sessionManager.getAllSessions({ limit: 100 });
    assert.strictEqual(result.total, 5, 'Should only count .tmp session files');
  })) passed++; else failed++;

  // getSessionById tests
  console.log('\ngetSessionById:');

  if (test('getSessionById finds by short ID prefix', () => {
    const result = sessionManager.getSessionById('abcd1234');
    assert.ok(result, 'Should find session by exact short ID');
    assert.strictEqual(result.shortId, 'abcd1234');
  })) passed++; else failed++;

  if (test('getSessionById finds by short ID prefix match', () => {
    const result = sessionManager.getSessionById('abcd');
    assert.ok(result, 'Should find session by short ID prefix');
    assert.strictEqual(result.shortId, 'abcd1234');
  })) passed++; else failed++;

  if (test('getSessionById finds by full filename', () => {
    const result = sessionManager.getSessionById('2026-01-15-abcd1234-session.tmp');
    assert.ok(result, 'Should find session by full filename');
    assert.strictEqual(result.shortId, 'abcd1234');
  })) passed++; else failed++;

  if (test('getSessionById finds by filename without .tmp', () => {
    const result = sessionManager.getSessionById('2026-01-15-abcd1234-session');
    assert.ok(result, 'Should find session by filename without extension');
  })) passed++; else failed++;

  if (test('getSessionById returns null for non-existent ID', () => {
    const result = sessionManager.getSessionById('zzzzzzzz');
    assert.strictEqual(result, null);
  })) passed++; else failed++;

  if (test('getSessionById includes content when requested', () => {
    const result = sessionManager.getSessionById('abcd1234', true);
    assert.ok(result, 'Should find session');
    assert.ok(result.content, 'Should include content');
    assert.ok(result.content.includes('Session 1'), 'Content should match');
  })) passed++; else failed++;

  if (test('getSessionById finds old format (no short ID)', () => {
    const result = sessionManager.getSessionById('2026-02-10-session');
    assert.ok(result, 'Should find old-format session by filename');
  })) passed++; else failed++;

  // Cleanup
  process.env.HOME = origHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }

  // Summary
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
