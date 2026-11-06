/**
 * Tests for GitBackend: what a push ships to the shared repository. The
 * memory database under ~/.egc/memory never leaves the machine (an older
 * version mirrored it into the sync checkout in the clear), and the guards
 * before init() hold. Runs against the built memory server modules.
 */
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const BUILD = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build');

// Fixed git locations before a PATH lookup.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

// GitBackend reads the home directory when it pushes, so the suite runs with
// a home of its own: the real ~/.egc/memory is never read, touched or shipped.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-gitbackend-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

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

function git(args, cwd) {
  return execFileSync(GIT_BIN, args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

// Every path committed on `branch` of a bare remote, or nothing when the
// branch does not exist yet.
function remoteTree(remote, branch) {
  try {
    return git(['ls-tree', '-r', '--name-only', branch], remote).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// A backend initialized against a bare remote of its own, ready to push.
async function pushingBackend(GitBackend, tempBase, name) {
  const remote = path.join(tempBase, `${name}-remote.git`);
  git(['init', '--bare', remote], tempBase);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  const repoDir = path.join(tempBase, `${name}-repo`);
  const backend = new GitBackend(repoDir);
  await backend.init({ backend: 'git', remote, branch: 'main' });
  return { backend, repoDir, remote };
}

function stageOneEnvelope(repoDir) {
  fs.mkdirSync(path.join(repoDir, 'state', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'state', 'proj', 'main.md'), '{"egcTeamEnvelope":2}\n');
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
  const run = async (name, fn) => {
    if (await test(name, fn)) passed++; else failed++;
  };
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-gitbackend-test-'));

  try {
    await run('push never ships the memory database: ~/.egc/memory stays out of the shared repository', async () => {
      const memoryDir = path.join(HOME, '.egc', 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, 'state.db'), 'sqlite bytes that must stay on this machine');
      const { backend, repoDir, remote } = await pushingBackend(GitBackend, tempBase, 'ships');
      stageOneEnvelope(repoDir);
      assert.strictEqual(await backend.push(), true, 'the staged state is pushed');
      assert.ok(!fs.existsSync(path.join(repoDir, 'memory')), 'no memory/ tree is written into the sync checkout');
      const tree = remoteTree(remote, 'main');
      assert.deepStrictEqual(tree.filter(p => p.startsWith('memory/')), [], `nothing under memory/ reaches the remote, got: ${tree.join(', ')}`);
      assert.ok(tree.includes('state/proj/main.md'), 'the state envelope does reach the remote');
      assert.ok(fs.existsSync(path.join(memoryDir, 'state.db')), 'the local database is untouched');
      await backend.destroy();
    });

    await run('push retires a memory/ tree an older version left in the sync checkout, and the commit removes it from the shared repository', async () => {
      const { backend, repoDir, remote } = await pushingBackend(GitBackend, tempBase, 'retires');
      // What a push before this change left behind: the database mirrored
      // into the checkout in the clear and committed to the shared repository.
      fs.mkdirSync(path.join(repoDir, 'memory'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'memory', 'state.db'), 'mirrored in the clear by an older version');
      git(['add', '-A'], repoDir);
      git(['-c', 'user.name=older', '-c', 'user.email=older@egc.local', 'commit', '-q', '-m', 'sync: team memory update from older'], repoDir);
      git(['push', '-q', 'origin', 'main'], repoDir);
      assert.ok(remoteTree(remote, 'main').includes('memory/state.db'), 'precondition: the old mirror is in the remote');
      stageOneEnvelope(repoDir);
      assert.strictEqual(await backend.push(), true, 'the push commits the retirement and the new state');
      assert.ok(!fs.existsSync(path.join(repoDir, 'memory')), 'the old memory/ tree leaves the checkout');
      const tree = remoteTree(remote, 'main');
      assert.deepStrictEqual(tree.filter(p => p.startsWith('memory/')), [], `the commit removes memory/ from the remote, got: ${tree.join(', ')}`);
      assert.ok(tree.includes('state/proj/main.md'));
      await backend.destroy();
    });

    await run('push sweeps the temporaries an interrupted old mirror left beside memory/, so none of them is committed', async () => {
      const { backend, repoDir, remote } = await pushingBackend(GitBackend, tempBase, 'sweeps');
      for (const name of ['.tmp-sync-memory-1-ab', '.tmp-old-memory-1-cd', 'memory']) {
        fs.mkdirSync(path.join(repoDir, name), { recursive: true });
        fs.writeFileSync(path.join(repoDir, name, 'state.db'), `left by an interrupted mirror in ${name}`);
      }
      stageOneEnvelope(repoDir);
      assert.strictEqual(await backend.push(), true, 'the push still goes through');
      const left = fs.readdirSync(repoDir).filter(entry => entry === 'memory' || entry.startsWith('.tmp-sync-memory-') || entry.startsWith('.tmp-old-memory-'));
      assert.deepStrictEqual(left, [], 'the mirror and its temporaries leave the checkout');
      const tree = remoteTree(remote, 'main');
      assert.deepStrictEqual(tree.filter(p => p.startsWith('memory/') || p.startsWith('.tmp-')), [], `nothing of the mirror reaches the remote, got: ${tree.join(', ')}`);
      assert.ok(tree.includes('state/proj/main.md'));
      await backend.destroy();
    });

    await run('GitBackend guards against operations before init', async () => {
      const repoDir = path.join(tempBase, 'repo-guards');
      const backend = new GitBackend(repoDir);

      await assert.rejects(async () => backend.status(), /GitBackend not initialized/);
      await assert.rejects(async () => backend.pull(), /GitBackend not initialized/);
      await assert.rejects(async () => backend.push(), /GitBackend not initialized/);

      await backend.destroy();
      await assert.rejects(async () => backend.status(), /GitBackend not initialized/);
    });

    await run('init refuses a remote it cannot read and names the reason, instead of swallowing the failed pull', async () => {
      const backend = new GitBackend(path.join(tempBase, 'repo-unreachable'));
      await assert.rejects(
        () => backend.init({ backend: 'git', remote: path.join(tempBase, 'no-such-remote.git'), branch: 'main' }),
        /cannot be read/,
      );
      await backend.destroy();
    });

    await run('init against an empty remote succeeds, and pull reports nothing to pull without an error', async () => {
      const { backend } = await pushingBackend(GitBackend, tempBase, 'empty');
      assert.deepStrictEqual(await backend.pull(), [], 'an empty remote branch is not a failure');
      await backend.destroy();
    });

    await run('pull throws when the remote stops being readable, instead of returning an empty list', async () => {
      const { backend, remote } = await pushingBackend(GitBackend, tempBase, 'vanishing');
      fs.rmSync(remote, { recursive: true, force: true });
      await assert.rejects(() => backend.pull(), /cannot be read/);
      await backend.destroy();
    });

    await run('GitBackend constructor initializes repository directory', () => {
      const customRepo = path.join(tempBase, 'custom-repo-dir');
      assert.ok(!fs.existsSync(customRepo), 'precondition: custom repo dir does not exist');
      const backend = new GitBackend(customRepo);
      assert.ok(fs.existsSync(customRepo), 'constructor must create the repo directory');
      assert.ok(backend instanceof GitBackend);
    });
  } finally {
    fs.rmSync(tempBase, { recursive: true, force: true });
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
