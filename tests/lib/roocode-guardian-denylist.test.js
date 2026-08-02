/**
 * Tests for scripts/lib/roocode-guardian-denylist.js
 *
 * Roo Code has no external hook API (confirmed against docs.roocode.com's
 * own auto-approving-actions page and issue #12025, an open feature request
 * for exactly this), so unlike every other host wired here this seeds Roo
 * Code's own native roo-cline.deniedCommands setting in .vscode/settings.json
 * instead of installing a Guardian adapter script. The merge must be a union
 * (never replace), so a user's own deniedCommands entries always survive.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DANGEROUS_COMMANDS,
  DENIED_COMMANDS_KEY,
  addRoocodeDenylistEntries,
  applyRoocodeDenylistToFile,
  hasRoocodeDenylistEntries,
  inspectRoocodeDenylistFile,
  removeRoocodeDenylistEntries,
  removeRoocodeDenylistFromFile,
  resolveVsCodeSettingsPath,
} = require('../../scripts/lib/roocode-guardian-denylist');

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

function runTests() {
  console.log('\n=== Testing roocode-guardian-denylist ===\n');

  let passed = 0;
  let failed = 0;

  if (test('resolveVsCodeSettingsPath resolves under <projectRoot>/.vscode/settings.json', () => {
    assert.strictEqual(
      resolveVsCodeSettingsPath('/home/user/project'),
      path.join('/home/user/project', '.vscode', 'settings.json')
    );
  })) passed++; else failed++;

  if (test('addRoocodeDenylistEntries seeds every DANGEROUS_COMMANDS entry on an empty settings object', () => {
    const { settings, changed } = addRoocodeDenylistEntries({});
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(settings[DENIED_COMMANDS_KEY], DANGEROUS_COMMANDS);
  })) passed++; else failed++;

  if (test('addRoocodeDenylistEntries is a union: a user\'s own entries are preserved, not replaced', () => {
    const base = { [DENIED_COMMANDS_KEY]: ['sudo', 'chmod 777'] };
    const { settings, changed } = addRoocodeDenylistEntries(base);
    assert.strictEqual(changed, true);
    assert.ok(settings[DENIED_COMMANDS_KEY].includes('sudo'));
    assert.ok(settings[DENIED_COMMANDS_KEY].includes('chmod 777'));
    for (const cmd of DANGEROUS_COMMANDS) {
      assert.ok(settings[DENIED_COMMANDS_KEY].includes(cmd));
    }
  })) passed++; else failed++;

  if (test('addRoocodeDenylistEntries preserves unrelated settings keys', () => {
    const base = { 'editor.fontSize': 14, [DENIED_COMMANDS_KEY]: [] };
    const { settings } = addRoocodeDenylistEntries(base);
    assert.strictEqual(settings['editor.fontSize'], 14);
  })) passed++; else failed++;

  if (test('addRoocodeDenylistEntries is idempotent: no change when every entry is already present', () => {
    const first = addRoocodeDenylistEntries({});
    const second = addRoocodeDenylistEntries(first.settings);
    assert.strictEqual(second.changed, false);
    assert.deepStrictEqual(second.settings[DENIED_COMMANDS_KEY], DANGEROUS_COMMANDS);
  })) passed++; else failed++;

  if (test('hasRoocodeDenylistEntries is true only when every DANGEROUS_COMMANDS entry is present', () => {
    assert.strictEqual(hasRoocodeDenylistEntries({}), false);
    assert.strictEqual(hasRoocodeDenylistEntries({ [DENIED_COMMANDS_KEY]: ['rm'] }), false);
    assert.strictEqual(hasRoocodeDenylistEntries({ [DENIED_COMMANDS_KEY]: DANGEROUS_COMMANDS }), true);
    assert.strictEqual(
      hasRoocodeDenylistEntries({ [DENIED_COMMANDS_KEY]: [...DANGEROUS_COMMANDS, 'sudo'] }),
      true,
      'extra user entries alongside the full set must still count as present'
    );
  })) passed++; else failed++;

  if (test('removeRoocodeDenylistEntries strips only the EGC-managed entries, preserving the user\'s own', () => {
    const base = { [DENIED_COMMANDS_KEY]: [...DANGEROUS_COMMANDS, 'sudo'] };
    const { settings, changed } = removeRoocodeDenylistEntries(base);
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(settings[DENIED_COMMANDS_KEY], ['sudo']);
  })) passed++; else failed++;

  if (test('removeRoocodeDenylistEntries deletes the key entirely when nothing is left', () => {
    const { settings, changed } = removeRoocodeDenylistEntries({ [DENIED_COMMANDS_KEY]: DANGEROUS_COMMANDS });
    assert.strictEqual(changed, true);
    assert.ok(!(DENIED_COMMANDS_KEY in settings));
  })) passed++; else failed++;

  if (test('removeRoocodeDenylistEntries reports no change when nothing EGC-managed is present', () => {
    const { changed } = removeRoocodeDenylistEntries({ [DENIED_COMMANDS_KEY]: ['sudo'] });
    assert.strictEqual(changed, false);
  })) passed++; else failed++;

  if (test('applyRoocodeDenylistToFile writes a fresh settings.json and is idempotent on disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roocode-denylist-apply-'));
    const settingsPath = path.join(tempDir, 'settings.json');
    try {
      const first = applyRoocodeDenylistToFile(settingsPath);
      assert.strictEqual(first.changed, true);

      const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.deepStrictEqual(onDisk[DENIED_COMMANDS_KEY], DANGEROUS_COMMANDS);

      const second = applyRoocodeDenylistToFile(settingsPath);
      assert.strictEqual(second.changed, false, 'must not rewrite the file when already applied');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('applyRoocodeDenylistToFile preserves a hand-written settings.json, including the user\'s own denylist', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roocode-denylist-preserve-'));
    const settingsPath = path.join(tempDir, 'settings.json');
    try {
      fs.writeFileSync(settingsPath, JSON.stringify({
        'editor.fontSize': 14,
        [DENIED_COMMANDS_KEY]: ['sudo'],
      }, null, 2));

      applyRoocodeDenylistToFile(settingsPath);

      const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.strictEqual(onDisk['editor.fontSize'], 14);
      assert.ok(onDisk[DENIED_COMMANDS_KEY].includes('sudo'));
      for (const cmd of DANGEROUS_COMMANDS) {
        assert.ok(onDisk[DENIED_COMMANDS_KEY].includes(cmd));
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('removeRoocodeDenylistFromFile on a missing file is a no-op', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roocode-denylist-remove-missing-'));
    const settingsPath = path.join(tempDir, 'settings.json');
    try {
      const result = removeRoocodeDenylistFromFile(settingsPath);
      assert.strictEqual(result.changed, false);
      assert.strictEqual(fs.existsSync(settingsPath), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('apply then remove round-trips: the user\'s own entry survives, EGC entries are gone', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roocode-denylist-roundtrip-'));
    const settingsPath = path.join(tempDir, 'settings.json');
    try {
      fs.writeFileSync(settingsPath, JSON.stringify({ [DENIED_COMMANDS_KEY]: ['sudo'] }, null, 2));
      applyRoocodeDenylistToFile(settingsPath);
      removeRoocodeDenylistFromFile(settingsPath);

      const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.deepStrictEqual(onDisk[DENIED_COMMANDS_KEY], ['sudo']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('inspectRoocodeDenylistFile reports missing/drifted/ok correctly', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roocode-denylist-inspect-'));
    const settingsPath = path.join(tempDir, 'settings.json');
    try {
      assert.strictEqual(inspectRoocodeDenylistFile(settingsPath), 'drifted');

      fs.writeFileSync(settingsPath, JSON.stringify({ [DENIED_COMMANDS_KEY]: ['rm'] }, null, 2));
      assert.strictEqual(inspectRoocodeDenylistFile(settingsPath), 'drifted');

      applyRoocodeDenylistToFile(settingsPath);
      assert.strictEqual(inspectRoocodeDenylistFile(settingsPath), 'ok');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('inspectRoocodeDenylistFile reports drifted instead of throwing on invalid JSON', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roocode-denylist-invalid-'));
    const settingsPath = path.join(tempDir, 'settings.json');
    try {
      fs.writeFileSync(settingsPath, '{ not valid json');
      assert.strictEqual(inspectRoocodeDenylistFile(settingsPath), 'drifted');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\n${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

const ok = runTests();
process.exit(ok ? 0 : 1);
