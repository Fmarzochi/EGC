'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { encryptOne } = require('../../scripts/maintenance/encrypt-plaintext-state');
const { readStateFileDecrypted, isEncryptedBuffer } = require('../../scripts/lib/state-crypto');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const { env } = process;
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'maintenance', 'encrypt-plaintext-state.js');
const DOCTOR_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'doctor.js');
const SEALED = Buffer.concat([Buffer.from('EGC1:'), Buffer.alloc(40, 7)]);

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function run(script, args, homeDir) {
  try {
    const stdout = execFileSync('node', [script, ...args], {
      env: { ...env, HOME: homeDir, USERPROFILE: homeDir },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// A home with two plain files (flat and per branch), one encrypted, one
// empty, one archived copy and a JSON neighbour: only the two plain ones
// are work.
function seedHome(homeDir) {
  const stateDir = path.join(homeDir, '.egc', 'state');
  fs.mkdirSync(path.join(stateDir, 'Projetos--demo'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'archive'), { recursive: true });
  const flat = path.join(stateDir, 'Projetos--demo.md');
  const branch = path.join(stateDir, 'Projetos--demo', 'main.md');
  const sealed = path.join(stateDir, 'Projetos--sealed.md');
  const archived = path.join(stateDir, 'archive', 'old.md');
  fs.writeFileSync(flat, '# Project State\nproject: /srv/demo\nupdated: 2026-06-10T05:32:05.652Z\n\n## Context\nflat\n');
  fs.writeFileSync(branch, '# Project State\nproject: /srv/demo\nbranch: main\n\n## Context\nbranch\n');
  fs.writeFileSync(sealed, SEALED);
  fs.writeFileSync(path.join(stateDir, 'Projetos--empty.md'), '');
  fs.writeFileSync(archived, '# Project State\narchived copy\n');
  fs.writeFileSync(path.join(stateDir, 'budget-usage.json'), '{}');
  return { stateDir, flat, branch, sealed, archived };
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
  console.log('=== Testing encrypt-plaintext-state.js ===');
  let passed = 0;
  let failed = 0;

  if (test('dry run lists the plain files with size and last write and writes nothing', () => {
    const homeDir = createTempDir('encrypt-home-');
    try {
      const seeded = seedHome(homeDir);
      const before = { flat: fs.readFileSync(seeded.flat), branch: fs.readFileSync(seeded.branch) };

      const result = run(SCRIPT, [], homeDir);
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes(`Would encrypt 2 plain-text state files under ${seeded.stateDir} (4 checked):`), result.stdout);
      assert.ok(result.stdout.includes(`${seeded.flat} (`));
      assert.ok(result.stdout.includes(`${seeded.branch} (`));
      assert.ok(/bytes, last write \d{4}-\d{2}-\d{2}T/.test(result.stdout));
      assert.ok(result.stdout.includes('Dry run: nothing was written.'));
      assert.ok(!result.stdout.includes('old.md'), 'the archive folder is not live state');
      assert.ok(Buffer.compare(fs.readFileSync(seeded.flat), before.flat) === 0, 'dry run must not touch the file');
      assert.ok(Buffer.compare(fs.readFileSync(seeded.branch), before.branch) === 0);
      assert.ok(!fs.existsSync(path.join(homeDir, '.egc', 'encryption.key')), 'a dry run has no reason to create a key');

      const json = JSON.parse(run(SCRIPT, ['--json'], homeDir).stdout);
      assert.strictEqual(json.apply, false);
      assert.strictEqual(json.scan.count, 2);
      assert.strictEqual(json.scan.checked, 4);
      assert.deepStrictEqual(json.results, []);
      assert.ok(json.scan.files.every(file => typeof file.sizeBytes === 'number' && typeof file.modifiedAt === 'string'));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('--apply encrypts each plain file in place, readable back, sidecar written, the rest untouched, and the doctor goes quiet', () => {
    const homeDir = createTempDir('encrypt-home-');
    try {
      const seeded = seedHome(homeDir);
      const original = { flat: fs.readFileSync(seeded.flat, 'utf8'), branch: fs.readFileSync(seeded.branch, 'utf8') };
      const keyPath = path.join(homeDir, '.egc', 'encryption.key');

      const result = run(SCRIPT, ['--apply'], homeDir);
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('Encrypting 2 plain-text state files'), result.stdout);
      assert.ok(result.stdout.includes('Encrypted 2, skipped 0, failed 0.'), result.stdout);

      for (const [name, filePath] of Object.entries({ flat: seeded.flat, branch: seeded.branch })) {
        const raw = fs.readFileSync(filePath);
        assert.ok(isEncryptedBuffer(raw), `${name} must carry the EGC1 header now`);
        assert.strictEqual(readStateFileDecrypted(filePath, keyPath), original[name], `${name} must decrypt back to the exact original`);
        assert.ok(fs.existsSync(`${filePath}.hmac`), `${name} must get the integrity sidecar the server checks`);
        if (process.platform !== 'win32') {
          assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600, `${name} must be private`);
        }
      }
      assert.ok(Buffer.compare(fs.readFileSync(seeded.sealed), SEALED) === 0, 'an already encrypted file is never rewritten');
      assert.strictEqual(fs.readFileSync(path.join(seeded.stateDir, 'Projetos--empty.md')).length, 0, 'an empty file stays empty');
      assert.strictEqual(fs.readFileSync(seeded.archived, 'utf8'), '# Project State\narchived copy\n', 'the archive folder is left alone');

      const again = run(SCRIPT, ['--apply'], homeDir);
      assert.strictEqual(again.code, 0, again.stderr);
      assert.ok(again.stdout.includes('No plain-text state file under'), 'a second run finds nothing to do');

      const doctor = run(DOCTOR_SCRIPT, [], homeDir);
      assert.strictEqual(doctor.code, 0);
      assert.ok(!doctor.stdout.includes('State files:'), 'the doctor must stop warning once the files are encrypted');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('the doctor hint names this script by absolute path and the --apply step', () => {
    const homeDir = createTempDir('encrypt-home-');
    try {
      seedHome(homeDir);
      const doctor = run(DOCTOR_SCRIPT, [], homeDir);
      assert.strictEqual(doctor.code, 0);
      assert.ok(doctor.stdout.includes(`node "${SCRIPT}"`), 'the hint must run as pasted from any cwd');
      assert.ok(doctor.stdout.includes('with --apply at the end'));
      assert.ok(doctor.stdout.includes('saved by the EGC hooks before 1.1.18'), 'the third origin of a plain file is named');
      const json = JSON.parse(run(DOCTOR_SCRIPT, ['--json'], homeDir).stdout);
      assert.strictEqual(json.plaintextStateFiles.encryptCommand, `node "${SCRIPT}"`);
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('a file that stopped being plain between the listing and the write is skipped, not rewritten', () => {
    const homeDir = createTempDir('encrypt-home-');
    const previousHome = env.HOME;
    const previousProfile = env.USERPROFILE;
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
    try {
      const seeded = seedHome(homeDir);
      const outcome = encryptOne(seeded.sealed);
      assert.deepStrictEqual(outcome, { path: seeded.sealed, status: 'skipped', reason: 'no longer a plain regular file' });
      assert.ok(Buffer.compare(fs.readFileSync(seeded.sealed), SEALED) === 0);
      assert.ok(!fs.existsSync(`${seeded.sealed}.merge.lock`), 'the lock is released on the skip path');
    } finally {
      env.HOME = previousHome;
      env.USERPROFILE = previousProfile;
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('a file whose ciphertext does not read back as the original is reported as failed', () => {
    const homeDir = createTempDir('encrypt-home-');
    const previousHome = env.HOME;
    const previousProfile = env.USERPROFILE;
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
    try {
      const seeded = seedHome(homeDir);
      const outcome = encryptOne(seeded.flat, () => 'something else');
      assert.strictEqual(outcome.status, 'failed');
      assert.ok(outcome.reason.includes('did not read back'));
      assert.ok(!fs.existsSync(`${seeded.flat}.merge.lock`), 'the lock is released on the failure path');
    } finally {
      env.HOME = previousHome;
      env.USERPROFILE = previousProfile;
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('a write that cannot land is reported as failed with exit 1 and the plain file is left as it was', () => {
    if (process.platform === 'win32') return;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const homeDir = createTempDir('encrypt-home-');
    try {
      const seeded = seedHome(homeDir);
      // The key is created before the directory is sealed, so the failure
      // under test is the state write itself, not the key.
      fs.mkdirSync(path.join(homeDir, '.egc'), { recursive: true });
      const original = fs.readFileSync(seeded.flat, 'utf8');
      fs.chmodSync(path.join(seeded.stateDir, 'Projetos--demo'), 0o500);
      fs.chmodSync(seeded.stateDir, 0o500);
      try {
        const result = run(SCRIPT, ['--apply'], homeDir);
        assert.strictEqual(result.code, 1, 'a failed file must fail the run');
        assert.ok(result.stdout.includes('-> failed:'), result.stdout);
        assert.ok(/Encrypted 0, skipped 0, failed 2\./.test(result.stdout), result.stdout);
        assert.strictEqual(fs.readFileSync(seeded.flat, 'utf8'), original, 'the original must survive a failed write');
      } finally {
        fs.chmodSync(seeded.stateDir, 0o700);
        fs.chmodSync(path.join(seeded.stateDir, 'Projetos--demo'), 0o700);
      }
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('an unknown option exits 1 with the usage text', () => {
    const homeDir = createTempDir('encrypt-home-');
    try {
      const result = run(SCRIPT, ['--force'], homeDir);
      assert.strictEqual(result.code, 1);
      assert.ok(result.stderr.includes('Unknown option: --force'));
      assert.ok(result.stdout.includes('Usage:'));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
