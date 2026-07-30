'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DISPATCH_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'lib', 'crusher', 'shim-dispatch.js');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function writeFakeBinary(filePath, scriptBody) {
  fs.writeFileSync(filePath, `#!/bin/sh\n${scriptBody}\n`, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

function seedManifest(homeDir, entries) {
  const binDir = path.join(homeDir, '.egc', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'manifest.json'), JSON.stringify(entries));
}

function runShim(homeDir, name, args, options = {}) {
  return spawnSync(process.execPath, [DISPATCH_SCRIPT, name, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
    ...options,
  });
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.stack || err.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing scripts/lib/crusher/shim-dispatch.js ===\n');
  let passed = 0;
  let failed = 0;

  if (test('a non-generic command with large output gets compressed with the crusher marker', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      const fakeGit = path.join(dir, 'fake-git');
      const bigBody = Array.from({ length: 100 }, (_, i) => `commit ${'a'.repeat(40)}\nAuthor: x\nDate: y\n\n    message ${i}\n`).join('\n');
      writeFakeBinary(fakeGit, `cat <<'EOF'\n${bigBody}\nEOF`);
      seedManifest(dir, { git: fakeGit });

      const result = runShim(dir, 'git', ['log', '--stat']);
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('[egc-crusher] saved'), 'expected the crusher marker in output');
      assert.ok(result.stdout.length < bigBody.length, 'expected compressed output to be smaller than the original');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('a generic command (git status) never gets captured or compressed, even with large output', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      const fakeGit = path.join(dir, 'fake-git');
      const bigBody = 'x'.repeat(5000);
      writeFakeBinary(fakeGit, `printf '%s' '${bigBody}'`);
      seedManifest(dir, { git: fakeGit });

      const result = runShim(dir, 'git', ['status']);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, bigBody);
      assert.ok(!result.stdout.includes('[egc-crusher]'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('small non-generic output (below the crush threshold) passes through unchanged', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      const fakeGit = path.join(dir, 'fake-git');
      writeFakeBinary(fakeGit, `echo 'commit abc123'`);
      seedManifest(dir, { git: fakeGit });

      const result = runShim(dir, 'git', ['log']);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout.trim(), 'commit abc123');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('the real exit code is preserved through the shim', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      const fakeGit = path.join(dir, 'fake-git');
      writeFakeBinary(fakeGit, `echo 'failure'\nexit 7`);
      seedManifest(dir, { git: fakeGit });

      const result = runShim(dir, 'git', ['status']);
      assert.strictEqual(result.status, 7);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('stdin is passed through to the real binary untouched', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      const fakeCat = path.join(dir, 'fake-npm');
      writeFakeBinary(fakeCat, 'cat');
      seedManifest(dir, { npm: fakeCat });

      const result = runShim(dir, 'npm', ['status'], { input: 'hello from stdin' });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, 'hello from stdin');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('an unresolvable binary name exits 127 with "command not found"', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      seedManifest(dir, {});
      const result = runShim(dir, 'totally-fake-binary-xyz-123', ['--version']);
      assert.strictEqual(result.status, 127);
      assert.ok(result.stderr.includes('command not found'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('a stale manifest entry pointing nowhere degrades to "command not found", never crashes', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      // The manifest points at a path that does not exist, and a fresh PATH
      // lookup for this nonsense name also fails -- must degrade to "command
      // not found", not an uncaught throw or a hung process.
      seedManifest(dir, { 'totally-fake-binary-xyz-123': path.join(dir, 'does-not-exist') });
      const result = runShim(dir, 'totally-fake-binary-xyz-123', []);
      assert.strictEqual(result.status, 127);
      assert.strictEqual(result.signal, null, 'must exit cleanly, not crash/signal');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
