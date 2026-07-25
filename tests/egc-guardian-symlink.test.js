'use strict';
/**
 * Tests that isProtectedPath resolves symlinks, so a link created inside an
 * allowed directory cannot point past the check into a denied path.
 *
 * Run with: node tests/egc-guardian-symlink.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildPath = path.join(
  __dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'validator.js',
);

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
if (process.platform === 'win32') {
  console.log('[SKIP] symlink creation needs elevation on Windows.');
  process.exit(0);
}

const { isProtectedPath } = require(buildPath);

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

console.log('\n=== Testing egc-guardian symlink resolution ===\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-sym-'));
const linkToEtc = path.join(tmp, 'link-to-etc');
fs.symlinkSync('/etc', linkToEtc);

run('a symlink pointing at a denied dir resolves and is protected', () => {
  assert.strictEqual(isProtectedPath(linkToEtc), true);
});
run('a plain path in a temp dir is not protected', () => {
  assert.strictEqual(isProtectedPath(path.join(tmp, 'notes.txt')), false);
});
run('a not-yet-created file resolves via its parent and stays allowed', () => {
  assert.strictEqual(isProtectedPath(path.join(tmp, 'new-file.md')), false);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
