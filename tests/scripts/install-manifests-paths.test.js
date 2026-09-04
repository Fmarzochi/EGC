/**
 * Manifest paths are locations inside the repository: the loader refuses an
 * absolute path or one that climbs out with '..' before any installer
 * derives a filesystem target from it (security audit 2026-08-17, C4).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadInstallManifests, isUnsafeManifestPath } = require('../../scripts/lib/install-manifests');

function writeRepo(root, paths) {
  fs.mkdirSync(path.join(root, 'manifests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'manifests', 'install-modules.json'), JSON.stringify({
    version: 1,
    modules: [{ id: 'rules-core', kind: 'rules', description: 'Rules', paths, targets: ['egc'], dependencies: [], defaultInstall: true, cost: 'light', stability: 'stable' }],
  }));
  fs.writeFileSync(path.join(root, 'manifests', 'install-profiles.json'), JSON.stringify({ version: 1, profiles: { core: { description: 'Core', modules: ['rules-core'] } } }));
}

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
  console.log('\n=== Testing manifest path safety ===\n');
  let passed = 0;
  let failed = 0;

  if (test('isUnsafeManifestPath classifies relative, absolute and climbing paths', () => {
    for (const ok of ['rules', 'agents/x.md', '.agents', '..foo/bar', 'a/..b']) assert.strictEqual(isUnsafeManifestPath(ok), false, ok);
    for (const bad of ['/etc/passwd', '../x', 'a/../b', 'a/..', '..', 'C:\\x', '\\\\server\\share', '', '  ']) assert.strictEqual(isUnsafeManifestPath(bad), true, JSON.stringify(bad));
  })) passed++; else failed++;

  if (test('loadInstallManifests refuses a module whose path climbs out of the repository', () => {
    for (const unsafe of ['../outside', 'rules/../../etc/passwd', '/etc/passwd']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-paths-'));
      try {
        writeRepo(root, ['rules', unsafe]);
        assert.throws(() => loadInstallManifests({ repoRoot: root }), /unsafe path/, unsafe);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  })) passed++; else failed++;

  if (test('a non-string path is unsafe and refused by the loader', () => {
    assert.strictEqual(isUnsafeManifestPath(null), true);
    assert.strictEqual(isUnsafeManifestPath(42), true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-paths-'));
    try {
      writeRepo(root, ['rules', null]);
      assert.throws(() => loadInstallManifests({ repoRoot: root }), /unsafe path/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('a relative path that leaves the repository through a symlink is refused', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-paths-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
      try {
        fs.symlinkSync(outside, path.join(root, 'rules'), 'dir');
      } catch (error) {
        console.log(`    - skipped: cannot create symlinks here (${error.code})`);
        return;
      }
      writeRepo(root, ['rules']);
      assert.throws(() => loadInstallManifests({ repoRoot: root }), /through a link/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('loadInstallManifests still accepts ordinary relative paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-paths-'));
    try {
      writeRepo(root, ['rules', 'agents/x.md', '.agents']);
      const manifests = loadInstallManifests({ repoRoot: root });
      assert.strictEqual(manifests.modules.length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('the shipped manifests pass the same check', () => {
    const manifests = loadInstallManifests();
    assert.ok(manifests.modules.length > 0);
    for (const module of manifests.modules) for (const p of module.paths) assert.strictEqual(isUnsafeManifestPath(p), false, `${module.id}: ${p}`);
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
