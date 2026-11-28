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
  const tally = ok => { if (ok) passed++; else failed++; };

  tally(test('path resolution functions compute expected paths under target root', () => {
    const root = '/path/to/crush/home';
    assert.strictEqual(resolveCrushHooksJsonPath(root), path.join(root, 'crush.json'));
    assert.strictEqual(
      resolveCrushGuardianAdapterDestination(root),
      path.join(root, 'scripts', 'hooks', 'crush-guardian-adapter.js')
    );
  }));

  tally(test('addCrushHookEntry appends hook entry with matcher on empty config', () => {
    const { config, changed } = addCrushHookEntry({}, PRE_TOOL_USE_EVENT, 'node adapter.js', CRUSH_GUARDIAN_MATCHER);
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(config.hooks[PRE_TOOL_USE_EVENT], [
      { matcher: CRUSH_GUARDIAN_MATCHER, command: 'node adapter.js' },
    ]);
  }));

  tally(test('addCrushHookEntry is idempotent when entry already exists', () => {
    const first = addCrushHookEntry({}, PRE_TOOL_USE_EVENT, 'node adapter.js', CRUSH_GUARDIAN_MATCHER);
    const second = addCrushHookEntry(first.config, PRE_TOOL_USE_EVENT, 'node adapter.js', CRUSH_GUARDIAN_MATCHER);
    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.config.hooks[PRE_TOOL_USE_EVENT].length, 1);
  }));

  tally(test('addCrushHookEntry preserves existing hooks and other events', () => {
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
  }));

  tally(test('addCrushHookEntry updates stale egc adapter entry in place', () => {
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
  }));

  tally(test('removeCrushHookEntry removes matching command', () => {
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
  }));

  tally(test('file operations: applyCrushHookToFile, inspectCrushHookFile, and removeCrushHookFromFile', () => {
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
  }));

  tally(test('createCrushGuardianHookMergeOperation returns correct operation descriptor', () => {
    const root = '/crush/home';
    const op = createCrushGuardianHookMergeOperation(root);
    assert.strictEqual(op.kind, 'merge-claude-settings-hooks');
    assert.strictEqual(op.moduleId, 'egc-bash-guardian-hook');
    assert.strictEqual(op.destinationPath, path.join(root, 'crush.json'));
    assert.strictEqual(op.hookEvent, CRUSH_PRE_TOOL_USE_EVENT);
    assert.strictEqual(op.hookMatcher, CRUSH_GUARDIAN_MATCHER);
    assert.strictEqual(op.hookScriptPath, path.join(root, 'scripts', 'hooks', 'crush-guardian-adapter.js'));
  }));

  tally(test('createCrushCrusherHookMergeOperation returns correct operation descriptor', () => {
    const root = '/crush/home';
    const op = createCrushCrusherHookMergeOperation(root);
    assert.strictEqual(op.kind, 'merge-claude-settings-hooks');
    assert.strictEqual(op.moduleId, 'egc-crusher-hook');
    assert.strictEqual(op.destinationPath, path.join(root, 'crush.json'));
    assert.strictEqual(op.hookEvent, CRUSH_PRE_TOOL_USE_EVENT);
    assert.strictEqual(op.hookMatcher, CRUSH_CRUSHER_MATCHER);
    assert.strictEqual(op.hookScriptPath, path.join(root, 'scripts', 'hooks', 'crusher-hook.js'));
  }));

  tally(test('createCrushGuardianScriptCopyOperations creates copy operations for dependencies and adapter', () => {
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
  }));

  tally(test('the session hooks go under SessionStart and TurnEnd with no matcher, beside the gates, and leave one at a time', () => {
    const {
      CRUSH_HOOK_OPERATION_HANDLERS,
      CRUSH_SESSION_START_EVENT,
      CRUSH_TURN_END_EVENT,
      createCrushSessionHookMergeOperations,
      crushNativeEvent,
    } = require('../../scripts/lib/crush-settings-hooks');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-hooks-test-'));
    try {
      const configPath = resolveCrushHooksJsonPath(tmpDir);
      fs.writeFileSync(configPath, JSON.stringify({ model: 'keep', hooks: { SessionStart: [{ command: 'node mine.js' }] } }, null, 2));
      const guardian = resolveCrushGuardianAdapterDestination(tmpDir);
      applyCrushHookToFile(configPath, guardian, CRUSH_GUARDIAN_MATCHER);
      const [start, stop] = createCrushSessionHookMergeOperations(tmpDir);
      assert.strictEqual(start.hookEvent, CRUSH_SESSION_START_EVENT);
      assert.strictEqual(crushNativeEvent(start.hookEvent), 'SessionStart');
      assert.strictEqual(start.hookScriptPath, path.join(tmpDir, 'scripts', 'hooks', 'crush-session-start.js'));
      assert.strictEqual(stop.hookEvent, CRUSH_TURN_END_EVENT);
      assert.strictEqual(crushNativeEvent(stop.hookEvent), 'TurnEnd');
      assert.strictEqual(stop.hookScriptPath, path.join(tmpDir, 'scripts', 'hooks', 'team-sync-stop.js'));
      assert.strictEqual(start.hookMatcher, undefined, 'a session event takes no matcher');
      assert.strictEqual(start.moduleId, 'egc-host-session-hook');
      assert.strictEqual(start.destinationPath, configPath);
      for (const operation of [start, stop]) {
        CRUSH_HOOK_OPERATION_HANDLERS.apply(operation);
        CRUSH_HOOK_OPERATION_HANDLERS.apply(operation);
      }
      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.strictEqual(written.model, 'keep', 'the rest of crush.json is untouched');
      assert.deepStrictEqual(written.hooks.SessionStart, [{ command: 'node mine.js' }, { command: `"${process.execPath}" "${start.hookScriptPath}"` }], 'the entry goes beside the person\'s own, once, with no matcher key');
      assert.deepStrictEqual(written.hooks.TurnEnd, [{ command: `"${process.execPath}" "${stop.hookScriptPath}"` }]);
      assert.strictEqual(written.hooks.PreToolUse.length, 1, 'the Guardian entry is untouched');
      assert.strictEqual(CRUSH_HOOK_OPERATION_HANDLERS.inspect(start), 'ok');
      assert.strictEqual(CRUSH_HOOK_OPERATION_HANDLERS.inspect(stop), 'ok');
      assert.strictEqual(inspectCrushHookFile(configPath, guardian, CRUSH_GUARDIAN_MATCHER), 'ok');
      const edited = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      edited.hooks.TurnEnd[0].matcher = '^bash$';
      fs.writeFileSync(configPath, JSON.stringify(edited, null, 2));
      assert.strictEqual(CRUSH_HOOK_OPERATION_HANDLERS.inspect(stop), 'drifted', 'a matcher put on a session entry by hand is drift');
      CRUSH_HOOK_OPERATION_HANDLERS.apply(stop);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).hooks.TurnEnd, [{ command: `"${process.execPath}" "${stop.hookScriptPath}"` }], 'repair rewrites the entry without the matcher, once');
      assert.strictEqual(CRUSH_HOOK_OPERATION_HANDLERS.inspect(stop), 'ok');
      CRUSH_HOOK_OPERATION_HANDLERS.remove(start);
      const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.deepStrictEqual(after.hooks.SessionStart, [{ command: 'node mine.js' }], 'only the EGC entry leaves the event');
      assert.strictEqual(after.hooks.TurnEnd.length, 1);
      assert.strictEqual(CRUSH_HOOK_OPERATION_HANDLERS.inspect(start), 'drifted');
      assert.strictEqual(CRUSH_HOOK_OPERATION_HANDLERS.inspect(stop), 'ok');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
