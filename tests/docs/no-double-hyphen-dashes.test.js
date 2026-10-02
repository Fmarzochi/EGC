'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

const docs = ['docs/installation.md', 'docs/TROUBLESHOOTING.md'];

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

function hasDoubleHyphenDash(line) {
  // Ignore inline code and Markdown link destinations.
  let text = line.replace(/`[^`]*`/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '');

  // Ignore Markdown table separators.
  if (/^\s*\|?[\s:-]+\|[\s|:-]+\|?\s*$/.test(text)) {
    return false;
  }

  // Ignore CLI flags such as --raw, --target, --history, --lts.
  text = text.replace(/(^|[^\w-])--[\w-]+/g, '$1');

  // Ignore code-block content represented by indentation.
  if (/^\s{4}/.test(line)) {
    return false;
  }

  // Detect remaining double hyphens used as punctuation.
  return /--/.test(text);
}

console.log('\n=== Testing docs for double-hyphen dash separators ===\n');

test('detects spaced double-hyphen dash punctuation', () => {
  assert.strictEqual(hasDoubleHyphenDash('hello -- world'), true);
});

test('detects unspaced double-hyphen dash punctuation', () => {
  assert.strictEqual(hasDoubleHyphenDash('hello--world'), true);
});

test('allows CLI flags', () => {
  assert.strictEqual(hasDoubleHyphenDash('Run the command with --raw.'), false);
});

test('allows code-formatted filenames', () => {
  assert.strictEqual(hasDoubleHyphenDash('See `some--filename.md` for details.'), false);
});

test('allows Markdown syntax', () => {
  assert.strictEqual(hasDoubleHyphenDash('[link](https://example.com?a=1--2)'), false);
});

for (const relativePath of docs) {
  test(`${relativePath} does not use double hyphens as dash punctuation`, () => {
    const content = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

    const lines = content.split(/\r?\n/);
    const offenders = [];

    lines.forEach((line, index) => {
      if (hasDoubleHyphenDash(line)) {
        offenders.push(`${index + 1}: ${line}`);
      }
    });

    assert.deepStrictEqual(offenders, [], `Found double-hyphen dash punctuation:\n${offenders.join('\n')}`);
  });
}

if (failed > 0) {
  console.log(`\nFailed: ${failed}`);
  process.exit(1);
}

console.log(`\nPassed: ${passed}`);
