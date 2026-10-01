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

if (test('the project registries of every store are merged, the first store winning on the same project', () => withHome(home => {
  write(path.join(home, '.gemini', 'homunculus', 'projects.json'), JSON.stringify({ aaa111: { name: 'from-gemini' } }));
  write(path.join(home, '.claude', 'homunculus', 'projects.json'), JSON.stringify({ aaa111: { name: 'from-claude' }, bbb222: { name: 'only-claude' } }));

  migrateLegacyLearningStore({ homeDir: home });

  const registry = JSON.parse(read(path.join(home, '.egc-learning', 'projects.json')));
  assert.deepStrictEqual(registry, { aaa111: { name: 'from-gemini' }, bbb222: { name: 'only-claude' } });
}))) passed++; else failed++;

if (test('a legacy store under EGC_DIR is migrated too', () => withHome(home => {
  const customDir = path.join(home, 'custom-egc-dir');
  write(path.join(customDir, 'homunculus', 'a.yaml'), 'a');
  const savedEgcDir = process.env.EGC_DIR;
  process.env.EGC_DIR = customDir;
  try {
    const result = migrateLegacyLearningStore({ homeDir: home });
    assert.deepStrictEqual(result.migrated, [path.join(customDir, 'homunculus')]);
    assert.strictEqual(read(path.join(home, '.egc-learning', 'a.yaml')), 'a');
  } finally {
    if (savedEgcDir === undefined) delete process.env.EGC_DIR;
    else process.env.EGC_DIR = savedEgcDir;
  }
}))) passed++; else failed++;

if (test('live observer runtime files are not copied into the new store', () => withHome(home => {
  const legacy = path.join(home, '.gemini', 'homunculus');
  write(path.join(legacy, 'instincts', 'personal', 'a.yaml'), 'a');
  write(path.join(legacy, '.observer.pid'), '12345');
  write(path.join(legacy, '.observer-signal-counter'), '3');
  write(path.join(legacy, '.observer-last-activity'), '2026-10-01T00:00:00Z');
  write(path.join(legacy, '.observer-sessions', 'sess1'), 'x');

  migrateLegacyLearningStore({ homeDir: home });

  const store = path.join(home, '.egc-learning');
  assert.strictEqual(read(path.join(store, 'instincts', 'personal', 'a.yaml')), 'a');
  for (const name of ['.observer.pid', '.observer-signal-counter', '.observer-last-activity', '.observer-sessions']) {
    assert.ok(!fs.existsSync(path.join(store, name)), `${name} is left out of the new store, so a fresh observer always starts there`);
  }
}))) passed++; else failed++;

if (test('an entry that cannot be inspected fails the migration instead of being silently dropped', () => withHome(home => {
  const legacy = path.join(home, '.gemini', 'homunculus');
  write(path.join(legacy, 'a.yaml'), 'a');
  write(path.join(legacy, 'locked.yaml'), 'locked');

  const originalLstat = fs.lstatSync;
  fs.lstatSync = (entryPath, ...rest) => {
    if (path.basename(entryPath) === 'locked.yaml') {
      const error = new Error('EACCES: permission denied, lstat');
      error.code = 'EACCES';
      throw error;
    }
    return originalLstat(entryPath, ...rest);
  };

  let result;
  try {
    result = migrateLegacyLearningStore({ homeDir: home });
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.strictEqual(result.failed.length, 1);
  assert.strictEqual(result.failed[0].source, legacy);
  assert.ok(!fs.existsSync(path.join(home, '.egc-learning', MIGRATION_MARKER)), 'a failed migration never writes the marker');
  const leftovers = fs.readdirSync(home).filter(name => name.startsWith('.egc-learning') && name !== '.egc-learning');
  assert.deepStrictEqual(leftovers, [], 'a failed copy leaves no abandoned staging folder behind to leak on every retry');
}))) passed++; else failed++;

function canCreateSymlinks() {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-symlink-probe-'));
  try {
    const target = path.join(probeDir, 'target.txt');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(probeDir, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

// Creating links needs a privilege Windows may not grant without developer
// mode; skipped explicitly so a denied symlink never silently counts as a
// passed assertion.
if (!canCreateSymlinks()) {
  console.log('  - skipped symlink test; this environment does not permit creating symbolic links');
} else if (test('a symbolic link inside an old store is not copied', () => withHome(home => {
  const legacy = path.join(home, '.gemini', 'homunculus');
  write(path.join(legacy, 'instincts', 'personal', 'real.yaml'), 'real');
  write(path.join(home, 'outside.txt'), 'outside');
  fs.symlinkSync(path.join(home, 'outside.txt'), path.join(legacy, 'instincts', 'personal', 'link.yaml'));

  migrateLegacyLearningStore({ homeDir: home });

  const personal = path.join(home, '.egc-learning', 'instincts', 'personal');
  assert.strictEqual(read(path.join(personal, 'real.yaml')), 'real');
  assert.ok(!fs.existsSync(path.join(personal, 'link.yaml')), 'the link is left behind');
}))) passed++; else failed++;

if (!canCreateSymlinks()) {
  console.log('  - skipped registry symlink test; this environment does not permit creating symbolic links');
} else if (test('a symlinked project registry is never read as a source of truth', () => withHome(home => {
  const legacy = path.join(home, '.gemini', 'homunculus');
  write(path.join(legacy, 'a.yaml'), 'a');
  write(path.join(home, 'outside-registry.json'), JSON.stringify({ zzz999: { name: 'planted' } }));
  fs.symlinkSync(path.join(home, 'outside-registry.json'), path.join(legacy, 'projects.json'));

  migrateLegacyLearningStore({ homeDir: home });

  assert.ok(!fs.existsSync(path.join(home, '.egc-learning', 'projects.json')), 'a linked registry is never merged in');
}))) passed++; else failed++;

if (test('a first copy into an empty home leaves no temporary folder behind', () => withHome(home => {
  write(path.join(home, '.gemini', 'homunculus', 'a.yaml'), 'a');

  migrateLegacyLearningStore({ homeDir: home });

  const leftovers = fs.readdirSync(home).filter(name => name.startsWith('.egc-learning') && name !== '.egc-learning');
  assert.deepStrictEqual(leftovers, []);
  assert.strictEqual(read(path.join(home, '.egc-learning', 'a.yaml')), 'a');
}))) passed++; else failed++;

if (test('a session that loses the race to place a file never clobbers the one that won', () => withHome(home => {
  write(path.join(home, '.gemini', 'homunculus', 'a.yaml'), 'from this session');
  write(path.join(home, '.gemini', 'homunculus', 'b.yaml'), 'b');
  const store = path.join(home, '.egc-learning');

  // Another session places a.yaml right before this session's own placement,
  // whichever primitive places it: the window a check-then-rename loses in.
  const originals = { linkSync: fs.linkSync, renameSync: fs.renameSync };
  let intercepted = false;
  for (const name of Object.keys(originals)) {
    fs[name] = (src, dest) => {
      if (!intercepted && path.basename(dest) === 'a.yaml') {
        intercepted = true;
        fs.writeFileSync(dest, 'from the other session');
      }
      return originals[name](src, dest);
    };
  }

  let result;
  try {
    result = migrateLegacyLearningStore({ homeDir: home });
  } finally {
    Object.assign(fs, originals);
  }

  assert.deepStrictEqual(result.failed, []);
  assert.strictEqual(read(path.join(store, 'a.yaml')), 'from the other session', 'the file the other session placed first is kept');
  assert.strictEqual(read(path.join(store, 'b.yaml')), 'b', 'the rest of this session\'s copy still lands');
}))) passed++; else failed++;

if (!canCreateSymlinks()) {
  console.log('  - skipped destination symlink test; this environment does not permit creating symbolic links');
} else if (test('a linked directory already in the store is refused, so nothing is written outside it', () => withHome(home => {
  write(path.join(home, '.gemini', 'homunculus', 'instincts', 'personal', 'a.yaml'), 'a');
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(home, '.egc-learning'), { recursive: true });
  fs.symlinkSync(outside, path.join(home, '.egc-learning', 'instincts'));

  const result = migrateLegacyLearningStore({ homeDir: home });

  assert.strictEqual(result.failed.length, 1);
  assert.deepStrictEqual(fs.readdirSync(outside), [], 'nothing lands behind the link');
  assert.ok(!fs.existsSync(path.join(home, '.egc-learning', MIGRATION_MARKER)), 'a refused migration never writes the marker');
}))) passed++; else failed++;

if (!canCreateSymlinks()) {
  console.log('  - skipped store-root symlink test; this environment does not permit creating symbolic links');
} else if (test('a store root that is itself a link is refused', () => withHome(home => {
  write(path.join(home, '.gemini', 'homunculus', 'a.yaml'), 'a');
  const outside = path.join(home, 'outside-root');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(home, '.egc-learning'));

  const result = migrateLegacyLearningStore({ homeDir: home });

  assert.strictEqual(result.failed.length, 1);
  assert.deepStrictEqual(fs.readdirSync(outside), [], 'nothing lands behind the linked store root');
}))) passed++; else failed++;

if (test('a filesystem without hard links still migrates, with a copy that never replaces', () => withHome(home => {
  write(path.join(home, '.gemini', 'homunculus', 'a.yaml'), 'a');
  write(path.join(home, '.gemini', 'homunculus', 'b.yaml'), 'from the old store');
  const store = path.join(home, '.egc-learning');
  write(path.join(store, 'b.yaml'), 'already in the new store');

  // FAT and exFAT refuse hard links.
  const originalLink = fs.linkSync;
  fs.linkSync = () => {
    const error = new Error('EPERM: operation not permitted, link');
    error.code = 'EPERM';
    throw error;
  };

  let result;
  try {
    result = migrateLegacyLearningStore({ homeDir: home });
  } finally {
    fs.linkSync = originalLink;
  }

  assert.deepStrictEqual(result.failed, []);
  assert.strictEqual(read(path.join(store, 'a.yaml')), 'a');
  assert.strictEqual(read(path.join(store, 'b.yaml')), 'already in the new store', 'the fallback copy never replaces');
}))) passed++; else failed++;

if (!canCreateSymlinks()) {
  console.log('  - skipped dangling destination test; this environment does not permit creating symbolic links');
} else if (test('a dangling link where a file should land fails the source instead of counting as copied', () => withHome(home => {
  write(path.join(home, '.gemini', 'homunculus', 'a.yaml'), 'a');
  const store = path.join(home, '.egc-learning');
  fs.mkdirSync(store, { recursive: true });
  fs.symlinkSync(path.join(home, 'nowhere.yaml'), path.join(store, 'a.yaml'));

  const result = migrateLegacyLearningStore({ homeDir: home });

  assert.strictEqual(result.failed.length, 1);
  assert.ok(!fs.existsSync(path.join(store, MIGRATION_MARKER)), 'the marker waits until the file can really be placed');
}))) passed++; else failed++;

if (test('a retry after a crash completes the entries a previous run never reached', () => withHome(home => {
  write(path.join(home, '.gemini', 'homunculus', 'a.yaml'), 'a');
  write(path.join(home, '.gemini', 'homunculus', 'b.yaml'), 'b');
  const store = path.join(home, '.egc-learning');
  // A previous run moved a.yaml into the live store and was killed before
  // moving b.yaml or writing the marker: the store exists but is incomplete.
  write(path.join(store, 'a.yaml'), 'a');

  const result = migrateLegacyLearningStore({ homeDir: home });

  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(result.migrated, [path.join(home, '.gemini', 'homunculus')]);
  assert.strictEqual(read(path.join(store, 'a.yaml')), 'a', 'the entry from the crashed run is left as is');
  assert.strictEqual(read(path.join(store, 'b.yaml')), 'b', 'the entry the crashed run never reached is still copied');
  const leftovers = fs.readdirSync(home).filter(name => name.startsWith('.egc-learning') && name !== '.egc-learning');
  assert.deepStrictEqual(leftovers, [], 'the abandoned staging folder is cleaned up');
}))) passed++; else failed++;

console.log(`\nPassed: ${passed}, Failed: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
