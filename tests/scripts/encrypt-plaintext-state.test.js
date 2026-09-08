'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { encryptOne } = require('../../scripts/maintenance/encrypt-plaintext-state');
const { stateRoot } = require('../../scripts/lib/state-plaintext');
const { shellQuote } = require('../../scripts/lib/doctor-summary');
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

// Whether the directory really refuses a new file for this process.
function directoryRefusesWrites(dirPath) {
  const probe = path.join(dirPath, '.probe-' + process.pid);
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' });
  } catch {
    return true;
  }
  fs.unlinkSync(probe);
  return false;
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
      assert.ok(doctor.stdout.includes(`node ${shellQuote(SCRIPT)}`), 'the hint must run as pasted from any cwd');
      assert.ok(doctor.stdout.includes('with --apply at the end'));
      assert.ok(doctor.stdout.includes('saved by the EGC hooks before 1.1.18'), 'the third origin of a plain file is named');
      const json = JSON.parse(run(DOCTOR_SCRIPT, ['--json'], homeDir).stdout);
      assert.strictEqual(json.plaintextStateFiles.encryptCommand, `node ${shellQuote(SCRIPT)}`);
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
      const outcome = encryptOne(seeded.sealed, stateRoot(seeded.stateDir));
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
      const original = fs.readFileSync(seeded.flat, 'utf8');
      const outcome = encryptOne(seeded.flat, stateRoot(seeded.stateDir), () => 'something else');
      assert.strictEqual(outcome.status, 'failed');
      assert.ok(outcome.reason.includes('did not read back'));
      assert.strictEqual(fs.readFileSync(seeded.flat, 'utf8'), original, 'the plain content is put back after a failed verification');
      assert.ok(!fs.existsSync(`${seeded.flat}.hmac`), 'the sidecar written for the discarded ciphertext is removed');
      assert.ok(!fs.existsSync(`${seeded.flat}.merge.lock`), 'the lock is released on the failure path');
    } finally {
      env.HOME = previousHome;
      env.USERPROFILE = previousProfile;
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('a sidecar that cannot be published fails the file and puts the plain content back', () => {
    const homeDir = createTempDir('encrypt-home-');
    try {
      const seeded = seedHome(homeDir);
      const original = fs.readFileSync(seeded.flat, 'utf8');
      // A directory squatting on the sidecar path: the exclusive temp file
      // cannot be renamed over it, so the sidecar write reports failure.
      fs.mkdirSync(`${seeded.flat}.hmac`);

      const result = run(SCRIPT, ['--apply'], homeDir);
      assert.strictEqual(result.code, 1, result.stdout);
      assert.ok(result.stdout.includes('the integrity sidecar could not be written; the plain file was put back'), result.stdout);
      assert.strictEqual(fs.readFileSync(seeded.flat, 'utf8'), original, 'the plain content must be back in place');
      assert.ok(fs.statSync(`${seeded.flat}.hmac`).isDirectory(), 'the squatter is left alone');
      assert.ok(isEncryptedBuffer(fs.readFileSync(seeded.branch)), 'the other file still went through');
      assert.ok(/Encrypted 1, skipped 0, failed 1\./.test(result.stdout), result.stdout);
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('a project directory that is really a link is never entered, and a link at the sidecar path is replaced, not followed', () => {
    if (process.platform === 'win32') return;
    const homeDir = createTempDir('encrypt-home-');
    const outside = createTempDir('encrypt-outside-');
    try {
      const seeded = seedHome(homeDir);
      fs.writeFileSync(path.join(outside, 'main.md'), '# Project State\nnot ours\n');
      fs.symlinkSync(outside, path.join(seeded.stateDir, 'Projetos--linked'));
      const target = path.join(outside, 'victim.txt');
      fs.writeFileSync(target, 'untouched');
      fs.symlinkSync(target, `${seeded.flat}.hmac`);

      const result = run(SCRIPT, ['--apply'], homeDir);
      assert.strictEqual(result.code, 0, result.stdout);
      assert.ok(!result.stdout.includes('Projetos--linked'), 'a linked directory is not scanned');
      assert.strictEqual(fs.readFileSync(path.join(outside, 'main.md'), 'utf8'), '# Project State\nnot ours\n', 'nothing outside the state directory is touched');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'untouched', 'the sidecar write must not go through the link');
      assert.ok(fs.lstatSync(`${seeded.flat}.hmac`).isFile(), 'the link is replaced by the real sidecar');
      assert.ok(isEncryptedBuffer(fs.readFileSync(seeded.flat)));
    } finally {
      cleanup(homeDir);
      cleanup(outside);
    }
  })) passed++; else failed++;

  if (test('a write that cannot land is reported as failed with exit 1 and the plain file is left as it was', () => {
    if (process.platform === 'win32') return;
    const homeDir = createTempDir('encrypt-home-');
    try {
      const seeded = seedHome(homeDir);
      // The key is created before the directory is sealed, so the failure
      // under test is the state write itself, not the key.
      fs.mkdirSync(path.join(homeDir, '.egc'), { recursive: true });
      const original = fs.readFileSync(seeded.flat, 'utf8');
      fs.chmodSync(path.join(seeded.stateDir, 'Projetos--demo'), 0o500);
      fs.chmodSync(seeded.stateDir, 0o500);
      // Root, a container with broad DAC privileges, or a filesystem that
      // ignores mode bits can still write here; then the failure cannot be
      // provoked and the case is skipped rather than asserted on.
      if (!directoryRefusesWrites(seeded.stateDir)) {
        fs.chmodSync(seeded.stateDir, 0o700);
        fs.chmodSync(path.join(seeded.stateDir, 'Projetos--demo'), 0o700);
        return;
      }
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

  if (test('a plain file that cannot be read is a failure of the run, not a skip that leaves it plain', () => {
    if (process.platform === 'win32') return;
    const homeDir = createTempDir('encrypt-home-');
    try {
      const seeded = seedHome(homeDir);
      // The scan lists the file while it is readable; it is sealed only
      // for the apply pass, through the injectable reader of encryptOne.
      const original = fs.readFileSync(seeded.flat, 'utf8');
      fs.chmodSync(seeded.flat, 0o000);
      const readable = (() => { try { fs.readFileSync(seeded.flat); return true; } catch { return false; } })();
      if (readable) return; // privileges make the seal ineffective here
      const previousHome = env.HOME;
      const previousProfile = env.USERPROFILE;
      env.HOME = homeDir;
      env.USERPROFILE = homeDir;
      try {
        assert.throws(() => encryptOne(seeded.flat, stateRoot(seeded.stateDir)), /EACCES|EPERM/, 'an I/O error must surface, not read as a skip');
        assert.ok(!fs.existsSync(`${seeded.flat}.merge.lock`), 'the lock is released when the read throws');
      } finally {
        env.HOME = previousHome;
        env.USERPROFILE = previousProfile;
      }
      fs.chmodSync(seeded.flat, 0o600);
      assert.strictEqual(fs.readFileSync(seeded.flat, 'utf8'), original, 'the file was never touched');
    } finally {
      try { fs.chmodSync(path.join(homeDir, '.egc', 'state', 'Projetos--demo.md'), 0o600); } catch { /* already gone */ }
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
