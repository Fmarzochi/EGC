/**
 * Tests for scripts/lib/claude-settings-hooks.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  HOOK_MODULE_ID,
  HOOK_OPERATION_KIND,
  HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  SESSION_START_EVENT,
  STOP_EVENT,
  STOP_HOOK_MODULE_ID,
  STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  addSessionStartHook,
  addStopHook,
  applySessionStartHookToFile,
  applyStopHookToFile,
  buildSessionStartCommand,
  buildStopCommand,
  createSessionStartHookMergeOperation,
  createStopHookMergeOperation,
  hasSessionStartHook,
  hasStopHook,
  inspectSessionStartHookFile,
  inspectStopHookFile,
  removeSessionStartHook,
  removeSessionStartHookFromFile,
  removeStopHook,
  removeStopHookFromFile,
  resolveHookScriptDestination,
  resolveSettingsPath,
  resolveStopHookScriptDestination,
} = require('../../scripts/lib/claude-settings-hooks');

const HOOK_SCRIPT_PATH = '/home/user/.claude/egc/hooks/claude-session-start.js';
const STOP_HOOK_SCRIPT_PATH = '/home/user/.claude/egc/hooks/claude-session-stop.js';

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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function thirdPartySettings() {
  return {
    model: 'opus',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [{ type: 'command', command: 'echo third-party' }],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'echo guard' }],
        },
      ],
    },
  };
}

function stopHookThirdPartySettings() {
  return {
    model: 'opus',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      Stop: [
        {
          matcher: 'cleanup',
          hooks: [{ type: 'command', command: 'echo third-party-stop' }],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'echo guard' }],
        },
      ],
    },
  };
}

function runTests() {
  console.log('\n=== Testing claude-settings-hooks.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('adds the SessionStart hook to empty settings', () => {
    const { settings, changed } = addSessionStartHook({}, HOOK_SCRIPT_PATH);

    assert.strictEqual(changed, true);
    assert.deepStrictEqual(settings.hooks[SESSION_START_EVENT], [
      {
        hooks: [
          { type: 'command', command: buildSessionStartCommand(HOOK_SCRIPT_PATH) },
        ],
      },
    ]);
    assert.ok(hasSessionStartHook(settings, HOOK_SCRIPT_PATH));
  })) passed++; else failed++;

  if (test('add is idempotent and reports no change when the hook exists', () => {
    const first = addSessionStartHook({}, HOOK_SCRIPT_PATH);
    const second = addSessionStartHook(first.settings, HOOK_SCRIPT_PATH);

    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.settings.hooks[SESSION_START_EVENT].length, 1);
  })) passed++; else failed++;

  if (test('add preserves third-party hooks and unrelated settings keys', () => {
    const { settings } = addSessionStartHook(thirdPartySettings(), HOOK_SCRIPT_PATH);

    assert.strictEqual(settings.model, 'opus');
    assert.deepStrictEqual(settings.permissions, { allow: ['Bash(npm test)'] });
    assert.strictEqual(settings.hooks.PreToolUse.length, 1);
    assert.strictEqual(settings.hooks[SESSION_START_EVENT].length, 2);
    assert.strictEqual(
      settings.hooks[SESSION_START_EVENT][0].hooks[0].command,
      'echo third-party'
    );
    assert.ok(hasSessionStartHook(settings, HOOK_SCRIPT_PATH));
  })) passed++; else failed++;

  if (test('remove strips only the EGC entry and keeps third-party hooks', () => {
    const installed = addSessionStartHook(thirdPartySettings(), HOOK_SCRIPT_PATH).settings;
    const { settings, changed } = removeSessionStartHook(installed, HOOK_SCRIPT_PATH);

    assert.strictEqual(changed, true);
    assert.strictEqual(settings.model, 'opus');
    assert.strictEqual(settings.hooks[SESSION_START_EVENT].length, 1);
    assert.strictEqual(
      settings.hooks[SESSION_START_EVENT][0].hooks[0].command,
      'echo third-party'
    );
    assert.strictEqual(settings.hooks.PreToolUse.length, 1);
    assert.ok(!hasSessionStartHook(settings, HOOK_SCRIPT_PATH));
  })) passed++; else failed++;

  if (test('remove keeps sibling entries when the EGC entry shares a matcher group', () => {
    const settings = {
      hooks: {
        [SESSION_START_EVENT]: [
          {
            hooks: [
              { type: 'command', command: 'echo sibling' },
              { type: 'command', command: buildSessionStartCommand(HOOK_SCRIPT_PATH) },
            ],
          },
        ],
      },
    };
    const result = removeSessionStartHook(settings, HOOK_SCRIPT_PATH);

    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual(result.settings.hooks[SESSION_START_EVENT], [
      { hooks: [{ type: 'command', command: 'echo sibling' }] },
    ]);
  })) passed++; else failed++;

  if (test('remove drops empty hooks containers when EGC was the only hook', () => {
    const installed = addSessionStartHook({ model: 'opus' }, HOOK_SCRIPT_PATH).settings;
    const { settings, changed } = removeSessionStartHook(installed, HOOK_SCRIPT_PATH);

    assert.strictEqual(changed, true);
    assert.deepStrictEqual(settings, { model: 'opus' });
  })) passed++; else failed++;

  if (test('remove is a no-op when the hook is not registered', () => {
    const settings = thirdPartySettings();
    const result = removeSessionStartHook(settings, HOOK_SCRIPT_PATH);

    assert.strictEqual(result.changed, false);
    assert.deepStrictEqual(result.settings, settings);
  })) passed++; else failed++;

  if (test('applySessionStartHookToFile creates settings.json when absent', () => {
    const homeDir = createTempDir('claude-settings-hooks-');
    try {
      const settingsPath = path.join(homeDir, '.claude', 'settings.json');
      const result = applySessionStartHookToFile(settingsPath, HOOK_SCRIPT_PATH);

      assert.strictEqual(result.changed, true);
      assert.ok(hasSessionStartHook(readJson(settingsPath), HOOK_SCRIPT_PATH));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('applySessionStartHookToFile merges into existing settings without rewriting other keys', () => {
    const homeDir = createTempDir('claude-settings-hooks-');
    try {
      const settingsPath = path.join(homeDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify(thirdPartySettings(), null, 2));

      applySessionStartHookToFile(settingsPath, HOOK_SCRIPT_PATH);
      const repeat = applySessionStartHookToFile(settingsPath, HOOK_SCRIPT_PATH);
      const settings = readJson(settingsPath);

      assert.strictEqual(repeat.changed, false);
      assert.strictEqual(settings.model, 'opus');
      assert.strictEqual(settings.hooks[SESSION_START_EVENT].length, 2);
      assert.strictEqual(settings.hooks.PreToolUse.length, 1);
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('applySessionStartHookToFile treats an empty settings file as an empty object', () => {
    const homeDir = createTempDir('claude-settings-hooks-');
    try {
      const settingsPath = path.join(homeDir, 'settings.json');
      fs.writeFileSync(settingsPath, '\n');

      const result = applySessionStartHookToFile(settingsPath, HOOK_SCRIPT_PATH);

      assert.strictEqual(result.changed, true);
      assert.ok(hasSessionStartHook(readJson(settingsPath), HOOK_SCRIPT_PATH));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('applySessionStartHookToFile rejects invalid JSON instead of overwriting it', () => {
    const homeDir = createTempDir('claude-settings-hooks-');
    try {
      const settingsPath = path.join(homeDir, 'settings.json');
      fs.writeFileSync(settingsPath, '{ not json');

      assert.throws(
        () => applySessionStartHookToFile(settingsPath, HOOK_SCRIPT_PATH),
        /Failed to parse Claude Code settings/
      );
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '{ not json');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('removeSessionStartHookFromFile never deletes settings.json', () => {
    const homeDir = createTempDir('claude-settings-hooks-');
    try {
      const settingsPath = path.join(homeDir, 'settings.json');
      applySessionStartHookToFile(settingsPath, HOOK_SCRIPT_PATH);

      const result = removeSessionStartHookFromFile(settingsPath, HOOK_SCRIPT_PATH);

      assert.strictEqual(result.changed, true);
      assert.ok(fs.existsSync(settingsPath));
      assert.deepStrictEqual(readJson(settingsPath), {});
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('removeSessionStartHookFromFile is a no-op when settings.json is absent', () => {
    const homeDir = createTempDir('claude-settings-hooks-');
    try {
      const settingsPath = path.join(homeDir, 'settings.json');
      const result = removeSessionStartHookFromFile(settingsPath, HOOK_SCRIPT_PATH);

      assert.strictEqual(result.changed, false);
      assert.ok(!fs.existsSync(settingsPath));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('inspectSessionStartHookFile reports ok, drifted, and invalid JSON as drifted', () => {
    const homeDir = createTempDir('claude-settings-hooks-');
    try {
      const settingsPath = path.join(homeDir, 'settings.json');

      fs.writeFileSync(settingsPath, JSON.stringify(thirdPartySettings()));
      assert.strictEqual(inspectSessionStartHookFile(settingsPath, HOOK_SCRIPT_PATH), 'drifted');

      applySessionStartHookToFile(settingsPath, HOOK_SCRIPT_PATH);
      assert.strictEqual(inspectSessionStartHookFile(settingsPath, HOOK_SCRIPT_PATH), 'ok');

      fs.writeFileSync(settingsPath, '{ not json');
      assert.strictEqual(inspectSessionStartHookFile(settingsPath, HOOK_SCRIPT_PATH), 'drifted');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('createSessionStartHookMergeOperation builds a managed operation for the target root', () => {
    const targetRoot = path.join('/home/user', '.claude');
    const operation = createSessionStartHookMergeOperation(targetRoot);

    assert.strictEqual(operation.kind, HOOK_OPERATION_KIND);
    assert.strictEqual(operation.moduleId, HOOK_MODULE_ID);
    assert.strictEqual(operation.sourceRelativePath, HOOK_SCRIPT_SOURCE_RELATIVE_PATH);
    assert.strictEqual(operation.destinationPath, resolveSettingsPath(targetRoot));
    assert.strictEqual(operation.ownership, 'managed');
    assert.strictEqual(operation.scaffoldOnly, false);
    assert.strictEqual(operation.hookEvent, SESSION_START_EVENT);
    assert.strictEqual(operation.hookScriptPath, resolveHookScriptDestination(targetRoot));
    assert.strictEqual(
      operation.hookCommand,
      buildSessionStartCommand(resolveHookScriptDestination(targetRoot))
    );
  })) passed++; else failed++;

  console.log('\n--- Stop hook ---\n');

  if (test('addStopHook adds the Stop hook to empty settings', () => {
    const { settings, changed } = addStopHook({}, STOP_HOOK_SCRIPT_PATH);

    assert.strictEqual(changed, true);
    assert.deepStrictEqual(settings.hooks[STOP_EVENT], [
      { hooks: [{ type: 'command', command: buildStopCommand(STOP_HOOK_SCRIPT_PATH) }] },
    ]);
    assert.ok(hasStopHook(settings, STOP_HOOK_SCRIPT_PATH));
  })) passed++; else failed++;

  if (test('addStopHook is idempotent and reports no change when the hook exists', () => {
    const first = addStopHook({}, STOP_HOOK_SCRIPT_PATH);
    const second = addStopHook(first.settings, STOP_HOOK_SCRIPT_PATH);

    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.settings.hooks[STOP_EVENT].length, 1);
  })) passed++; else failed++;

  if (test('addStopHook preserves third-party Stop hooks and unrelated settings keys', () => {
    const { settings } = addStopHook(stopHookThirdPartySettings(), STOP_HOOK_SCRIPT_PATH);

    assert.strictEqual(settings.model, 'opus');
    assert.deepStrictEqual(settings.permissions, { allow: ['Bash(npm test)'] });
    assert.strictEqual(settings.hooks.PreToolUse.length, 1);
    assert.strictEqual(settings.hooks[STOP_EVENT].length, 2);
    assert.strictEqual(
      settings.hooks[STOP_EVENT][0].hooks[0].command,
      'echo third-party-stop'
    );
    assert.ok(hasStopHook(settings, STOP_HOOK_SCRIPT_PATH));
  })) passed++; else failed++;

  if (test('removeStopHook strips only the EGC Stop entry and keeps third-party hooks', () => {
    const installed = addStopHook(stopHookThirdPartySettings(), STOP_HOOK_SCRIPT_PATH).settings;
    const { settings, changed } = removeStopHook(installed, STOP_HOOK_SCRIPT_PATH);

    assert.strictEqual(changed, true);
    assert.strictEqual(settings.model, 'opus');
    assert.strictEqual(settings.hooks[STOP_EVENT].length, 1);
    assert.strictEqual(
      settings.hooks[STOP_EVENT][0].hooks[0].command,
      'echo third-party-stop'
    );
    assert.strictEqual(settings.hooks.PreToolUse.length, 1);
    assert.ok(!hasStopHook(settings, STOP_HOOK_SCRIPT_PATH));
  })) passed++; else failed++;

  if (test('removeStopHook drops empty hooks containers when EGC was the only Stop hook', () => {
    const installed = addStopHook({ model: 'opus' }, STOP_HOOK_SCRIPT_PATH).settings;
    const { settings, changed } = removeStopHook(installed, STOP_HOOK_SCRIPT_PATH);

    assert.strictEqual(changed, true);
    assert.deepStrictEqual(settings, { model: 'opus' });
  })) passed++; else failed++;

  if (test('removeStopHook is a no-op when the Stop hook is not registered', () => {
    const settings = stopHookThirdPartySettings();
    const result = removeStopHook(settings, STOP_HOOK_SCRIPT_PATH);

    assert.strictEqual(result.changed, false);
    assert.deepStrictEqual(result.settings, settings);
  })) passed++; else failed++;

  if (test('applyStopHookToFile creates settings.json with Stop hook when absent', () => {
    const homeDir = createTempDir('claude-stop-hooks-');
    try {
      const settingsPath = path.join(homeDir, '.claude', 'settings.json');
      const result = applyStopHookToFile(settingsPath, STOP_HOOK_SCRIPT_PATH);

      assert.strictEqual(result.changed, true);
      assert.ok(hasStopHook(readJson(settingsPath), STOP_HOOK_SCRIPT_PATH));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('applyStopHookToFile is idempotent on subsequent calls', () => {
    const homeDir = createTempDir('claude-stop-hooks-');
    try {
      const settingsPath = path.join(homeDir, 'settings.json');
      applyStopHookToFile(settingsPath, STOP_HOOK_SCRIPT_PATH);
      const repeat = applyStopHookToFile(settingsPath, STOP_HOOK_SCRIPT_PATH);

      assert.strictEqual(repeat.changed, false);
      assert.strictEqual(readJson(settingsPath).hooks[STOP_EVENT].length, 1);
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('removeStopHookFromFile is a no-op when settings.json is absent', () => {
    const homeDir = createTempDir('claude-stop-hooks-');
    try {
      const settingsPath = path.join(homeDir, 'settings.json');
      const result = removeStopHookFromFile(settingsPath, STOP_HOOK_SCRIPT_PATH);

      assert.strictEqual(result.changed, false);
      assert.ok(!fs.existsSync(settingsPath));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('inspectStopHookFile reports ok, drifted, and invalid JSON as drifted', () => {
    const homeDir = createTempDir('claude-stop-hooks-');
    try {
      const settingsPath = path.join(homeDir, 'settings.json');

      fs.writeFileSync(settingsPath, JSON.stringify(stopHookThirdPartySettings()));
      assert.strictEqual(inspectStopHookFile(settingsPath, STOP_HOOK_SCRIPT_PATH), 'drifted');

      applyStopHookToFile(settingsPath, STOP_HOOK_SCRIPT_PATH);
      assert.strictEqual(inspectStopHookFile(settingsPath, STOP_HOOK_SCRIPT_PATH), 'ok');

      fs.writeFileSync(settingsPath, '{ not json');
      assert.strictEqual(inspectStopHookFile(settingsPath, STOP_HOOK_SCRIPT_PATH), 'drifted');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('createStopHookMergeOperation builds a managed operation for the target root', () => {
    const targetRoot = path.join('/home/user', '.claude');
    const operation = createStopHookMergeOperation(targetRoot);

    assert.strictEqual(operation.kind, HOOK_OPERATION_KIND);
    assert.strictEqual(operation.moduleId, STOP_HOOK_MODULE_ID);
    assert.strictEqual(operation.sourceRelativePath, STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH);
    assert.strictEqual(operation.destinationPath, resolveSettingsPath(targetRoot));
    assert.strictEqual(operation.ownership, 'managed');
    assert.strictEqual(operation.scaffoldOnly, false);
    assert.strictEqual(operation.hookEvent, STOP_EVENT);
    assert.strictEqual(operation.hookScriptPath, resolveStopHookScriptDestination(targetRoot));
    assert.strictEqual(
      operation.hookCommand,
      buildStopCommand(resolveStopHookScriptDestination(targetRoot))
    );
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
