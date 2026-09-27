'use strict';
/**
 * The source filters every install enumerator shares: tooling artifacts and
 * the install-state files a local install leaves inside a source tree are
 * never copied as sources, whatever the adapter names its state.
 */

const assert = require('node:assert');

const {
  isGeneratedRuntimeSourcePath,
  isIgnoredSourceDirectory,
  isIgnoredSourceFile,
} = require('../../scripts/lib/install-source-filters');

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

console.log('\n=== Testing the install source filters ===\n');

run('every adapter install-state name is a generated source, with either separator', () => {
  for (const sourcePath of [
    'bundle/egc/install-state.json',
    '.agents/egc/codex-install-state.json',
    '.agents/egc/goose-install-state.json',
    '.agents/egc/openhands-install-state.json',
    'bundle/egc-install-state.json',
    'egc-install-state.json',
    'bundle\\egc\\codex-install-state.json',
  ]) {
    assert.strictEqual(isGeneratedRuntimeSourcePath(sourcePath), true, sourcePath);
  }
});

run('a file that only looks like one is still a source', () => {
  for (const sourcePath of [
    'bundle/egc/notes.json',
    'bundle/myegc/install-state.json',
    'bundle/egc/nested/install-state.json',
    'commands/install-state.md',
    'bundle/egc-install-state.json.bak',
    '',
  ]) {
    assert.strictEqual(isGeneratedRuntimeSourcePath(sourcePath), false, sourcePath);
  }
});

run('tooling directories and files are ignored, ordinary ones are not', () => {
  assert.strictEqual(isIgnoredSourceDirectory('node_modules'), true);
  assert.strictEqual(isIgnoredSourceDirectory('commands'), false);
  assert.strictEqual(isIgnoredSourceFile('.DS_Store'), true);
  assert.strictEqual(isIgnoredSourceFile('cache.pyc'), true);
  assert.strictEqual(isIgnoredSourceFile('README.md'), false);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
