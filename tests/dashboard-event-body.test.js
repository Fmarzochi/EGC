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

// U+1F389 PARTY POPPER, as raw UTF-8 bytes rather than a literal emoji
// character. This file must stay free of Extended_Pictographic code points
// (see scripts/ci/check-unicode-safety.js) — writing the emoji as a string
// literal would trip that gate.
const PARTY_POPPER_BYTES = Buffer.from([0xF0, 0x9F, 0x8E, 0x89]);
const EMOJI_PLACEHOLDER = '@EMOJI@';

// Serializes `obj` to JSON, then splices PARTY_POPPER_BYTES in at the byte
// offset where EMOJI_PLACEHOLDER appears in the resulting text. This gives
// an exact, known byte offset for the emoji's 4-byte UTF-8 sequence, so
// tests can split precisely inside it instead of scanning for "some"
// multi-byte character boundary.
function payloadBufferWithEmoji(obj) {
  const json = JSON.stringify(obj);
  const markerIndex = json.indexOf(EMOJI_PLACEHOLDER);
  if (markerIndex === -1) throw new Error('EMOJI_PLACEHOLDER not found in payload');

  const before = Buffer.from(json.slice(0, markerIndex), 'utf8');
  const after = Buffer.from(json.slice(markerIndex + EMOJI_PLACEHOLDER.length), 'utf8');

  return {
    buf: Buffer.concat([before, PARTY_POPPER_BYTES, after]),
    emojiStart: before.length,
  };
}

test('multi-byte UTF-8 character split across chunks decodes correctly', () => {
  const { buf: payloadBuf, emojiStart } = payloadBufferWithEmoji({
    ide: 'claude',
    event: 'pre_tool',
    note: `日本語 パス名 ${EMOJI_PLACEHOLDER} done`,
  });
  const payload = payloadBuf.toString('utf8');

  // Split 2 bytes into the emoji's 4-byte UTF-8 sequence.
  const splitIndex = emojiStart + 2;

  const collector = createBodyCollector();
  collector.push(payloadBuf.subarray(0, splitIndex));
  collector.push(payloadBuf.subarray(splitIndex));

  assert.equal(collector.toString(), payload);
  assert.deepEqual(JSON.parse(collector.toString()), JSON.parse(payload));
});

test('character split across three chunks still decodes correctly', () => {
  const { buf: payloadBuf, emojiStart } = payloadBufferWithEmoji({
    ide: 'claude',
    note: EMOJI_PLACEHOLDER,
  });
  const payload = payloadBuf.toString('utf8');

  const collector = createBodyCollector();
  // Split the emoji's 4 raw bytes into three separate pushes: byte 0, byte 1,
  // then bytes 2-3.
  collector.push(payloadBuf.subarray(0, emojiStart + 1));
  collector.push(payloadBuf.subarray(emojiStart + 1, emojiStart + 2));
  collector.push(payloadBuf.subarray(emojiStart + 2));

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
