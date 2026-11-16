/**
 * Tests for scripts/lib/state-snapshot.js encrypted read-modify-write.
 *
 * Regression coverage for the corruption bug: this module used to read an
 * encrypted state file as plain UTF-8 and write the result back as plain
 * UTF-8, silently mangling the AES-256-GCM ciphertext on every PreCompact
 * snapshot or "remember" intent. The fixture below reproduces that exact
 * byte-for-byte old behavior alongside the fixed one so a regression here
 * fails loudly instead of surfacing later as "Failed to decrypt existing
 * state file".
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { decryptStateBuffer, isEncryptedBuffer } = require('../../scripts/lib/state-crypto');
const { writeSnapshotToDisk, applyMinedMemory, withStateFileLockSync, saveState } = require('../../scripts/lib/state-snapshot');

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

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

// Mirrors the real server format without requiring a server build.
function encryptFixture(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return Buffer.concat([Buffer.from('EGC1:', 'utf-8'), iv, cipher.getAuthTag(), encrypted]);
}

// A no-git project directory keeps detectBranch() returning null, so state
// resolves to the flat <slug>.md path -- one less moving part in the fixture.
function setupHome(prefix) {
  const home = createTempDir(prefix);
  const projectPath = createTempDir(`${prefix}project-`);
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.join(home, '.egc'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.egc', 'encryption.key'), key.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
  return { home, projectPath, key };
}

function stateFilePath(home, projectPath) {
  const slug = projectPath.replaceAll('\\', '/').split('/').filter(Boolean).slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_');
  return path.join(home, '.egc', 'state', `${slug}.md`);
}

function withHome(home, fn) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    process.env.HOME = previous;
  }
}

// Reproduces the pre-fix bug byte-for-byte: read encrypted buffer as UTF-8,
// mutate as text, write the result back as UTF-8 with no re-encryption.
function corruptWithOldBehavior(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  fs.writeFileSync(filePath, content, 'utf-8');
}

function runTests() {
  console.log('\n=== Testing scripts/lib/state-snapshot.js ===\n');

  let passed = 0;
  let failed = 0;
  const tally = ok => { if (ok) passed++; else failed++; };

  tally(test('writeSnapshotToDisk preserves content and re-encrypts correctly', () => {
    const { home, projectPath, key } = setupHome('state-snapshot-fix-');
    try {
      const filePath = stateFilePath(home, projectPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const plaintext = '# Project State\nproject: x\nupdated: 2026-01-01T00:00:00.000Z\n\n## Context\nsecret memory\n\n## Active Decisions\n\n## Do Not Repeat\n\n## Preferences\n\n## Next Session\n';
      fs.writeFileSync(filePath, encryptFixture(plaintext, key));

      withHome(home, () => writeSnapshotToDisk(projectPath));

      const raw = fs.readFileSync(filePath);
      assert.strictEqual(isEncryptedBuffer(raw), true, 'output must still be encrypted');
      const decrypted = decryptStateBuffer(raw, path.join(home, '.egc', 'encryption.key'));
      assert.notStrictEqual(decrypted, null, 'output must decrypt with the original key');
      assert.ok(decrypted.includes('secret memory'), 'original content must be preserved');
      assert.ok(decrypted.includes('[session-snapshot '), 'session marker must be injected');
    } finally {
      cleanup(home);
      cleanup(projectPath);
    }
  }));

  tally(test('applyMinedMemory preserves content and re-encrypts correctly', () => {
    const { home, projectPath, key } = setupHome('state-snapshot-mine-');
    try {
      const filePath = stateFilePath(home, projectPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const plaintext = '# Project State\nproject: x\nupdated: 2026-01-01T00:00:00.000Z\n\n## Context\n\n## Active Decisions\n\n## Do Not Repeat\n\n## Preferences\n\n## Next Session\n';
      fs.writeFileSync(filePath, encryptFixture(plaintext, key));

      const result = withHome(home, () => applyMinedMemory(projectPath, { decisions: ['ship the fix'] }));
      assert.strictEqual(result.added, 1);

      const raw = fs.readFileSync(filePath);
      const decrypted = decryptStateBuffer(raw, path.join(home, '.egc', 'encryption.key'));
      assert.ok(decrypted.includes('ship the fix'));
    } finally {
      cleanup(home);
      cleanup(projectPath);
    }
  }));

  tally(test('reproduces the old bug: plain UTF-8 read-modify-write corrupts the ciphertext', () => {
    const { home, projectPath, key } = setupHome('state-snapshot-oldbug-');
    try {
      const filePath = stateFilePath(home, projectPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, encryptFixture('# Project State\nsecret\n', key));

      corruptWithOldBehavior(filePath);

      const raw = fs.readFileSync(filePath);
      const decrypted = decryptStateBuffer(raw, path.join(home, '.egc', 'encryption.key'));
      assert.strictEqual(decrypted, null, 'the old read-modify-write path must corrupt the ciphertext');
    } finally {
      cleanup(home);
      cleanup(projectPath);
    }
  }));

  tally(test('a genuinely undecryptable file is never silently overwritten', () => {
    const { home, projectPath, key } = setupHome('state-snapshot-guard-');
    try {
      const filePath = stateFilePath(home, projectPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload = encryptFixture('# Project State\nsecret\n', key);
      payload[payload.length - 1] ^= 0xff; // tamper: real corruption, wrong key would also trigger this
      fs.writeFileSync(filePath, payload);
      const before = fs.readFileSync(filePath);

      withHome(home, () => writeSnapshotToDisk(projectPath));

      const after = fs.readFileSync(filePath);
      assert.ok(before.equals(after), 'undecryptable file must be left untouched, not replaced with a blank skeleton');
    } finally {
      cleanup(home);
      cleanup(projectPath);
    }
  }));

  tally(test('the lock timeout names no path and honors a short retry budget: a lock held by a live process is reported by its role only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-lock-msg-'));
    try {
      const stateFile = path.join(dir, 'state.md');
      fs.writeFileSync(`${stateFile}.merge.lock`, String(process.pid));
      const startedAt = Date.now();
      assert.throws(
        () => withStateFileLockSync(stateFile, () => 'never', { retries: 3, retryDelayMs: 5 }),
        error => error.message === 'Timeout acquiring the state file lock: another process holds it'
      );
      assert.ok(Date.now() - startedAt < 2000, 'a three-retry budget of 5 ms each must not wait for the default 50 x 100 ms');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  tally(test('a null or out-of-range options argument is accepted: the callback runs and the lock is released', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-lock-opts-'));
    try {
      const stateFile = path.join(dir, 'state.md');
      assert.strictEqual(withStateFileLockSync(stateFile, () => 'ran', null), 'ran');
      assert.strictEqual(withStateFileLockSync(stateFile, () => 'ran again', { retries: 0, retryDelayMs: -1 }), 'ran again');
      assert.ok(!fs.existsSync(`${stateFile}.merge.lock`), 'the lock file is released after the callback');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  tally(test('saveState leaves the state file read-only and the next save still replaces it (#2143)', () => {
    if (process.platform === 'win32') return;
    const { home, projectPath } = setupHome('egc-snapshot-mode-');
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    const previousKeyFile = process.env.EGC_ENCRYPTION_KEY_FILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    // The fixture's key lives under the temporary home; a configured key file
    // in the caller's environment must not take its place.
    delete process.env.EGC_ENCRYPTION_KEY_FILE;
    try {
      const filePath = path.join(home, '.egc', 'state', 'demo', 'main.md');
      saveState(filePath, '# Project State\nproject: demo\n\n## Context\nfirst\n');
      assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o400, 'read-only once written');
      saveState(filePath, '# Project State\nproject: demo\n\n## Context\nsecond\n');
      assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o400, 'still read-only after the second save');
      const raw = fs.readFileSync(filePath);
      assert.ok(isEncryptedBuffer(raw));
      assert.match(decryptStateBuffer(raw, path.join(home, '.egc', 'encryption.key')), /second/);
    } finally {
      process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      if (previousKeyFile !== undefined) process.env.EGC_ENCRYPTION_KEY_FILE = previousKeyFile;
      cleanup(home);
      cleanup(projectPath);
    }
  }));

  tally(test('on Windows saveState keeps the state file writable, so the next save is not refused (#2143)', () => {
    if (process.platform !== 'win32') return;
    const { home, projectPath } = setupHome('egc-snapshot-mode-win-');
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    const previousKeyFile = process.env.EGC_ENCRYPTION_KEY_FILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.EGC_ENCRYPTION_KEY_FILE;
    try {
      const filePath = path.join(home, '.egc', 'state', 'demo', 'main.md');
      saveState(filePath, '# Project State\nproject: demo\n\n## Context\nfirst\n');
      assert.notStrictEqual(fs.statSync(filePath).mode & 0o200, 0, 'no read-only attribute: Windows keeps its ACLs');
      saveState(filePath, '# Project State\nproject: demo\n\n## Context\nsecond\n');
      assert.match(decryptStateBuffer(fs.readFileSync(filePath), path.join(home, '.egc', 'encryption.key')), /second/);
    } finally {
      process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      if (previousKeyFile !== undefined) process.env.EGC_ENCRYPTION_KEY_FILE = previousKeyFile;
      cleanup(home);
      cleanup(projectPath);
    }
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
