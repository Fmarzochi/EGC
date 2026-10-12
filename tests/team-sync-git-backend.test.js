/**
 * Tests for GitBackend and mirrorCopy atomic copy-then-swap (#1685).
 * Runs against the built memory server modules.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const BUILD = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build');

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result
        .then(() => {
          console.log(`  ✓ ${name}`);
          return true;
        })
        .catch(error => {
          console.log(`  ✗ ${name}`);
          console.log(`    Error: ${error.message}`);
          return false;
        });
    }
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function runRecoveryTests(GitBackend, tempBase) {
  let passed = 0;
  let failed = 0;

  // 7. a failed swap after the backup rename restores the original destination
  if (await test('mirrorCopy restores the original destination when installing the new tree fails', () => {
    const backend = new GitBackend(path.join(tempBase, 'repo-rollback'));
    const src = path.join(tempBase, 'src-rollback');
    const dest = path.join(tempBase, 'dest-rollback');

    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'keep.txt'), 'original state');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'incoming.txt'), 'incoming');

    const originalRename = fs.renameSync;
    let calls = 0;
    fs.renameSync = (from, to) => {
      calls++;
      if (calls === 2) throw new Error('Simulated rename failure');
      return originalRename(from, to);
    };
    try {
      assert.throws(() => backend.mirrorCopy(src, dest), /Simulated rename failure/);
    } finally {
      fs.renameSync = originalRename;
    }

    assert.strictEqual(fs.readFileSync(path.join(dest, 'keep.txt'), 'utf8'), 'original state');
    const leaked = fs.readdirSync(tempBase).filter(f => f.startsWith('.tmp-sync-dest-rollback') || f.startsWith('.tmp-old-dest-rollback'));
    assert.deepStrictEqual(leaked, [], 'no temporary directory may leak after the rollback');
  })) passed++; else failed++;

  // 8. a backup left by a crash is restored instead of swept, and sibling temporaries stay untouched
  if (await test('mirrorCopy restores a surviving backup when the destination is missing', () => {
    const backend = new GitBackend(path.join(tempBase, 'repo-crash'));
    const src = path.join(tempBase, 'src-crash');
    const dest = path.join(tempBase, 'dest-crash');
    const backup = path.join(tempBase, '.tmp-old-dest-crash-1-aa');
    const siblingBackup = path.join(tempBase, '.tmp-old-other-dest-1-bb');

    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'state.txt'), 'only surviving copy');
    fs.mkdirSync(siblingBackup, { recursive: true });
    fs.writeFileSync(path.join(siblingBackup, 'state.txt'), 'belongs to another destination');
    fs.mkdirSync(src, { recursive: true });

    const originalCpSync = fs.cpSync;
    fs.cpSync = () => {
      throw new Error('Simulated disk failure during copy');
    };
    try {
      assert.throws(() => backend.mirrorCopy(src, dest), /Simulated disk failure/);
    } finally {
      fs.cpSync = originalCpSync;
    }

    assert.strictEqual(fs.readFileSync(path.join(dest, 'state.txt'), 'utf8'), 'only surviving copy');
    assert.ok(fs.existsSync(siblingBackup), 'a backup of another destination must not be swept');
  })) passed++; else failed++;

  return { passed, failed };
}

async function runTests() {
  console.log('\n=== Testing GitBackend team sync ===\n');

  let GitBackend;
  const buildFile = path.join(BUILD, 'sync', 'GitBackend.js');
  if (!fs.existsSync(buildFile)) {
    console.error(`[SKIP] GitBackend build not found at ${buildFile}. Run 'npm run build' in mcp/servers/egc-memory first.`);
    process.exit(0);
  }
  const mod = await import(pathToFileURL(buildFile).href);
  GitBackend = mod.GitBackend;

  let passed = 0;
  let failed = 0;
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-gitbackend-test-'));

  try {
    // 1. mirrorCopy copies a fresh directory tree to a new destination
    if (await test('mirrorCopy copies directory tree to a new destination', () => {
      const repoDir = path.join(tempBase, 'repo-1');
      const backend = new GitBackend(repoDir);
      const src = path.join(tempBase, 'src-1');
      const dest = path.join(tempBase, 'dest-1');

      fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(src, 'file1.txt'), 'hello 1');
      fs.writeFileSync(path.join(src, 'sub', 'file2.txt'), 'hello 2');

      backend.mirrorCopy(src, dest);

      assert.ok(fs.existsSync(dest), 'destination must exist');
      assert.strictEqual(fs.readFileSync(path.join(dest, 'file1.txt'), 'utf8'), 'hello 1');
      assert.strictEqual(fs.readFileSync(path.join(dest, 'sub', 'file2.txt'), 'utf8'), 'hello 2');
    })) passed++; else failed++;

    // 2. mirrorCopy replaces an existing destination tree
    if (await test('mirrorCopy updates an existing destination directory', () => {
      const repoDir = path.join(tempBase, 'repo-2');
      const backend = new GitBackend(repoDir);
      const src = path.join(tempBase, 'src-2');
      const dest = path.join(tempBase, 'dest-2');

      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'old.txt'), 'old data');

      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'new.txt'), 'new data');

      backend.mirrorCopy(src, dest);

      assert.strictEqual(fs.readFileSync(path.join(dest, 'new.txt'), 'utf8'), 'new data');
      assert.ok(!fs.existsSync(path.join(dest, 'old.txt')), 'old file must be retired');
    })) passed++; else failed++;

    // 3. mirrorCopy preserves existing destination content when copy fails (acceptance criteria #1685)
    if (await test('mirrorCopy preserves existing destination content when copy fails', () => {
      const repoDir = path.join(tempBase, 'repo-3');
      const backend = new GitBackend(repoDir);
      const src = path.join(tempBase, 'src-3');
      const dest = path.join(tempBase, 'dest-3');

      // Seed destination with existing content that must survive
      fs.mkdirSync(path.join(dest, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(dest, 'critical.txt'), 'important state content');
      fs.writeFileSync(path.join(dest, 'nested', 'state.json'), '{"survive": true}');

      // Source directory
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'incoming.txt'), 'corrupted or partial');

      // Intercept fs.cpSync to simulate copy failure
      const originalCpSync = fs.cpSync;
      let errorThrown = false;
      fs.cpSync = () => {
        throw new Error('Simulated disk failure during copy');
      };

      try {
        backend.mirrorCopy(src, dest);
      } catch (err) {
        errorThrown = true;
        assert.ok(err.message.includes('Simulated disk failure during copy'));
      } finally {
        fs.cpSync = originalCpSync;
      }

      assert.strictEqual(errorThrown, true, 'mirrorCopy must rethrow the copy error');

      // Destination must be completely intact with previous content
      assert.ok(fs.existsSync(dest), 'destination directory must still exist');
      assert.strictEqual(
        fs.readFileSync(path.join(dest, 'critical.txt'), 'utf8'),
        'important state content',
        'critical file must survive unharmed'
      );
      assert.strictEqual(
        fs.readFileSync(path.join(dest, 'nested', 'state.json'), 'utf8'),
        '{"survive": true}',
        'nested files must survive unharmed'
      );

      // Verify no temporary files leaked in parent directory
      const parentFiles = fs.readdirSync(tempBase);
      const leakedTemps = parentFiles.filter(f => f.startsWith('.tmp-sync-') || f.startsWith('.tmp-old-'));
      assert.deepStrictEqual(leakedTemps, [], 'temporary directories must be cleaned up on failure');
    })) passed++; else failed++;

    // 4. GitBackend status and uninitialized guards
    if (await test('GitBackend guards against operations before init', async () => {
      const repoDir = path.join(tempBase, 'repo-guards');
      const backend = new GitBackend(repoDir);

      await assert.rejects(async () => backend.status(), /GitBackend not initialized/);
      await assert.rejects(async () => backend.pull(), /GitBackend not initialized/);
      await assert.rejects(async () => backend.push(), /GitBackend not initialized/);

      await backend.destroy();
      await assert.rejects(async () => backend.status(), /GitBackend not initialized/);
    })) passed++; else failed++;

    // 5. GitBackend constructor accepts custom repoDir and creates directory
    if (await test('GitBackend constructor initializes repository directory', () => {
      const customRepo = path.join(tempBase, 'custom-repo-dir');
      assert.ok(!fs.existsSync(customRepo), 'precondition: custom repo dir does not exist');
      const backend = new GitBackend(customRepo);
      assert.ok(fs.existsSync(customRepo), 'constructor must create the repo directory');
      assert.ok(backend instanceof GitBackend);
    })) passed++; else failed++;

    // 6. mirrorCopy sweeps stale temporary siblings (.tmp-sync-* and .tmp-old-*) before copying
    if (await test('mirrorCopy sweeps stale temporaries of its own destination before copying', () => {
      const repoDir = path.join(tempBase, 'repo-sweep');
      const backend = new GitBackend(repoDir);
      const src = path.join(tempBase, 'src-sweep');
      const dest = path.join(tempBase, 'dest-sweep');
      const staleTemp1 = path.join(tempBase, '.tmp-sync-dest-sweep-1-x');
      const staleTemp2 = path.join(tempBase, '.tmp-old-dest-sweep-1-x');

      fs.mkdirSync(staleTemp1, { recursive: true });
      fs.writeFileSync(path.join(staleTemp1, 'orphan.txt'), 'stale sync data');
      fs.mkdirSync(staleTemp2, { recursive: true });
      fs.writeFileSync(path.join(staleTemp2, 'orphan.txt'), 'stale old data');

      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'data.txt'), 'live data');

      backend.mirrorCopy(src, dest);

      assert.strictEqual(fs.existsSync(staleTemp1), false, 'stale .tmp-sync leftover of this destination must be swept');
      assert.strictEqual(fs.existsSync(staleTemp2), false, 'stale .tmp-old leftover of this destination must be swept');
      assert.strictEqual(fs.readFileSync(path.join(dest, 'data.txt'), 'utf8'), 'live data');
    })) passed++; else failed++;

    const recovery = await runRecoveryTests(GitBackend, tempBase);
    passed += recovery.passed;
    failed += recovery.failed;
  } finally {
    fs.rmSync(tempBase, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
