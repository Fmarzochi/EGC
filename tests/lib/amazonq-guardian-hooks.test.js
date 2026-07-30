/**
 * Tests for scripts/lib/amazonq-guardian-hooks.js
 *
 * Amazon Q's custom-agent config is a flat {hooks: {preToolUse:
 * [{matcher, command}]}} shape, structurally identical to Kiro's, but the
 * two hosts share neither the extraEntryFields (execute_bash matcher) nor
 * the isOwnBasename migration logic, so they route through this dedicated
 * module rather than kiro-guardian-hooks.js.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  AGENT_CONFIG_EVENT_KEY,
  EXECUTE_BASH_MATCHER,
  addAmazonQHookEntry,
  applyAmazonQGuardianHookToFile,
  inspectAmazonQGuardianHookFile,
  removeAmazonQGuardianHookFromFile,
  removeAmazonQHookEntry,
  resolveAgentConfigPath,
  resolveGuardianAdapterScriptDestination,
} = require('../../scripts/lib/amazonq-guardian-hooks');

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
  console.log('\n=== Testing amazonq-guardian-hooks ===\n');

  let passed = 0;
  let failed = 0;

  if (test('resolveAgentConfigPath and resolveGuardianAdapterScriptDestination compute paths under targetRoot', () => {
    const targetRoot = '/home/user/project/.amazonq';
    assert.strictEqual(resolveAgentConfigPath(targetRoot), path.join(targetRoot, 'cli-agents', 'egc-guardian.json'));
    assert.strictEqual(
      resolveGuardianAdapterScriptDestination(targetRoot),
      path.join(targetRoot, 'scripts', 'hooks', 'amazonq-guardian-adapter.js')
    );
  })) passed++; else failed++;

  if (test('addAmazonQHookEntry appends a new entry on an empty config, tagged with the execute_bash matcher', () => {
    const { config, changed } = addAmazonQHookEntry({}, 'node adapter.js');
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(config.hooks[AGENT_CONFIG_EVENT_KEY], [
      { matcher: EXECUTE_BASH_MATCHER, command: 'node adapter.js' },
    ]);
  })) passed++; else failed++;

  if (test('addAmazonQHookEntry is idempotent (no duplicate on re-add)', () => {
    const first = addAmazonQHookEntry({}, 'node adapter.js');
    const second = addAmazonQHookEntry(first.config, 'node adapter.js');
    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.config.hooks[AGENT_CONFIG_EVENT_KEY].length, 1);
  })) passed++; else failed++;

  if (test('addAmazonQHookEntry migrates a stale entry (same adapter basename, different path) in place', () => {
    const base = {
      hooks: {
        [AGENT_CONFIG_EVENT_KEY]: [{ matcher: EXECUTE_BASH_MATCHER, command: 'node /old/path/amazonq-guardian-adapter.js' }],
      },
    };
    const { config, changed } = addAmazonQHookEntry(base, 'node /new/path/amazonq-guardian-adapter.js');
    assert.strictEqual(changed, true);
    assert.strictEqual(config.hooks[AGENT_CONFIG_EVENT_KEY].length, 1, 'must migrate in place, not append a duplicate');
    assert.strictEqual(config.hooks[AGENT_CONFIG_EVENT_KEY][0].command, 'node /new/path/amazonq-guardian-adapter.js');
  })) passed++; else failed++;

  if (test('addAmazonQHookEntry preserves a third-party command instead of migrating it', () => {
    const base = { hooks: { [AGENT_CONFIG_EVENT_KEY]: [{ matcher: EXECUTE_BASH_MATCHER, command: 'node .amazonq/hooks/other.js' }] } };
    const { config } = addAmazonQHookEntry(base, 'node adapter.js');
    assert.strictEqual(config.hooks[AGENT_CONFIG_EVENT_KEY].length, 2);
    assert.ok(config.hooks[AGENT_CONFIG_EVENT_KEY].some(e => e.command === 'node .amazonq/hooks/other.js'));
  })) passed++; else failed++;

  if (test('addAmazonQHookEntry preserves unrelated top-level keys', () => {
    const base = { name: 'egc-guardian', hooks: { postToolUse: [{ command: 'node log.js' }] } };
    const { config } = addAmazonQHookEntry(base, 'node adapter.js');
    assert.strictEqual(config.name, 'egc-guardian');
    assert.deepStrictEqual(config.hooks.postToolUse, [{ command: 'node log.js' }]);
  })) passed++; else failed++;

  if (test('applyAmazonQGuardianHookToFile writes a fresh agent config and is idempotent', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazonq-hooks-apply-'));
    const agentConfigPath = path.join(tempDir, 'egc-guardian.json');
    try {
      const first = applyAmazonQGuardianHookToFile(agentConfigPath, '/abs/adapter.js');
      assert.strictEqual(first.changed, true);

      const onDisk = JSON.parse(fs.readFileSync(agentConfigPath, 'utf8'));
      assert.strictEqual(onDisk.hooks[AGENT_CONFIG_EVENT_KEY].length, 1);
      assert.strictEqual(onDisk.hooks[AGENT_CONFIG_EVENT_KEY][0].matcher, EXECUTE_BASH_MATCHER);

      const second = applyAmazonQGuardianHookToFile(agentConfigPath, '/abs/adapter.js');
      assert.strictEqual(second.changed, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('applyAmazonQGuardianHookToFile preserves a hand-written agent config on disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazonq-hooks-preserve-'));
    const agentConfigPath = path.join(tempDir, 'egc-guardian.json');
    try {
      fs.writeFileSync(agentConfigPath, JSON.stringify({
        name: 'egc-guardian',
        hooks: { postToolUse: [{ command: 'node .amazonq/hooks/log.js' }] },
      }, null, 2));

      applyAmazonQGuardianHookToFile(agentConfigPath, '/abs/adapter.js');

      const onDisk = JSON.parse(fs.readFileSync(agentConfigPath, 'utf8'));
      assert.strictEqual(onDisk.name, 'egc-guardian');
      assert.deepStrictEqual(onDisk.hooks.postToolUse, [{ command: 'node .amazonq/hooks/log.js' }]);
      assert.strictEqual(onDisk.hooks[AGENT_CONFIG_EVENT_KEY].length, 1);
      assert.ok(onDisk.hooks[AGENT_CONFIG_EVENT_KEY][0].command.includes('adapter.js'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('removeAmazonQHookEntry drops only the EGC entry, keeps third-party hooks and other events', () => {
    const base = {
      hooks: {
        [AGENT_CONFIG_EVENT_KEY]: [
          { matcher: EXECUTE_BASH_MATCHER, command: 'node .amazonq/hooks/other.js' },
          { matcher: EXECUTE_BASH_MATCHER, command: 'node adapter.js' },
        ],
        postToolUse: [{ command: 'node log.js' }],
      },
    };
    const { config, changed } = removeAmazonQHookEntry(base, 'node adapter.js');
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(config.hooks[AGENT_CONFIG_EVENT_KEY], [
      { matcher: EXECUTE_BASH_MATCHER, command: 'node .amazonq/hooks/other.js' },
    ]);
    assert.deepStrictEqual(config.hooks.postToolUse, [{ command: 'node log.js' }]);
  })) passed++; else failed++;

  if (test('removeAmazonQHookEntry deletes the event key entirely once empty', () => {
    const base = { hooks: { [AGENT_CONFIG_EVENT_KEY]: [{ matcher: EXECUTE_BASH_MATCHER, command: 'node adapter.js' }] } };
    const { config } = removeAmazonQHookEntry(base, 'node adapter.js');
    assert.strictEqual(AGENT_CONFIG_EVENT_KEY in config.hooks, false);
  })) passed++; else failed++;

  if (test('removeAmazonQGuardianHookFromFile on a missing file is a no-op', () => {
    const result = removeAmazonQGuardianHookFromFile('/nonexistent/egc-guardian.json', '/abs/adapter.js');
    assert.strictEqual(result.changed, false);
  })) passed++; else failed++;

  if (test('removeAmazonQGuardianHookFromFile removes the entry from an existing file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazonq-hooks-remove-'));
    const agentConfigPath = path.join(tempDir, 'egc-guardian.json');
    try {
      applyAmazonQGuardianHookToFile(agentConfigPath, '/abs/adapter.js');
      const result = removeAmazonQGuardianHookFromFile(agentConfigPath, '/abs/adapter.js');
      assert.strictEqual(result.changed, true);
      const onDisk = JSON.parse(fs.readFileSync(agentConfigPath, 'utf8'));
      assert.strictEqual(AGENT_CONFIG_EVENT_KEY in onDisk.hooks, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('inspectAmazonQGuardianHookFile reports ok when present, drifted when absent', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazonq-hooks-inspect-'));
    const agentConfigPath = path.join(tempDir, 'egc-guardian.json');
    try {
      assert.strictEqual(inspectAmazonQGuardianHookFile(agentConfigPath, '/abs/adapter.js'), 'drifted');
      applyAmazonQGuardianHookToFile(agentConfigPath, '/abs/adapter.js');
      assert.strictEqual(inspectAmazonQGuardianHookFile(agentConfigPath, '/abs/adapter.js'), 'ok');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('inspectAmazonQGuardianHookFile reports drifted on invalid JSON instead of throwing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazonq-hooks-inspect-invalid-'));
    const agentConfigPath = path.join(tempDir, 'egc-guardian.json');
    try {
      fs.writeFileSync(agentConfigPath, '{not valid json');
      assert.strictEqual(inspectAmazonQGuardianHookFile(agentConfigPath, '/abs/adapter.js'), 'drifted');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
