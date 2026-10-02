'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

const docs = ['docs/installation.md', 'docs/TROUBLESHOOTING.md'];

const DASH_PUNCTUATION = new RegExp(`(^|\\s)--(\\s|$)|\\w--\\w|[${String.fromCharCode(0x2013, 0x2014)}]`);

function proseOffenders(content) {
  const offenders = [];
  let inFence = false;

  content.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }

    if (inFence) return;

    const prose = line.replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']');

    if (DASH_PUNCTUATION.test(prose)) {
      offenders.push(`${index + 1}: ${line}`);
    }
  });

  return offenders;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

console.log('\n=== Testing docs for dash punctuation ===\n');

test('detects spaced double-hyphen dash punctuation', () => {
  assert.deepStrictEqual(proseOffenders('first -- second'), ['1: first -- second']);
});

test('detects unspaced double-hyphen dash punctuation', () => {
  assert.deepStrictEqual(proseOffenders('first--second'), ['1: first--second']);
});

test('detects double hyphen at end of line', () => {
  assert.deepStrictEqual(proseOffenders('ends with --'), ['1: ends with --']);
});

test('detects double hyphen at start of line', () => {
  assert.deepStrictEqual(proseOffenders('-- starts here'), ['1: -- starts here']);
});

test('detects em dash', () => {
  assert.deepStrictEqual(proseOffenders(`first ${String.fromCharCode(0x2014)} second`), [`1: first ${String.fromCharCode(0x2014)} second`]);
});

test('detects en dash', () => {
  assert.deepStrictEqual(proseOffenders(`first ${String.fromCharCode(0x2013)} second`), [`1: first ${String.fromCharCode(0x2013)} second`]);
});

test('allows CLI flags', () => {
  assert.deepStrictEqual(proseOffenders('egc install --target copilot'), []);
});

test('allows CLI flags in parentheses', () => {
  assert.deepStrictEqual(proseOffenders('run it (--raw skips compression)'), []);
});

test('allows double hyphens inside inline code', () => {
  assert.deepStrictEqual(proseOffenders('`Projetos--demo.md`'), []);
});

test('allows double hyphens inside Markdown link destinations', () => {
  assert.deepStrictEqual(proseOffenders('see [the guide](TROUBLESHOOTING.md#npm-install--g-on-windows)'), []);
});

for (const relativePath of docs) {
  test(`${relativePath} does not use invalid dash punctuation`, () => {
    const content = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

    const offenders = proseOffenders(content);

    assert.deepStrictEqual(offenders, [], `Found invalid dash punctuation:\n${offenders.join('\n')}`);
  });
}

if (failed > 0) {
  console.log(`\nFailed: ${failed}`);
  process.exit(1);
}

console.log(`\nPassed: ${passed}`);
