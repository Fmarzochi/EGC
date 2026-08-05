'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SHIM_BINARY_NAMES,
  shimDir,
  manifestPath,
  readManifest,
  pathEnvKey,
  normalizePathForCompare,
  resolveWithoutShim,
  resolveRealBinary,
} = require('../../scripts/lib/crusher/shim-paths');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function withHome(tempHome, fn) {
  // os.homedir() reads USERPROFILE on Windows, HOME everywhere else -- both
  // must be overridden or the real runner/user home leaks into the test.
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    return fn();
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  }
}

function writeFakeExecutable(filePath) {
  fs.writeFileSync(filePath, '#!/bin/sh\necho fake\n', 'utf8');
  fs.chmodSync(filePath, 0o755);
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
  console.log('\n=== Testing scripts/lib/crusher/shim-paths.js ===\n');
  let passed = 0;
  let failed = 0;

  if (test('shimDir/manifestPath resolve under the current HOME', () => {
    const dir = createTempDir('egc-shim-paths-');
    try {
      withHome(dir, () => {
        assert.strictEqual(shimDir(), path.join(dir, '.egc', 'bin'));
        assert.strictEqual(manifestPath(), path.join(dir, '.egc', 'bin', 'manifest.json'));
      });
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('readManifest returns {} when the manifest file does not exist', () => {
    const dir = createTempDir('egc-shim-paths-');
    try {
      withHome(dir, () => {
        assert.deepStrictEqual(readManifest(), {});
      });
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('readManifest returns {} instead of throwing on corrupt JSON', () => {
    const dir = createTempDir('egc-shim-paths-');
    try {
      withHome(dir, () => {
        fs.mkdirSync(path.join(dir, '.egc', 'bin'), { recursive: true });
        fs.writeFileSync(manifestPath(), '{not valid json');
        assert.deepStrictEqual(readManifest(), {});
      });
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('pathEnvKey finds the PATH variable regardless of case', () => {
    assert.ok(['PATH', 'Path'].includes(pathEnvKey()));
  })) passed++; else failed++;

  if (test('normalizePathForCompare is case-insensitive on win32/darwin, case-sensitive on linux (audit EGC-520)', () => {
    const upper = '/Users/Felipe/.egc/bin';
    const lower = '/users/felipe/.egc/bin';

    withPlatform('win32', () => {
      assert.strictEqual(normalizePathForCompare(upper), normalizePathForCompare(lower));
    });
    withPlatform('darwin', () => {
      assert.strictEqual(normalizePathForCompare(upper), normalizePathForCompare(lower));
    });
    withPlatform('linux', () => {
      assert.notStrictEqual(normalizePathForCompare(upper), normalizePathForCompare(lower));
    });
  })) passed++; else failed++;

  if (test('resolveWithoutShim finds a real system binary (node itself)', () => {
    const found = resolveWithoutShim('node');
    assert.ok(found, 'expected node to resolve on PATH');
    assert.ok(fs.existsSync(found));
  })) passed++; else failed++;

  if (test('resolveWithoutShim returns null for a name that does not exist anywhere', () => {
    assert.strictEqual(resolveWithoutShim('totally-fake-binary-xyz-123'), null);
  })) passed++; else failed++;

  if (test('resolveWithoutShim never resolves to something inside the shim directory itself', () => {
    const dir = createTempDir('egc-shim-paths-');
    try {
      withHome(dir, () => {
        const shimBinDir = shimDir();
        fs.mkdirSync(shimBinDir, { recursive: true });
        const decoy = path.join(shimBinDir, 'node');
        writeFakeExecutable(decoy);

        const savedPath = process.env.PATH;
        process.env.PATH = `${shimBinDir}${path.delimiter}${savedPath}`;
        try {
          const found = resolveWithoutShim('node');
          assert.notStrictEqual(path.resolve(found), path.resolve(decoy), 'must not resolve back to the shim decoy');
        } finally {
          process.env.PATH = savedPath;
        }
      });
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('a HOME override never makes resolution return the launcher itself (fork-bomb regression)', () => {
    // The exact failure that used to fork-bomb the machine: launchers
    // installed under one home, the process running with HOME pointing
    // somewhere else, and the launcher's own directory still on PATH.
    const installHome = createTempDir('egc-shim-paths-install-');
    const overrideHome = createTempDir('egc-shim-paths-override-');
    const realBinDir = createTempDir('egc-shim-paths-real-');
    try {
      const installedShimDir = path.join(installHome, '.egc', 'bin');
      fs.mkdirSync(installedShimDir, { recursive: true });
      const launcher = path.join(installedShimDir, 'npm');
      writeFakeExecutable(launcher);
      const realNpm = path.join(realBinDir, 'npm');
      writeFakeExecutable(realNpm);

      withHome(overrideHome, () => {
        const savedPath = process.env.PATH;
        process.env.PATH = `${installedShimDir}${path.delimiter}${realBinDir}${path.delimiter}${savedPath}`;
        try {
          const found = resolveRealBinary('npm', launcher);
          assert.ok(found, 'expected npm to resolve somewhere');
          assert.strictEqual(path.resolve(found), path.resolve(realNpm), 'must skip the launcher directory and find the real npm');
        } finally {
          process.env.PATH = savedPath;
        }
      });
    } finally {
      cleanup(installHome);
      cleanup(overrideHome);
      cleanup(realBinDir);
    }
  })) passed++; else failed++;

  if (test('the manifest next to the launcher wins even when HOME points elsewhere', () => {
    const installHome = createTempDir('egc-shim-paths-install-');
    const overrideHome = createTempDir('egc-shim-paths-override-');
    try {
      const installedShimDir = path.join(installHome, '.egc', 'bin');
      fs.mkdirSync(installedShimDir, { recursive: true });
      const launcher = path.join(installedShimDir, 'npm');
      writeFakeExecutable(launcher);
      const realNpm = path.join(installHome, 'real-npm');
      writeFakeExecutable(realNpm);
      fs.writeFileSync(path.join(installedShimDir, 'manifest.json'), JSON.stringify({ npm: realNpm }));

      withHome(overrideHome, () => {
        assert.strictEqual(resolveRealBinary('npm', launcher), realNpm);
      });
    } finally {
      cleanup(installHome);
      cleanup(overrideHome);
    }
  })) passed++; else failed++;

  if (test('a manifest entry pointing back into a shim directory is rejected, not spawned', () => {
    const home = createTempDir('egc-shim-paths-');
    const realBinDir = createTempDir('egc-shim-paths-real-');
    try {
      withHome(home, () => {
        const dir = shimDir();
        fs.mkdirSync(dir, { recursive: true });
        const launcher = path.join(dir, 'npm');
        writeFakeExecutable(launcher);
        const realNpm = path.join(realBinDir, 'npm');
        writeFakeExecutable(realNpm);
        fs.writeFileSync(manifestPath(), JSON.stringify({ npm: launcher }));

        const savedPath = process.env.PATH;
        process.env.PATH = `${dir}${path.delimiter}${realBinDir}${path.delimiter}${savedPath}`;
        try {
          const found = resolveRealBinary('npm', launcher);
          assert.ok(found, 'expected npm to resolve somewhere');
          assert.strictEqual(path.resolve(found), path.resolve(realNpm), 'a poisoned manifest must fall through to a real PATH lookup');
        } finally {
          process.env.PATH = savedPath;
        }
      });
    } finally {
      cleanup(home);
      cleanup(realBinDir);
    }
  })) passed++; else failed++;

  if (test('resolveRealBinary prefers a valid manifest entry over a fresh PATH lookup', () => {
    const dir = createTempDir('egc-shim-paths-');
    try {
      withHome(dir, () => {
        fs.mkdirSync(shimDir(), { recursive: true });
        const fakeGit = path.join(dir, 'fake-git');
        writeFakeExecutable(fakeGit);
        fs.writeFileSync(manifestPath(), JSON.stringify({ git: fakeGit }));

        assert.strictEqual(resolveRealBinary('git'), fakeGit);
      });
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('resolveRealBinary falls back to a fresh lookup when the manifest entry no longer exists on disk', () => {
    const dir = createTempDir('egc-shim-paths-');
    try {
      withHome(dir, () => {
        fs.mkdirSync(shimDir(), { recursive: true });
        fs.writeFileSync(manifestPath(), JSON.stringify({ node: path.join(dir, 'deleted-node') }));

        const found = resolveRealBinary('node');
        assert.ok(found && fs.existsSync(found), 'must recover via a fresh PATH lookup');
        assert.notStrictEqual(found, path.join(dir, 'deleted-node'));
      });
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('SHIM_BINARY_NAMES excludes node, go, cargo, dotnet and mvn/gradle (deliberate v1 scope)', () => {
    for (const excluded of ['node', 'go', 'cargo', 'dotnet', 'mvn', 'gradle']) {
      assert.ok(!SHIM_BINARY_NAMES.includes(excluded), `${excluded} must not be in the v1 shim list`);
    }
    assert.ok(SHIM_BINARY_NAMES.includes('git'));
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
