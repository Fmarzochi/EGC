'use strict';

// Scrubber Layer A engine: invisible Unicode, space look-alikes, dashes, and
// the load-bearing preservation rules that keep multilingual text intact.
// Fixtures are built with String.fromCodePoint so this source stays pure ASCII
// (the repo's unicode-safety gate forbids literal invisible characters).

const assert = require('node:assert');
const { inspect, clean } = require('../../scripts/lib/scrubber/engine');

const cp = (...codes) => String.fromCodePoint(...codes);
const ZWSP = cp(0x200b);
const ZWJ = cp(0x200d);
const WJ = cp(0x2060);
const BOM = cp(0xfeff);
const SOFT_HYPHEN = cp(0x00ad);
const NBSP = cp(0x00a0);
const IDEO_SPACE = cp(0x3000);
const RLM = cp(0x200f);
const RLO = cp(0x202e);
const LRE = cp(0x202a);
const PDF = cp(0x202c);
const EM_DASH = cp(0x2014);
const EN_DASH = cp(0x2013);
const MINUS = cp(0x2212);
const VS16 = cp(0xfe0f);

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

check('strips a zero-width space between ASCII', () => {
  const r = clean(`a${ZWSP}b`);
  assert.strictEqual(r.cleaned, 'ab');
  assert.strictEqual(r.stats.removedCount, 1);
});

check('strips BOM, word joiner, and soft hyphen', () => {
  const r = clean(`${BOM}hel${SOFT_HYPHEN}lo${WJ} world`);
  assert.strictEqual(r.cleaned, 'hello world');
  assert.strictEqual(r.stats.removedCount, 3);
});

check('replaces NBSP and ideographic space with a plain space', () => {
  const r = clean(`a${NBSP}b${IDEO_SPACE}c`);
  assert.strictEqual(r.cleaned, 'a b c');
  assert.strictEqual(r.stats.replacedCount, 2);
});

check('leaves clean ASCII untouched', () => {
  const r = clean('hello world, this is fine.');
  assert.strictEqual(r.cleaned, 'hello world, this is fine.');
  assert.strictEqual(r.changed, false);
});

check('preserves the ZWJ inside an emoji family sequence', () => {
  const family = cp(0x1f468) + ZWJ + cp(0x1f469);
  assert.strictEqual(clean(family).cleaned, family);
});

check('preserves VS16 after an emoji base', () => {
  const arrow = cp(0x2194) + VS16;
  assert.strictEqual(clean(arrow).cleaned, arrow);
});

check('preserves a complete subdivision flag tag sequence', () => {
  const scotland = cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f);
  assert.strictEqual(clean(scotland).cleaned, scotland);
});

check('preserves RTL marks by default but reports them', () => {
  const rtl = `abc${RLM}`;
  assert.strictEqual(clean(rtl).cleaned, rtl);
  assert.ok(inspect(rtl).hits.some(h => h.kind === 'bidi'));
});

check('strips a bidi override (not a paired embedding)', () => {
  const r = clean(`a${RLO}b`);
  assert.strictEqual(r.cleaned, 'ab');
  assert.strictEqual(r.stats.removedCount, 1);
});

check('preserves a paired LRE/PDF embedding by default', () => {
  const embedded = `x${LRE}y${PDF}z`;
  assert.strictEqual(clean(embedded).cleaned, embedded);
});

check('turns an em dash clause separator into a comma', () => {
  const r = clean(`this ${EM_DASH} that`);
  assert.strictEqual(r.cleaned, 'this, that');
  assert.strictEqual(r.stats.dashCount, 1);
});

check('turns a numeric en-dash range into an ASCII hyphen range', () => {
  const r = clean(`1990${EN_DASH}2000`);
  assert.strictEqual(r.cleaned, '1990-2000');
  assert.strictEqual(r.stats.dashCount, 1);
});

check('leaves the ASCII hyphen and minus sign untouched', () => {
  const input = `well-known a - b and x${MINUS}y`;
  assert.strictEqual(clean(input).cleaned, input);
});

check('normalizes a Cyrillic look-alike only in aggressive mode', () => {
  const spoof = `${cp(0x0410)}dmin`;
  assert.strictEqual(clean(spoof).cleaned, spoof);
  assert.strictEqual(clean(spoof, { aggressive: true }).cleaned, 'Admin');
});

check('normalizes fullwidth Latin in aggressive mode', () => {
  const fullwidth = cp(0xff28, 0xff45, 0xff4c, 0xff4c, 0xff4f);
  assert.strictEqual(clean(fullwidth, { aggressive: true }).cleaned, 'Hello');
});

check('inspect reports a zero-width hit with count and confidence', () => {
  const report = inspect(`a${ZWSP}b${ZWSP}c`);
  const hit = report.hits.find(h => h.codepoint === 0x200b);
  assert.ok(hit);
  assert.strictEqual(hit.count, 2);
  assert.strictEqual(hit.confidence, 'probable');
});

check('inspect reports dashes and a clean text reports none', () => {
  assert.strictEqual(inspect(`a ${EM_DASH} b`).dashes, 1);
  assert.strictEqual(inspect('plain text').suspiciousTotal, 0);
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
