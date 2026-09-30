/**
 * Regression coverage for install and removal clarity: the README carries
 * the one install command and hands off to the installation guide, and the
 * guide is where removal, dry runs and component discovery are documented.
 */

const assert = require('assert');

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const README = path.join(REPO_ROOT, 'README.md');
const GUIDE = path.join(REPO_ROOT, 'docs', 'installation.md');

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
  console.log('\n=== Testing install README clarity ===\n');

  let passed = 0;
  let failed = 0;

  const readme = fs.readFileSync(README, 'utf8');
  const guide = fs.readFileSync(GUIDE, 'utf8');

  if (test('README gives the one install command and points at the installation guide', () => {
    assert.ok(
      readme.includes('npm install -g @egchq/egc && egc install'),
      'README should show the single npm install command'
    );
    assert.ok(
      readme.includes('docs/installation.md'),
      'README should hand off to the installation guide for every other command'
    );
  })) passed++; else failed++;

  if (test('installation guide documents removal, its dry run and the package uninstall', () => {
    assert.ok(
      guide.includes('### Removing EGC'),
      'guide should have a visible removal section'
    );
    assert.ok(
      guide.includes('`egc uninstall --target <target>`'),
      'guide should document uninstall per target'
    );
    assert.ok(
      guide.includes('`--dry-run` lists the paths first'),
      'guide should document the dry run before a removal'
    );
    assert.ok(
      guide.includes('npm uninstall -g @egchq/egc'),
      'guide should document removing the package itself'
    );
    assert.ok(
      guide.includes('removes every managed file that target\'s install-state recorded'),
      'guide should explain that uninstall touches only files recorded in the install-state'
    );
  })) passed++; else failed++;

  if (test('installation guide lists consult and uninstall in the command reference', () => {
    assert.ok(
      guide.includes('| `egc consult` |'),
      'guide should list consult as the component discovery command'
    );
    assert.ok(
      guide.includes('| `egc uninstall` |'),
      'guide should list uninstall in the command reference'
    );
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
