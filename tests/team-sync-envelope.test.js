/**
 * Team sync envelopes: state leaves the machine sealed with the team key and
 * only verified envelopes reach local state (security audit 2026-08-17,
 * day 10 of the schedule). Runs against the built memory server modules.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const BUILD = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build');

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

async function runTests() {
  console.log('\n=== Testing team sync envelopes ===\n');
  let envelope;
  let teamSync;
  let encryption;
  let integrity;
  try {
    envelope = await import(pathToFileURL(path.join(BUILD, 'sync', 'envelope.js')).href);
    teamSync = await import(pathToFileURL(path.join(BUILD, 'sync', 'TeamSync.js')).href);
    encryption = await import(pathToFileURL(path.join(BUILD, 'encryption.js')).href);
    integrity = await import(pathToFileURL(path.join(BUILD, 'integrity.js')).href);
  } catch (error) {
    console.error(`[SKIP] Could not import the memory server build: ${error.message}. Run 'npm run build' in mcp/servers/egc-memory first.`);
    process.exit(0);
  }
  let passed = 0;
  let failed = 0;
  const run = (name, fn) => {
    if (test(name, fn)) passed++; else failed++;
  };
  const teamKey = crypto.randomBytes(32);
  const otherKey = crypto.randomBytes(32);
  const personalKey = crypto.randomBytes(32);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-team-envelope-'));
  const isLinkPath = (candidate) => {
    try {
      return fs.lstatSync(candidate).isSymbolicLink();
    } catch {
      return false;
    }
  };

  const syncDir = path.join(dir, 'sync');
  const localDir = path.join(dir, 'local');
  const doc = (updated, body) => `# Project State\nupdated: ${updated}\n\n${body}\n`;
  try {
    run('an envelope opens with the team key and with nothing else', () => {
      const sealed = envelope.sealEnvelope('hello team', teamKey, 'proj/main.md');
      assert.strictEqual(envelope.openEnvelope(sealed, teamKey, 'proj/main.md'), 'hello team');
      assert.strictEqual(envelope.openEnvelope(sealed, teamKey, path.join('proj', 'main.md')), 'hello team', 'the platform separator is normalized');
      assert.strictEqual(envelope.openEnvelope(sealed, otherKey, 'proj/main.md'), null);
      assert.strictEqual(envelope.openEnvelope(sealed, teamKey, 'other/main.md'), null, 'an envelope copied to another path is refused');
      if (path.sep === '/') assert.strictEqual(envelope.openEnvelope(envelope.sealEnvelope('x', teamKey, 'a\\b.md'), teamKey, 'a/b.md'), null, 'a backslash in a POSIX name is not a separator');

      const parsed = JSON.parse(sealed);
      assert.strictEqual(envelope.openEnvelope(JSON.stringify({ ...parsed, path: 'other/main.md' }), teamKey, 'other/main.md'), null, 'a rewritten path breaks the signature');
      const flipped = Buffer.from(parsed.data, 'base64');
      flipped[flipped.length - 1] ^= 0x01;
      assert.strictEqual(envelope.openEnvelope(JSON.stringify({ ...parsed, data: flipped.toString('base64') }), teamKey, 'proj/main.md'), null);
      assert.strictEqual(envelope.openEnvelope(JSON.stringify({ ...parsed, mac: parsed.mac.replace(/^./, c => (c === 'a' ? 'b' : 'a')) }), teamKey, 'proj/main.md'), null);
      assert.strictEqual(envelope.openEnvelope('# Project State\nupdated: 2026-01-01\n', teamKey, 'proj/main.md'), null);
      assert.strictEqual(envelope.openEnvelope('{"egcTeamEnvelope":1}', teamKey, 'proj/main.md'), null);
    });

    run('the merge takes a newer verified envelope, keeps newer local state, and rejects everything else', () => {
      fs.mkdirSync(path.join(syncDir, 'proj'), { recursive: true });
      fs.mkdirSync(path.join(localDir, 'proj'), { recursive: true });
      fs.writeFileSync(path.join(syncDir, 'proj', 'newer.md'), envelope.sealEnvelope(doc('2026-09-04T12:00:00.000Z', 'remote wins'), teamKey, 'proj/newer.md'));
      encryption.writeStateFile(path.join(localDir, 'proj', 'newer.md'), doc('2026-09-01T12:00:00.000Z', 'local old'), personalKey);
      fs.writeFileSync(path.join(syncDir, 'proj', 'older.md'), envelope.sealEnvelope(doc('2026-08-01T12:00:00.000Z', 'remote old'), teamKey, 'proj/older.md'));
      encryption.writeStateFile(path.join(localDir, 'proj', 'older.md'), doc('2026-09-03T12:00:00.000Z', 'local wins'), personalKey);
      fs.writeFileSync(path.join(syncDir, 'proj', 'fresh.md'), envelope.sealEnvelope(doc('2026-09-02T12:00:00.000Z', 'brand new'), teamKey, 'proj/fresh.md'));
      fs.writeFileSync(path.join(syncDir, 'proj', 'plain.md'), doc('2026-09-09T12:00:00.000Z', 'injected in the clear'));
      fs.writeFileSync(path.join(syncDir, 'proj', 'foreign.md'), envelope.sealEnvelope(doc('2026-09-09T12:00:00.000Z', 'sealed with another key'), otherKey, 'proj/foreign.md'));
      fs.writeFileSync(path.join(syncDir, 'proj', 'moved.md'), envelope.sealEnvelope(doc('2026-09-09T12:00:00.000Z', 'copied from elsewhere'), teamKey, 'proj/newer.md'));
      fs.writeFileSync(path.join(localDir, 'proj', 'legacy.md'), doc('2026-09-08T12:00:00.000Z', 'legacy plaintext, newer than the team'));
      fs.writeFileSync(path.join(syncDir, 'proj', 'legacy.md'), envelope.sealEnvelope(doc('2026-08-08T12:00:00.000Z', 'older remote'), teamKey, 'proj/legacy.md'));
      encryption.writeStateFile(path.join(localDir, 'proj', 'locked.md'), doc('2026-01-01T12:00:00.000Z', 'sealed under a rotated key'), otherKey);
      fs.writeFileSync(path.join(syncDir, 'proj', 'locked.md'), envelope.sealEnvelope(doc('2026-09-09T12:00:00.000Z', 'would replace it'), teamKey, 'proj/locked.md'));
      let linked;
      try {
        fs.symlinkSync(path.join(dir, 'elsewhere.md'), path.join(syncDir, 'proj', 'link.md'));
        linked = true;
      } catch {
        linked = false;
      }
      let linkedParent;
      try {
        fs.mkdirSync(path.join(dir, 'parent-target'), { recursive: true });
        fs.symlinkSync(path.join(dir, 'parent-target'), path.join(localDir, 'linked-parent'), 'dir');
        fs.mkdirSync(path.join(syncDir, 'linked-parent'), { recursive: true });
        fs.writeFileSync(path.join(syncDir, 'linked-parent', 'note.md'), envelope.sealEnvelope(doc('2026-09-09T12:00:00.000Z', 'through a linked parent'), teamKey, 'linked-parent/note.md'));
        linkedParent = true;
      } catch {
        linkedParent = false;
      }
      const outcome = teamSync.mergeTeamStateFrom(syncDir, localDir, teamKey, personalKey);
      if (linkedParent) {
        const linkedLocalRoot = path.join(dir, 'linked-local-root');
        fs.symlinkSync(path.join(dir, 'parent-target'), linkedLocalRoot, 'dir');
        const viaLink = teamSync.mergeTeamStateFrom(syncDir, linkedLocalRoot, teamKey, personalKey);
        assert.strictEqual(viaLink.merged, 0, 'nothing is merged into a local tree that is a link');
        assert.ok(viaLink.rejected.some(entry => entry.includes('local tree is a link')), JSON.stringify(viaLink.rejected));
        assert.throws(() => teamSync.stageTeamState(linkedLocalRoot, syncDir, teamKey, personalKey), /local state tree is a link/);
        const linkedLocalParent = path.join(dir, 'linked-parent-of-local', 'state');
        fs.symlinkSync(path.join(dir, 'parent-target'), path.join(dir, 'linked-parent-of-local'), 'dir');
        const viaParent = teamSync.mergeTeamStateFrom(syncDir, linkedLocalParent, teamKey, personalKey);
        assert.strictEqual(viaParent.merged, 0, 'nothing is merged below a linked parent');
        assert.throws(() => teamSync.stageTeamState(linkedLocalParent, syncDir, teamKey, personalKey), /local state tree is a link/);
        fs.mkdirSync(path.join(dir, 'sync-target'), { recursive: true });
        const linkedSyncRoot = path.join(dir, 'linked-sync-root');
        fs.symlinkSync(path.join(dir, 'sync-target'), linkedSyncRoot, 'dir');
        const viaSyncLink = teamSync.mergeTeamStateFrom(linkedSyncRoot, localDir, teamKey, personalKey);
        assert.ok(viaSyncLink.rejected.some(entry => entry.includes('sync tree is a link')), JSON.stringify(viaSyncLink.rejected));
        assert.ok(!fs.existsSync(linkedSyncRoot) && !isLinkPath(linkedSyncRoot), 'the linked sync tree is removed from the checkout');
        assert.ok(fs.existsSync(path.join(dir, 'sync-target')), 'the target of the link is untouched');
        fs.symlinkSync(path.join(dir, 'sync-target'), linkedSyncRoot, 'dir');
        assert.throws(() => teamSync.stageTeamState(localDir, linkedSyncRoot, teamKey, personalKey), /sync state tree is a link/);
        assert.strictEqual(fs.readdirSync(path.join(dir, 'sync-target')).length, 0, 'nothing is staged through the linked sync tree');

        assert.strictEqual(fs.readdirSync(path.join(dir, 'parent-target')).length, 0, 'nothing is written through the linked root');
        assert.ok(outcome.rejected.some(entry => entry.startsWith(path.join('linked-parent', 'note.md'))), 'a local parent that is a link is refused');
        assert.strictEqual(fs.readdirSync(path.join(dir, 'parent-target')).length, 0, 'nothing is written through the linked parent');
        outcome.rejected = outcome.rejected.filter(entry => !entry.startsWith(path.join('linked-parent', 'note.md')));
      }
      const expectedUnopened = ['proj/foreign.md', 'proj/moved.md', 'proj/plain.md'].map(p => p.split('/').join(path.sep)).sort();
      assert.deepStrictEqual(outcome.unopened.sort(), expectedUnopened, 'what does not open with the team key is reported apart from the links');
      assert.deepStrictEqual(outcome.rejected.sort(), linked ? [path.join('proj', 'link.md')] : [], 'only a link is rejected outright');
      assert.deepStrictEqual(outcome.unreadable, [path.join('proj', 'locked.md')]);
      assert.strictEqual(outcome.merged, 3, 'newer, fresh and the legacy plaintext rewrite');
      assert.strictEqual(outcome.opened, linkedParent ? 6 : 5, 'newer, older, fresh, legacy and locked opened with the team key, and the note behind the linked parent too');
      for (const name of ['foreign.md', 'moved.md', 'plain.md']) {
        assert.ok(fs.existsSync(path.join(syncDir, 'proj', name)), `${name} stays in the sync tree: a file this key cannot open is not this machine's to remove`);
      }
      if (linked) {
        const link = path.join(syncDir, 'proj', 'link.md');
        assert.ok(!fs.existsSync(link) && !isLinkPath(link), 'a link is removed from the sync tree');
      }
      assert.ok(fs.existsSync(path.join(syncDir, 'proj', 'locked.md')), 'a verified envelope stays in the sync tree');
      assert.ok(encryption.isEncrypted(fs.readFileSync(path.join(localDir, 'proj', 'legacy.md'))), 'legacy plaintext is rewritten encrypted');
      assert.ok(encryption.readStateFile(path.join(localDir, 'proj', 'legacy.md'), personalKey).includes('legacy plaintext'));
      assert.ok(encryption.readStateFile(path.join(localDir, 'proj', 'locked.md'), otherKey).includes('rotated key'), 'the unreadable local file is untouched');
      assert.ok(encryption.readStateFile(path.join(localDir, 'proj', 'newer.md'), personalKey).includes('remote wins'));
      assert.ok(encryption.readStateFile(path.join(localDir, 'proj', 'older.md'), personalKey).includes('local wins'));
      assert.ok(encryption.readStateFile(path.join(localDir, 'proj', 'fresh.md'), personalKey).includes('brand new'));
      assert.ok(!fs.existsSync(path.join(localDir, 'proj', 'plain.md')));
      assert.ok(!fs.existsSync(path.join(localDir, 'proj', 'foreign.md')));
      assert.ok(encryption.isEncrypted(fs.readFileSync(path.join(localDir, 'proj', 'fresh.md'))), 'local state stays encrypted at rest');
    });

    run('a key that opens nothing leaves the sync tree untouched, so a later push has nothing to remove', () => {
      const strangerSync = path.join(dir, 'stranger-sync');
      const strangerLocal = path.join(dir, 'stranger-local');
      fs.mkdirSync(path.join(strangerSync, 'proj'), { recursive: true });
      fs.writeFileSync(path.join(strangerSync, 'proj', 'main.md'), envelope.sealEnvelope(doc('2026-09-04T12:00:00.000Z', 'the team'), teamKey, 'proj/main.md'));
      const outcome = teamSync.mergeTeamStateFrom(strangerSync, strangerLocal, otherKey, personalKey);
      assert.strictEqual(outcome.opened, 0, 'no envelope opened with the wrong key');
      assert.strictEqual(outcome.merged, 0);
      assert.deepStrictEqual(outcome.unopened, [path.join('proj', 'main.md')]);
      assert.deepStrictEqual(outcome.rejected, []);
      assert.ok(fs.existsSync(path.join(strangerSync, 'proj', 'main.md')), 'the file the stranger cannot open stays where it was');
      assert.ok(!fs.existsSync(path.join(strangerLocal, 'proj', 'main.md')), 'nothing reaches local state');
    });

    run('staging seals every local file with the team key and nothing leaves in the clear', () => {
      const stagedDir = path.join(dir, 'staged');
      const count = teamSync.stageTeamState(localDir, stagedDir, teamKey, personalKey);
      assert.strictEqual(count, 4, 'newer, older, fresh and the rewritten legacy file; the unreadable one is left out');
      for (const name of ['newer.md', 'older.md', 'fresh.md', 'legacy.md']) {
        const raw = fs.readFileSync(path.join(stagedDir, 'proj', name), 'utf8');
        assert.ok(!raw.includes('Project State'), `${name} is not in the clear`);
        assert.ok(envelope.openEnvelope(raw, teamKey, `proj/${name}`).includes('Project State'), `${name} opens with the team key at its path`);
        assert.strictEqual(envelope.openEnvelope(raw, otherKey, `proj/${name}`), null);
      }
      assert.ok(!fs.existsSync(path.join(stagedDir, 'proj', 'locked.md')), 'an undecryptable local file is not staged');
    });

    run('staging leaves a path the merge could not open as it is, so this machine never writes over an envelope it cannot read', () => {
      const keptDir = path.join(dir, 'kept');
      fs.mkdirSync(path.join(keptDir, 'proj'), { recursive: true });
      const foreign = envelope.sealEnvelope(doc('2026-09-05T12:00:00.000Z', 'another team'), otherKey, 'proj/newer.md');
      fs.writeFileSync(path.join(keptDir, 'proj', 'newer.md'), foreign);
      const count = teamSync.stageTeamState(localDir, keptDir, teamKey, personalKey, new Set([path.join('proj', 'newer.md')]));
      assert.strictEqual(count, 3, 'the kept path is not staged, the other three are');
      assert.strictEqual(fs.readFileSync(path.join(keptDir, 'proj', 'newer.md'), 'utf8'), foreign, 'the envelope this key cannot open is byte for byte what it was');
      assert.ok(fs.existsSync(path.join(keptDir, 'proj', 'older.md')), 'the other paths are staged as usual');
    });

    run('the integrity sidecars never travel: a pushed one is retired, none is staged, and a merged document gets a sidecar of this machine', () => {
      const sidecarSync = path.join(dir, 'sidecar-sync');
      const sidecarLocal = path.join(dir, 'sidecar-local');
      const integrityKey = crypto.randomBytes(32);
      fs.mkdirSync(path.join(sidecarSync, 'proj'), { recursive: true });
      fs.mkdirSync(path.join(sidecarLocal, 'proj'), { recursive: true });
      const remoteDoc = doc('2026-09-06T12:00:00.000Z', 'from the other machine');
      fs.writeFileSync(path.join(sidecarSync, 'proj', 'main.md'), envelope.sealEnvelope(remoteDoc, teamKey, 'proj/main.md'));
      fs.writeFileSync(path.join(sidecarSync, 'proj', 'main.md.hmac'), envelope.sealEnvelope('a'.repeat(64), teamKey, 'proj/main.md.hmac'));
      encryption.writeStateFile(path.join(sidecarLocal, 'proj', 'main.md'), doc('2026-09-01T12:00:00.000Z', 'older here'), personalKey);
      fs.writeFileSync(path.join(sidecarLocal, 'proj', 'main.md.hmac'), 'f'.repeat(64));
      const outcome = teamSync.mergeTeamStateFrom(sidecarSync, sidecarLocal, teamKey, personalKey, integrityKey);
      assert.strictEqual(outcome.merged, 1);
      assert.strictEqual(outcome.opened, 1, 'the sidecar is not an envelope to count');
      assert.deepStrictEqual(outcome.unopened, [], 'a pushed sidecar is not reported as rejected');
      assert.deepStrictEqual(outcome.rejected, []);
      assert.ok(!fs.existsSync(path.join(sidecarSync, 'proj', 'main.md.hmac')), 'the sidecar an earlier version pushed is retired from the sync tree');
      assert.ok(fs.existsSync(path.join(sidecarSync, 'proj', 'main.md')), 'the document stays');
      assert.strictEqual(fs.readFileSync(path.join(sidecarLocal, 'proj', 'main.md.hmac'), 'utf8'), integrity.computeHmac(remoteDoc, integrityKey), 'the merged document carries a sidecar made with the key of this machine');
      const stagedDir = path.join(dir, 'sidecar-staged');
      assert.strictEqual(teamSync.stageTeamState(sidecarLocal, stagedDir, teamKey, personalKey), 1, 'only the document is staged');
      assert.ok(!fs.existsSync(path.join(stagedDir, 'proj', 'main.md.hmac')), 'no sidecar leaves the machine');
    });

    run('a local document the merge keeps gets its sidecar repaired when older versions left it unusable, and a well-formed mismatch is left alone', () => {
      const repairSync = path.join(dir, 'repair-sync');
      const repairLocal = path.join(dir, 'repair-local');
      const integrityKey = crypto.randomBytes(32);
      fs.mkdirSync(path.join(repairSync, 'proj'), { recursive: true });
      fs.mkdirSync(path.join(repairLocal, 'proj'), { recursive: true });
      const olderRemote = doc('2026-09-02T12:00:00.000Z', 'older on the remote');
      const localDocs = { 'garbage.md': doc('2026-09-09T12:00:00.000Z', 'kept, sidecar garbage'), 'missing.md': doc('2026-09-09T12:00:00.000Z', 'kept, sidecar missing'), 'tamper.md': doc('2026-09-09T12:00:00.000Z', 'kept, sidecar well formed') };
      for (const name of Object.keys(localDocs)) {
        fs.writeFileSync(path.join(repairSync, 'proj', name), envelope.sealEnvelope(olderRemote, teamKey, `proj/${name}`));
        encryption.writeStateFile(path.join(repairLocal, 'proj', name), localDocs[name], personalKey);
      }
      fs.writeFileSync(path.join(repairLocal, 'proj', 'garbage.md.hmac'), 'EGC1:bytes an older merge wrote over the sidecar');
      fs.writeFileSync(path.join(repairLocal, 'proj', 'tamper.md.hmac'), 'f'.repeat(64));
      // A link planted at a sidecar path, pointing at a file that looks like
      // a sidecar: it must be neither accepted nor written through. Only the
      // refusal of symbolic links by the platform skips this part.
      const victim = path.join(dir, 'victim.hmac');
      fs.writeFileSync(victim, 'a'.repeat(64));
      let planted = false;
      try {
        fs.symlinkSync(victim, path.join(repairLocal, 'proj', 'missing.md.hmac'));
        planted = true;
      } catch (error) {
        if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
      }
      const outcome = teamSync.mergeTeamStateFrom(repairSync, repairLocal, teamKey, personalKey, integrityKey);
      assert.strictEqual(outcome.merged, 0, 'the local documents are newer and stay');
      assert.strictEqual(fs.readFileSync(path.join(repairLocal, 'proj', 'garbage.md.hmac'), 'utf8'), integrity.computeHmac(localDocs['garbage.md'], integrityKey), 'the garbage sidecar is written anew');
      assert.strictEqual(fs.readFileSync(path.join(repairLocal, 'proj', 'tamper.md.hmac'), 'utf8'), 'f'.repeat(64), 'a well-formed sidecar that does not match is the tamper signal and stays');
      assert.ok(!fs.lstatSync(path.join(repairLocal, 'proj', 'missing.md.hmac')).isSymbolicLink(), planted ? 'the planted link is replaced by a real sidecar' : 'the missing sidecar is a real file');
      assert.strictEqual(fs.readFileSync(path.join(repairLocal, 'proj', 'missing.md.hmac'), 'utf8'), integrity.computeHmac(localDocs['missing.md'], integrityKey), 'the sidecar is written with the key of this machine');
      assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'a'.repeat(64), 'the file behind a planted link is neither read as a sidecar nor written');
    });

    run('the team key is validated and generated as 64 hex characters', () => {
      assert.ok(/^[0-9a-f]{64}$/.test(envelope.generateTeamKey()));
      assert.strictEqual(envelope.parseTeamKey('not-a-key'), null);
      assert.strictEqual(envelope.parseTeamKey(undefined), null);
      assert.strictEqual(envelope.parseTeamKey(teamKey.toString('hex')).equals(teamKey), true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
