/**
 * Tests for scripts/lib/protocol-file-write.js (#1832).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeProtocolFile } = require('../../scripts/lib/protocol-file-write');

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.message}`);
    return false;
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-protocol-write-'));
}

function leftovers(dir) {
  return fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));
}

let passed = 0;
let failed = 0;
const tally = ok => { if (ok) passed++; else failed++; };

console.log('\n=== protocol-file-write (#1832) ===\n');

tally(test('a regular file is replaced with the new text, keeps its mode, and leaves no temporary file', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, 0o600);
    writeProtocolFile(file, 'new');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepStrictEqual(leftovers(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

tally(test('a missing file is created, with its directory', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'nested', 'GEMINI.md');
    writeProtocolFile(file, 'created');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'created');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

tally(test('a symlink to a file in another directory survives, and the file it points at holds the new text', () => {
  const dir = tempDir();
  try {
    const dotfiles = path.join(dir, 'dotfiles');
    const home = path.join(dir, 'home');
    fs.mkdirSync(dotfiles);
    fs.mkdirSync(home);
    const real = path.join(dotfiles, 'CLAUDE.md');
    const link = path.join(home, 'CLAUDE.md');
    fs.writeFileSync(real, 'old');
    try {
      fs.symlinkSync(real, link, 'file');
    } catch {
      console.log('  [SKIP] symlink not available on this runner');
      return;
    }
    writeProtocolFile(link, 'new');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is still a link');
    assert.strictEqual(fs.realpathSync(link), fs.realpathSync(real), 'and points where it did');
    assert.strictEqual(fs.readFileSync(real, 'utf8'), 'new');
    assert.deepStrictEqual(leftovers(dotfiles), []);
    assert.deepStrictEqual(leftovers(home), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

tally(test('a write that fails midway leaves the original text and its backup intact, and no temporary file', () => {
  const dir = tempDir();
  const originalWrite = fs.writeFileSync;
  try {
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, 'the person text');
    writeProtocolFile(`${file}.egc.bak`, fs.readFileSync(file, 'utf8'));
    fs.writeFileSync = (target, data, options) => {
      if (typeof target === 'number') {
        originalWrite.call(fs, target, String(data).slice(0, 3), options);
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return originalWrite.call(fs, target, data, options);
    };
    assert.throws(() => writeProtocolFile(file, 'the person text plus the protocol'), /disk full/);
    fs.writeFileSync = originalWrite;
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'the person text', 'the file the tool reads is untouched');
    assert.strictEqual(fs.readFileSync(`${file}.egc.bak`, 'utf8'), 'the person text', 'the backup still holds it');
    assert.deepStrictEqual(leftovers(dir), []);
  } finally {
    fs.writeFileSync = originalWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

tally(test('a chain of links whose last target is missing creates that target and leaves every link in place', () => {
  const dir = tempDir();
  try {
    const final = path.join(dir, 'dotfiles', 'CLAUDE.md');
    const middle = path.join(dir, 'middle', 'CLAUDE.md');
    const link = path.join(dir, 'home', 'CLAUDE.md');
    for (const p of [final, middle, link]) fs.mkdirSync(path.dirname(p), { recursive: true });
    try {
      fs.symlinkSync(final, middle, 'file');
      fs.symlinkSync(middle, link, 'file');
    } catch {
      console.log('  [SKIP] symlink not available on this runner');
      return;
    }
    writeProtocolFile(link, 'new');
    assert.ok(fs.lstatSync(link).isSymbolicLink() && fs.lstatSync(middle).isSymbolicLink(), 'both links stay links');
    assert.strictEqual(fs.readFileSync(final, 'utf8'), 'new', 'the missing final target is created');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

tally(test('a new file keeps the permissions of the creation mask', () => {
  if (process.platform === 'win32') return;
  const dir = tempDir();
  const previous = process.umask(0o077);
  try {
    const file = path.join(dir, 'GEMINI.md');
    writeProtocolFile(file, 'created');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'umask 077 gives 0600, not 0644');
  } finally {
    process.umask(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

tally(test('an existing file the process may not write is refused, not replaced', () => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) return;
  const dir = tempDir();
  try {
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, 'read only');
    fs.chmodSync(file, 0o444);
    assert.throws(() => writeProtocolFile(file, 'new'), error => error.code === 'EACCES');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'read only');
    assert.deepStrictEqual(leftovers(dir), []);
  } finally {
    fs.chmodSync(path.join(dir, 'CLAUDE.md'), 0o644);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
