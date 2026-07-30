/**
 * Tests for scripts/lib/openhands-guardian-hooks.js
 *
 * OpenHands' hooks.json has no top-level "hooks" wrapper: event names sit
 * directly at the document root, each value an array of {matcher, hooks:
 * [{command, timeout}]} rule groups. That shape needs its own merge logic
 * distinct from both flat-hooks-json-merge.js (Kiro/Amazon Q) and
 * claude-settings-hooks.js (Claude/Goose), so it is exercised directly here.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PRE_TOOL_USE_EVENT,
  TERMINAL_MATCHER,
  addOpenHandsHookEntry,
  applyOpenHandsGuardianHookToFile,
  buildHookCommand,
  inspectOpenHandsGuardianHookFile,
  removeOpenHandsGuardianHookFromFile,
  removeOpenHandsHookEntry,
  resolveGuardianAdapterScriptDestination,
  resolveHooksJsonPath,
} = require('../../scripts/lib/openhands-guardian-hooks');

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
  console.log('\n=== Testing openhands-guardian-hooks ===\n');

  let passed = 0;
  let failed = 0;

  if (test('resolveGuardianAdapterScriptDestination and resolveHooksJsonPath compute paths under targetRoot/projectRoot', () => {
    const targetRoot = '/home/user/project/.openhands';
    assert.strictEqual(
      resolveGuardianAdapterScriptDestination(targetRoot),
      path.join(targetRoot, 'scripts', 'hooks', 'openhands-guardian-adapter.js')
    );
    assert.strictEqual(
      resolveHooksJsonPath('/home/user/project'),
      path.join('/home/user/project', '.openhands', 'hooks.json')
    );
  })) passed++; else failed++;

  if (test('buildHookCommand quotes the node binary and script path', () => {
    const command = buildHookCommand('/abs/adapter.js');
    assert.strictEqual(command, `"${process.execPath}" "/abs/adapter.js"`);
  })) passed++; else failed++;

  if (test('addOpenHandsHookEntry appends a brand-new matcher group on an empty config', () => {
    const { config, changed } = addOpenHandsHookEntry({}, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER, 'node adapter.js');
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(config[PRE_TOOL_USE_EVENT], [
      { matcher: TERMINAL_MATCHER, hooks: [{ type: 'command', command: 'node adapter.js' }] },
    ]);
  })) passed++; else failed++;

  if (test('addOpenHandsHookEntry does not duplicate an already-present command in the matching group', () => {
    const first = addOpenHandsHookEntry({}, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER, 'node adapter.js');
    const second = addOpenHandsHookEntry(first.config, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER, 'node adapter.js');
    assert.strictEqual(second.config[PRE_TOOL_USE_EVENT].length, 1);
    assert.strictEqual(second.config[PRE_TOOL_USE_EVENT][0].hooks.length, 1);
  })) passed++; else failed++;

  if (test('addOpenHandsHookEntry appends into an existing matching group alongside other hooks', () => {
    const base = {
      [PRE_TOOL_USE_EVENT]: [
        { matcher: TERMINAL_MATCHER, hooks: [{ type: 'command', command: 'node .openhands/hooks/other.js' }] },
      ],
    };
    const { config } = addOpenHandsHookEntry(base, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER, 'node adapter.js');
    assert.strictEqual(config[PRE_TOOL_USE_EVENT].length, 1);
    assert.strictEqual(config[PRE_TOOL_USE_EVENT][0].hooks.length, 2);
    assert.ok(config[PRE_TOOL_USE_EVENT][0].hooks.some(h => h.command === 'node .openhands/hooks/other.js'));
    assert.ok(config[PRE_TOOL_USE_EVENT][0].hooks.some(h => h.command === 'node adapter.js'));
  })) passed++; else failed++;

  if (test('addOpenHandsHookEntry preserves unrelated matcher groups and event keys', () => {
    const base = {
      [PRE_TOOL_USE_EVENT]: [{ matcher: 'file_write', hooks: [{ type: 'command', command: 'node audit.js' }] }],
      post_tool_use: [{ matcher: TERMINAL_MATCHER, hooks: [{ type: 'command', command: 'node log.js' }] }],
    };
    const { config } = addOpenHandsHookEntry(base, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER, 'node adapter.js');
    assert.strictEqual(config[PRE_TOOL_USE_EVENT].length, 2);
    assert.ok(config[PRE_TOOL_USE_EVENT].some(g => g.matcher === 'file_write'));
    assert.deepStrictEqual(config.post_tool_use, base.post_tool_use);
  })) passed++; else failed++;

  if (test('applyOpenHandsGuardianHookToFile writes a fresh hooks.json and is idempotent on disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhands-hooks-apply-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      const first = applyOpenHandsGuardianHookToFile(hooksJsonPath, '/abs/adapter.js');
      assert.strictEqual(first.changed, true);

      const onDisk = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.strictEqual(onDisk[PRE_TOOL_USE_EVENT][0].matcher, TERMINAL_MATCHER);
      assert.strictEqual(onDisk[PRE_TOOL_USE_EVENT][0].hooks.length, 1);

      applyOpenHandsGuardianHookToFile(hooksJsonPath, '/abs/adapter.js');
      const onDiskAgain = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.strictEqual(onDiskAgain[PRE_TOOL_USE_EVENT][0].hooks.length, 1, 'must not duplicate the entry on re-apply');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('applyOpenHandsGuardianHookToFile preserves a hand-written hooks.json on disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhands-hooks-preserve-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      fs.writeFileSync(hooksJsonPath, JSON.stringify({
        post_tool_use: [{ matcher: TERMINAL_MATCHER, hooks: [{ type: 'command', command: 'node log.js' }] }],
      }, null, 2));

      applyOpenHandsGuardianHookToFile(hooksJsonPath, '/abs/adapter.js');

      const onDisk = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.deepStrictEqual(onDisk.post_tool_use, [
        { matcher: TERMINAL_MATCHER, hooks: [{ type: 'command', command: 'node log.js' }] },
      ]);
      assert.ok(onDisk[PRE_TOOL_USE_EVENT][0].hooks[0].command.includes('adapter.js'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('applyOpenHandsGuardianHookToFile on an empty file behaves like a missing one', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhands-hooks-empty-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      fs.writeFileSync(hooksJsonPath, '   ');
      const result = applyOpenHandsGuardianHookToFile(hooksJsonPath, '/abs/adapter.js');
      assert.strictEqual(result.changed, true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('applyOpenHandsGuardianHookToFile throws a clear error on invalid JSON', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhands-hooks-invalid-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      fs.writeFileSync(hooksJsonPath, '{not valid json');
      assert.throws(() => applyOpenHandsGuardianHookToFile(hooksJsonPath, '/abs/adapter.js'), /Failed to parse OpenHands hooks config/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('applyOpenHandsGuardianHookToFile throws a clear error when the file is not a JSON object', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhands-hooks-nonobject-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      fs.writeFileSync(hooksJsonPath, '[1, 2, 3]');
      assert.throws(() => applyOpenHandsGuardianHookToFile(hooksJsonPath, '/abs/adapter.js'), /expected a JSON object/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('removeOpenHandsHookEntry drops only the EGC hook, keeps sibling hooks in the same group', () => {
    const base = {
      [PRE_TOOL_USE_EVENT]: [
        {
          matcher: TERMINAL_MATCHER,
          hooks: [
            { type: 'command', command: 'node other.js' },
            { type: 'command', command: 'node adapter.js' },
          ],
        },
      ],
    };
    const { config, changed } = removeOpenHandsHookEntry(base, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER, 'node adapter.js');
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(config[PRE_TOOL_USE_EVENT], [
      { matcher: TERMINAL_MATCHER, hooks: [{ type: 'command', command: 'node other.js' }] },
    ]);
  })) passed++; else failed++;

  if (test('removeOpenHandsHookEntry deletes the matcher group entirely once its hooks are empty', () => {
    const base = {
      [PRE_TOOL_USE_EVENT]: [{ matcher: TERMINAL_MATCHER, hooks: [{ type: 'command', command: 'node adapter.js' }] }],
    };
    const { config, changed } = removeOpenHandsHookEntry(base, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER, 'node adapter.js');
    assert.strictEqual(changed, true);
    assert.strictEqual(PRE_TOOL_USE_EVENT in config, false);
  })) passed++; else failed++;

  if (test('removeOpenHandsHookEntry preserves unrelated matcher groups after emptying ours', () => {
    const base = {
      [PRE_TOOL_USE_EVENT]: [
        { matcher: TERMINAL_MATCHER, hooks: [{ type: 'command', command: 'node adapter.js' }] },
        { matcher: 'file_write', hooks: [{ type: 'command', command: 'node audit.js' }] },
      ],
    };
    const { config } = removeOpenHandsHookEntry(base, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER, 'node adapter.js');
    assert.strictEqual(config[PRE_TOOL_USE_EVENT].length, 1);
    assert.strictEqual(config[PRE_TOOL_USE_EVENT][0].matcher, 'file_write');
  })) passed++; else failed++;

  if (test('removeOpenHandsHookEntry treats a non-object config and a non-array event value as empty', () => {
    const fromNull = removeOpenHandsHookEntry(null, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER, 'node adapter.js');
    assert.strictEqual(fromNull.changed, false);

    const fromMalformedEvent = removeOpenHandsHookEntry({ [PRE_TOOL_USE_EVENT]: 'not-an-array' }, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER, 'node adapter.js');
    assert.strictEqual(fromMalformedEvent.changed, false);
  })) passed++; else failed++;

  if (test('removeOpenHandsHookEntry treats a matching group with a non-array hooks field as empty', () => {
    const base = { [PRE_TOOL_USE_EVENT]: [{ matcher: TERMINAL_MATCHER, hooks: 'not-an-array' }] };
    const { config, changed } = removeOpenHandsHookEntry(base, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER, 'node adapter.js');
    assert.strictEqual(changed, false);
    assert.strictEqual(config, base);
  })) passed++; else failed++;

  if (test('removeOpenHandsHookEntry is a no-op when the entry is not present', () => {
    const base = { [PRE_TOOL_USE_EVENT]: [{ matcher: TERMINAL_MATCHER, hooks: [{ type: 'command', command: 'node other.js' }] }] };
    const { config, changed } = removeOpenHandsHookEntry(base, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER, 'node adapter.js');
    assert.strictEqual(changed, false);
    assert.strictEqual(config, base);
  })) passed++; else failed++;

  if (test('removeOpenHandsGuardianHookFromFile on a missing file is a no-op', () => {
    const result = removeOpenHandsGuardianHookFromFile('/nonexistent/hooks.json', '/abs/adapter.js');
    assert.strictEqual(result.changed, false);
  })) passed++; else failed++;

  if (test('removeOpenHandsGuardianHookFromFile removes the entry from an existing file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhands-hooks-remove-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      applyOpenHandsGuardianHookToFile(hooksJsonPath, '/abs/adapter.js');
      const result = removeOpenHandsGuardianHookFromFile(hooksJsonPath, '/abs/adapter.js');
      assert.strictEqual(result.changed, true);
      const onDisk = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.strictEqual(PRE_TOOL_USE_EVENT in onDisk, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('inspectOpenHandsGuardianHookFile reports drifted when missing, ok when present, drifted on parse error', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhands-hooks-inspect-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      assert.strictEqual(inspectOpenHandsGuardianHookFile(hooksJsonPath, '/abs/adapter.js'), 'drifted');
      applyOpenHandsGuardianHookToFile(hooksJsonPath, '/abs/adapter.js');
      assert.strictEqual(inspectOpenHandsGuardianHookFile(hooksJsonPath, '/abs/adapter.js'), 'ok');

      fs.writeFileSync(hooksJsonPath, '{not valid json');
      assert.strictEqual(inspectOpenHandsGuardianHookFile(hooksJsonPath, '/abs/adapter.js'), 'drifted');

      fs.writeFileSync(hooksJsonPath, JSON.stringify({ [PRE_TOOL_USE_EVENT]: 'not-an-array' }));
      assert.strictEqual(inspectOpenHandsGuardianHookFile(hooksJsonPath, '/abs/adapter.js'), 'drifted');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
