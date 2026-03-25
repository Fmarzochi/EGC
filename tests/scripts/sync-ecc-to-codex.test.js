/**
 * Source-level tests for scripts/sync-ecc-to-codex.sh
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'sync-ecc-to-codex.sh');
const source = fs.readFileSync(scriptPath, 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing sync-ecc-to-codex.sh ===\n');

  let passed = 0;
  let failed = 0;

  if (test('run_or_echo does not use eval', () => {
    assert.ok(!source.includes('eval "$@"'), 'run_or_echo should not execute through eval');
  })) passed++; else failed++;

  if (test('run_or_echo executes argv directly', () => {
    assert.ok(source.includes('    "$@"'), 'run_or_echo should execute the argv vector directly');
  })) passed++; else failed++;

  if (test('dry-run output shell-escapes argv', () => {
    assert.ok(source.includes(`printf ' %q' "$@"`), 'Dry-run mode should print shell-escaped argv');
  })) passed++; else failed++;

  if (test('filesystem-changing calls use argv-form run_or_echo invocations', () => {
    assert.ok(source.includes('run_or_echo mkdir -p "$BACKUP_DIR"'), 'mkdir should use argv form');
    assert.ok(source.includes('run_or_echo rm -rf "$dest"'), 'rm should use argv form');
    assert.ok(source.includes('run_or_echo cp -R "$skill_dir" "$dest"'), 'recursive copy should use argv form');
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();