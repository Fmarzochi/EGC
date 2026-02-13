/**
 * Tests for scripts/setup-package-manager.js
 *
 * Tests CLI argument parsing and output via subprocess invocation.
 *
 * Run with: node tests/scripts/setup-package-manager.test.js
 */

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'setup-package-manager.js');

// Run the script with given args, return { stdout, stderr, code }
function run(args = [], env = {}) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      timeout: 10000
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      code: err.status || 1
    };
  }
}

// Test helper
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing setup-package-manager.js ===\n');

  let passed = 0;
  let failed = 0;

  // --help flag
  console.log('--help:');

  if (test('shows help with --help flag', () => {
    const result = run(['--help']);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Package Manager Setup'));
    assert.ok(result.stdout.includes('--detect'));
    assert.ok(result.stdout.includes('--global'));
    assert.ok(result.stdout.includes('--project'));
  })) passed++; else failed++;

  if (test('shows help with -h flag', () => {
    const result = run(['-h']);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Package Manager Setup'));
  })) passed++; else failed++;

  if (test('shows help with no arguments', () => {
    const result = run([]);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Package Manager Setup'));
  })) passed++; else failed++;

  // --detect flag
  console.log('\n--detect:');

  if (test('detects current package manager', () => {
    const result = run(['--detect']);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Package Manager Detection'));
    assert.ok(result.stdout.includes('Current selection'));
  })) passed++; else failed++;

  if (test('shows detection sources', () => {
    const result = run(['--detect']);
    assert.ok(result.stdout.includes('From package.json'));
    assert.ok(result.stdout.includes('From lock file'));
    assert.ok(result.stdout.includes('Environment var'));
  })) passed++; else failed++;

  if (test('shows available managers in detection output', () => {
    const result = run(['--detect']);
    assert.ok(result.stdout.includes('npm'));
    assert.ok(result.stdout.includes('pnpm'));
    assert.ok(result.stdout.includes('yarn'));
    assert.ok(result.stdout.includes('bun'));
  })) passed++; else failed++;

  // --list flag
  console.log('\n--list:');

  if (test('lists available package managers', () => {
    const result = run(['--list']);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Available Package Managers'));
    assert.ok(result.stdout.includes('npm'));
    assert.ok(result.stdout.includes('Lock file'));
    assert.ok(result.stdout.includes('Install'));
  })) passed++; else failed++;

  // --global flag
  console.log('\n--global:');

  if (test('rejects --global without package manager name', () => {
    const result = run(['--global']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('requires a package manager name'));
  })) passed++; else failed++;

  if (test('rejects --global with unknown package manager', () => {
    const result = run(['--global', 'unknown-pm']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('Unknown package manager'));
  })) passed++; else failed++;

  // --project flag
  console.log('\n--project:');

  if (test('rejects --project without package manager name', () => {
    const result = run(['--project']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('requires a package manager name'));
  })) passed++; else failed++;

  if (test('rejects --project with unknown package manager', () => {
    const result = run(['--project', 'unknown-pm']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('Unknown package manager'));
  })) passed++; else failed++;

  // Positional argument
  console.log('\npositional argument:');

  if (test('rejects unknown positional argument', () => {
    const result = run(['not-a-pm']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('Unknown option or package manager'));
  })) passed++; else failed++;

  // Environment variable
  console.log('\nenvironment variable:');

  if (test('detects env var override', () => {
    const result = run(['--detect'], { CLAUDE_PACKAGE_MANAGER: 'pnpm' });
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('pnpm'));
  })) passed++; else failed++;

  // --detect output completeness
  console.log('\n--detect output completeness:');

  if (test('shows all three command types in detection output', () => {
    const result = run(['--detect']);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Install:'), 'Should show Install command');
    assert.ok(result.stdout.includes('Run script:'), 'Should show Run script command');
    assert.ok(result.stdout.includes('Execute binary:'), 'Should show Execute binary command');
  })) passed++; else failed++;

  if (test('shows current marker for active package manager', () => {
    const result = run(['--detect']);
    assert.ok(result.stdout.includes('(current)'), 'Should mark current PM');
  })) passed++; else failed++;

  // ── Round 31: flag-as-PM-name rejection ──
  // Note: --help, --detect, --list are checked BEFORE --global/--project in argv
  // parsing, so passing e.g. --global --list triggers the --list handler first.
  // The startsWith('-') fix protects against flags that AREN'T caught earlier,
  // like --global --project or --project --unknown-flag.
  console.log('\n--global flag validation (Round 31):');

  if (test('rejects --global --project (flag not caught by earlier checks)', () => {
    const result = run(['--global', '--project']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('requires a package manager name'));
  })) passed++; else failed++;

  if (test('rejects --global --unknown-flag (arbitrary flag as PM name)', () => {
    const result = run(['--global', '--foo-bar']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('requires a package manager name'));
  })) passed++; else failed++;

  if (test('rejects --global -x (single-dash flag as PM name)', () => {
    const result = run(['--global', '-x']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('requires a package manager name'));
  })) passed++; else failed++;

  if (test('--global --list is handled by --list check first (exit 0)', () => {
    // --list is checked before --global in the parsing order
    const result = run(['--global', '--list']);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Available Package Managers'));
  })) passed++; else failed++;

  console.log('\n--project flag validation (Round 31):');

  if (test('rejects --project --global (cross-flag confusion)', () => {
    // --global handler runs before --project, catches it first
    const result = run(['--project', '--global']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('requires a package manager name'));
  })) passed++; else failed++;

  if (test('rejects --project --unknown-flag', () => {
    const result = run(['--project', '--bar']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('requires a package manager name'));
  })) passed++; else failed++;

  if (test('rejects --project -z (single-dash flag)', () => {
    const result = run(['--project', '-z']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('requires a package manager name'));
  })) passed++; else failed++;

  // Summary
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
