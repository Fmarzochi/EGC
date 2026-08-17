'use strict';

// Scrubber image metadata: PNG chunk and JPEG segment stripping, built on
// synthetic minimal fixtures so the parser structure is exercised without any
// real image asset. Fail-safe behavior on malformed input is verified too.

const assert = require('node:assert');
const {
  detectImageFormat,
  cleanPng,
  cleanJpeg,
  cleanImage,
  inspectImage,
} = require('../../scripts/lib/scrubber/image-meta');

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    Error: ${err.stack}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  if (test(name, fn)) passed += 1;
  else failed += 1;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); // the parser drops whole chunks and ignores CRC
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, crc]);
}

function jpegSeg(marker, data) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, data]);
}

check('png drops a tEXt chunk and keeps image chunks', () => {
  const png = Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', Buffer.alloc(13)),
    pngChunk('tEXt', Buffer.from('Software\0SomeAI', 'latin1')),
    pngChunk('IDAT', Buffer.from([1, 2, 3])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const r = cleanPng(png);
  assert.ok(r.removed.includes('png:tEXt'));
  assert.ok(r.cleaned.subarray(0, 8).equals(PNG_SIG));
  assert.ok(!r.cleaned.toString('latin1').includes('SomeAI'));
  assert.ok(r.cleaned.toString('latin1').includes('IHDR'));
  assert.ok(r.cleaned.toString('latin1').includes('IEND'));
  assert.strictEqual(cleanPng(r.cleaned).removed.length, 0);
});

check('png with no metadata chunk is returned unchanged', () => {
  const png = Buffer.concat([PNG_SIG, pngChunk('IHDR', Buffer.alloc(13)), pngChunk('IDAT', Buffer.from([9])), pngChunk('IEND', Buffer.alloc(0))]);
  const r = cleanPng(png);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.equals(png));
});

check('png with a malformed chunk length bails out unchanged', () => {
  const bad = Buffer.concat([PNG_SIG, Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('tEXt', 'latin1'), Buffer.from([1, 2])]);
  const r = cleanPng(bad);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.equals(bad));
});

check('jpeg drops APP1 (EXIF/XMP) and keeps the scan verbatim', () => {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSeg(0xe0, Buffer.from('JFIF\0', 'latin1')),
    jpegSeg(0xe1, Buffer.from('Exif\0\0secretdata', 'latin1')),
    jpegSeg(0xdb, Buffer.alloc(4)),
    Buffer.from([0xff, 0xda]),
    Buffer.from([0x00, 0x11, 0x22, 0x33]),
    Buffer.from([0xff, 0xd9]),
  ]);
  const r = cleanJpeg(jpeg);
  assert.ok(r.removed.includes('jpeg:app1'));
  assert.ok(r.cleaned.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
  assert.ok(!r.cleaned.toString('latin1').includes('secretdata'));
  assert.ok(r.cleaned.toString('latin1').includes('JFIF'));
  assert.strictEqual(r.cleaned[r.cleaned.length - 1], 0xd9);
});

check('jpeg with only baseline segments is unchanged', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), jpegSeg(0xe0, Buffer.from('JFIF\0', 'latin1')), Buffer.from([0xff, 0xda]), Buffer.from([1, 2]), Buffer.from([0xff, 0xd9])]);
  const r = cleanJpeg(jpeg);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.equals(jpeg));
});

check('detectImageFormat recognizes png/jpeg and rejects others', () => {
  assert.strictEqual(detectImageFormat(PNG_SIG), 'png');
  assert.strictEqual(detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.strictEqual(detectImageFormat(Buffer.from('not an image', 'latin1')), null);
});

check('cleanImage and inspectImage dispatch by format', () => {
  const png = Buffer.concat([PNG_SIG, pngChunk('IHDR', Buffer.alloc(13)), pngChunk('iTXt', Buffer.from('k\0\0\0\0\0v', 'latin1')), pngChunk('IEND', Buffer.alloc(0))]);
  const c = cleanImage(png);
  assert.strictEqual(c.format, 'png');
  assert.ok(c.removed.includes('png:iTXt'));
  assert.strictEqual(inspectImage(png).suspicious, true);
  assert.strictEqual(inspectImage(Buffer.from('plain', 'latin1')).suspicious, false);
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
