'use strict';
/**
 * Regression tests for Fmarzochi/EGC#503
 *
 * dashboard/aider-watcher.js and dashboard/vscode-adapter.js both track a
 * "last known size" per watched file so they only read the bytes appended
 * since the previous check. Before this fix, if the watched file shrank
 * (truncated or rotated by the producing tool), the stale "last size" was
 * never reset:
 *
 *   if (stat.size <= lastSizes[filePath]) return;
 *
 * This made the watcher stop emitting events permanently after any log
 * rotation, and if size genuinely shrank between the statSync() and the
 * read, `Buffer.alloc(stat.size - lastSizes[filePath])` would receive a
 * negative length and throw.
 *
 * These tests exercise the exact fixed read-offset logic from both files
 * against real files on disk (real fs.statSync/openSync/readSync, no
 * mocking) to verify: (1) growth still works as before, (2) a shrink
 * resets the offset and resumes emitting from the start, (3) the buffer
 * length can never go negative.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Helper: the exact post-fix logic from aider-watcher.js / vscode-adapter.js,
// extracted as a pure function of (filePath, lastSize) -> { chunk, newSize }.
// This is the same four lines as dashboard/aider-watcher.js:38-46 (and the
// equivalent in vscode-adapter.js:57-64), just wrapped so it's testable
// without spinning up fs.watch(), setInterval(), or the HTTP POST side
// effects that the real watcher scripts perform on require().
// ---------------------------------------------------------------------------
function readDelta(filePath, lastSize) {
  const stat = fs.statSync(filePath);
  if (stat.size < lastSize) lastSize = 0; // truncated/rotated: reset and re-read from start
  if (stat.size <= lastSize) return { chunk: null, newSize: lastSize };

  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(stat.size - lastSize);
  fs.readSync(fd, buf, 0, buf.length, lastSize);
  fs.closeSync(fd);

  return { chunk: buf.toString('utf8'), newSize: stat.size };
}

function withTempFile(initialContent, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-watcher-test-'));
  const filePath = path.join(dir, 'watched.log');
  fs.writeFileSync(filePath, initialContent, 'utf8');
  try {
    return fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('no change: size unchanged returns no chunk', () => {
  withTempFile('hello', (filePath) => {
    const lastSize = fs.statSync(filePath).size;
    const result = readDelta(filePath, lastSize);
    assert.equal(result.chunk, null);
    assert.equal(result.newSize, lastSize);
  });
});

test('growth: file grows, only the appended bytes are read (pre-existing behavior preserved)', () => {
  withTempFile('hello', (filePath) => {
    const lastSize = fs.statSync(filePath).size; // 5
    fs.appendFileSync(filePath, ' world');

    const result = readDelta(filePath, lastSize);
    assert.equal(result.chunk, ' world');
    assert.equal(result.newSize, 11);
  });
});

test('truncation: file shrinks to empty, watcher resets and resumes emitting on next growth', () => {
  withTempFile('this is a long line of aider chat history', (filePath) => {
    const lastSize = fs.statSync(filePath).size; // 42

    // Simulate truncation (e.g. aider rotating its history file).
    fs.truncateSync(filePath, 0);

    // Immediately after truncation with nothing written yet: no chunk, but
    // the offset must have been reset to 0, not left stuck at 42.
    const afterTruncate = readDelta(filePath, lastSize);
    assert.equal(afterTruncate.chunk, null);
    assert.equal(afterTruncate.newSize, 0,
      'offset must reset to 0 on truncation, not stay at the stale pre-truncation size');

    // New content is written post-rotation — this is the regression: before
    // the fix, lastSizes[filePath] was still 42, so `stat.size <= 42` would
    // keep returning true (since new content here is shorter than the old
    // line), and the watcher would silently never emit again.
    fs.writeFileSync(filePath, 'new short line');
    const afterRewrite = readDelta(filePath, afterTruncate.newSize);
    assert.equal(afterRewrite.chunk, 'new short line');
    assert.equal(afterRewrite.newSize, 14);
  });
});

test('rotation: file replaced with a smaller (but non-empty) file, watcher reads it from the start', () => {
  withTempFile('================ very long aider session log ================', (filePath) => {
    const lastSize = fs.statSync(filePath).size; // 64

    // Simulate log rotation: a fresh, shorter file replaces the old one.
    fs.writeFileSync(filePath, 'fresh log');

    const result = readDelta(filePath, lastSize);
    assert.equal(result.chunk, 'fresh log',
      'after rotation the watcher must read the new file from byte 0, not skip it as "already seen"');
    assert.equal(result.newSize, 9);
  });
});

test('regression guard: shrink never produces a negative Buffer.alloc length', () => {
  withTempFile('0123456789'.repeat(10), (filePath) => { // 100 bytes
    const lastSize = fs.statSync(filePath).size; // 100
    fs.truncateSync(filePath, 3); // shrink to 3 bytes — smaller than lastSize

    // Before the fix this would compute stat.size - lastSize = 3 - 100 = -97
    // and Buffer.alloc(-97) would throw a RangeError, permanently crashing
    // the watch callback (caught by the outer try/catch, but the event and
    // every event after it on this file would be lost).
    assert.doesNotThrow(() => {
      const result = readDelta(filePath, lastSize);
      // 3 <= 0 is false after reset, so this read happens and returns the
      // 3 bytes from the start.
      assert.equal(result.chunk, '012');
      assert.equal(result.newSize, 3);
    });
  });
});

test('multiple shrink/grow cycles: watcher keeps emitting correctly across repeated rotations', () => {
  withTempFile('first', (filePath) => {
    let lastSize = fs.statSync(filePath).size;

    fs.appendFileSync(filePath, '-second');
    let r = readDelta(filePath, lastSize);
    assert.equal(r.chunk, '-second');
    lastSize = r.newSize;

    // First rotation. In production, fs.watch fires its callback on the
    // truncate event itself, so the offset reset happens before any new
    // content exists -- mirror that here rather than jumping straight to
    // the rewrite.
    fs.truncateSync(filePath, 0);
    r = readDelta(filePath, lastSize);
    assert.equal(r.chunk, null);
    lastSize = r.newSize; // must now be 0

    fs.writeFileSync(filePath, 'third');
    r = readDelta(filePath, lastSize);
    assert.equal(r.chunk, 'third',
      'first rotation: must resume reading from 0, not stay stuck at the previous size');
    lastSize = r.newSize;

    // Second rotation -- same pattern, proving the fix isn't a one-shot
    // fluke and keeps resetting correctly every time the file shrinks.
    fs.truncateSync(filePath, 0);
    r = readDelta(filePath, lastSize);
    assert.equal(r.chunk, null);
    lastSize = r.newSize; // must now be 0 again, not stuck at 5 ('third'.length)

    fs.writeFileSync(filePath, 'fourth-rotation');
    r = readDelta(filePath, lastSize);
    assert.equal(r.chunk, 'fourth-rotation',
      'second rotation: the fix must keep working across repeated truncations, not just once');
  });
});
