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
  inspectWindsurfGateGuardHookFile,
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

  if (test('addWindsurfHookEntry migrates a stale GUARDIAN entry (same script, different path) in place instead of duplicating', () => {
    const base = {
      hooks: {
        [PRE_RUN_COMMAND_EVENT]: [{ command: 'node /old/path/windsurf-guardian-adapter.js' }],
      },
    };
    const { config, changed } = addWindsurfHookEntry(base, PRE_RUN_COMMAND_EVENT, 'node /new/path/windsurf-guardian-adapter.js');
    assert.strictEqual(changed, true);
    assert.strictEqual(config.hooks[PRE_RUN_COMMAND_EVENT].length, 1, 'must migrate in place, not append a duplicate');
    assert.strictEqual(config.hooks[PRE_RUN_COMMAND_EVENT][0].command, 'node /new/path/windsurf-guardian-adapter.js');
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

  // Windsurf registers two adapter scripts on pre_run_command (GateGuard
  // first, Guardian after). The stale-entry migration used to treat ANY
  // host-owned entry as the one being re-registered, so the Guardian merge
  // replaced the GateGuard entry, every repair swapped them back, and doctor
  // reported hooks.json as drifted on a healthy install.
  if (test('addWindsurfHookEntry keeps the GateGuard entry when the Guardian joins the same event', () => {
    const gateguard = 'node /abs/scripts/hooks/windsurf-gateguard-adapter.js';
    const guardian = 'node /abs/scripts/hooks/windsurf-guardian-adapter.js';
    const first = addWindsurfHookEntry({}, PRE_RUN_COMMAND_EVENT, gateguard);
    const second = addWindsurfHookEntry(first.config, PRE_RUN_COMMAND_EVENT, guardian);
    assert.strictEqual(second.changed, true);
    assert.deepStrictEqual(
      second.config.hooks[PRE_RUN_COMMAND_EVENT].map(entry => entry.command),
      [gateguard, guardian],
      'both adapters must coexist on pre_run_command, in registration order'
    );
    const third = addWindsurfHookEntry(second.config, PRE_RUN_COMMAND_EVENT, gateguard);
    assert.strictEqual(third.changed, false, 're-registering GateGuard with the Guardian present must be a no-op, not a swap');
  })) passed++; else failed++;

  if (test('addWindsurfHookEntry migrates only the stale GateGuard entry when the Guardian shares the event', () => {
    const guardian = 'node /abs/scripts/hooks/windsurf-guardian-adapter.js';
    const base = {
      hooks: {
        [PRE_RUN_COMMAND_EVENT]: [
          { command: 'node /old/path/windsurf-gateguard-adapter.js' },
          { command: guardian },
        ],
      },
    };
    const { config, changed } = addWindsurfHookEntry(base, PRE_RUN_COMMAND_EVENT, 'node /new/path/windsurf-gateguard-adapter.js');
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(
      config.hooks[PRE_RUN_COMMAND_EVENT].map(entry => entry.command),
      ['node /new/path/windsurf-gateguard-adapter.js', guardian]
    );
  })) passed++; else failed++;

  if (test('addWindsurfHookEntry recognises a stale entry written with Windows paths and quoting', () => {
    const base = {
      hooks: {
        [PRE_RUN_COMMAND_EVENT]: [
          { command: '"C:\\node\\node.exe" "C:\\old\\windsurf-gateguard-adapter.js"' },
          { command: '"C:\\node\\node.exe" "C:\\old\\windsurf-guardian-adapter.js"' },
        ],
      },
    };
    const next = '"C:\\node\\node.exe" "C:\\new\\windsurf-guardian-adapter.js"';
    const { config, changed } = addWindsurfHookEntry(base, PRE_RUN_COMMAND_EVENT, next);
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(
      config.hooks[PRE_RUN_COMMAND_EVENT].map(entry => entry.command),
      ['"C:\\node\\node.exe" "C:\\old\\windsurf-gateguard-adapter.js"', next]
    );
  })) passed++; else failed++;

  if (test('applyWindsurfGateGuardHookToFile leaves both adapters inspectable as ok on pre_run_command', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windsurf-hooks-coexist-'));
    const hooksJsonPath = path.join(tempDir, 'hooks.json');
    try {
      applyWindsurfGateGuardHookToFile(hooksJsonPath, PRE_RUN_COMMAND_EVENT, '/abs/windsurf-gateguard-adapter.js');
      applyWindsurfGateGuardHookToFile(hooksJsonPath, PRE_RUN_COMMAND_EVENT, '/abs/windsurf-guardian-adapter.js');
      assert.strictEqual(inspectWindsurfGateGuardHookFile(hooksJsonPath, PRE_RUN_COMMAND_EVENT, '/abs/windsurf-gateguard-adapter.js'), 'ok');
      assert.strictEqual(inspectWindsurfGateGuardHookFile(hooksJsonPath, PRE_RUN_COMMAND_EVENT, '/abs/windsurf-guardian-adapter.js'), 'ok');
      const onDisk = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      assert.strictEqual(onDisk.hooks[PRE_RUN_COMMAND_EVENT].length, 2);
      const again = applyWindsurfGateGuardHookToFile(hooksJsonPath, PRE_RUN_COMMAND_EVENT, '/abs/windsurf-gateguard-adapter.js');
      assert.strictEqual(again.changed, false, 'a repair pass over a healthy file must not rewrite it');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
