/**
 * Tests for scripts/lib/cursor-guardian-hooks.js
 *
 * Cursor's hooks.json schema is a flat {version, hooks: {<event>: [{command}]}}
 * map (no matcher/group wrapper, no "type": "command" field), unlike Claude
 * Code's settings.json, so it needs its own merge logic. These tests exercise
 * that merge logic directly (additive, idempotent, preserves unrelated keys
 * and third-party hooks).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  BEFORE_SHELL_EXECUTION_EVENT,
  addCursorHookEntry,
  applyCursorGuardianHookToFile,
  inspectCursorGuardianHookFile,
  removeCursorGuardianHookFromFile,
  removeCursorHookEntry,
  resolveGuardianAdapterScriptDestination,
  resolveHooksJsonPath,
} = require('../../scripts/lib/cursor-guardian-hooks');

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
  console.log('\n=== Testing cursor-guardian-hooks ===\n');

  let passed = 0;
  let failed = 0;

  if (test('resolveHooksJsonPath and resolveGuardianAdapterScriptDestination compute paths under targetRoot', () => {
    const targetRoot = '/home/user/project/.cursor';
    assert.strictEqual(resolveHooksJsonPath(targetRoot), path.join(targetRoot, 'hooks.json'));
    assert.strictEqual(
      resolveGuardianAdapterScriptDestination(targetRoot),
      path.join(targetRoot, 'scripts', 'hooks', 'cursor-guardian-adapter.js')
    );
  })) passed++; else failed++;

  if (test('addCursorHookEntry appends a new event array on an empty config, defaulting version', () => {
    const { config, changed } = addCursorHookEntry({}, BEFORE_SHELL_EXECUTION_EVENT, 'node adapter.js');
    assert.strictEqual(changed, true);
    assert.strictEqual(config.version, 1);
    assert.deepStrictEqual(config.hooks[BEFORE_SHELL_EXECUTION_EVENT], [{ command: 'node adapter.js' }]);
  })) passed++; else failed++;

  if (test('addCursorHookEntry is idempotent (no duplicate on re-add)', () => {
    const first = addCursorHookEntry({}, BEFORE_SHELL_EXECUTION_EVENT, 'node adapter.js');
    const second = addCursorHookEntry(first.config, BEFORE_SHELL_EXECUTION_EVENT, 'node adapter.js');
    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.config.hooks[BEFORE_SHELL_EXECUTION_EVENT].length, 1);
  })) passed++; else failed++;

  if (test('addCursorHookEntry preserves third-party hooks in the same event array', () => {
    const base = {
      version: 1,
      hooks: { [BEFORE_SHELL_EXECUTION_EVENT]: [{ command: 'node .cursor/hooks/before-shell-execution.js' }] },
    };
    const { config } = addCursorHookEntry(base, BEFORE_SHELL_EXECUTION_EVENT, 'node adapter.js');
    assert.strictEqual(config.hooks[BEFORE_SHELL_EXECUTION_EVENT].length, 2);
    assert.ok(config.hooks[BEFORE_SHELL_EXECUTION_EVENT].some(entry => entry.command === 'node .cursor/hooks/before-shell-execution.js'));
    assert.ok(config.hooks[BEFORE_SHELL_EXECUTION_EVENT].some(entry => entry.command === 'node adapter.js'));
  })) passed++; else failed++;

  if (test('addCursorHookEntry preserves unrelated events and top-level keys', () => {
    const base = { version: 1, hooks: { preToolUse: [{ command: 'node before-tool-use.js' }] } };
    const { config } = addCursorHookEntry(base, BEFORE_SHELL_EXECUTION_EVENT, 'node adapter.js');
    assert.strictEqual(config.version, 1);
    assert.deepStrictEqual(config.hooks.preToolUse, [{ command: 'node before-tool-use.js' }]);
    assert.deepStrictEqual(config.hooks[BEFORE_SHELL_EXECUTION_EVENT], [{ command: 'node adapter.js' }]);
  })) passed++; else failed++;

  if (test('addCursorHookEntry migrates a stale entry (same script, different path) in place instead of duplicating', () => {
    const base = {
      version: 1,
      hooks: {
        [BEFORE_SHELL_EXECUTION_EVENT]: [{ command: 'node /old/path/cursor-guardian-adapter.js' }],
      },
    };
    const { config, changed } = addCursorHookEntry(base, BEFORE_SHELL_EXECUTION_EVENT, 'node /new/path/cursor-guardian-adapter.js');
    assert.strictEqual(changed, true);
    assert.strictEqual(config.hooks[BEFORE_SHELL_EXECUTION_EVENT].length, 1, 'must migrate in place, not append a duplicate');
    assert.strictEqual(config.hooks[BEFORE_SHELL_EXECUTION_EVENT][0].command, 'node /new/path/cursor-guardian-adapter.js');
  })) passed++; else failed++;

  if (test('applyCursorGuardianHookToFile writes the event to a fresh file and is idempotent', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-hooks-apply-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      const first = applyCursorGuardianHookToFile(hooksJsonPath, BEFORE_SHELL_EXECUTION_EVENT, '/abs/adapter.js');
      assert.strictEqual(first.changed, true);

      const onDisk = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.strictEqual(onDisk.version, 1);
      assert.strictEqual(onDisk.hooks[BEFORE_SHELL_EXECUTION_EVENT].length, 1);

      const second = applyCursorGuardianHookToFile(hooksJsonPath, BEFORE_SHELL_EXECUTION_EVENT, '/abs/adapter.js');
      assert.strictEqual(second.changed, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('applyCursorGuardianHookToFile preserves a hand-written hooks.json on disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-hooks-preserve-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      fs.writeFileSync(hooksJsonPath, JSON.stringify({
        version: 1,
        hooks: { afterFileEdit: [{ command: 'node .cursor/hooks/after-file-edit.js' }] },
      }, null, 2));

      applyCursorGuardianHookToFile(hooksJsonPath, BEFORE_SHELL_EXECUTION_EVENT, '/abs/adapter.js');

      const onDisk = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.deepStrictEqual(onDisk.hooks.afterFileEdit, [{ command: 'node .cursor/hooks/after-file-edit.js' }]);
      assert.strictEqual(onDisk.hooks[BEFORE_SHELL_EXECUTION_EVENT].length, 1);
      assert.ok(onDisk.hooks[BEFORE_SHELL_EXECUTION_EVENT][0].command.includes('adapter.js'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('removeCursorHookEntry drops only the EGC entry, keeps third-party hooks and other events', () => {
    const base = {
      version: 1,
      hooks: {
        [BEFORE_SHELL_EXECUTION_EVENT]: [
          { command: 'node .cursor/hooks/before-shell-execution.js' },
          { command: 'node adapter.js' },
        ],
        afterFileEdit: [{ command: 'node .cursor/hooks/after-file-edit.js' }],
      },
    };
    const { config, changed } = removeCursorHookEntry(base, BEFORE_SHELL_EXECUTION_EVENT, 'node adapter.js');
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(config.hooks[BEFORE_SHELL_EXECUTION_EVENT], [{ command: 'node .cursor/hooks/before-shell-execution.js' }]);
    assert.deepStrictEqual(config.hooks.afterFileEdit, [{ command: 'node .cursor/hooks/after-file-edit.js' }]);
  })) passed++; else failed++;

  if (test('removeCursorHookEntry deletes the event key entirely once empty', () => {
    const base = { version: 1, hooks: { [BEFORE_SHELL_EXECUTION_EVENT]: [{ command: 'node adapter.js' }] } };
    const { config } = removeCursorHookEntry(base, BEFORE_SHELL_EXECUTION_EVENT, 'node adapter.js');
    assert.strictEqual(BEFORE_SHELL_EXECUTION_EVENT in config.hooks, false);
  })) passed++; else failed++;

  if (test('removeCursorGuardianHookFromFile on a missing file is a no-op', () => {
    const result = removeCursorGuardianHookFromFile('/nonexistent/hooks.json', BEFORE_SHELL_EXECUTION_EVENT, '/abs/adapter.js');
    assert.strictEqual(result.changed, false);
  })) passed++; else failed++;

  if (test('inspectCursorGuardianHookFile reports ok when present, drifted when absent', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-hooks-inspect-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      assert.strictEqual(inspectCursorGuardianHookFile(hooksJsonPath, BEFORE_SHELL_EXECUTION_EVENT, '/abs/adapter.js'), 'drifted');
      applyCursorGuardianHookToFile(hooksJsonPath, BEFORE_SHELL_EXECUTION_EVENT, '/abs/adapter.js');
      assert.strictEqual(inspectCursorGuardianHookFile(hooksJsonPath, BEFORE_SHELL_EXECUTION_EVENT, '/abs/adapter.js'), 'ok');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
