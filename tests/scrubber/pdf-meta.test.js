'use strict';

// Scrubber PDF metadata: in-place, same-length redaction of the Document
// Information Dictionary, scoped to the Info object named by the trailer. Built
// on synthetic minimal PDFs so the byte-offset guarantee (cleaned length equals
// original length) and the stream-safety guarantee are verified directly.

const assert = require('node:assert');
const { detectPdf, cleanPdf, inspectPdf } = require('../../scripts/lib/scrubber/pdf-meta');

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

// A PDF whose trailer points /Info at object 1, whose dictionary body is
// `infoDict`. `extra` inserts additional objects between the Info object and
// the trailer.
function pdfWithInfo(infoDict, extra = '') {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< ${infoDict} >>\nendobj\n${extra}trailer\n<< /Info 1 0 R >>\n%%EOF\n`,
    'latin1',
  );
}

check('detectPdf recognizes the PDF header only', () => {
  assert.strictEqual(detectPdf(pdfWithInfo('/Title (x)')), true);
  assert.strictEqual(detectPdf(Buffer.from('not a pdf', 'latin1')), false);
});

check('blanks Info dictionary metadata in place, preserving length', () => {
  const buf = pdfWithInfo('/Title (My Title) /Producer (SomeAI 1.0) /Author (Jane)');
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
  assert.ok(text.includes('%%EOF'));
});

check('blanks a hex-string metadata value', () => {
  const buf = pdfWithInfo('/Producer <536f6d654149>');
  const r = cleanPdf(buf);
  assert.ok(r.removed.includes('pdf:Producer'));
  assert.strictEqual(r.cleaned.length, buf.length);
  assert.ok(!r.cleaned.toString('latin1').includes('536f6d654149'));
});

check('does not match a key that is a prefix of a longer name', () => {
  const buf = pdfWithInfo('/CreatorTool (KeepThis)');
  const r = cleanPdf(buf);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.toString('latin1').includes('KeepThis'));
});

check('does not treat a following dictionary as a hex value', () => {
  const buf = pdfWithInfo('/Author << /Nested (x) >>');
  const r = cleanPdf(buf);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.toString('latin1').includes('/Nested (x)'));
});

check('leaves an encrypted PDF untouched and reports it', () => {
  const buf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Producer (SomeAI) >>\nendobj\ntrailer\n<< /Encrypt 5 0 R /Info 1 0 R >>\n%%EOF\n', 'latin1');
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

check('a pdf with no /Info reference has nothing blanked (honestly partial)', () => {
  const buf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Producer (SomeAI) >>\nendobj\ntrailer\n<< /Root 2 0 R >>\n%%EOF\n', 'latin1');
  const r = cleanPdf(buf);
  assert.strictEqual(r.removed.length, 0);
  assert.ok(r.cleaned.toString('latin1').includes('SomeAI'));
});

check('does not treat /Encrypt in page text as an encrypted PDF', () => {
  const buf = pdfWithInfo('/Producer (SomeAI)', '5 0 obj\n(a string mentioning /Encrypt here)\nendobj\n');
  const r = cleanPdf(buf);
  assert.strictEqual(r.encrypted, false);
  assert.ok(r.removed.includes('pdf:Producer'));
  assert.ok(!r.cleaned.toString('latin1').includes('SomeAI'));
});

check('never blanks a metadata key outside the Info object (e.g. inside a stream)', () => {
  const streamObj = '5 0 obj\n<< /Length 33 >>\nstream\n/Producer (keep me inside the stream)\nendstream\nendobj\n';
  const buf = pdfWithInfo('/Producer (RealMeta)', streamObj);
  const r = cleanPdf(buf);
  assert.ok(r.removed.includes('pdf:Producer'));
  assert.ok(!r.cleaned.toString('latin1').includes('RealMeta')); // Info value blanked
  assert.ok(r.cleaned.toString('latin1').includes('keep me inside the stream')); // stream untouched
});

check('resolves /Info without matching a longer object number', () => {
  const buf = Buffer.from('%PDF-1.4\n11 0 obj\n<< /Producer (WrongObj) >>\nendobj\n1 0 obj\n<< /Producer (RightMeta) >>\nendobj\ntrailer\n<< /Info 1 0 R >>\n%%EOF\n', 'latin1');
  const r = cleanPdf(buf);
  assert.ok(r.removed.includes('pdf:Producer'));
  assert.ok(!r.cleaned.toString('latin1').includes('RightMeta'));
  assert.ok(r.cleaned.toString('latin1').includes('WrongObj')); // 11 0 obj is not the target
});

check('inspectPdf reports partial and suspicious honestly', () => {
  const suspicious = inspectPdf(pdfWithInfo('/Producer (SomeAI)'));
  assert.strictEqual(suspicious.partial, true);
  assert.strictEqual(suspicious.suspicious, true);
  const clean = inspectPdf(pdfWithInfo('/Trapped /False'));
  assert.strictEqual(clean.suspicious, false);
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
