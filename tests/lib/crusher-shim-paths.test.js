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
  resolveWithoutShim,
  resolveRealBinary,
} = require('../../scripts/lib/crusher/shim-paths');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
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
