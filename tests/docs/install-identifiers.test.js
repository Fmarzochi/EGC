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

  test(`${relativePath} documents the canonical marketplace plugin identifier`, () => {
    assert.ok(content.includes('egc@egc'));
  });
}

const pluginAndManualInstallDocs = [
  'README.md',
  'README.zh-CN.md',
  'README.zh-CN.md',
];

const publicCommandNamespaceDocs = [
  'README.md',
  'README.zh-CN.md',
  'docs/pt-BR/README.md',
  'docs/tr/README.md',
  'docs/ko-KR/README.md',
  'docs/ja-JP/README.md',
  'README.zh-CN.md',
  'docs/zh-TW/README.md',
];

for (const relativePath of pluginAndManualInstallDocs) {
  const absolute2 = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolute2)) { console.log(`SKIP: ${relativePath} (baseline-absent)`); continue; }
  const content = fs.readFileSync(absolute2, 'utf8');

  test(`${relativePath} warns not to run the full installer after plugin install`, () => {
    assert.ok(
      content.includes('--profile full'),
      'Expected docs to mention the full installer explicitly'
    );
    assert.ok(
      content.includes('/plugin install'),
      'Expected docs to mention plugin install explicitly'
    );
    assert.ok(
      content.includes('不要再运行')
      || content.includes('do not run'),
      'Expected docs to warn that plugin install and full install are not sequential'
    );
  });
}

for (const relativePath of publicCommandNamespaceDocs) {
  const absolute3 = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolute3)) { console.log(`SKIP: ${relativePath} (baseline-absent)`); continue; }
  const content = fs.readFileSync(absolute3, 'utf8');

  test(`${relativePath} uses the canonical plugin command namespace`, () => {
    assert.ok(
      !content.includes('/egc:'),
      'Expected docs not to advertise the unsupported /egc: plugin alias'
    );
    assert.ok(
      content.includes('/egc:plan'),
      'Expected docs to show the canonical plugin command namespace'
    );
  });
}

if (failed > 0) {
  console.log(`\nFailed: ${failed}`);
  process.exit(1);
}

console.log(`\nPassed: ${passed}`);
