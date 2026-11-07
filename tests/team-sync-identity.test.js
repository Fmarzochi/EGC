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
  let envelope;
  try {
    branchState = await import(pathToFileURL(path.join(BUILD, 'branch-state.js')).href);
    teamSync = await import(pathToFileURL(path.join(BUILD, 'sync', 'TeamSync.js')).href);
    encryption = await import(pathToFileURL(path.join(BUILD, 'encryption.js')).href);
    envelope = await import(pathToFileURL(path.join(BUILD, 'sync', 'envelope.js')).href);
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

    run('a document an older version keyed by the path is shared under the key of its repository, so the other machine reads it for its own checkout', () => {
      const legacyRepoA = makeCheckout(dir, path.join('linux', 'old', 'legacy'), 'https://example.com/Legacy/Repo.git');
      const legacyRepoB = makeCheckout(dir, path.join('mac', 'elsewhere', 'legacy-clone'), 'git@example.com:Legacy/Repo.git');
      const legacyName = path.join(branchState.projectSlug(legacyRepoA), `${branchState.branchStateKey('main')}.md`);
      const legacyFile = path.join(stateA, legacyName);
      writeSealed(encryption, legacyFile, doc(legacyRepoA, '2026-11-07T09:00:00.000Z', 'before the identity'), keyA);
      assert.strictEqual(branchState.resolveStateRead(stateA, legacyRepoA, 'main').filePath, legacyFile, 'read where it is, with no manual step');
      const keyedFile = branchState.resolveStateWrite(stateA, legacyRepoA, 'main');
      assert.ok(!keyedFile.includes(branchState.projectSlug(legacyRepoA)), 'the next write of that project goes under its remote key');
      const keyedName = path.relative(stateA, keyedFile);

      teamSync.stageTeamState(stateA, syncDir, teamKey, keyA);
      assert.ok(fs.existsSync(path.join(syncDir, keyedName)), 'the legacy document is shared under the key of its repository');
      assert.ok(!fs.existsSync(path.join(syncDir, legacyName)), 'and not under the name of a folder of this machine');
      const toB = teamSync.mergeTeamStateFrom(syncDir, stateB, teamKey, keyB);
      assert.ok(toB.merged >= 1, JSON.stringify(toB));
      const readB = branchState.resolveStateRead(stateB, legacyRepoB, 'main');
      assert.strictEqual(readB.source, 'branch', 'the other machine reads it for its own checkout of that repository');
      assert.ok(encryption.readStateFile(readB.filePath, keyB).includes('before the identity'));

      teamSync.mergeTeamStateFrom(syncDir, stateA, teamKey, keyA);
      const readA = branchState.resolveStateRead(stateA, legacyRepoA, 'main');
      assert.strictEqual(readA.filePath, keyedFile, 'the sync back gives the first machine the keyed copy, which it reads from then on');
      assert.ok(encryption.readStateFile(keyedFile, keyA).includes('before the identity'));
      assert.ok(encryption.readStateFile(legacyFile, keyA).includes('before the identity'), 'the legacy document is left as it was');

      writeSealed(encryption, keyedFile, doc(legacyRepoA, '2026-11-07T12:00:00.000Z', 'after the identity'), keyA);
      teamSync.stageTeamState(stateA, syncDir, teamKey, keyA);
      const shared = fs.readFileSync(path.join(syncDir, keyedName), 'utf8');
      const opened = envelope.openEnvelope(shared, teamKey, keyedName);
      assert.ok(opened.includes('after the identity'), 'once a keyed document exists, the legacy one is not staged over it');
    });

    run('a keyed document that arrives from the other machine first merges with the legacy one instead of shadowing it unread', () => {
      const remote = 'https://example.com/Second/Repo.git';
      const secondA = makeCheckout(dir, path.join('linux', 'second', 'app'), remote);
      const secondB = makeCheckout(dir, path.join('mac', 'second', 'clone'), remote);
      const legacyFile = path.join(stateA, branchState.projectSlug(secondA), `${branchState.branchStateKey('main')}.md`);
      writeSealed(encryption, legacyFile, doc(secondA, '2026-11-07T11:00:00.000Z', 'decided on A before the upgrade'), keyA);
      const keyedB = branchState.resolveStateWrite(stateB, secondB, 'main');
      writeSealed(encryption, keyedB, doc(secondB, '2026-11-07T10:00:00.000Z', 'decided on B after the upgrade'), keyB);
      assert.ok(teamSync.stageTeamState(stateB, syncDir, teamKey, keyB) >= 1);

      const toA = teamSync.mergeTeamStateFrom(syncDir, stateA, teamKey, keyA);
      assert.ok(toA.merged >= 1, JSON.stringify(toA));
      const keyedA = branchState.resolveStateWrite(stateA, secondA, 'main');
      assert.ok(fs.existsSync(keyedA), 'the keyed document now exists on the first machine');
      assert.ok(encryption.readStateFile(keyedA, keyA).includes('decided on A before the upgrade'), 'and it carries the newer legacy state, which was never read by the other machine');
      assert.strictEqual(branchState.resolveStateRead(stateA, secondA, 'main').filePath, keyedA);

      teamSync.stageTeamState(stateA, syncDir, teamKey, keyA);
      const toB = teamSync.mergeTeamStateFrom(syncDir, stateB, teamKey, keyB);
      assert.ok(toB.merged >= 1, JSON.stringify(toB));
      assert.ok(encryption.readStateFile(keyedB, keyB).includes('decided on A before the upgrade'), 'the other machine reads it after the next sync');
    });

    run('a pre-hash main.md is not shared next to the hashed document of the same branch, and two legacy checkouts of one repository share the newer', () => {
      const remote = 'https://example.com/Third/Repo.git';
      const third = makeCheckout(dir, path.join('linux', 'third', 'app'), remote);
      const key = branchState.projectKey(third);
      writeSealed(encryption, path.join(stateA, key, `${branchState.branchStateKey('main')}.md`), doc(third, '2026-11-07T12:00:00.000Z', 'hashed and keyed'), keyA);
      writeSealed(encryption, path.join(stateA, branchState.projectSlug(third), 'main.md'), doc(third, '2026-11-07T13:00:00.000Z', 'pre-hash main.md'), keyA);
      teamSync.stageTeamState(stateA, syncDir, teamKey, keyA);
      assert.ok(!fs.existsSync(path.join(syncDir, key, 'main.md')), 'the pre-hash file of a branch that has a hashed keyed document is not shared');

      const remoteTwice = 'https://example.com/Fourth/Repo.git';
      const cloneOne = makeCheckout(dir, path.join('linux', 'fourth', 'one'), remoteTwice);
      const cloneTwo = makeCheckout(dir, path.join('linux', 'fourth', 'two'), remoteTwice);
      const branchName = `${branchState.branchStateKey('main')}.md`;
      writeSealed(encryption, path.join(stateA, branchState.projectSlug(cloneOne), branchName), doc(cloneOne, '2026-11-07T10:00:00.000Z', 'older clone'), keyA);
      writeSealed(encryption, path.join(stateA, branchState.projectSlug(cloneTwo), branchName), doc(cloneTwo, '2026-11-07T11:00:00.000Z', 'newer clone'), keyA);
      teamSync.stageTeamState(stateA, syncDir, teamKey, keyA);
      const sharedName = path.join(branchState.projectKey(cloneOne), branchName);
      const opened = envelope.openEnvelope(fs.readFileSync(path.join(syncDir, sharedName), 'utf8'), teamKey, sharedName);
      assert.ok(opened.includes('newer clone'), 'the newer of the two legacy documents is the one shared');
    });

    run('a pre-hash branch file and a flat file of the versions before branches take the hashed name of their branch, so they meet the keyed document', () => {
      const remote = 'https://example.com/Fifth/Repo.git';
      const fifthA = makeCheckout(dir, path.join('linux', 'fifth', 'app'), remote);
      const fifthB = makeCheckout(dir, path.join('mac', 'fifth', 'clone'), remote);
      const hashedMain = `${branchState.branchStateKey('main')}.md`;
      writeSealed(encryption, path.join(stateA, branchState.projectSlug(fifthA), 'main.md'), doc(fifthA, '2026-11-07T11:00:00.000Z', 'pre-hash on A'), keyA);
      const keyedB = path.join(stateB, branchState.projectKey(fifthB), hashedMain);
      writeSealed(encryption, keyedB, doc(fifthB, '2026-11-07T10:00:00.000Z', 'hashed on B'), keyB);
      teamSync.stageTeamState(stateB, syncDir, teamKey, keyB);
      teamSync.mergeTeamStateFrom(syncDir, stateA, teamKey, keyA);
      const keyedA = path.join(stateA, branchState.projectKey(fifthA), hashedMain);
      assert.ok(fs.existsSync(keyedA), 'the hashed document lands on A');
      assert.ok(encryption.readStateFile(keyedA, keyA).includes('pre-hash on A'), 'merged with the newer pre-hash document, under the hashed name');
      teamSync.stageTeamState(stateA, syncDir, teamKey, keyA);
      assert.ok(!fs.existsSync(path.join(syncDir, branchState.projectKey(fifthA), 'main.md')), 'nothing is shared under the pre-hash name');

      const sixth = makeCheckout(dir, path.join('linux', 'sixth', 'app'), 'https://example.com/Sixth/Repo.git');
      const flatDoc = `# Project State\nproject: ${sixth}\nauthor: test\nupdated: 2026-11-07T09:00:00.000Z\n\n## Context\nflat, before branches\n`;
      writeSealed(encryption, path.join(stateA, `${branchState.projectSlug(sixth)}.md`), flatDoc, keyA);
      teamSync.stageTeamState(stateA, syncDir, teamKey, keyA);
      const sharedFlat = path.join(branchState.projectKey(sixth), hashedMain);
      assert.ok(fs.existsSync(path.join(syncDir, sharedFlat)), 'a flat document is shared as the document of the default branch');
      assert.ok(!fs.existsSync(path.join(syncDir, `${branchState.projectKey(sixth)}.md`)), 'and not as a flat file under the key');

      if (process.platform !== 'win32') {
        const seventh = makeCheckout(dir, path.join('linux', 'seventh', 'app'), 'https://example.com/Seventh/Repo.git');
        writeSealed(encryption, path.join(stateA, branchState.projectSlug(seventh), hashedMain), doc(seventh, '2026-11-07T08:00:00.000Z', 'legacy behind a planted link'), keyA);
        const keyedDir = path.join(stateA, branchState.projectKey(seventh));
        fs.mkdirSync(keyedDir, { recursive: true });
        fs.symlinkSync(path.join(dir, 'elsewhere.md'), path.join(keyedDir, hashedMain));
        teamSync.stageTeamState(stateA, syncDir, teamKey, keyA);
        const sharedSeventh = path.join(branchState.projectKey(seventh), hashedMain);
        assert.ok(fs.existsSync(path.join(syncDir, sharedSeventh)), 'a link planted at the keyed path does not pass for the keyed document, so the legacy one is still shared');
        assert.ok(envelope.openEnvelope(fs.readFileSync(path.join(syncDir, sharedSeventh), 'utf8'), teamKey, sharedSeventh).includes('legacy behind a planted link'));
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
