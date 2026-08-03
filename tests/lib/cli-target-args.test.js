'use strict';
/**
 * Tests for scripts/lib/cli-target-args.js
 *
 * Run with: node tests/lib/cli-target-args.test.js
 */
const assert = require('node:assert');
const path = require('node:path');
const { parseTargetArgs } = require('../../scripts/lib/cli-target-args');

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
const run = (name, fn) => { if (test(name, fn)) passed++; else failed++; };

console.log('\n=== Testing cli-target-args ===\n');

run('parses a single --target', () => {
  const result = parseTargetArgs(['node', 'script.js', '--target', 'claude']);
  assert.deepStrictEqual(result.targets, ['claude']);
});

run('parses multiple --target flags', () => {
  const result = parseTargetArgs(['node', 'script.js', '--target', 'claude', '--target', 'cursor']);
  assert.deepStrictEqual(result.targets, ['claude', 'cursor']);
});

run('--target with no value throws the exact original message', () => {
  assert.throws(
    () => parseTargetArgs(['node', 'script.js', '--target']),
    /^Error: --target requires a value$/,
  );
});

run('--repo-root resolves to an absolute path', () => {
  const result = parseTargetArgs(['node', 'script.js', '--repo-root', '.']);
  assert.strictEqual(result.repoRoot, path.resolve('.'));
});

run('--repo-root with no value throws the exact original message', () => {
  assert.throws(
    () => parseTargetArgs(['node', 'script.js', '--repo-root']),
    /^Error: --repo-root requires a path argument$/,
  );
});

run('--repo-root pointing at a nonexistent path throws', () => {
  assert.throws(
    () => parseTargetArgs(['node', 'script.js', '--repo-root', '/does/not/exist/xyz']),
    /--repo-root path does not exist/,
  );
});

run('--dry-run is ignored when supportsDryRun is false', () => {
  assert.throws(
    () => parseTargetArgs(['node', 'script.js', '--dry-run']),
    /Unknown argument: --dry-run/,
  );
});

run('--dry-run sets dryRun when supportsDryRun is true', () => {
  const result = parseTargetArgs(['node', 'script.js', '--dry-run'], { supportsDryRun: true });
  assert.strictEqual(result.dryRun, true);
});

run('--json sets json', () => {
  const result = parseTargetArgs(['node', 'script.js', '--json']);
  assert.strictEqual(result.json, true);
});

run('--help and -h both set help', () => {
  assert.strictEqual(parseTargetArgs(['node', 'script.js', '--help']).help, true);
  assert.strictEqual(parseTargetArgs(['node', 'script.js', '-h']).help, true);
});

run('unknown argument throws', () => {
  assert.throws(
    () => parseTargetArgs(['node', 'script.js', '--nope']),
    /Unknown argument: --nope/,
  );
});

run('no args returns all defaults', () => {
  const result = parseTargetArgs(['node', 'script.js']);
  assert.deepStrictEqual(result, { targets: [], repoRoot: null, dryRun: false, json: false, help: false });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
