'use strict';

const assert = require('assert');
const { maybeSkipBaselineAbsent } = require('../lib/baseline-absent');

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    if (maybeSkipBaselineAbsent(error, name)) return true;
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

const publicInstallDocs = [
  'README.md',
  'README.zh-CN.md',
  'docs/pt-BR/README.md',
  'README.zh-CN.md',
  'docs/ja-JP/skills/configure-egc/SKILL.md',
  'docs/zh-CN/skills/configure-egc/SKILL.md',
];

console.log('\n=== Testing public install identifiers ===\n');

for (const relativePath of publicInstallDocs) {
  const absolute = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolute)) { console.log(`SKIP: ${relativePath} (baseline-absent)`); continue; }
  const content = fs.readFileSync(absolute, 'utf8');

  test(`${relativePath} does not use the stale egc@egc plugin identifier`, () => {
    assert.ok(!content.includes('egc@egc'));
  });
}

if (failed > 0) {
  console.log(`\nFailed: ${failed}`);
  process.exit(1);
}

console.log(`\nPassed: ${passed}`);
