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
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new Error('async test cases are not supported by this harness');
    }
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

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
// A minimal Start-of-Frame segment (marker only needs to be recognized).
const SOF = jpegSeg(0xc0, Buffer.alloc(6));
// A minimal Start-of-Scan segment plus entropy data with no 0xff bytes.
const SOS = Buffer.concat([jpegSeg(0xda, Buffer.from([0x01, 0x00])), Buffer.from([0x00, 0x11, 0x22, 0x33])]);

check('png drops a tEXt chunk and keeps image chunks', () => {
  const png = Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', Buffer.alloc(13)),
    pngChunk('tEXt', Buffer.from('Software\0SomeAI', 'latin1')),
    pngChunk('IDAT', Buffer.from([1, 2, 3])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const r = cleanPng(png);
  assert.strictEqual(r.valid, true);
  assert.ok(r.removed.includes('png:tEXt'));
  assert.ok(r.cleaned.subarray(0, 8).equals(PNG_SIG));
  assert.ok(!r.cleaned.toString('latin1').includes('SomeAI'));
  assert.ok(r.cleaned.toString('latin1').includes('IHDR'));
  assert.ok(r.cleaned.toString('latin1').includes('IEND'));
  assert.strictEqual(cleanPng(r.cleaned).removed.length, 0);
});

check('png drops an unknown private ancillary chunk but keeps known color chunks', () => {
  const png = Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', Buffer.alloc(13)),
    pngChunk('gAMA', Buffer.alloc(4)),
    pngChunk('prVt', Buffer.from('hidden provenance', 'latin1')),
    pngChunk('IDAT', Buffer.from([1])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const r = cleanPng(png);
  assert.strictEqual(r.valid, true);
  assert.ok(r.removed.includes('png:prVt'));
  assert.ok(!r.cleaned.toString('latin1').includes('hidden provenance'));
  assert.ok(r.cleaned.toString('latin1').includes('gAMA'));
});

check('png with no droppable chunk is returned unchanged', () => {
  const png = Buffer.concat([PNG_SIG, pngChunk('IHDR', Buffer.alloc(13)), pngChunk('IDAT', Buffer.from([9])), pngChunk('IEND', Buffer.alloc(0))]);
  const r = cleanPng(png);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.equals(png));
});

check('png with a malformed chunk length bails out unchanged (valid:false)', () => {
  const bad = Buffer.concat([PNG_SIG, Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('tEXt', 'latin1'), Buffer.from([1, 2])]);
  const r = cleanPng(bad);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.equals(bad));
});

check('png with trailing bytes after IEND is left untouched (no truncation)', () => {
  const png = Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', Buffer.alloc(13)),
    pngChunk('tEXt', Buffer.from('x\0y', 'latin1')),
    pngChunk('IEND', Buffer.alloc(0)),
    Buffer.from('TRAILER', 'latin1'),
  ]);
  const r = cleanPng(png);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.equals(png));
});

check('jpeg drops APP1 (EXIF/XMP) and keeps the scan verbatim', () => {
  const jpeg = Buffer.concat([
    SOI,
    jpegSeg(0xe0, Buffer.from('JFIF\0', 'latin1')),
    jpegSeg(0xe1, Buffer.from('Exif\0\0secretdata', 'latin1')),
    jpegSeg(0xdb, Buffer.alloc(4)),
    SOF,
    SOS,
    EOI,
  ]);
  const r = cleanJpeg(jpeg);
  assert.strictEqual(r.valid, true);
  assert.ok(r.removed.includes('jpeg:app1'));
  assert.ok(r.cleaned.subarray(0, 2).equals(SOI));
  assert.ok(!r.cleaned.toString('latin1').includes('secretdata'));
  assert.ok(r.cleaned.toString('latin1').includes('JFIF'));
  assert.strictEqual(r.cleaned[r.cleaned.length - 1], 0xd9);
});

check('jpeg labels a COM segment as jpeg:com, not app14', () => {
  const jpeg = Buffer.concat([SOI, jpegSeg(0xfe, Buffer.from('a comment', 'latin1')), SOF, SOS, EOI]);
  const r = cleanJpeg(jpeg);
  assert.strictEqual(r.valid, true);
  assert.ok(r.removed.includes('jpeg:com'));
  assert.ok(!r.removed.includes('jpeg:app14'));
});

check('progressive jpeg drops metadata between two scans', () => {
  const jpeg = Buffer.concat([SOI, jpegSeg(0xdb, Buffer.alloc(4)), SOF, SOS, jpegSeg(0xe1, Buffer.from('Exif\0\0between', 'latin1')), SOS, EOI]);
  const r = cleanJpeg(jpeg);
  assert.strictEqual(r.valid, true);
  assert.ok(r.removed.includes('jpeg:app1'));
  assert.ok(!r.cleaned.toString('latin1').includes('between'));
});

check('jpeg with only baseline segments is unchanged', () => {
  const jpeg = Buffer.concat([SOI, jpegSeg(0xe0, Buffer.from('JFIF\0', 'latin1')), SOF, SOS, EOI]);
  const r = cleanJpeg(jpeg);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.equals(jpeg));
});

check('jpeg truncated without EOI bails out unchanged (valid:false)', () => {
  const jpeg = Buffer.concat([SOI, jpegSeg(0xe1, Buffer.from('Exif\0\0x', 'latin1')), jpegSeg(0xdb, Buffer.alloc(4))]);
  const r = cleanJpeg(jpeg);
  assert.strictEqual(r.valid, false);
  assert.ok(r.cleaned.equals(jpeg));
});

check('detectImageFormat recognizes png/jpeg and rejects others', () => {
  assert.strictEqual(detectImageFormat(PNG_SIG), 'png');
  assert.strictEqual(detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.strictEqual(detectImageFormat(Buffer.from('not an image', 'latin1')), null);
});

check('cleanImage marks a recognized-but-unsupported format as not scrubbed', () => {
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(8)]);
  const c = cleanImage(webp);
  assert.strictEqual(c.format, 'webp');
  assert.strictEqual(c.supported, false);
  assert.strictEqual(c.valid, false);
  assert.ok(c.cleaned.equals(webp));
  assert.strictEqual(inspectImage(webp).scanned, false);
});

check('cleanImage and inspectImage dispatch a valid png', () => {
  const png = Buffer.concat([PNG_SIG, pngChunk('IHDR', Buffer.alloc(13)), pngChunk('iTXt', Buffer.from('k\0\0\0\0\0v', 'latin1')), pngChunk('IDAT', Buffer.from([1])), pngChunk('IEND', Buffer.alloc(0))]);
  const c = cleanImage(png);
  assert.strictEqual(c.format, 'png');
  assert.strictEqual(c.supported, true);
  assert.strictEqual(c.valid, true);
  assert.ok(c.removed.includes('png:iTXt'));
  const i = inspectImage(png);
  assert.strictEqual(i.scanned, true);
  assert.strictEqual(i.suspicious, true);
  assert.strictEqual(inspectImage(Buffer.from('plain', 'latin1')).suspicious, false);
});

check('png keeps APNG animation chunks while dropping text', () => {
  const png = Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', Buffer.alloc(13)),
    pngChunk('acTL', Buffer.alloc(8)),
    pngChunk('tEXt', Buffer.from('k\0v', 'latin1')),
    pngChunk('fcTL', Buffer.alloc(26)),
    pngChunk('IDAT', Buffer.from([1])),
    pngChunk('fdAT', Buffer.from([2, 3])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const r = cleanPng(png);
  assert.strictEqual(r.valid, true);
  assert.ok(r.removed.includes('png:tEXt'));
  assert.ok(r.cleaned.toString('latin1').includes('acTL'));
  assert.ok(r.cleaned.toString('latin1').includes('fcTL'));
  assert.ok(r.cleaned.toString('latin1').includes('fdAT'));
});

check('png without IDAT is not a valid image and is left untouched', () => {
  const png = Buffer.concat([PNG_SIG, pngChunk('IHDR', Buffer.alloc(13)), pngChunk('tEXt', Buffer.from('k\0v', 'latin1')), pngChunk('IEND', Buffer.alloc(0))]);
  const r = cleanPng(png);
  assert.strictEqual(r.valid, false);
  assert.ok(r.cleaned.equals(png));
});

check('jpeg with 0xff fill bytes before the scan marker is handled', () => {
  const jpeg = Buffer.concat([SOI, jpegSeg(0xe1, Buffer.from('Exif\0\0z', 'latin1')), SOF, Buffer.from([0xff, 0xff]), SOS, EOI]);
  const r = cleanJpeg(jpeg);
  assert.strictEqual(r.valid, true);
  assert.ok(r.removed.includes('jpeg:app1'));
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
