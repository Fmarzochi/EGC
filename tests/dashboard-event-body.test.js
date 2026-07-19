'use strict';
/**
 * Regression tests for Fmarzochi/EGC#916
 *
 * Exercises the real createBodyCollector() factory shared with
 * dashboard/server.js's POST /event handler.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBodyCollector } = require('../dashboard/event-body');

// Returns a byte index that lands inside a multi-byte UTF-8 character
// (i.e. on a continuation byte, 10xxxxxx), so splitting the buffer there
// simulates a chunk boundary landing mid-character.
function findMidCharacterSplit(buf) {
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i] & 0xc0) === 0x80) return i;
  }
  throw new Error('payload has no multi-byte character to split');
}

test('multi-byte UTF-8 character split across chunks decodes correctly', () => {
  const payload = JSON.stringify({
    ide: 'claude',
    event: 'pre_tool',
    note: '日本語 パス名 🎉 done',
  });
  const buf = Buffer.from(payload, 'utf8');
  const splitIndex = findMidCharacterSplit(buf);

  const collector = createBodyCollector();
  collector.push(buf.subarray(0, splitIndex));
  collector.push(buf.subarray(splitIndex));

  assert.equal(collector.toString(), payload);
  assert.deepEqual(JSON.parse(collector.toString()), JSON.parse(payload));
});

test('character split across three chunks still decodes correctly', () => {
  const payload = JSON.stringify({ ide: 'claude', note: '🎉' });
  const buf = Buffer.from(payload, 'utf8');
  const splitIndex = findMidCharacterSplit(buf);

  const collector = createBodyCollector();
  // Split the multi-byte character's bytes into two separate pushes too.
  collector.push(buf.subarray(0, splitIndex));
  collector.push(buf.subarray(splitIndex, splitIndex + 1));
  collector.push(buf.subarray(splitIndex + 1));

  assert.equal(collector.toString(), payload);
});

test('size() counts bytes, not decoded characters', () => {
  const collector = createBodyCollector();
  const buf = Buffer.from('日本語', 'utf8'); // 3 chars, 9 bytes
  const returned = collector.push(buf);

  assert.equal(buf.length, 9);
  assert.equal(returned, 9);
  assert.equal(collector.size(), 9);
});

test('size accumulates across multiple pushes', () => {
  const collector = createBodyCollector();
  collector.push(Buffer.from('abc'));
  const total = collector.push(Buffer.from('defgh'));
  assert.equal(total, 8);
  assert.equal(collector.size(), 8);
});

test('ASCII-only payload delivered in a single chunk still works', () => {
  const payload = JSON.stringify({ ide: 'claude', event: 'pre_tool' });
  const collector = createBodyCollector();
  collector.push(Buffer.from(payload, 'utf8'));
  assert.equal(collector.toString(), payload);
});
