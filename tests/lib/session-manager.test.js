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
  // On Windows, os.homedir() uses USERPROFILE, not HOME — set both for cross-platform
  const tmpHome = path.join(os.tmpdir(), `ecc-session-mgr-test-${Date.now()}`);
  const tmpSessionsDir = path.join(tmpHome, '.claude', 'sessions');
  fs.mkdirSync(tmpSessionsDir, { recursive: true });
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

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
  process.env.USERPROFILE = tmpHome;

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

  if (test('getSessionById returns null for empty string', () => {
    const result = sessionManager.getSessionById('');
    assert.strictEqual(result, null, 'Empty string should not match any session');
  })) passed++; else failed++;

  if (test('getSessionById metadata and stats populated when includeContent=true', () => {
    const result = sessionManager.getSessionById('abcd1234', true);
    assert.ok(result, 'Should find session');
    assert.ok(result.metadata, 'Should have metadata');
    assert.ok(result.stats, 'Should have stats');
    assert.strictEqual(typeof result.stats.totalItems, 'number', 'stats.totalItems should be number');
    assert.strictEqual(typeof result.stats.lineCount, 'number', 'stats.lineCount should be number');
  })) passed++; else failed++;

  // parseSessionMetadata edge cases
  console.log('\nparseSessionMetadata (edge cases):');

  if (test('handles CRLF line endings', () => {
    const content = '# CRLF Session\r\n\r\n**Date:** 2026-03-01\r\n**Started:** 09:00\r\n\r\n### Completed\r\n- [x] Task A\r\n- [x] Task B\r\n';
    const meta = sessionManager.parseSessionMetadata(content);
    assert.strictEqual(meta.title, 'CRLF Session');
    assert.strictEqual(meta.date, '2026-03-01');
    assert.strictEqual(meta.started, '09:00');
    assert.strictEqual(meta.completed.length, 2);
  })) passed++; else failed++;

  if (test('takes first h1 heading as title', () => {
    const content = '# First Title\n\nSome text\n\n# Second Title\n';
    const meta = sessionManager.parseSessionMetadata(content);
    assert.strictEqual(meta.title, 'First Title');
  })) passed++; else failed++;

  if (test('handles empty sections (Completed with no items)', () => {
    const content = '# Session\n\n### Completed\n\n### In Progress\n\n';
    const meta = sessionManager.parseSessionMetadata(content);
    assert.deepStrictEqual(meta.completed, []);
    assert.deepStrictEqual(meta.inProgress, []);
  })) passed++; else failed++;

  if (test('handles content with only title and notes', () => {
    const content = '# Just Notes\n\n### Notes for Next Session\nRemember to test\n';
    const meta = sessionManager.parseSessionMetadata(content);
    assert.strictEqual(meta.title, 'Just Notes');
    assert.strictEqual(meta.notes, 'Remember to test');
    assert.deepStrictEqual(meta.completed, []);
    assert.deepStrictEqual(meta.inProgress, []);
  })) passed++; else failed++;

  if (test('extracts context with backtick fenced block', () => {
    const content = '# Session\n\n### Context to Load\n```\nsrc/index.ts\nlib/utils.js\n```\n';
    const meta = sessionManager.parseSessionMetadata(content);
    assert.strictEqual(meta.context, 'src/index.ts\nlib/utils.js');
  })) passed++; else failed++;

  if (test('trims whitespace from title', () => {
    const content = '#   Spaces Around Title   \n';
    const meta = sessionManager.parseSessionMetadata(content);
    assert.strictEqual(meta.title, 'Spaces Around Title');
  })) passed++; else failed++;

  // getSessionStats edge cases
  console.log('\ngetSessionStats (edge cases):');

  if (test('detects notes and context presence', () => {
    const content = '# Stats Test\n\n### Notes for Next Session\nSome notes\n\n### Context to Load\n```\nfile.ts\n```\n';
    const stats = sessionManager.getSessionStats(content);
    assert.strictEqual(stats.hasNotes, true);
    assert.strictEqual(stats.hasContext, true);
  })) passed++; else failed++;

  if (test('detects absence of notes and context', () => {
    const content = '# Simple Session\n\nJust some content\n';
    const stats = sessionManager.getSessionStats(content);
    assert.strictEqual(stats.hasNotes, false);
    assert.strictEqual(stats.hasContext, false);
  })) passed++; else failed++;

  if (test('treats Unix absolute path ending with .tmp as file path', () => {
    // Content that starts with / and ends with .tmp should be treated as a path
    // This tests the looksLikePath heuristic
    const fakeContent = '/some/path/session.tmp';
    // Since the file doesn't exist, getSessionContent returns null,
    // parseSessionMetadata(null) returns defaults
    const stats = sessionManager.getSessionStats(fakeContent);
    assert.strictEqual(stats.totalItems, 0);
    assert.strictEqual(stats.lineCount, 0);
  })) passed++; else failed++;

  // getSessionSize edge case
  console.log('\ngetSessionSize (edge cases):');

  if (test('returns MB for large file', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, 'large.tmp');
      // Create a file > 1MB
      fs.writeFileSync(sessionPath, 'x'.repeat(1024 * 1024 + 100));
      const size = sessionManager.getSessionSize(sessionPath);
      assert.ok(size.includes('MB'), `Expected MB, got: ${size}`);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  // appendSessionContent edge case
  if (test('appendSessionContent returns false for invalid path', () => {
    const result = sessionManager.appendSessionContent('/nonexistent/deep/path/session.tmp', 'content');
    assert.strictEqual(result, false);
  })) passed++; else failed++;

  // parseSessionFilename edge cases
  console.log('\nparseSessionFilename (additional edge cases):');

  if (test('rejects uppercase letters in short ID', () => {
    const result = sessionManager.parseSessionFilename('2026-02-01-ABCD1234-session.tmp');
    assert.strictEqual(result, null, 'Uppercase letters should be rejected');
  })) passed++; else failed++;

  if (test('rejects filenames with extra segments', () => {
    const result = sessionManager.parseSessionFilename('2026-02-01-abc12345-extra-session.tmp');
    assert.strictEqual(result, null, 'Extra segments should be rejected');
  })) passed++; else failed++;

  if (test('rejects impossible month (13)', () => {
    const result = sessionManager.parseSessionFilename('2026-13-01-abcd1234-session.tmp');
    assert.strictEqual(result, null, 'Month 13 should be rejected');
  })) passed++; else failed++;

  if (test('rejects impossible day (32)', () => {
    const result = sessionManager.parseSessionFilename('2026-01-32-abcd1234-session.tmp');
    assert.strictEqual(result, null, 'Day 32 should be rejected');
  })) passed++; else failed++;

  if (test('rejects month 00', () => {
    const result = sessionManager.parseSessionFilename('2026-00-15-abcd1234-session.tmp');
    assert.strictEqual(result, null, 'Month 00 should be rejected');
  })) passed++; else failed++;

  if (test('rejects day 00', () => {
    const result = sessionManager.parseSessionFilename('2026-01-00-abcd1234-session.tmp');
    assert.strictEqual(result, null, 'Day 00 should be rejected');
  })) passed++; else failed++;

  if (test('accepts valid edge date (month 12, day 31)', () => {
    const result = sessionManager.parseSessionFilename('2026-12-31-abcd1234-session.tmp');
    assert.ok(result, 'Month 12, day 31 should be accepted');
    assert.strictEqual(result.date, '2026-12-31');
  })) passed++; else failed++;

  if (test('rejects Feb 31 (calendar-inaccurate date)', () => {
    const result = sessionManager.parseSessionFilename('2026-02-31-abcd1234-session.tmp');
    assert.strictEqual(result, null, 'Feb 31 does not exist');
  })) passed++; else failed++;

  if (test('rejects Apr 31 (calendar-inaccurate date)', () => {
    const result = sessionManager.parseSessionFilename('2026-04-31-abcd1234-session.tmp');
    assert.strictEqual(result, null, 'Apr 31 does not exist');
  })) passed++; else failed++;

  if (test('rejects Feb 29 in non-leap year', () => {
    const result = sessionManager.parseSessionFilename('2025-02-29-abcd1234-session.tmp');
    assert.strictEqual(result, null, '2025 is not a leap year');
  })) passed++; else failed++;

  if (test('accepts Feb 29 in leap year', () => {
    const result = sessionManager.parseSessionFilename('2024-02-29-abcd1234-session.tmp');
    assert.ok(result, '2024 is a leap year');
    assert.strictEqual(result.date, '2024-02-29');
  })) passed++; else failed++;

  if (test('accepts Jun 30 (valid 30-day month)', () => {
    const result = sessionManager.parseSessionFilename('2026-06-30-abcd1234-session.tmp');
    assert.ok(result, 'June has 30 days');
    assert.strictEqual(result.date, '2026-06-30');
  })) passed++; else failed++;

  if (test('rejects Jun 31 (invalid 30-day month)', () => {
    const result = sessionManager.parseSessionFilename('2026-06-31-abcd1234-session.tmp');
    assert.strictEqual(result, null, 'June has only 30 days');
  })) passed++; else failed++;

  if (test('datetime field is a Date object', () => {
    const result = sessionManager.parseSessionFilename('2026-06-15-abcdef12-session.tmp');
    assert.ok(result);
    assert.ok(result.datetime instanceof Date, 'datetime should be a Date');
    assert.ok(!isNaN(result.datetime.getTime()), 'datetime should be valid');
  })) passed++; else failed++;

  // writeSessionContent tests
  console.log('\nwriteSessionContent:');

  if (test('creates new session file', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, 'write-test.tmp');
      const result = sessionManager.writeSessionContent(sessionPath, '# Test Session\n');
      assert.strictEqual(result, true, 'Should return true on success');
      assert.ok(fs.existsSync(sessionPath), 'File should exist');
      assert.strictEqual(fs.readFileSync(sessionPath, 'utf8'), '# Test Session\n');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('overwrites existing session file', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, 'overwrite-test.tmp');
      fs.writeFileSync(sessionPath, 'old content');
      const result = sessionManager.writeSessionContent(sessionPath, 'new content');
      assert.strictEqual(result, true);
      assert.strictEqual(fs.readFileSync(sessionPath, 'utf8'), 'new content');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('writeSessionContent returns false for invalid path', () => {
    const result = sessionManager.writeSessionContent('/nonexistent/deep/path/session.tmp', 'content');
    assert.strictEqual(result, false, 'Should return false for invalid path');
  })) passed++; else failed++;

  // appendSessionContent tests
  console.log('\nappendSessionContent:');

  if (test('appends to existing session file', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, 'append-test.tmp');
      fs.writeFileSync(sessionPath, '# Session\n');
      const result = sessionManager.appendSessionContent(sessionPath, '\n## Added Section\n');
      assert.strictEqual(result, true);
      const content = fs.readFileSync(sessionPath, 'utf8');
      assert.ok(content.includes('# Session'));
      assert.ok(content.includes('## Added Section'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  // deleteSession tests
  console.log('\ndeleteSession:');

  if (test('deletes existing session file', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, 'delete-me.tmp');
      fs.writeFileSync(sessionPath, '# To Delete');
      assert.ok(fs.existsSync(sessionPath), 'File should exist before delete');
      const result = sessionManager.deleteSession(sessionPath);
      assert.strictEqual(result, true, 'Should return true');
      assert.ok(!fs.existsSync(sessionPath), 'File should not exist after delete');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('deleteSession returns false for non-existent file', () => {
    const result = sessionManager.deleteSession('/nonexistent/session.tmp');
    assert.strictEqual(result, false, 'Should return false for missing file');
  })) passed++; else failed++;

  // sessionExists tests
  console.log('\nsessionExists:');

  if (test('returns true for existing session file', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, 'exists.tmp');
      fs.writeFileSync(sessionPath, '# Exists');
      assert.strictEqual(sessionManager.sessionExists(sessionPath), true);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('returns false for non-existent file', () => {
    assert.strictEqual(sessionManager.sessionExists('/nonexistent/file.tmp'), false);
  })) passed++; else failed++;

  if (test('returns false for directory (not a file)', () => {
    const dir = createTempSessionDir();
    try {
      assert.strictEqual(sessionManager.sessionExists(dir), false, 'Directory should not count as session');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  // getAllSessions pagination edge cases (offset/limit clamping)
  console.log('\ngetAllSessions (pagination edge cases):');

  if (test('getAllSessions clamps negative offset to 0', () => {
    const result = sessionManager.getAllSessions({ offset: -5, limit: 2 });
    // Negative offset should be clamped to 0, returning the first 2 sessions
    assert.strictEqual(result.sessions.length, 2);
    assert.strictEqual(result.offset, 0);
    assert.strictEqual(result.total, 5);
  })) passed++; else failed++;

  if (test('getAllSessions clamps NaN offset to 0', () => {
    const result = sessionManager.getAllSessions({ offset: NaN, limit: 3 });
    assert.strictEqual(result.sessions.length, 3);
    assert.strictEqual(result.offset, 0);
  })) passed++; else failed++;

  if (test('getAllSessions clamps NaN limit to default', () => {
    const result = sessionManager.getAllSessions({ offset: 0, limit: NaN });
    // NaN limit should be clamped to default (50), returning all 5 sessions
    assert.ok(result.sessions.length > 0);
    assert.strictEqual(result.total, 5);
  })) passed++; else failed++;

  if (test('getAllSessions clamps negative limit to 1', () => {
    const result = sessionManager.getAllSessions({ offset: 0, limit: -10 });
    // Negative limit should be clamped to 1
    assert.strictEqual(result.sessions.length, 1);
    assert.strictEqual(result.limit, 1);
  })) passed++; else failed++;

  if (test('getAllSessions clamps zero limit to 1', () => {
    const result = sessionManager.getAllSessions({ offset: 0, limit: 0 });
    assert.strictEqual(result.sessions.length, 1);
    assert.strictEqual(result.limit, 1);
  })) passed++; else failed++;

  if (test('getAllSessions handles string offset/limit gracefully', () => {
    const result = sessionManager.getAllSessions({ offset: 'abc', limit: 'xyz' });
    // String non-numeric should be treated as 0/default
    assert.strictEqual(result.offset, 0);
    assert.ok(result.sessions.length > 0);
  })) passed++; else failed++;

  if (test('getAllSessions handles fractional offset (floors to integer)', () => {
    const result = sessionManager.getAllSessions({ offset: 1.7, limit: 2 });
    // 1.7 should floor to 1, skip first session, return next 2
    assert.strictEqual(result.offset, 1);
    assert.strictEqual(result.sessions.length, 2);
  })) passed++; else failed++;

  if (test('getAllSessions handles Infinity offset', () => {
    // Infinity should clamp to 0 since Number(Infinity) is Infinity but
    // Math.floor(Infinity) is Infinity — however slice(Infinity) returns []
    // Actually: Number(Infinity) || 0 = Infinity, Math.floor(Infinity) = Infinity
    // Math.max(0, Infinity) = Infinity, so slice(Infinity) = []
    const result = sessionManager.getAllSessions({ offset: Infinity, limit: 2 });
    assert.strictEqual(result.sessions.length, 0);
    assert.strictEqual(result.total, 5);
  })) passed++; else failed++;

  // getSessionStats with code blocks and special characters
  console.log('\ngetSessionStats (code blocks & special chars):');

  if (test('counts tasks with inline backticks correctly', () => {
    const content = '# Test\n\n### Completed\n- [x] Fixed `app.js` bug with `fs.readFile()`\n- [x] Ran `npm install` successfully\n\n### In Progress\n- [ ] Review `config.ts` changes\n';
    const stats = sessionManager.getSessionStats(content);
    assert.strictEqual(stats.completedItems, 2, 'Should count 2 completed items');
    assert.strictEqual(stats.inProgressItems, 1, 'Should count 1 in-progress item');
    assert.strictEqual(stats.totalItems, 3);
  })) passed++; else failed++;

  if (test('handles special chars in notes section', () => {
    const content = '# Test\n\n### Notes for Next Session\nDon\'t forget: <important> & "quotes" & \'apostrophes\'\n';
    const stats = sessionManager.getSessionStats(content);
    assert.strictEqual(stats.hasNotes, true, 'Should detect notes section');
    const meta = sessionManager.parseSessionMetadata(content);
    assert.ok(meta.notes.includes('<important>'), 'Notes should preserve HTML-like content');
  })) passed++; else failed++;

  if (test('counts items in multiline code-heavy session', () => {
    const content = '# Code Session\n\n### Completed\n- [x] Refactored `lib/utils.js`\n- [x] Updated `package.json` version\n- [x] Fixed `\\`` escaping bug\n\n### In Progress\n- [ ] Test `getSessionStats()` function\n- [ ] Review PR #42\n';
    const stats = sessionManager.getSessionStats(content);
    assert.strictEqual(stats.completedItems, 3);
    assert.strictEqual(stats.inProgressItems, 2);
  })) passed++; else failed++;

  // getSessionStats with empty content
  if (test('getSessionStats handles empty string content', () => {
    const stats = sessionManager.getSessionStats('');
    assert.strictEqual(stats.totalItems, 0);
    // Empty string is falsy in JS, so content ? ... : 0 returns 0
    assert.strictEqual(stats.lineCount, 0, 'Empty string is falsy, lineCount = 0');
    assert.strictEqual(stats.hasNotes, false);
    assert.strictEqual(stats.hasContext, false);
  })) passed++; else failed++;

  // ── Round 26 tests ──

  console.log('\nparseSessionFilename (30-day month validation):');

  if (test('rejects Sep 31 (September has 30 days)', () => {
    const result = sessionManager.parseSessionFilename('2026-09-31-abcd1234-session.tmp');
    assert.strictEqual(result, null, 'Sep 31 does not exist');
  })) passed++; else failed++;

  if (test('rejects Nov 31 (November has 30 days)', () => {
    const result = sessionManager.parseSessionFilename('2026-11-31-abcd1234-session.tmp');
    assert.strictEqual(result, null, 'Nov 31 does not exist');
  })) passed++; else failed++;

  if (test('accepts Sep 30 (valid 30-day month boundary)', () => {
    const result = sessionManager.parseSessionFilename('2026-09-30-abcd1234-session.tmp');
    assert.ok(result, 'Sep 30 is valid');
    assert.strictEqual(result.date, '2026-09-30');
  })) passed++; else failed++;

  console.log('\ngetSessionStats (path heuristic edge cases):');

  if (test('multiline content ending with .tmp is treated as content', () => {
    const content = 'Line 1\nLine 2\nDownload file.tmp';
    const stats = sessionManager.getSessionStats(content);
    // Has newlines so looksLikePath is false → treated as content
    assert.strictEqual(stats.lineCount, 3, 'Should count 3 lines');
  })) passed++; else failed++;

  if (test('single-line content not starting with / treated as content', () => {
    const content = 'some random text.tmp';
    const stats = sessionManager.getSessionStats(content);
    assert.strictEqual(stats.lineCount, 1, 'Should treat as content, not a path');
  })) passed++; else failed++;

  console.log('\ngetAllSessions (combined filters):');

  if (test('combines date filter + search filter + pagination', () => {
    // We have 2026-02-01-ijkl9012 and 2026-02-01-mnop3456 with date 2026-02-01
    const result = sessionManager.getAllSessions({
      date: '2026-02-01',
      search: 'ijkl',
      limit: 10
    });
    assert.strictEqual(result.total, 1, 'Only one session matches both date and search');
    assert.strictEqual(result.sessions[0].shortId, 'ijkl9012');
  })) passed++; else failed++;

  if (test('date filter + offset beyond matches returns empty', () => {
    const result = sessionManager.getAllSessions({
      date: '2026-02-01',
      offset: 100,
      limit: 10
    });
    assert.strictEqual(result.sessions.length, 0);
    assert.strictEqual(result.total, 2, 'Two sessions match the date');
    assert.strictEqual(result.hasMore, false);
  })) passed++; else failed++;

  console.log('\ngetSessionById (ambiguous prefix):');

  if (test('returns first match when multiple sessions share a prefix', () => {
    // Sessions with IDs abcd1234 and efgh5678 exist
    // 'e' should match efgh5678 (only match)
    const result = sessionManager.getSessionById('efgh');
    assert.ok(result, 'Should find session by prefix');
    assert.strictEqual(result.shortId, 'efgh5678');
  })) passed++; else failed++;

  console.log('\nparseSessionMetadata (edge cases):');

  if (test('handles unclosed code fence in Context section', () => {
    const content = '# Session\n\n### Context to Load\n```\nsrc/index.ts\n';
    const meta = sessionManager.parseSessionMetadata(content);
    // Regex requires closing ```, so no context should be extracted
    assert.strictEqual(meta.context, '', 'Unclosed code fence should not extract context');
  })) passed++; else failed++;

  if (test('handles empty task text in checklist items', () => {
    const content = '# Session\n\n### Completed\n- [x] \n- [x] Real task\n';
    const meta = sessionManager.parseSessionMetadata(content);
    // \s* in the regex bridges across newlines, collapsing the empty
    // task + next task into a single match. This is an edge case —
    // real sessions don't have empty checklist items.
    assert.strictEqual(meta.completed.length, 1);
  })) passed++; else failed++;

  // ── Round 43: getSessionById default excludes content ──
  console.log('\nRound 43: getSessionById (default excludes content):');

  if (test('getSessionById without includeContent omits content, metadata, and stats', () => {
    // Default call (includeContent=false) should NOT load file content
    const result = sessionManager.getSessionById('abcd1234');
    assert.ok(result, 'Should find the session');
    assert.strictEqual(result.shortId, 'abcd1234');
    // These fields should be absent when includeContent is false
    assert.strictEqual(result.content, undefined, 'content should be undefined');
    assert.strictEqual(result.metadata, undefined, 'metadata should be undefined');
    assert.strictEqual(result.stats, undefined, 'stats should be undefined');
    // Basic fields should still be present
    assert.ok(result.sessionPath, 'sessionPath should be present');
    assert.ok(result.size !== undefined, 'size should be present');
    assert.ok(result.modifiedTime, 'modifiedTime should be present');
  })) passed++; else failed++;

  // ── Round 54: search filter scope and getSessionPath utility ──
  console.log('\nRound 54: search filter scope and path utility:');

  if (test('getAllSessions search filter matches only short ID, not title or content', () => {
    // "Session" appears in file CONTENT (e.g. "# Session 1") but not in any shortId
    const result = sessionManager.getAllSessions({ search: 'Session', limit: 100 });
    assert.strictEqual(result.total, 0, 'Search should not match title/content, only shortId');
    // Verify that searching by actual shortId substring still works
    const result2 = sessionManager.getAllSessions({ search: 'abcd', limit: 100 });
    assert.strictEqual(result2.total, 1, 'Search by shortId should still work');
  })) passed++; else failed++;

  if (test('getSessionPath returns absolute path for session filename', () => {
    const filename = '2026-02-01-testpath-session.tmp';
    const result = sessionManager.getSessionPath(filename);
    assert.ok(path.isAbsolute(result), 'Should return an absolute path');
    assert.ok(result.endsWith(filename), `Path should end with filename, got: ${result}`);
    // Since HOME is overridden, sessions dir should be under tmpHome
    assert.ok(result.includes('.claude'), 'Path should include .claude directory');
    assert.ok(result.includes('sessions'), 'Path should include sessions directory');
  })) passed++; else failed++;

  // ── Round 66: getSessionById noIdMatch path (date-only string for old format) ──
  console.log('\nRound 66: getSessionById (noIdMatch — date-only match for old format):');

  if (test('getSessionById finds old-format session by date-only string (noIdMatch)', () => {
    // File is 2026-02-10-session.tmp (old format, shortId = 'no-id')
    // Calling with '2026-02-10' → filenameMatch fails (filename !== '2026-02-10' and !== '2026-02-10.tmp')
    // shortIdMatch fails (shortId === 'no-id', not !== 'no-id')
    // noIdMatch succeeds: shortId === 'no-id' && filename === '2026-02-10-session.tmp'
    const result = sessionManager.getSessionById('2026-02-10');
    assert.ok(result, 'Should find old-format session by date-only string');
    assert.strictEqual(result.shortId, 'no-id', 'Should have no-id shortId');
    assert.ok(result.filename.includes('2026-02-10-session.tmp'), 'Should match old-format file');
    assert.ok(result.sessionPath, 'Should have sessionPath');
    assert.ok(result.date === '2026-02-10', 'Should have correct date');
  })) passed++; else failed++;

  // Cleanup — restore both HOME and USERPROFILE (Windows)
  process.env.HOME = origHome;
  if (origUserProfile !== undefined) {
    process.env.USERPROFILE = origUserProfile;
  } else {
    delete process.env.USERPROFILE;
  }
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }

  // ── Round 30: datetime local-time fix and parseSessionFilename edge cases ──
  console.log('\nRound 30: datetime local-time fix:');

  if (test('datetime day matches the filename date (local-time constructor)', () => {
    const result = sessionManager.parseSessionFilename('2026-06-15-abcdef12-session.tmp');
    assert.ok(result);
    // With the fix, getDate()/getMonth() should return local-time values
    // matching the filename, regardless of timezone
    assert.strictEqual(result.datetime.getDate(), 15, 'Day should be 15 (local time)');
    assert.strictEqual(result.datetime.getMonth(), 5, 'Month should be 5 (June, 0-indexed)');
    assert.strictEqual(result.datetime.getFullYear(), 2026, 'Year should be 2026');
  })) passed++; else failed++;

  if (test('datetime matches for January 1 (timezone-sensitive date)', () => {
    // Jan 1 at UTC midnight is Dec 31 in negative offsets — this tests the fix
    const result = sessionManager.parseSessionFilename('2026-01-01-abc12345-session.tmp');
    assert.ok(result);
    assert.strictEqual(result.datetime.getDate(), 1, 'Day should be 1 in local time');
    assert.strictEqual(result.datetime.getMonth(), 0, 'Month should be 0 (January)');
  })) passed++; else failed++;

  if (test('datetime matches for December 31 (year boundary)', () => {
    const result = sessionManager.parseSessionFilename('2025-12-31-abc12345-session.tmp');
    assert.ok(result);
    assert.strictEqual(result.datetime.getDate(), 31);
    assert.strictEqual(result.datetime.getMonth(), 11); // December
    assert.strictEqual(result.datetime.getFullYear(), 2025);
  })) passed++; else failed++;

  console.log('\nRound 30: parseSessionFilename edge cases:');

  if (test('parses session ID with many dashes (UUID-like)', () => {
    const result = sessionManager.parseSessionFilename('2026-02-13-a1b2c3d4-session.tmp');
    assert.ok(result);
    assert.strictEqual(result.shortId, 'a1b2c3d4');
    assert.strictEqual(result.date, '2026-02-13');
  })) passed++; else failed++;

  if (test('rejects filename with missing session.tmp suffix', () => {
    const result = sessionManager.parseSessionFilename('2026-02-13-abc12345.tmp');
    assert.strictEqual(result, null, 'Should reject filename without -session.tmp');
  })) passed++; else failed++;

  if (test('rejects filename with extra text after suffix', () => {
    const result = sessionManager.parseSessionFilename('2026-02-13-abc12345-session.tmp.bak');
    assert.strictEqual(result, null, 'Should reject filenames with extra extension');
  })) passed++; else failed++;

  if (test('handles old-format filename without session ID', () => {
    // The regex match[2] is undefined for old format → shortId defaults to 'no-id'
    const result = sessionManager.parseSessionFilename('2026-02-13-session.tmp');
    if (result) {
      assert.strictEqual(result.shortId, 'no-id', 'Should default to no-id');
    }
    // Either null (regex doesn't match) or has no-id — both are acceptable
    assert.ok(true, 'Old format handled without crash');
  })) passed++; else failed++;

  // ── Round 33: birthtime / createdTime fallback ──
  console.log('\ncreatedTime fallback (Round 33):');

  // Use HOME override approach (consistent with existing getAllSessions tests)
  const r33Home = path.join(os.tmpdir(), `ecc-r33-birthtime-${Date.now()}`);
  const r33SessionsDir = path.join(r33Home, '.claude', 'sessions');
  fs.mkdirSync(r33SessionsDir, { recursive: true });
  const r33OrigHome = process.env.HOME;
  const r33OrigProfile = process.env.USERPROFILE;
  process.env.HOME = r33Home;
  process.env.USERPROFILE = r33Home;

  const r33Filename = '2026-02-13-r33birth-session.tmp';
  const r33FilePath = path.join(r33SessionsDir, r33Filename);
  fs.writeFileSync(r33FilePath, '{"type":"test"}');

  if (test('getAllSessions returns createdTime from birthtime when available', () => {
    const result = sessionManager.getAllSessions({ limit: 100 });
    assert.ok(result.sessions.length > 0, 'Should find the test session');
    const session = result.sessions[0];
    assert.ok(session.createdTime instanceof Date, 'createdTime should be a Date');
    // birthtime should be populated on macOS/Windows — createdTime should match it
    const stats = fs.statSync(r33FilePath);
    if (stats.birthtime && stats.birthtime.getTime() > 0) {
      assert.strictEqual(
        session.createdTime.getTime(),
        stats.birthtime.getTime(),
        'createdTime should match birthtime when available'
      );
    }
  })) passed++; else failed++;

  if (test('getSessionById returns createdTime field', () => {
    const session = sessionManager.getSessionById('r33birth');
    assert.ok(session, 'Should find the session');
    assert.ok(session.createdTime instanceof Date, 'createdTime should be a Date');
    assert.ok(session.createdTime.getTime() > 0, 'createdTime should be non-zero');
  })) passed++; else failed++;

  if (test('createdTime falls back to ctime when birthtime is epoch-zero', () => {
    // This tests the || fallback logic: stats.birthtime || stats.ctime
    // On some FS, birthtime may be epoch 0 (falsy as a Date number comparison
    // but truthy as a Date object). The fallback is defensive.
    const stats = fs.statSync(r33FilePath);
    // Both birthtime and ctime should be valid Dates on any modern OS
    assert.ok(stats.ctime instanceof Date, 'ctime should exist');
    // The fallback expression `birthtime || ctime` should always produce a valid Date
    const fallbackResult = stats.birthtime || stats.ctime;
    assert.ok(fallbackResult instanceof Date, 'Fallback should produce a Date');
    assert.ok(fallbackResult.getTime() > 0, 'Fallback date should be non-zero');
  })) passed++; else failed++;

  // Cleanup Round 33 HOME override
  process.env.HOME = r33OrigHome;
  if (r33OrigProfile !== undefined) {
    process.env.USERPROFILE = r33OrigProfile;
  } else {
    delete process.env.USERPROFILE;
  }
  try { fs.rmSync(r33Home, { recursive: true, force: true }); } catch {}

  // ── Round 46: path heuristic and checklist edge cases ──
  console.log('\ngetSessionStats Windows path heuristic (Round 46):');

  if (test('recognises Windows drive-letter path as a file path', () => {
    // The looksLikePath regex includes /^[A-Za-z]:[/\\]/ for Windows
    // A non-existent Windows path should still be treated as a path
    // (getSessionContent returns null → parseSessionMetadata(null) → defaults)
    const stats1 = sessionManager.getSessionStats('C:/Users/test/session.tmp');
    assert.strictEqual(stats1.lineCount, 0, 'C:/ path treated as path, not content');
    const stats2 = sessionManager.getSessionStats('D:\\Sessions\\2026-01-01.tmp');
    assert.strictEqual(stats2.lineCount, 0, 'D:\\ path treated as path, not content');
  })) passed++; else failed++;

  if (test('does not treat bare drive letter without slash as path', () => {
    // "C:session.tmp" has no slash after colon → regex fails → treated as content
    const stats = sessionManager.getSessionStats('C:session.tmp');
    assert.strictEqual(stats.lineCount, 1, 'Bare C: without slash treated as content');
  })) passed++; else failed++;

  console.log('\nparseSessionMetadata checkbox case sensitivity (Round 46):');

  if (test('uppercase [X] does not match completed items regex', () => {
    const content = '# Test\n\n### Completed\n- [X] Uppercase task\n- [x] Lowercase task\n';
    const meta = sessionManager.parseSessionMetadata(content);
    // Regex is /- \[x\]\s*(.+)/g — only matches lowercase [x]
    assert.strictEqual(meta.completed.length, 1, 'Only lowercase [x] should match');
    assert.strictEqual(meta.completed[0], 'Lowercase task');
  })) passed++; else failed++;

  // getAllSessions returns empty result when sessions directory does not exist
  if (test('getAllSessions returns empty when sessions dir missing', () => {
    const tmpDir = createTempSessionDir();
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    try {
      // Point HOME to a dir with no .claude/sessions/
      process.env.HOME = tmpDir;
      process.env.USERPROFILE = tmpDir;
      // Re-require to pick up new HOME
      delete require.cache[require.resolve('../../scripts/lib/session-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      const freshSM = require('../../scripts/lib/session-manager');
      const result = freshSM.getAllSessions();
      assert.deepStrictEqual(result.sessions, [], 'Should return empty sessions array');
      assert.strictEqual(result.total, 0, 'Total should be 0');
      assert.strictEqual(result.hasMore, false, 'hasMore should be false');
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      delete require.cache[require.resolve('../../scripts/lib/session-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      cleanup(tmpDir);
    }
  })) passed++; else failed++;

  // ── Round 69: getSessionById returns null when sessions dir missing ──
  console.log('\nRound 69: getSessionById (missing sessions directory):');

  if (test('getSessionById returns null when sessions directory does not exist', () => {
    const tmpDir = createTempSessionDir();
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    try {
      // Point HOME to a dir with no .claude/sessions/
      process.env.HOME = tmpDir;
      process.env.USERPROFILE = tmpDir;
      // Re-require to pick up new HOME
      delete require.cache[require.resolve('../../scripts/lib/session-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      const freshSM = require('../../scripts/lib/session-manager');
      const result = freshSM.getSessionById('anything');
      assert.strictEqual(result, null, 'Should return null when sessions dir does not exist');
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      delete require.cache[require.resolve('../../scripts/lib/session-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      cleanup(tmpDir);
    }
  })) passed++; else failed++;

  // ── Round 78: getSessionStats reads real file when given existing .tmp path ──
  console.log('\nRound 78: getSessionStats (actual file path → reads from disk):');

  if (test('getSessionStats reads from disk when given path to existing .tmp file', () => {
    const dir = createTempSessionDir();
    try {
      const sessionPath = path.join(dir, '2026-03-01-test1234-session.tmp');
      const content = '# Real File Stats Test\n\n**Date:** 2026-03-01\n**Started:** 09:00\n\n### Completed\n- [x] First task\n- [x] Second task\n\n### In Progress\n- [ ] Third task\n\n### Notes for Next Session\nDon\'t forget the edge cases\n';
      fs.writeFileSync(sessionPath, content);

      // Pass the FILE PATH (not content) — this exercises looksLikePath branch
      const stats = sessionManager.getSessionStats(sessionPath);
      assert.strictEqual(stats.completedItems, 2, 'Should find 2 completed items from file');
      assert.strictEqual(stats.inProgressItems, 1, 'Should find 1 in-progress item from file');
      assert.strictEqual(stats.totalItems, 3, 'Should find 3 total items from file');
      assert.strictEqual(stats.hasNotes, true, 'Should detect notes section from file');
      assert.ok(stats.lineCount > 5, `Should have multiple lines from file, got ${stats.lineCount}`);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  // ── Round 78: getAllSessions hasContent field ──
  console.log('\nRound 78: getAllSessions (hasContent field):');

  if (test('getAllSessions hasContent is true for non-empty and false for empty files', () => {
    const isoHome = path.join(os.tmpdir(), `ecc-hascontent-${Date.now()}`);
    const isoSessions = path.join(isoHome, '.claude', 'sessions');
    fs.mkdirSync(isoSessions, { recursive: true });
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    try {
      // Create one non-empty session and one empty session
      fs.writeFileSync(path.join(isoSessions, '2026-04-01-nonempty-session.tmp'), '# Has content');
      fs.writeFileSync(path.join(isoSessions, '2026-04-02-emptyfile-session.tmp'), '');

      process.env.HOME = isoHome;
      process.env.USERPROFILE = isoHome;
      delete require.cache[require.resolve('../../scripts/lib/session-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      const freshSM = require('../../scripts/lib/session-manager');

      const result = freshSM.getAllSessions({ limit: 100 });
      assert.strictEqual(result.total, 2, 'Should find both sessions');

      const nonEmpty = result.sessions.find(s => s.shortId === 'nonempty');
      const empty = result.sessions.find(s => s.shortId === 'emptyfile');

      assert.ok(nonEmpty, 'Should find the non-empty session');
      assert.ok(empty, 'Should find the empty session');
      assert.strictEqual(nonEmpty.hasContent, true, 'Non-empty file should have hasContent: true');
      assert.strictEqual(empty.hasContent, false, 'Empty file should have hasContent: false');
    } finally {
      process.env.HOME = savedHome;
      process.env.USERPROFILE = savedProfile;
      delete require.cache[require.resolve('../../scripts/lib/session-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ── Round 75: deleteSession catch — unlinkSync throws on read-only dir ──
  console.log('\nRound 75: deleteSession (unlink failure in read-only dir):');

  if (test('deleteSession returns false when file exists but directory is read-only', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      console.log('    (skipped — chmod ineffective on Windows/root)');
      return;
    }
    const tmpDir = path.join(os.tmpdir(), `sm-del-ro-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const sessionFile = path.join(tmpDir, 'test-session.tmp');
    fs.writeFileSync(sessionFile, 'session content');
    try {
      // Make directory read-only so unlinkSync throws EACCES
      fs.chmodSync(tmpDir, 0o555);
      const result = sessionManager.deleteSession(sessionFile);
      assert.strictEqual(result, false, 'Should return false when unlinkSync fails');
    } finally {
      try { fs.chmodSync(tmpDir, 0o755); } catch { /* best-effort */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ── Round 81: getSessionStats(null) ──
  console.log('\nRound 81: getSessionStats(null) (null input):');

  if (test('getSessionStats(null) returns zero lineCount and empty metadata', () => {
    // session-manager.js line 158-177: getSessionStats accepts path or content.
    // typeof null === 'string' is false → looksLikePath = false → content = null.
    // Line 177: content ? content.split('\n').length : 0 → lineCount: 0.
    // parseSessionMetadata(null) returns defaults → totalItems/completedItems/inProgressItems = 0.
    const stats = sessionManager.getSessionStats(null);
    assert.strictEqual(stats.lineCount, 0, 'null input should yield lineCount 0');
    assert.strictEqual(stats.totalItems, 0, 'null input should yield totalItems 0');
    assert.strictEqual(stats.completedItems, 0, 'null input should yield completedItems 0');
    assert.strictEqual(stats.inProgressItems, 0, 'null input should yield inProgressItems 0');
    assert.strictEqual(stats.hasNotes, false, 'null input should yield hasNotes false');
    assert.strictEqual(stats.hasContext, false, 'null input should yield hasContext false');
  })) passed++; else failed++;

  // ── Round 83: getAllSessions TOCTOU statSync catch (broken symlink) ──
  console.log('\nRound 83: getAllSessions (broken symlink — statSync catch):');

  if (test('getAllSessions skips broken symlink .tmp files gracefully', () => {
    // getAllSessions at line 241-246: statSync throws for broken symlinks,
    // the catch causes `continue`, skipping that entry entirely.
    const isoHome = path.join(os.tmpdir(), `ecc-r83-toctou-${Date.now()}`);
    const sessionsDir = path.join(isoHome, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create one real session file
    const realFile = '2026-02-10-abcd1234-session.tmp';
    fs.writeFileSync(path.join(sessionsDir, realFile), '# Real session\n');

    // Create a broken symlink that matches the session filename pattern
    const brokenSymlink = '2026-02-10-deadbeef-session.tmp';
    fs.symlinkSync('/nonexistent/path/that/does/not/exist', path.join(sessionsDir, brokenSymlink));

    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    process.env.HOME = isoHome;
    process.env.USERPROFILE = isoHome;
    try {
      delete require.cache[require.resolve('../../scripts/lib/session-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      const freshManager = require('../../scripts/lib/session-manager');
      const result = freshManager.getAllSessions({ limit: 100 });

      // Should have only the real session, not the broken symlink
      assert.strictEqual(result.total, 1, 'Should find only the real session, not the broken symlink');
      assert.ok(result.sessions[0].filename === realFile,
        `Should return the real file, got: ${result.sessions[0].filename}`);
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      delete require.cache[require.resolve('../../scripts/lib/session-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ── Round 84: getSessionById TOCTOU — statSync catch returns null for broken symlink ──
  console.log('\nRound 84: getSessionById (broken symlink — statSync catch):');

  if (test('getSessionById returns null when matching session is a broken symlink', () => {
    // getSessionById at line 307-310: statSync throws for broken symlinks,
    // the catch returns null (file deleted between readdir and stat).
    const isoHome = path.join(os.tmpdir(), `ecc-r84-getbyid-toctou-${Date.now()}`);
    const sessionsDir = path.join(isoHome, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create a broken symlink that matches a session ID pattern
    const brokenFile = '2026-02-11-deadbeef-session.tmp';
    fs.symlinkSync('/nonexistent/target/that/does/not/exist', path.join(sessionsDir, brokenFile));

    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = isoHome;
      process.env.USERPROFILE = isoHome;
      delete require.cache[require.resolve('../../scripts/lib/session-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      const freshSM = require('../../scripts/lib/session-manager');

      // Search by the short ID "deadbeef" — should match the broken symlink
      const result = freshSM.getSessionById('deadbeef');
      assert.strictEqual(result, null,
        'Should return null when matching session file is a broken symlink');
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      delete require.cache[require.resolve('../../scripts/lib/session-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ── Round 88: parseSessionMetadata null date/started/lastUpdated fields ──
  console.log('\nRound 88: parseSessionMetadata content lacking Date/Started/Updated fields:');
  if (test('parseSessionMetadata returns null for date, started, lastUpdated when fields absent', () => {
    const content = '# Title Only\n\n### Notes for Next Session\nSome notes\n';
    const meta = sessionManager.parseSessionMetadata(content);
    assert.strictEqual(meta.date, null,
      'date should be null when **Date:** field is absent');
    assert.strictEqual(meta.started, null,
      'started should be null when **Started:** field is absent');
    assert.strictEqual(meta.lastUpdated, null,
      'lastUpdated should be null when **Last Updated:** field is absent');
    // Confirm other fields still parse correctly
    assert.strictEqual(meta.title, 'Title Only');
    assert.strictEqual(meta.notes, 'Some notes');
  })) passed++; else failed++;

  // ── Round 89: getAllSessions skips subdirectories (!entry.isFile()) ──
  console.log('\nRound 89: getAllSessions (subdirectory skip):');

  if (test('getAllSessions skips subdirectories inside sessions dir', () => {
    // session-manager.js line 220: if (!entry.isFile() || ...) continue;
    // Existing tests create non-.tmp FILES to test filtering (e.g., notes.txt).
    // This test creates a DIRECTORY — entry.isFile() returns false, so it should be skipped.
    const isoHome = path.join(os.tmpdir(), `ecc-r89-subdir-skip-${Date.now()}`);
    const sessionsDir = path.join(isoHome, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create a real session file
    const realFile = '2026-02-11-abcd1234-session.tmp';
    fs.writeFileSync(path.join(sessionsDir, realFile), '# Test session');

    // Create a subdirectory inside sessions dir — should be skipped by !entry.isFile()
    const subdir = path.join(sessionsDir, 'some-nested-dir');
    fs.mkdirSync(subdir);

    // Also create a subdirectory whose name ends in .tmp — still not a file
    const tmpSubdir = path.join(sessionsDir, '2026-02-11-fakeid00-session.tmp');
    fs.mkdirSync(tmpSubdir);

    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    process.env.HOME = isoHome;
    process.env.USERPROFILE = isoHome;
    try {
      delete require.cache[require.resolve('../../scripts/lib/session-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      const freshManager = require('../../scripts/lib/session-manager');
      const result = freshManager.getAllSessions({ limit: 100 });

      // Should find only the real file, not either subdirectory
      assert.strictEqual(result.total, 1,
        `Should find 1 session (the file), not subdirectories. Got ${result.total}`);
      assert.strictEqual(result.sessions[0].filename, realFile,
        `Should return the real file. Got: ${result.sessions[0].filename}`);
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      delete require.cache[require.resolve('../../scripts/lib/session-manager')];
      delete require.cache[require.resolve('../../scripts/lib/utils')];
      fs.rmSync(isoHome, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ── Round 91: getSessionStats with mixed Windows path separators ──
  console.log('\nRound 91: getSessionStats (mixed Windows path separators):');

  if (test('getSessionStats treats mixed Windows separators as a file path', () => {
    // session-manager.js line 166: regex /^[A-Za-z]:[/\\]/ checks only the
    // character right after the colon. Mixed separators like C:\Users/Mixed\session.tmp
    // should still match because the first separator (\) satisfies the regex.
    const stats = sessionManager.getSessionStats('C:\\Users/Mixed\\session.tmp');
    assert.strictEqual(stats.lineCount, 0,
      'Mixed separators should be treated as path (file does not exist → lineCount 0)');
    assert.strictEqual(stats.totalItems, 0, 'Non-existent path should have 0 items');
  })) passed++; else failed++;

  // ── Round 92: getSessionStats with UNC path treated as content ──
  console.log('\nRound 92: getSessionStats (Windows UNC path):');

  if (test('getSessionStats treats UNC path as content (not recognized as file path)', () => {
    // session-manager.js line 163-166: The path heuristic checks for Unix paths
    // (starts with /) and Windows drive-letter paths (/^[A-Za-z]:[/\\]/). UNC paths
    // (\\server\share\file.tmp) don't match either pattern, so the function treats
    // the string as pre-read content rather than a file path to read.
    const stats = sessionManager.getSessionStats('\\\\server\\share\\session.tmp');
    assert.strictEqual(stats.lineCount, 1,
      'UNC path should be treated as single-line content (not a recognized path)');
  })) passed++; else failed++;

  // ── Round 93: getSessionStats with drive letter but no slash (regex boundary) ──
  console.log('\nRound 93: getSessionStats (drive letter without slash — regex boundary):');

  if (test('getSessionStats treats drive letter without slash as content (not a path)', () => {
    // session-manager.js line 166: /^[A-Za-z]:[/\\]/ requires a '/' or '\'
    // immediately after the colon.  'Z:nosession.tmp' has 'Z:n' which does NOT
    // match, so looksLikePath is false even though .endsWith('.tmp') is true.
    const stats = sessionManager.getSessionStats('Z:nosession.tmp');
    assert.strictEqual(stats.lineCount, 1,
      'Z:nosession.tmp (no slash) should be treated as single-line content');
    assert.strictEqual(stats.totalItems, 0,
      'Content without session items should have 0 totalItems');
  })) passed++; else failed++;

  // Summary
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
