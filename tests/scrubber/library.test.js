'use strict';

// Scrubber library modules: AI co-authorship stripping (human co-authors kept)
// and the binary guard that keeps the write-hook off binary files.

const assert = require('node:assert');
const { stripAiCoauthorship } = require('../../scripts/lib/scrubber/coauthor-strip');
const { looksBinary, hasTextExtension } = require('../../scripts/lib/scrubber/binary-guard');

const ROBOT = String.fromCodePoint(0x1f916);

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

check('strips a Claude co-author trailer', () => {
  const msg = 'feat: add thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
  const r = stripAiCoauthorship(msg);
  assert.strictEqual(r.removed.length, 1);
  assert.strictEqual(r.message, 'feat: add thing');
});

check('strips a "Generated with" AI line', () => {
  const msg = `fix: bug\n\n${ROBOT} Generated with Claude Code`;
  const r = stripAiCoauthorship(msg);
  assert.strictEqual(r.removed.length, 1);
  assert.ok(!/Generated with/.test(r.message));
});

check('keeps a human co-author using a github noreply email', () => {
  const msg = 'feat: x\n\nCo-authored-by: John Doe <12345+johndoe@users.noreply.github.com>';
  const r = stripAiCoauthorship(msg);
  assert.strictEqual(r.removed.length, 0);
  assert.strictEqual(r.message, msg);
});

check('removes only the AI co-author when mixed with a human one', () => {
  const msg = [
    'feat: y',
    '',
    'Co-authored-by: Jane Dev <jane@example.com>',
    'Co-Authored-By: Claude <noreply@anthropic.com>',
  ].join('\n');
  const r = stripAiCoauthorship(msg);
  assert.strictEqual(r.removed.length, 1);
  assert.ok(/Jane Dev/.test(r.message));
  assert.ok(!/Claude/.test(r.message));
});

check('leaves a plain message untouched', () => {
  const msg = 'chore: tidy up\n\nJust a normal body line.';
  const r = stripAiCoauthorship(msg);
  assert.strictEqual(r.removed.length, 0);
  assert.strictEqual(r.message, msg);
});

check('detects binary by magic number (png, zip, pdf)', () => {
  assert.ok(looksBinary(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')));
  assert.ok(looksBinary(Buffer.from('PK\x03\x04', 'latin1')));
  assert.ok(looksBinary(Buffer.from('%PDF-1.7', 'latin1')));
});

check('treats normal text as non-binary', () => {
  assert.strictEqual(looksBinary('const x = 1;\nconsole.log(x);\n'), null);
  assert.strictEqual(looksBinary(''), null);
});

check('detects NUL bytes as binary', () => {
  assert.ok(looksBinary(Buffer.from('abc\x00def', 'latin1')));
});

check('refuses a decoded-binary string via NUL and replacement chars', () => {
  const nul = String.fromCodePoint(0);
  const replacement = String.fromCodePoint(0xfffd);
  assert.ok(looksBinary(`abc${nul}def`));
  assert.ok(looksBinary(`${replacement.repeat(30)}x`));
  assert.strictEqual(looksBinary('perfectly normal text'), null);
});

check('hasTextExtension recognizes text files and rejects binaries', () => {
  assert.ok(hasTextExtension('src/app.js'));
  assert.ok(hasTextExtension('README.MD'));
  assert.ok(hasTextExtension('a/b/c.py'));
  assert.strictEqual(hasTextExtension('image.png'), false);
  assert.strictEqual(hasTextExtension('archive.zip'), false);
  assert.strictEqual(hasTextExtension('Makefile'), false);
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
