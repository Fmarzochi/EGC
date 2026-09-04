/**
 * The installer refuses to write through a symbolic link at the destination
 * or under a linked directory inside the target root (security audit
 * 2026-08-17, day 11); the root itself may be a link the user made.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { refuseLinkedDestination } = require('../../scripts/lib/install/apply');

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
  console.log('\n=== Testing linked destinations in the installer ===\n');
  let passed = 0;
  let failed = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-apply-links-'));
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  let links = true;
  try {
    fs.writeFileSync(path.join(outside, 'target.md'), 'outside');
    fs.symlinkSync(path.join(outside, 'target.md'), path.join(root, 'linked.md'));
    fs.symlinkSync(outside, path.join(root, 'linked-dir'), 'dir');
    fs.symlinkSync(root, path.join(dir, 'root-link'), 'dir');
  } catch (error) {
    links = false;
    console.log(`  - skipped: cannot create symlinks here (${error.code})`);
  }
  try {
    if (links) {
      if (test('a destination that is a link is refused', () => {
        assert.throws(() => refuseLinkedDestination(path.join(root, 'linked.md'), root), /symbolic link/);
      })) passed++; else failed++;

      if (test('a destination under a linked directory inside the root is refused, even when the file does not exist yet', () => {
        assert.throws(() => refuseLinkedDestination(path.join(root, 'linked-dir', 'deep', 'new.md'), root), /symbolic link/);
        assert.ok(!fs.existsSync(path.join(outside, 'deep')));
      })) passed++; else failed++;

      if (test('a root that is itself a link is allowed', () => {
        const viaLink = path.join(dir, 'root-link');
        assert.doesNotThrow(() => refuseLinkedDestination(path.join(viaLink, 'rules', 'plain.md'), viaLink));
      })) passed++; else failed++;
    }

    if (test('a plain destination, existing or not, passes', () => {
      fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(root, 'rules', 'existing.md'), 'x');
      assert.doesNotThrow(() => refuseLinkedDestination(path.join(root, 'rules', 'existing.md'), root));
      assert.doesNotThrow(() => refuseLinkedDestination(path.join(root, 'rules', 'later.md'), root));
      assert.doesNotThrow(() => refuseLinkedDestination(path.join(outside, 'elsewhere.md'), root));
    })) passed++; else failed++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
