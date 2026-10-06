'use strict';

/**
 * Tests for scripts/lib/crush-settings-hooks.js
 *
 * Crush uses a flat {hooks: {<event>: [{matcher, command}]}} config shape
 * directly under crush.json. These tests verify adding, removing, inspecting,
 * and operation generation for Crush hooks.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CRUSH_CONFIG_FILE_NAME,
  CRUSH_CRUSHER_MATCHER,
  CRUSH_GUARDIAN_MATCHER,
  CRUSH_PRE_TOOL_USE_EVENT,
  PRE_TOOL_USE_EVENT,
  addCrushHookEntry,
  applyCrushHookToFile,
  createCrushCrusherHookMergeOperation,
  createCrushGuardianHookMergeOperation,
  createCrushGuardianScriptCopyOperations,
  inspectCrushHookFile,
  removeCrushHookEntry,
  removeCrushHookFromFile,
  resolveCrushGuardianAdapterDestination,
  resolveCrushHooksJsonPath,
} = require('../../scripts/lib/crush-settings-hooks');

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
  console.log('\n=== Testing crush-settings-hooks ===\n');

  let passed = 0;
  let failed = 0;

  if (test('path resolution functions compute expected paths under target root', () => {
    const root = '/path/to/crush/home';
    assert.strictEqual(resolveCrushHooksJsonPath(root), path.join(root, 'crush.json'));
    assert.strictEqual(
      resolveCrushGuardianAdapterDestination(root),
      path.join(root, 'scripts', 'hooks', 'crush-guardian-adapter.js')
    );
  })) passed++; else failed++;

  if (test('addCrushHookEntry appends hook entry with matcher on empty config', () => {
    const { config, changed } = addCrushHookEntry({}, PRE_TOOL_USE_EVENT, 'node adapter.js', CRUSH_GUARDIAN_MATCHER);
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(config.hooks[PRE_TOOL_USE_EVENT], [
      { matcher: CRUSH_GUARDIAN_MATCHER, command: 'node adapter.js' },
    ]);
  })) passed++; else failed++;

  if (test('addCrushHookEntry is idempotent when entry already exists', () => {
    const first = addCrushHookEntry({}, PRE_TOOL_USE_EVENT, 'node adapter.js', CRUSH_GUARDIAN_MATCHER);
    const second = addCrushHookEntry(first.config, PRE_TOOL_USE_EVENT, 'node adapter.js', CRUSH_GUARDIAN_MATCHER);
    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.config.hooks[PRE_TOOL_USE_EVENT].length, 1);
  })) passed++; else failed++;

  if (test('addCrushHookEntry preserves existing hooks and other events', () => {
    const initial = {
      otherKey: true,
      hooks: {
        PostToolUse: [{ command: 'echo done' }],
        [PRE_TOOL_USE_EVENT]: [{ matcher: '^custom$', command: 'node custom.js' }],
      },
    };
    const { config, changed } = addCrushHookEntry(initial, PRE_TOOL_USE_EVENT, 'node adapter.js', CRUSH_GUARDIAN_MATCHER);
    assert.strictEqual(changed, true);
    assert.strictEqual(config.otherKey, true);
    assert.strictEqual(config.hooks.PostToolUse.length, 1);
    assert.strictEqual(config.hooks[PRE_TOOL_USE_EVENT].length, 2);
    assert.strictEqual(config.hooks[PRE_TOOL_USE_EVENT][0].command, 'node custom.js');
    assert.strictEqual(config.hooks[PRE_TOOL_USE_EVENT][1].command, 'node adapter.js');
  })) passed++; else failed++;

  if (test('addCrushHookEntry updates stale egc adapter entry in place', () => {
    const initial = {
      hooks: {
        [PRE_TOOL_USE_EVENT]: [
          { matcher: CRUSH_GUARDIAN_MATCHER, command: 'node /old/path/scripts/hooks/crush-guardian-adapter.js' },
        ],
      },
    };
    const { config, changed } = addCrushHookEntry(
      initial,
      PRE_TOOL_USE_EVENT,
      'node /new/path/scripts/hooks/crush-guardian-adapter.js',
      CRUSH_GUARDIAN_MATCHER
    );
    assert.strictEqual(changed, true);
    assert.strictEqual(config.hooks[PRE_TOOL_USE_EVENT].length, 1);
    assert.strictEqual(
      config.hooks[PRE_TOOL_USE_EVENT][0].command,
      'node /new/path/scripts/hooks/crush-guardian-adapter.js'
    );
  })) passed++; else failed++;

  if (test('removeCrushHookEntry removes matching command', () => {
    const initial = {
      hooks: {
        [PRE_TOOL_USE_EVENT]: [
          { matcher: CRUSH_GUARDIAN_MATCHER, command: 'node adapter.js' },
          { command: 'node keep.js' },
        ],
      },
    };
    const { config, changed } = removeCrushHookEntry(initial, PRE_TOOL_USE_EVENT, 'node adapter.js');
    assert.strictEqual(changed, true);
    assert.strictEqual(config.hooks[PRE_TOOL_USE_EVENT].length, 1);
    assert.strictEqual(config.hooks[PRE_TOOL_USE_EVENT][0].command, 'node keep.js');
  })) passed++; else failed++;

  if (test('file operations: applyCrushHookToFile, inspectCrushHookFile, and removeCrushHookFromFile', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-hooks-test-'));
    try {
      const configPath = path.join(tmpDir, CRUSH_CONFIG_FILE_NAME);
      const scriptPath = path.join(tmpDir, 'adapter.js');

      assert.strictEqual(inspectCrushHookFile(configPath, scriptPath, CRUSH_GUARDIAN_MATCHER), 'drifted');

      const apply1 = applyCrushHookToFile(configPath, scriptPath, CRUSH_GUARDIAN_MATCHER);
      assert.strictEqual(apply1.changed, true);
      assert.strictEqual(inspectCrushHookFile(configPath, scriptPath, CRUSH_GUARDIAN_MATCHER), 'ok');
      assert.strictEqual(inspectCrushHookFile(configPath, scriptPath, '^different$'), 'drifted');

      const apply2 = applyCrushHookToFile(configPath, scriptPath, CRUSH_GUARDIAN_MATCHER);
      assert.strictEqual(apply2.changed, false);

      const removal = removeCrushHookFromFile(configPath, scriptPath);
      assert.strictEqual(removal.changed, true);
      assert.strictEqual(inspectCrushHookFile(configPath, scriptPath, CRUSH_GUARDIAN_MATCHER), 'drifted');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('createCrushGuardianHookMergeOperation returns correct operation descriptor', () => {
    const root = '/crush/home';
    const op = createCrushGuardianHookMergeOperation(root);
    assert.strictEqual(op.kind, 'merge-claude-settings-hooks');
    assert.strictEqual(op.moduleId, 'egc-bash-guardian-hook');
    assert.strictEqual(op.destinationPath, path.join(root, 'crush.json'));
    assert.strictEqual(op.hookEvent, CRUSH_PRE_TOOL_USE_EVENT);
    assert.strictEqual(op.hookMatcher, CRUSH_GUARDIAN_MATCHER);
    assert.strictEqual(op.hookScriptPath, path.join(root, 'scripts', 'hooks', 'crush-guardian-adapter.js'));
  })) passed++; else failed++;

  if (test('createCrushCrusherHookMergeOperation returns correct operation descriptor', () => {
    const root = '/crush/home';
    const op = createCrushCrusherHookMergeOperation(root);
    assert.strictEqual(op.kind, 'merge-claude-settings-hooks');
    assert.strictEqual(op.moduleId, 'egc-crusher-hook');
    assert.strictEqual(op.destinationPath, path.join(root, 'crush.json'));
    assert.strictEqual(op.hookEvent, CRUSH_PRE_TOOL_USE_EVENT);
    assert.strictEqual(op.hookMatcher, CRUSH_CRUSHER_MATCHER);
    assert.strictEqual(op.hookScriptPath, path.join(root, 'scripts', 'hooks', 'crusher-hook.js'));
  })) passed++; else failed++;

  if (test('createCrushGuardianScriptCopyOperations creates copy operations for dependencies and adapter', () => {
    const root = '/crush/home';
    const mockCreateRemapped = (moduleId, src, dest, options) => ({
      kind: 'copy',
      moduleId,
      sourceRelativePath: src,
      destinationPath: dest,
      ...options,
    });
    const ops = createCrushGuardianScriptCopyOperations(mockCreateRemapped, root);
    assert.ok(ops.length >= 4);
    const destPaths = ops.map(o => o.destinationPath);
    assert.ok(destPaths.some(p => p.endsWith('crush-guardian-adapter.js')));
    assert.ok(destPaths.some(p => p.endsWith('pre-bash-guardian-validate.js')));
    assert.ok(destPaths.some(p => p.endsWith('pre-write-guardian-validate.js')));
    assert.ok(destPaths.some(p => p.endsWith('adapter-stdin-json.js')));
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
