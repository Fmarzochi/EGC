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

console.log('\n=== Testing docs for double-hyphen dash separators ===\n');

for (const relativePath of docs) {
  test(`${relativePath} does not use double hyphens as dash punctuation`, () => {
    const content = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

    const lines = content.split(/\r?\n/);
    const offenders = [];

    lines.forEach((line, index) => {
      if (/\s--\s/.test(line)) {
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
