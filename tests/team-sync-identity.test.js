/**
 * Team sync identity (#2063): the same repository under two different paths
 * on two machines is one project. A state document is keyed by the normalized
 * origin remote of the repository, so what one machine writes is read by the
 * other for its own path after a sync, and nothing in the shared tree names a
 * local path or the remote URL. Runs against the built memory server modules.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { pathToFileURL } = require('url');

const BUILD = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build');
const REMOTE_HTTPS = 'https://github.com/Owner/Repo.git';
const REMOTE_SSH = 'git@github.com:Owner/Repo.git';

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

function git(cwd, args) {
  execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

// A checkout of the repository at `remoteUrl`, at the path a machine would
// hold it: two of these with the same remote under different paths stand
// for the two machines.
function makeCheckout(root, relativePath, remoteUrl) {
  const repo = path.join(root, relativePath);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init -q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'test repo\n');
  git(repo, 'add README.md');
  git(repo, '-c user.email=test@test -c user.name=test -c commit.gpgsign=false commit -q -m initial');
  git(repo, 'checkout -q -B main');
  git(repo, `remote add origin ${remoteUrl}`);
  return repo;
}

function doc(projectPath, updated, body) {
  return `# Project State\nproject: ${projectPath}\nbranch: main\nauthor: test\nupdated: ${updated}\n\n## Context\n${body}\n`;
}

function writeSealed(encryption, filePath, content, key) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  encryption.writeStateFile(filePath, content, key);
}

async function runTests() {
  console.log('\n=== Testing team sync project identity ===\n');
  let branchState;
  let teamSync;
  let encryption;
  try {
    branchState = await import(pathToFileURL(path.join(BUILD, 'branch-state.js')).href);
    teamSync = await import(pathToFileURL(path.join(BUILD, 'sync', 'TeamSync.js')).href);
    encryption = await import(pathToFileURL(path.join(BUILD, 'encryption.js')).href);
  } catch (error) {
    console.error(`[SKIP] Could not import the memory server build: ${error.message}. Run 'npm run build' in mcp/servers/egc-memory first.`);
    process.exit(0);
  }
  let passed = 0;
  let failed = 0;
  const run = (name, fn) => {
    if (test(name, fn)) passed++; else failed++;
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-team-identity-'));
  try {
    const syncDir = path.join(dir, 'sync', 'state');
    const stateA = path.join(dir, 'home-a', '.egc', 'state');
    const stateB = path.join(dir, 'home-b', '.egc', 'state');
    const repoA = makeCheckout(dir, path.join('linux', 'Projetos', 'EGC'), REMOTE_HTTPS);
    const repoB = makeCheckout(dir, path.join('mac', 'Projects', 'egc-clone'), REMOTE_SSH);
    const teamKey = crypto.randomBytes(32);
    const keyA = crypto.randomBytes(32);
    const keyB = crypto.randomBytes(32);

    run('the document of a repository is named by its remote identity, the same on both machines, with no path and no URL in the name', () => {
      const fileA = branchState.resolveStateWrite(stateA, repoA, 'main');
      const relative = path.relative(stateA, fileA);
      assert.match(relative.split(path.sep)[0], /^Repo--[0-9a-f]{64}$/, 'the readable name of the repository bound to the hash of its identity');
      for (const piece of ['linux', 'Projetos', 'EGC', 'github', 'Owner', 'mac', 'egc-clone']) {
        assert.ok(!relative.includes(piece), `${piece} is not in the name of the document`);
      }
      assert.strictEqual(path.relative(stateB, branchState.resolveStateWrite(stateB, repoB, 'main')), relative, 'the other machine names the same document the same way, from another path and another form of the URL');
    });

    run('after one sync each way, each machine reads the decision of the other for its own path', () => {
      const fileA = branchState.resolveStateWrite(stateA, repoA, 'main');
      writeSealed(encryption, fileA, doc(repoA, '2026-11-07T10:00:00.000Z', 'decided on machine A'), keyA);
      assert.strictEqual(teamSync.stageTeamState(stateA, syncDir, teamKey, keyA), 1);
      assert.deepStrictEqual(fs.readdirSync(syncDir), [path.basename(path.dirname(fileA))], 'the shared tree holds the keyed directory and nothing named after the path');

      const toB = teamSync.mergeTeamStateFrom(syncDir, stateB, teamKey, keyB);
      assert.strictEqual(toB.merged, 1, JSON.stringify(toB));
      const readB = branchState.resolveStateRead(stateB, repoB, 'main');
      assert.strictEqual(readB.source, 'branch', 'the second machine reads it as the state of its own checkout');
      assert.ok(encryption.readStateFile(readB.filePath, keyB).includes('decided on machine A'));

      const fileB = branchState.resolveStateWrite(stateB, repoB, 'main');
      assert.strictEqual(fileB, readB.filePath, 'the second machine writes where it read');
      writeSealed(encryption, fileB, doc(repoB, '2026-11-07T11:00:00.000Z', 'decided on machine A\ndecided on machine B'), keyB);
      assert.strictEqual(teamSync.stageTeamState(stateB, syncDir, teamKey, keyB), 1);
      const toA = teamSync.mergeTeamStateFrom(syncDir, stateA, teamKey, keyA);
      assert.strictEqual(toA.merged, 1, JSON.stringify(toA));
      const readA = branchState.resolveStateRead(stateA, repoA, 'main');
      assert.strictEqual(readA.filePath, fileA);
      const content = encryption.readStateFile(fileA, keyA);
      assert.ok(content.includes('decided on machine A'), 'the decision of the first machine is on the first machine');
      assert.ok(content.includes('decided on machine B'), 'and so is the decision of the second one');
    });

    run('a document an older version keyed by the path still travels and is still read on the machine that wrote it', () => {
      const legacyRepo = makeCheckout(dir, path.join('linux', 'old', 'legacy'), 'https://example.com/Legacy/Repo.git');
      const legacyName = path.join(branchState.projectSlug(legacyRepo), `${branchState.branchStateKey('main')}.md`);
      const legacyFile = path.join(stateA, legacyName);
      writeSealed(encryption, legacyFile, doc(legacyRepo, '2026-11-07T09:00:00.000Z', 'before the identity'), keyA);
      assert.strictEqual(branchState.resolveStateRead(stateA, legacyRepo, 'main').filePath, legacyFile, 'read where it is, with no manual step');
      assert.strictEqual(branchState.resolveStateWrite(stateA, legacyRepo, 'main').includes(branchState.projectSlug(legacyRepo)), false, 'the next write of that project goes under its remote key');

      teamSync.stageTeamState(stateA, syncDir, teamKey, keyA);
      teamSync.mergeTeamStateFrom(syncDir, stateB, teamKey, keyB);
      assert.ok(fs.existsSync(path.join(stateB, legacyName)), 'it lands under the same legacy name on the other machine');
      teamSync.mergeTeamStateFrom(syncDir, stateA, teamKey, keyA);
      assert.ok(encryption.readStateFile(legacyFile, keyA).includes('before the identity'), 'and the machine that wrote it still reads it after the sync comes back');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
