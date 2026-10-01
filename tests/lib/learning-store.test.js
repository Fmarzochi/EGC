'use strict';

// The continuous-learning store lives in one folder for every tool,
// ~/.egc-learning, outside ~/.egc (the Guardian refuses agent writes there,
// and the observer agent writes instincts itself). Earlier versions kept it
// under ~/.gemini/homunculus or under each tool's own folder; the first
// session start after the upgrade copies those in once, never overwriting a
// file already in the new store and never touching the old one.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getLearningDir } = require('../../scripts/lib/utils');
const { migrateLegacyLearningStore, MIGRATION_MARKER } = require('../../scripts/lib/learning-store');

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

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-learning-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

console.log('\n=== Testing the continuous-learning store ===\n');

let passed = 0;
let failed = 0;

if (test('the learning store is ~/.egc-learning, outside the protected ~/.egc', () => withHome(home => {
  assert.strictEqual(getLearningDir(), path.join(home, '.egc-learning'));
}))) passed++; else failed++;

if (test('the Antigravity-era store is copied in and left intact', () => withHome(home => {
  const legacy = path.join(home, '.gemini', 'homunculus');
  write(path.join(legacy, 'instincts', 'personal', 'a.yaml'), 'a');
  write(path.join(legacy, 'projects', 'p1', 'observations.jsonl'), '{"n":1}\n');
  write(path.join(legacy, 'projects.json'), '{"p1":{}}');

  const result = migrateLegacyLearningStore({ homeDir: home });

  const store = path.join(home, '.egc-learning');
  assert.deepStrictEqual(result.migrated, [legacy]);
  assert.strictEqual(read(path.join(store, 'instincts', 'personal', 'a.yaml')), 'a');
  assert.strictEqual(read(path.join(store, 'projects', 'p1', 'observations.jsonl')), '{"n":1}\n');
  assert.strictEqual(read(path.join(store, 'projects.json')), '{"p1":{}}');
  assert.strictEqual(read(path.join(legacy, 'instincts', 'personal', 'a.yaml')), 'a', 'the old store is never touched');
}))) passed++; else failed++;

if (test('stores kept under each tool folder are merged in without overwriting the first one copied', () => withHome(home => {
  write(path.join(home, '.gemini', 'homunculus', 'instincts', 'personal', 'shared.yaml'), 'from gemini');
  write(path.join(home, '.claude', 'homunculus', 'instincts', 'personal', 'shared.yaml'), 'from claude');
  write(path.join(home, '.claude', 'homunculus', 'instincts', 'personal', 'only-claude.yaml'), 'claude');
  write(path.join(home, '.egc', 'homunculus', 'evolved', 'skills', 's.md'), 'egc');

  const result = migrateLegacyLearningStore({ homeDir: home });

  const store = path.join(home, '.egc-learning');
  assert.deepStrictEqual(result.migrated, [
    path.join(home, '.gemini', 'homunculus'),
    path.join(home, '.claude', 'homunculus'),
    path.join(home, '.egc', 'homunculus'),
  ]);
  assert.strictEqual(read(path.join(store, 'instincts', 'personal', 'shared.yaml')), 'from gemini');
  assert.strictEqual(read(path.join(store, 'instincts', 'personal', 'only-claude.yaml')), 'claude');
  assert.strictEqual(read(path.join(store, 'evolved', 'skills', 's.md')), 'egc');
}))) passed++; else failed++;

if (test('a file already written to the new store is never overwritten', () => withHome(home => {
  write(path.join(home, '.gemini', 'homunculus', 'observations.jsonl'), 'old\n');
  write(path.join(home, '.egc-learning', 'observations.jsonl'), 'new\n');

  migrateLegacyLearningStore({ homeDir: home });

  assert.strictEqual(read(path.join(home, '.egc-learning', 'observations.jsonl')), 'new\n');
}))) passed++; else failed++;

if (test('the copy runs once: a marker records it and later calls change nothing', () => withHome(home => {
  write(path.join(home, '.gemini', 'homunculus', 'a.yaml'), 'a');
  const first = migrateLegacyLearningStore({ homeDir: home, now: () => new Date('2026-10-01T00:00:00Z') });
  write(path.join(home, '.gemini', 'homunculus', 'b.yaml'), 'b');

  const second = migrateLegacyLearningStore({ homeDir: home });

  const marker = JSON.parse(read(path.join(home, '.egc-learning', MIGRATION_MARKER)));
  assert.deepStrictEqual(marker, { migratedAt: '2026-10-01T00:00:00.000Z', sources: first.migrated });
  assert.deepStrictEqual(second.migrated, []);
  assert.ok(!fs.existsSync(path.join(home, '.egc-learning', 'b.yaml')), 'nothing is copied after the marker');
}))) passed++; else failed++;

if (test('without an old store nothing is created', () => withHome(home => {
  const result = migrateLegacyLearningStore({ homeDir: home });

  assert.deepStrictEqual(result.migrated, []);
  assert.ok(!fs.existsSync(path.join(home, '.egc-learning')), 'no empty store appears for people who never used continuous learning');
}))) passed++; else failed++;

if (test('a source that is not a folder is skipped and the others are still copied', () => withHome(home => {
  write(path.join(home, '.gemini', 'homunculus'), 'a file where a folder was expected');
  write(path.join(home, '.claude', 'homunculus', 'a.yaml'), 'a');

  const result = migrateLegacyLearningStore({ homeDir: home });

  assert.deepStrictEqual(result.migrated, [path.join(home, '.claude', 'homunculus')]);
  assert.strictEqual(read(path.join(home, '.egc-learning', 'a.yaml')), 'a');
}))) passed++; else failed++;

console.log(`\nPassed: ${passed}, Failed: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
