/**
 * Tests for scripts/lib/cursor-crusher-hooks.js
 *
 * Mirrors tests/lib/cursor-guardian-hooks.test.js's structure, but for the
 * Crusher's preToolUse entry instead of the Guardian's beforeShellExecution
 * entry -- both live in the same flat hooks.json, so these tests also cover
 * that the two never collide on the same event array.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PRE_TOOL_USE_EVENT,
  applyCursorCrusherHookToFile,
  inspectCursorCrusherHookFile,
  removeCursorCrusherHookFromFile,
  resolveCrusherAdapterScriptDestination,
} = require('../../scripts/lib/cursor-crusher-hooks');
const { BEFORE_SHELL_EXECUTION_EVENT, applyCursorGuardianHookToFile } = require('../../scripts/lib/cursor-guardian-hooks');

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
  console.log('\n=== Testing cursor-crusher-hooks ===\n');

  let passed = 0;
  let failed = 0;

  if (test('PRE_TOOL_USE_EVENT is Cursor\'s real event name', () => {
    assert.strictEqual(PRE_TOOL_USE_EVENT, 'preToolUse');
  })) passed++; else failed++;

  if (test('resolveCrusherAdapterScriptDestination computes a path under targetRoot', () => {
    const dest = resolveCrusherAdapterScriptDestination('/proj/.cursor');
    assert.strictEqual(dest, path.join('/proj/.cursor', 'scripts', 'hooks', 'cursor-crusher-adapter.js'));
  })) passed++; else failed++;

  if (test('applyCursorCrusherHookToFile writes preToolUse to a fresh file and is idempotent', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-crusher-hooks-apply-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      const first = applyCursorCrusherHookToFile(hooksJsonPath, '/abs/cursor-crusher-adapter.js');
      assert.strictEqual(first.changed, true);

      const onDisk = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.strictEqual(onDisk.version, 1);
      assert.strictEqual(onDisk.hooks[PRE_TOOL_USE_EVENT].length, 1);
      assert.ok(onDisk.hooks[PRE_TOOL_USE_EVENT][0].command.includes('cursor-crusher-adapter.js'));

      const second = applyCursorCrusherHookToFile(hooksJsonPath, '/abs/cursor-crusher-adapter.js');
      assert.strictEqual(second.changed, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('applyCursorCrusherHookToFile preserves a pre-existing third-party preToolUse entry', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-crusher-hooks-thirdparty-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      fs.writeFileSync(hooksJsonPath, JSON.stringify({
        version: 1,
        hooks: { [PRE_TOOL_USE_EVENT]: [{ command: 'node .cursor/hooks/before-tool-use.js' }] },
      }));
      applyCursorCrusherHookToFile(hooksJsonPath, '/abs/cursor-crusher-adapter.js');
      const onDisk = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.strictEqual(onDisk.hooks[PRE_TOOL_USE_EVENT].length, 2);
      assert.ok(onDisk.hooks[PRE_TOOL_USE_EVENT].some(entry => entry.command === 'node .cursor/hooks/before-tool-use.js'));
      assert.ok(onDisk.hooks[PRE_TOOL_USE_EVENT].some(entry => entry.command.includes('cursor-crusher-adapter.js')));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('the Crusher preToolUse entry and the Guardian beforeShellExecution entry coexist without colliding', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-crusher-vs-guardian-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      applyCursorGuardianHookToFile(hooksJsonPath, BEFORE_SHELL_EXECUTION_EVENT, '/abs/cursor-guardian-adapter.js');
      applyCursorCrusherHookToFile(hooksJsonPath, '/abs/cursor-crusher-adapter.js');

      const onDisk = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.strictEqual(onDisk.hooks[BEFORE_SHELL_EXECUTION_EVENT].length, 1);
      assert.ok(onDisk.hooks[BEFORE_SHELL_EXECUTION_EVENT][0].command.includes('cursor-guardian-adapter.js'));
      assert.strictEqual(onDisk.hooks[PRE_TOOL_USE_EVENT].length, 1);
      assert.ok(onDisk.hooks[PRE_TOOL_USE_EVENT][0].command.includes('cursor-crusher-adapter.js'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('removeCursorCrusherHookFromFile drops only the EGC entry, keeps third-party hooks', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-crusher-hooks-remove-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      fs.writeFileSync(hooksJsonPath, JSON.stringify({
        version: 1,
        hooks: { [PRE_TOOL_USE_EVENT]: [{ command: 'node .cursor/hooks/before-tool-use.js' }] },
      }));
      applyCursorCrusherHookToFile(hooksJsonPath, '/abs/cursor-crusher-adapter.js');
      const result = removeCursorCrusherHookFromFile(hooksJsonPath, '/abs/cursor-crusher-adapter.js');
      assert.strictEqual(result.changed, true);

      const onDisk = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.strictEqual(onDisk.hooks[PRE_TOOL_USE_EVENT].length, 1);
      assert.strictEqual(onDisk.hooks[PRE_TOOL_USE_EVENT][0].command, 'node .cursor/hooks/before-tool-use.js');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('removeCursorCrusherHookFromFile on a missing file is a no-op', () => {
    const result = removeCursorCrusherHookFromFile('/nonexistent/hooks.json', '/abs/cursor-crusher-adapter.js');
    assert.strictEqual(result.changed, false);
  })) passed++; else failed++;

  if (test('inspectCursorCrusherHookFile reports ok when present, drifted when absent', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-crusher-hooks-inspect-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      assert.strictEqual(inspectCursorCrusherHookFile(hooksJsonPath, '/abs/cursor-crusher-adapter.js'), 'drifted');
      applyCursorCrusherHookToFile(hooksJsonPath, '/abs/cursor-crusher-adapter.js');
      assert.strictEqual(inspectCursorCrusherHookFile(hooksJsonPath, '/abs/cursor-crusher-adapter.js'), 'ok');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
