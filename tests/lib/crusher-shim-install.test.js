'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { install, uninstall, status, SHIM_BINARY_NAMES } = require('../../scripts/lib/crusher/shim-install');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function withHome(tempHome, fn) {
  const saved = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
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
  console.log('\n=== Testing scripts/lib/crusher/shim-install.js ===\n');
  let passed = 0;
  let failed = 0;

  if (test('install() accounts for every SHIM_BINARY_NAMES entry as installed or skipped, never dropped', () => {
    const dir = createTempDir('egc-shim-install-');
    try {
      withHome(dir, () => {
        const result = install();
        const all = new Set([...result.installed, ...result.skipped]);
        assert.strictEqual(all.size, SHIM_BINARY_NAMES.length);
        for (const name of SHIM_BINARY_NAMES) assert.ok(all.has(name), `${name} missing from installed+skipped`);
      });
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('install() writes an executable launcher and a real manifest path for every installed binary', () => {
    const dir = createTempDir('egc-shim-install-');
    try {
      withHome(dir, () => {
        const result = install();
        assert.ok(result.installed.length > 0, 'expected at least one binary (e.g. git) to be found on this machine');

        const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'), 'utf8'));
        for (const name of result.installed) {
          const launcherPath = process.platform === 'win32' ? path.join(result.dir, `${name}.cmd`) : path.join(result.dir, name);
          assert.ok(fs.existsSync(launcherPath), `launcher missing for ${name}`);
          if (process.platform !== 'win32') {
            const mode = fs.statSync(launcherPath).mode & 0o777;
            assert.ok(mode & 0o100, `${name} launcher must be executable`);
          }
          assert.ok(manifest[name] && fs.existsSync(manifest[name]), `manifest entry for ${name} must point at a real file`);
        }
      });
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('installing twice appends the PATH block to an existing rc file exactly once', () => {
    if (process.platform === 'win32') return; // rc-file logic is POSIX-only
    const dir = createTempDir('egc-shim-install-');
    try {
      withHome(dir, () => {
        const rcPath = path.join(dir, '.bashrc');
        fs.writeFileSync(rcPath, '# pre-existing bashrc content\n');

        install();
        install();

        const content = fs.readFileSync(rcPath, 'utf8');
        const occurrences = content.split('EGC Token Crusher shim').length - 1;
        assert.strictEqual(occurrences, 1, 'PATH block must be idempotent across repeated installs');
        assert.ok(content.includes('# pre-existing bashrc content'), 'must not clobber existing rc content');
      });
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('install() never throws when no rc file candidates exist at all', () => {
    const dir = createTempDir('egc-shim-install-');
    try {
      withHome(dir, () => {
        assert.doesNotThrow(() => install());
      });
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('uninstall() removes every launcher, the manifest, and the PATH block cleanly', () => {
    if (process.platform === 'win32') return; // rc-file logic is POSIX-only
    const dir = createTempDir('egc-shim-install-');
    try {
      withHome(dir, () => {
        const rcPath = path.join(dir, '.bashrc');
        fs.writeFileSync(rcPath, '# original line one\n# original line two\n');

        const installed = install();
        const removed = uninstall();

        assert.deepStrictEqual(new Set(removed.removed), new Set(installed.installed));
        assert.ok(!fs.existsSync(path.join(installed.dir, 'manifest.json')));
        for (const name of installed.installed) {
          assert.ok(!fs.existsSync(path.join(installed.dir, name)));
        }

        const content = fs.readFileSync(rcPath, 'utf8');
        assert.ok(!content.includes('EGC Token Crusher shim'));
        assert.ok(content.includes('# original line one'));
        assert.ok(content.includes('# original line two'));
      });
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('status() reports the shimmed list and whether the dir is active on the current PATH', () => {
    const dir = createTempDir('egc-shim-install-');
    try {
      withHome(dir, () => {
        const before = status();
        assert.strictEqual(before.dirExists, false);
        assert.deepStrictEqual(before.shimmed, []);

        const installed = install();
        const afterInstall = status();
        assert.strictEqual(afterInstall.dirExists, true);
        assert.deepStrictEqual(new Set(afterInstall.shimmed), new Set(installed.installed));
        assert.strictEqual(afterInstall.activeInCurrentShell, false, 'installing does not change this process\'s own PATH');

        const savedPath = process.env.PATH;
        process.env.PATH = `${installed.dir}${path.delimiter}${savedPath}`;
        try {
          assert.strictEqual(status().activeInCurrentShell, true);
        } finally {
          process.env.PATH = savedPath;
        }
      });
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
