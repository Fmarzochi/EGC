'use strict';

// Scrubber PDF metadata: in-place, same-length redaction of the Document
// Information Dictionary. Built on synthetic minimal PDFs so the byte-offset
// guarantee (cleaned length equals original length) is verified directly.

const assert = require('node:assert');
const { detectPdf, cleanPdf, inspectPdf } = require('../../scripts/lib/scrubber/pdf-meta');

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

function pdf(body) {
  return Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`, 'latin1');
}

check('detectPdf recognizes the PDF header only', () => {
  assert.strictEqual(detectPdf(pdf('x')), true);
  assert.strictEqual(detectPdf(Buffer.from('not a pdf', 'latin1')), false);
});

check('blanks Info dictionary metadata in place, preserving length', () => {
  const buf = pdf('1 0 obj\n<< /Title (My Title) /Producer (SomeAI 1.0) /Author (Jane) >>\nendobj');
  const r = cleanPdf(buf);
  assert.strictEqual(r.partial, true);
  assert.strictEqual(r.encrypted, false);
  assert.ok(r.removed.includes('pdf:Title'));
  assert.ok(r.removed.includes('pdf:Producer'));
  assert.ok(r.removed.includes('pdf:Author'));
  assert.strictEqual(r.cleaned.length, buf.length); // byte offsets preserved
  const text = r.cleaned.toString('latin1');
  assert.ok(!text.includes('SomeAI'));
  assert.ok(!text.includes('My Title'));
  assert.ok(!text.includes('Jane'));
  assert.ok(text.includes('/Producer ('));
  assert.ok(text.includes('%%EOF'));
});

check('blanks a hex-string metadata value', () => {
  const buf = pdf('<< /Producer <536f6d654149> >>');
  const r = cleanPdf(buf);
  assert.ok(r.removed.includes('pdf:Producer'));
  assert.strictEqual(r.cleaned.length, buf.length);
  assert.ok(!r.cleaned.toString('latin1').includes('536f6d654149'));
});

check('does not match a key that is a prefix of a longer name', () => {
  const buf = pdf('<< /CreatorTool (KeepThis) >>');
  const r = cleanPdf(buf);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.toString('latin1').includes('KeepThis'));
});

check('does not treat a following dictionary as a hex value', () => {
  const buf = pdf('<< /Author << /Nested (x) >> >>');
  const r = cleanPdf(buf);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.toString('latin1').includes('/Nested (x)'));
});

check('leaves an encrypted PDF untouched and reports it', () => {
  const buf = pdf('trailer << /Encrypt 5 0 R /Info 1 0 R >>\n1 0 obj << /Producer (SomeAI) >> endobj');
  const r = cleanPdf(buf);
  assert.strictEqual(r.encrypted, true);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.equals(buf));
  assert.ok(r.cleaned.toString('latin1').includes('SomeAI'));
});

check('a non-pdf buffer is returned unchanged', () => {
  const buf = Buffer.from('/Producer (SomeAI)', 'latin1');
  const r = cleanPdf(buf);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.equals(buf));
});

check('inspectPdf reports partial and suspicious honestly', () => {
  const suspicious = inspectPdf(pdf('<< /Producer (SomeAI) >>'));
  assert.strictEqual(suspicious.partial, true);
  assert.strictEqual(suspicious.suspicious, true);
  const clean = inspectPdf(pdf('<< /Type /Catalog >>'));
  assert.strictEqual(clean.suspicious, false);
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
