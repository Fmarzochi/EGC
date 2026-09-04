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
      const sealed = envelope.sealEnvelope('hello team', teamKey);
      assert.strictEqual(envelope.openEnvelope(sealed, teamKey), 'hello team');
      assert.strictEqual(envelope.openEnvelope(sealed, otherKey), null);
      const parsed = JSON.parse(sealed);
      const flipped = Buffer.from(parsed.data, 'base64');
      flipped[flipped.length - 1] ^= 0x01;
      assert.strictEqual(envelope.openEnvelope(JSON.stringify({ ...parsed, data: flipped.toString('base64') }), teamKey), null);
      assert.strictEqual(envelope.openEnvelope(JSON.stringify({ ...parsed, mac: parsed.mac.replace(/^./, c => (c === 'a' ? 'b' : 'a')) }), teamKey), null);
      assert.strictEqual(envelope.openEnvelope('# Project State\nupdated: 2026-01-01\n', teamKey), null);
      assert.strictEqual(envelope.openEnvelope('{"egcTeamEnvelope":1}', teamKey), null);
    })) passed++; else failed++;

    if (test('the merge takes a newer verified envelope, keeps newer local state, and rejects everything else', () => {
      fs.mkdirSync(path.join(syncDir, 'proj'), { recursive: true });
      fs.mkdirSync(path.join(localDir, 'proj'), { recursive: true });
      fs.writeFileSync(path.join(syncDir, 'proj', 'newer.md'), envelope.sealEnvelope(doc('2026-09-04T12:00:00.000Z', 'remote wins'), teamKey));
      encryption.writeStateFile(path.join(localDir, 'proj', 'newer.md'), doc('2026-09-01T12:00:00.000Z', 'local old'), personalKey);
      fs.writeFileSync(path.join(syncDir, 'proj', 'older.md'), envelope.sealEnvelope(doc('2026-08-01T12:00:00.000Z', 'remote old'), teamKey));
      encryption.writeStateFile(path.join(localDir, 'proj', 'older.md'), doc('2026-09-03T12:00:00.000Z', 'local wins'), personalKey);
      fs.writeFileSync(path.join(syncDir, 'proj', 'fresh.md'), envelope.sealEnvelope(doc('2026-09-02T12:00:00.000Z', 'brand new'), teamKey));
      fs.writeFileSync(path.join(syncDir, 'proj', 'plain.md'), doc('2026-09-09T12:00:00.000Z', 'injected in the clear'));
      fs.writeFileSync(path.join(syncDir, 'proj', 'foreign.md'), envelope.sealEnvelope(doc('2026-09-09T12:00:00.000Z', 'sealed with another key'), otherKey));
      const outcome = teamSync.mergeTeamStateFrom(syncDir, localDir, teamKey, personalKey);
      assert.deepStrictEqual(outcome.rejected.sort(), ['proj/foreign.md', 'proj/plain.md'].map(p => p.split('/').join(path.sep)));
      assert.strictEqual(outcome.merged, 2);
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
      assert.strictEqual(count, 3);
      for (const name of ['newer.md', 'older.md', 'fresh.md']) {
        const raw = fs.readFileSync(path.join(stagedDir, 'proj', name), 'utf8');
        assert.ok(!raw.includes('Project State'), `${name} is not in the clear`);
        assert.ok(envelope.openEnvelope(raw, teamKey).includes('Project State'), `${name} opens with the team key`);
        assert.strictEqual(envelope.openEnvelope(raw, otherKey), null);
      }
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
