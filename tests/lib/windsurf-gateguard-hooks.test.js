/**
 * Tests for scripts/lib/windsurf-gateguard-hooks.js
 *
 * Windsurf's hooks.json schema is a flat {hooks: {<event>: [{command}]}} map
 * (no matcher/group wrapper, no "type": "command" field), unlike Claude
 * Code's settings.json, so it needs its own merge logic. These tests exercise
 * that merge logic directly (additive, idempotent, preserves unrelated keys
 * and third-party hooks) plus the full apply.js dispatch wiring.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PRE_RUN_COMMAND_EVENT,
  PRE_WRITE_CODE_EVENT,
  addWindsurfHookEntry,
  applyWindsurfGateGuardHookToFile,
  resolveAdapterScriptDestination,
  resolveHooksJsonPath,
} = require('../../scripts/lib/windsurf-gateguard-hooks');

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
  console.log('\n=== Testing windsurf-gateguard-hooks ===\n');

  let passed = 0;
  let failed = 0;

  if (test('resolveHooksJsonPath and resolveAdapterScriptDestination compute paths under targetRoot', () => {
    const targetRoot = '/home/user/.codeium/windsurf';
    assert.strictEqual(resolveHooksJsonPath(targetRoot), path.join(targetRoot, 'hooks.json'));
    assert.strictEqual(
      resolveAdapterScriptDestination(targetRoot),
      path.join(targetRoot, 'scripts', 'hooks', 'windsurf-gateguard-adapter.js')
    );
  })) passed++; else failed++;

  if (test('addWindsurfHookEntry appends a new event array on an empty config', () => {
    const { config, changed } = addWindsurfHookEntry({}, PRE_WRITE_CODE_EVENT, 'node adapter.js');
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(config.hooks[PRE_WRITE_CODE_EVENT], [{ command: 'node adapter.js' }]);
  })) passed++; else failed++;

  if (test('addWindsurfHookEntry is idempotent (no duplicate on re-add)', () => {
    const first = addWindsurfHookEntry({}, PRE_WRITE_CODE_EVENT, 'node adapter.js');
    const second = addWindsurfHookEntry(first.config, PRE_WRITE_CODE_EVENT, 'node adapter.js');
    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.config.hooks[PRE_WRITE_CODE_EVENT].length, 1);
  })) passed++; else failed++;

  if (test('addWindsurfHookEntry preserves third-party hooks in the same event array', () => {
    const base = { hooks: { [PRE_WRITE_CODE_EVENT]: [{ command: 'bash /some/other-hook.sh' }] } };
    const { config } = addWindsurfHookEntry(base, PRE_WRITE_CODE_EVENT, 'node adapter.js');
    assert.strictEqual(config.hooks[PRE_WRITE_CODE_EVENT].length, 2);
    assert.ok(config.hooks[PRE_WRITE_CODE_EVENT].some(entry => entry.command === 'bash /some/other-hook.sh'));
    assert.ok(config.hooks[PRE_WRITE_CODE_EVENT].some(entry => entry.command === 'node adapter.js'));
  })) passed++; else failed++;

  if (test('addWindsurfHookEntry preserves unrelated events and top-level keys', () => {
    const base = { $schema: 'https://example.com', hooks: { pre_read_code: [{ command: 'echo read' }] } };
    const { config } = addWindsurfHookEntry(base, PRE_RUN_COMMAND_EVENT, 'node adapter.js');
    assert.strictEqual(config.$schema, 'https://example.com');
    assert.deepStrictEqual(config.hooks.pre_read_code, [{ command: 'echo read' }]);
    assert.deepStrictEqual(config.hooks[PRE_RUN_COMMAND_EVENT], [{ command: 'node adapter.js' }]);
  })) passed++; else failed++;

  if (test('addWindsurfHookEntry migrates a stale entry (same script, different path) in place instead of duplicating', () => {
    const base = {
      hooks: {
        [PRE_WRITE_CODE_EVENT]: [{ command: 'node /old/path/windsurf-gateguard-adapter.js' }],
      },
    };
    const { config, changed } = addWindsurfHookEntry(base, PRE_WRITE_CODE_EVENT, 'node /new/path/windsurf-gateguard-adapter.js');
    assert.strictEqual(changed, true);
    assert.strictEqual(config.hooks[PRE_WRITE_CODE_EVENT].length, 1);
    assert.strictEqual(config.hooks[PRE_WRITE_CODE_EVENT][0].command, 'node /new/path/windsurf-gateguard-adapter.js');
  })) passed++; else failed++;

  if (test('applyWindsurfGateGuardHookToFile writes both events to a fresh file and is idempotent', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windsurf-hooks-apply-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      const first = applyWindsurfGateGuardHookToFile(hooksJsonPath, PRE_WRITE_CODE_EVENT, '/abs/adapter.js');
      assert.strictEqual(first.changed, true);
      applyWindsurfGateGuardHookToFile(hooksJsonPath, PRE_RUN_COMMAND_EVENT, '/abs/adapter.js');

      const onDisk = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.deepStrictEqual(Object.keys(onDisk.hooks).sort(), [PRE_RUN_COMMAND_EVENT, PRE_WRITE_CODE_EVENT].sort());

      const second = applyWindsurfGateGuardHookToFile(hooksJsonPath, PRE_WRITE_CODE_EVENT, '/abs/adapter.js');
      assert.strictEqual(second.changed, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('applyWindsurfGateGuardHookToFile preserves a hand-written hooks.json on disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windsurf-hooks-preserve-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      fs.writeFileSync(hooksJsonPath, JSON.stringify({
        hooks: { pre_run_command: [{ command: 'bash /user/custom.sh', show_output: true }] },
      }, null, 2));

      applyWindsurfGateGuardHookToFile(hooksJsonPath, PRE_WRITE_CODE_EVENT, '/abs/adapter.js');

      const onDisk = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.deepStrictEqual(onDisk.hooks.pre_run_command, [{ command: 'bash /user/custom.sh', show_output: true }]);
      assert.strictEqual(onDisk.hooks[PRE_WRITE_CODE_EVENT].length, 1);
      assert.ok(onDisk.hooks[PRE_WRITE_CODE_EVENT][0].command.includes('adapter.js'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
