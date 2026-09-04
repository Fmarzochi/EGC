/**
 * The atomic replacement used by the install replay: a destination that is
 * a link is replaced, never written through; modes are kept; a failed write
 * leaves nothing behind.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { copyFileKeepingMode, replaceFileWith } = require('../../scripts/lib/install/preserving-write');

const modes = process.platform !== 'win32';

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
  console.log('\n=== Testing the atomic file replacement ===\n');
  let passed = 0;
  let failed = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-preserving-write-'));
  try {
    if (test('a symlinked destination is replaced and its target is untouched', () => {
      const target = path.join(dir, 'target.txt');
      const link = path.join(dir, 'link.txt');
      fs.writeFileSync(target, 'target content');
      let linked = true;
      try {
        fs.symlinkSync(target, link);
      } catch (error) {
        linked = false;
        console.log(`    - skipped: cannot create symlinks here (${error.code})`);
      }
      if (!linked) return;
      replaceFileWith(link, descriptor => fs.writeFileSync(descriptor, 'replaced'));
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'target content');
      assert.strictEqual(fs.readFileSync(link, 'utf8'), 'replaced');
      assert.ok(!fs.lstatSync(link).isSymbolicLink(), 'the destination is a regular file now');
    })) passed++; else failed++;

    if (test('an existing destination keeps its mode, a new copy takes the source mode', () => {
      const existing = path.join(dir, 'existing.txt');
      fs.writeFileSync(existing, 'old');
      if (modes) fs.chmodSync(existing, 0o600);
      replaceFileWith(existing, descriptor => fs.writeFileSync(descriptor, 'new'));
      assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'new');
      if (modes) assert.strictEqual(fs.statSync(existing).mode & 0o777, 0o600);
      const source = path.join(dir, 'source.json');
      fs.writeFileSync(source, '{}');
      if (modes) fs.chmodSync(source, 0o640);
      const created = path.join(dir, 'created.json');
      copyFileKeepingMode(source, created);
      assert.strictEqual(fs.readFileSync(created, 'utf8'), '{}');
      if (modes) assert.strictEqual(fs.statSync(created).mode & 0o777, 0o640);
    })) passed++; else failed++;

    if (test('a failed write leaves no temporary file and no destination', () => {
      const destination = path.join(dir, 'never.txt');
      assert.throws(() => replaceFileWith(destination, () => { throw new Error('writer failed'); }), /writer failed/);
      assert.ok(!fs.existsSync(destination));
      assert.deepStrictEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
    })) passed++; else failed++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
