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
  try {
    envelope = await import(pathToFileURL(path.join(BUILD, 'sync', 'envelope.js')).href);
    teamSync = await import(pathToFileURL(path.join(BUILD, 'sync', 'TeamSync.js')).href);
    encryption = await import(pathToFileURL(path.join(BUILD, 'encryption.js')).href);
  } catch (error) {
    console.error(`[SKIP] Could not import the memory server build: ${error.message}. Run 'npm run build' in mcp/servers/egc-memory first.`);
    process.exit(0);
  }
  let passed = 0;
  let failed = 0;
  const teamKey = crypto.randomBytes(32);
  const otherKey = crypto.randomBytes(32);
  const personalKey = crypto.randomBytes(32);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-team-envelope-'));
  const syncDir = path.join(dir, 'sync');
  const localDir = path.join(dir, 'local');
  const doc = (updated, body) => `# Project State\nupdated: ${updated}\n\n${body}\n`;
  try {
    if (test('an envelope opens with the team key and with nothing else', () => {
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
    })) passed++; else failed++;

    if (test('the merge takes a newer verified envelope, keeps newer local state, and rejects everything else', () => {
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
        assert.strictEqual(fs.readdirSync(path.join(dir, 'parent-target')).length, 0, 'nothing is written through the linked root');
        assert.ok(outcome.rejected.some(entry => entry.startsWith(path.join('linked-parent', 'note.md'))), 'a local parent that is a link is refused');
        assert.strictEqual(fs.readdirSync(path.join(dir, 'parent-target')).length, 0, 'nothing is written through the linked parent');
        outcome.rejected = outcome.rejected.filter(entry => !entry.startsWith(path.join('linked-parent', 'note.md')));
      }
      const expectedRejected = ['proj/foreign.md', 'proj/moved.md', 'proj/plain.md'].concat(linked ? ['proj/link.md'] : []).map(p => p.split('/').join(path.sep)).sort();
      assert.deepStrictEqual(outcome.rejected.sort(), expectedRejected);
      assert.deepStrictEqual(outcome.unreadable, [path.join('proj', 'locked.md')]);
      assert.strictEqual(outcome.merged, 3, 'newer, fresh and the legacy plaintext rewrite');
      for (const name of ['foreign.md', 'moved.md', 'plain.md'].concat(linked ? ['link.md'] : [])) {
        assert.ok(!fs.existsSync(path.join(syncDir, 'proj', name)), `${name} is removed from the sync tree`);
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
    })) passed++; else failed++;

    if (test('staging seals every local file with the team key and nothing leaves in the clear', () => {
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
    })) passed++; else failed++;

    if (test('the team key is validated and generated as 64 hex characters', () => {
      assert.ok(/^[0-9a-f]{64}$/.test(envelope.generateTeamKey()));
      assert.strictEqual(envelope.parseTeamKey('not-a-key'), null);
      assert.strictEqual(envelope.parseTeamKey(undefined), null);
      assert.strictEqual(envelope.parseTeamKey(teamKey.toString('hex')).equals(teamKey), true);
    })) passed++; else failed++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
