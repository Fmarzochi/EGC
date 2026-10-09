/**
 * Tests for scripts/lib/no-follow-accumulator.js
 *
 * Run with: node tests/lib/no-follow-accumulator.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readFileNoFollow, appendLineNoFollow, writeAllBytesSync } = require('../../scripts/lib/no-follow-accumulator');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-no-follow-accum-'));

console.log('\nno-follow-accumulator\n======================\n');

if (test('appendLineNoFollow creates the file with mode 0600', () => {
  const target = path.join(dir, 'a.txt');
  const ok = appendLineNoFollow(target, 'line\n');
  assert.strictEqual(ok, true);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'line\n');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
  }
})) passed++; else failed++;

if (test('appendLineNoFollow accumulates across calls', () => {
  const target = path.join(dir, 'b.txt');
  appendLineNoFollow(target, 'one\n');
  appendLineNoFollow(target, 'two\n');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'one\ntwo\n');
})) passed++; else failed++;

if (process.platform !== 'win32') {
  if (test('appendLineNoFollow tightens a pre-existing file left at a wider mode', () => {
    const target = path.join(dir, 'c.txt');
    fs.writeFileSync(target, '', { mode: 0o644 });
    appendLineNoFollow(target, 'line\n');
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
  })) passed++; else failed++;

  if (test('appendLineNoFollow refuses to follow a symlink at the target path', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-no-follow-outside-'));
    const victim = path.join(outside, 'victim.txt');
    const link = path.join(dir, 'link.txt');
    fs.writeFileSync(victim, 'untouched');
    fs.symlinkSync(victim, link);
    const ok = appendLineNoFollow(link, 'line\n');
    assert.strictEqual(ok, false);
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'untouched');
    fs.rmSync(outside, { recursive: true, force: true });
  })) passed++; else failed++;

  if (test('readFileNoFollow refuses to follow a symlink at the target path', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-no-follow-outside-'));
    const secret = path.join(outside, 'secret.txt');
    const link = path.join(dir, 'read-link.txt');
    fs.writeFileSync(secret, 'secret content');
    fs.symlinkSync(secret, link);
    assert.strictEqual(readFileNoFollow(link), null);
    fs.rmSync(outside, { recursive: true, force: true });
  })) passed++; else failed++;
}

if (test('readFileNoFollow returns null for a missing file', () => {
  assert.strictEqual(readFileNoFollow(path.join(dir, 'does-not-exist.txt')), null);
})) passed++; else failed++;

if (test('readFileNoFollow reads back what appendLineNoFollow wrote', () => {
  const target = path.join(dir, 'd.txt');
  appendLineNoFollow(target, 'x\n');
  appendLineNoFollow(target, 'y\n');
  assert.strictEqual(readFileNoFollow(target), 'x\ny\n');
})) passed++; else failed++;

if (test('writeAllBytesSync writes every byte of a large buffer', () => {
  const target = path.join(dir, 'e.txt');
  const fd = fs.openSync(target, 'w');
  try {
    const big = 'z'.repeat(200_000);
    writeAllBytesSync(fd, big);
  } finally {
    fs.closeSync(fd);
  }
  assert.strictEqual(fs.statSync(target).size, 200_000);
})) passed++; else failed++;

if (test('writeAllBytesSync throws on zero progress instead of silently dropping data', () => {
  const target = path.join(dir, 'f.txt');
  const fd = fs.openSync(target, 'w');
  try {
    assert.throws(() => {
      const realWriteSync = fs.writeSync;
      fs.writeSync = () => 0;
      try {
        writeAllBytesSync(fd, 'anything');
      } finally {
        fs.writeSync = realWriteSync;
      }
    }, /short write/);
  } finally {
    fs.closeSync(fd);
  }
})) passed++; else failed++;

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
