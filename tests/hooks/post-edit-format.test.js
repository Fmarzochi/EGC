'use strict';

/**
 * Tests for scripts/hooks/post-edit-format.js (#1704): on Windows a locally
 * installed formatter runs through its JS entry under this Node, so a file
 * path with a space reaches it as one argument instead of being refused.
 *
 * Run with: node tests/hooks/post-edit-format.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { executeFormatterCommand } = require('../../scripts/hooks/post-edit-format');

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

let passed = 0;
let failed = 0;
const tally = ok => { if (ok) passed++; else failed++; };

console.log('\n=== Testing post-edit-format.js ===\n');

tally(test('on Windows a local formatter with a JS entry formats a path with a space, with no shell in between', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-1704-format-'));
  try {
    const entry = path.join(dir, 'fake-formatter.js');
    const record = path.join(dir, 'argv.json');
    fs.writeFileSync(entry, "require('fs').writeFileSync(process.env.FORMAT_RECORD, JSON.stringify(process.argv.slice(2)));\n");
    const target = path.join(dir, 'My Project (x)', 'app.js');
    process.env.FORMAT_RECORD = record;
    withPlatform('win32', () => executeFormatterCommand({ bin: 'C:\\tools\\prettier.cmd', prefix: [], entry }, ['--write', target], target, dir));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(record, 'utf8')), ['--write', target], 'the path arrived whole, as one argument');
  } finally {
    delete process.env.FORMAT_RECORD;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

tally(test('on Windows the .cmd runner fallback, which still needs a shell, keeps refusing shell metacharacters', () => {
  const unsafe = 'C:\\repo\\a&b.js';
  assert.throws(
    () => withPlatform('win32', () => executeFormatterCommand({ bin: 'npx.cmd', prefix: ['prettier'] }, ['--write', unsafe], unsafe, os.tmpdir())),
    /unsafe shell characters/
  );
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
