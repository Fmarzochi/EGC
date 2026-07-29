/**
 * Tests for scripts/lib/kiro-guardian-hooks.js
 *
 * Kiro CLI agent config is a flat {hooks: {<event>: [{matcher, command}]}}
 * map (no matcher/group wrapper, no "type": "command" field), unlike Claude
 * Code's settings.json, so it needs its own merge logic. These tests
 * exercise that merge logic directly (additive, idempotent, preserves
 * unrelated keys and third-party hooks), plus the execute_bash matcher
 * this host's preToolUse event needs that Cursor's beforeShellExecution
 * does not (Cursor's event already only fires for shell commands).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EXECUTE_BASH_MATCHER,
  PRE_TOOL_USE_EVENT,
  addKiroHookEntry,
  applyKiroGuardianHookToFile,
  inspectKiroGuardianHookFile,
  removeKiroGuardianHookFromFile,
  removeKiroHookEntry,
  resolveAgentConfigPath,
  resolveGuardianAdapterScriptDestination,
} = require('../../scripts/lib/kiro-guardian-hooks');

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
  console.log('\n=== Testing kiro-guardian-hooks ===\n');

  let passed = 0;
  let failed = 0;

  if (test('resolveAgentConfigPath and resolveGuardianAdapterScriptDestination compute paths under targetRoot', () => {
    const targetRoot = '/home/user/project/.kiro';
    assert.strictEqual(resolveAgentConfigPath(targetRoot), path.join(targetRoot, 'agents', 'default.json'));
    assert.strictEqual(
      resolveGuardianAdapterScriptDestination(targetRoot),
      path.join(targetRoot, 'scripts', 'hooks', 'kiro-guardian-adapter.js')
    );
  })) passed++; else failed++;

  if (test('addKiroHookEntry appends a new event array on an empty config, with the execute_bash matcher', () => {
    const { config, changed } = addKiroHookEntry({}, PRE_TOOL_USE_EVENT, 'node adapter.js');
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(config.hooks[PRE_TOOL_USE_EVENT], [{ matcher: EXECUTE_BASH_MATCHER, command: 'node adapter.js' }]);
  })) passed++; else failed++;

  if (test('addKiroHookEntry is idempotent (no duplicate on re-add)', () => {
    const first = addKiroHookEntry({}, PRE_TOOL_USE_EVENT, 'node adapter.js');
    const second = addKiroHookEntry(first.config, PRE_TOOL_USE_EVENT, 'node adapter.js');
    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.config.hooks[PRE_TOOL_USE_EVENT].length, 1);
  })) passed++; else failed++;

  if (test('addKiroHookEntry preserves third-party hooks in the same event array', () => {
    const base = {
      hooks: { [PRE_TOOL_USE_EVENT]: [{ matcher: 'fs_write', command: 'node .kiro/hooks/audit-write.js' }] },
    };
    const { config } = addKiroHookEntry(base, PRE_TOOL_USE_EVENT, 'node adapter.js');
    assert.strictEqual(config.hooks[PRE_TOOL_USE_EVENT].length, 2);
    assert.ok(config.hooks[PRE_TOOL_USE_EVENT].some(entry => entry.matcher === 'fs_write'));
    assert.ok(config.hooks[PRE_TOOL_USE_EVENT].some(entry => entry.command === 'node adapter.js' && entry.matcher === EXECUTE_BASH_MATCHER));
  })) passed++; else failed++;

  if (test('addKiroHookEntry preserves unrelated events and top-level keys', () => {
    const base = { name: 'default', hooks: { postToolUse: [{ command: 'node log.js' }] } };
    const { config } = addKiroHookEntry(base, PRE_TOOL_USE_EVENT, 'node adapter.js');
    assert.strictEqual(config.name, 'default');
    assert.deepStrictEqual(config.hooks.postToolUse, [{ command: 'node log.js' }]);
  })) passed++; else failed++;

  if (test('addKiroHookEntry migrates a stale entry (same script, different path) in place instead of duplicating', () => {
    const base = {
      hooks: {
        [PRE_TOOL_USE_EVENT]: [{ matcher: EXECUTE_BASH_MATCHER, command: 'node /old/path/kiro-guardian-adapter.js' }],
      },
    };
    const { config, changed } = addKiroHookEntry(base, PRE_TOOL_USE_EVENT, 'node /new/path/kiro-guardian-adapter.js');
    assert.strictEqual(changed, true);
    assert.strictEqual(config.hooks[PRE_TOOL_USE_EVENT].length, 1, 'must migrate in place, not append a duplicate');
    assert.strictEqual(config.hooks[PRE_TOOL_USE_EVENT][0].command, 'node /new/path/kiro-guardian-adapter.js');
  })) passed++; else failed++;

  if (test('applyKiroGuardianHookToFile writes the event to a fresh file and is idempotent', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-hooks-apply-'));
    const agentConfigPath = path.join(tempDir, 'default.json');
    try {
      const first = applyKiroGuardianHookToFile(agentConfigPath, PRE_TOOL_USE_EVENT, '/abs/adapter.js');
      assert.strictEqual(first.changed, true);

      const onDisk = JSON.parse(fs.readFileSync(agentConfigPath, 'utf8'));
      assert.strictEqual(onDisk.hooks[PRE_TOOL_USE_EVENT].length, 1);
      assert.strictEqual(onDisk.hooks[PRE_TOOL_USE_EVENT][0].matcher, EXECUTE_BASH_MATCHER);

      const second = applyKiroGuardianHookToFile(agentConfigPath, PRE_TOOL_USE_EVENT, '/abs/adapter.js');
      assert.strictEqual(second.changed, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('applyKiroGuardianHookToFile preserves a hand-written agent config on disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-hooks-preserve-'));
    const agentConfigPath = path.join(tempDir, 'default.json');
    try {
      fs.writeFileSync(agentConfigPath, JSON.stringify({
        name: 'default',
        hooks: { postToolUse: [{ command: 'node .kiro/hooks/log.js' }] },
      }, null, 2));

      applyKiroGuardianHookToFile(agentConfigPath, PRE_TOOL_USE_EVENT, '/abs/adapter.js');

      const onDisk = JSON.parse(fs.readFileSync(agentConfigPath, 'utf8'));
      assert.strictEqual(onDisk.name, 'default');
      assert.deepStrictEqual(onDisk.hooks.postToolUse, [{ command: 'node .kiro/hooks/log.js' }]);
      assert.strictEqual(onDisk.hooks[PRE_TOOL_USE_EVENT].length, 1);
      assert.ok(onDisk.hooks[PRE_TOOL_USE_EVENT][0].command.includes('adapter.js'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('removeKiroHookEntry drops only the EGC entry, keeps third-party hooks and other events', () => {
    const base = {
      hooks: {
        [PRE_TOOL_USE_EVENT]: [
          { matcher: 'fs_write', command: 'node .kiro/hooks/audit-write.js' },
          { matcher: EXECUTE_BASH_MATCHER, command: 'node adapter.js' },
        ],
        postToolUse: [{ command: 'node log.js' }],
      },
    };
    const { config, changed } = removeKiroHookEntry(base, PRE_TOOL_USE_EVENT, 'node adapter.js');
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(config.hooks[PRE_TOOL_USE_EVENT], [{ matcher: 'fs_write', command: 'node .kiro/hooks/audit-write.js' }]);
    assert.deepStrictEqual(config.hooks.postToolUse, [{ command: 'node log.js' }]);
  })) passed++; else failed++;

  if (test('removeKiroHookEntry deletes the event key entirely once empty', () => {
    const base = { hooks: { [PRE_TOOL_USE_EVENT]: [{ matcher: EXECUTE_BASH_MATCHER, command: 'node adapter.js' }] } };
    const { config } = removeKiroHookEntry(base, PRE_TOOL_USE_EVENT, 'node adapter.js');
    assert.strictEqual(PRE_TOOL_USE_EVENT in config.hooks, false);
  })) passed++; else failed++;

  if (test('removeKiroGuardianHookFromFile on a missing file is a no-op', () => {
    const result = removeKiroGuardianHookFromFile('/nonexistent/default.json', PRE_TOOL_USE_EVENT, '/abs/adapter.js');
    assert.strictEqual(result.changed, false);
  })) passed++; else failed++;

  if (test('inspectKiroGuardianHookFile reports ok when present, drifted when absent', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-hooks-inspect-'));
    const agentConfigPath = path.join(tempDir, 'default.json');
    try {
      assert.strictEqual(inspectKiroGuardianHookFile(agentConfigPath, PRE_TOOL_USE_EVENT, '/abs/adapter.js'), 'drifted');
      applyKiroGuardianHookToFile(agentConfigPath, PRE_TOOL_USE_EVENT, '/abs/adapter.js');
      assert.strictEqual(inspectKiroGuardianHookFile(agentConfigPath, PRE_TOOL_USE_EVENT, '/abs/adapter.js'), 'ok');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
