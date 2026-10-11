/**
 * Tests for scripts/lib/kiro-v3-guardian-hooks.js
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  GUARDIAN_HOOK_FILE_NAME,
  applyKiroV3GuardianHookToFile,
  buildGuardianHookDocument,
  inspectKiroV3GuardianHookFile,
  removeKiroV3GuardianHookFromFile,
  resolveGuardianHookFilePath,
} = require('../../scripts/lib/kiro-v3-guardian-hooks');

const ADAPTER = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'kiro-guardian-adapter.js');
const FAKE_GUARDIAN_CLI = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
    return false;
  }
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-kiro-v3-guardian-'));
}

function runRegisteredCommand(document, payload) {
  return spawnSync(document.hooks[0].action.command, {
    shell: true,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, EGC_DISABLED_HOOKS: '', EGC_GUARDIAN_CLI: FAKE_GUARDIAN_CLI },
  });
}

function runTests() {
  console.log('\n=== Testing kiro-v3-guardian-hooks.js ===\n');
  let passed = 0;
  let failed = 0;
  const tally = ok => { if (ok) passed++; else failed++; };

  tally(test('the document is a Kiro CLI 3.0 standalone hook file: v1, PreToolUse on the shell matcher, a command action (https://kiro.dev/docs/cli/v3/hooks-migration/, read 2026-10-10)', () => {
    const document = buildGuardianHookDocument('/abs/kiro-guardian-adapter.js');
    assert.strictEqual(document.version, 'v1');
    assert.strictEqual(document.hooks.length, 1);
    const [hook] = document.hooks;
    assert.strictEqual(hook.trigger, 'PreToolUse');
    assert.strictEqual(hook.matcher, 'shell', 'the shell group covers execute_bash');
    assert.strictEqual(hook.action.type, 'command');
    assert.ok(hook.action.command.endsWith('"/abs/kiro-guardian-adapter.js"'));
    assert.strictEqual(hook.enabled, true);
    assert.strictEqual(resolveGuardianHookFilePath('/root/.kiro'), path.join('/root/.kiro', 'hooks', GUARDIAN_HOOK_FILE_NAME));
  }));

  tally(test('apply writes the file once, inspect reports drift on a hand edit, remove deletes the whole file', () => {
    const root = makeRoot();
    const hookFile = resolveGuardianHookFilePath(root);
    try {
      assert.strictEqual(inspectKiroV3GuardianHookFile(hookFile, '/abs/adapter.js'), 'drifted');
      assert.deepStrictEqual(applyKiroV3GuardianHookToFile(hookFile, '/abs/adapter.js'), { changed: true });
      assert.deepStrictEqual(applyKiroV3GuardianHookToFile(hookFile, '/abs/adapter.js'), { changed: false });
      assert.strictEqual(inspectKiroV3GuardianHookFile(hookFile, '/abs/adapter.js'), 'ok');

      const edited = JSON.parse(fs.readFileSync(hookFile, 'utf8'));
      edited.hooks[0].enabled = false;
      fs.writeFileSync(hookFile, JSON.stringify(edited));
      assert.strictEqual(inspectKiroV3GuardianHookFile(hookFile, '/abs/adapter.js'), 'drifted', 'a disabled Guardian is drift');

      const reordered = buildGuardianHookDocument('/abs/adapter.js');
      fs.writeFileSync(hookFile, JSON.stringify({ hooks: reordered.hooks.map(hook => Object.fromEntries(Object.entries(hook).reverse())), version: reordered.version }));
      assert.strictEqual(inspectKiroV3GuardianHookFile(hookFile, '/abs/adapter.js'), 'ok', 'reordered keys and other whitespace are the same document');
      assert.deepStrictEqual(applyKiroV3GuardianHookToFile(hookFile, '/abs/adapter.js'), { changed: false }, 'apply is a no-op exactly when inspect says ok');

      assert.deepStrictEqual(removeKiroV3GuardianHookFromFile(hookFile), { changed: true });
      assert.ok(!fs.existsSync(hookFile));
      assert.deepStrictEqual(removeKiroV3GuardianHookFromFile(hookFile), { changed: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }));

  tally(test('a write that fails midway leaves the previous document intact and no temporary file', () => {
    const root = makeRoot();
    const hookFile = resolveGuardianHookFilePath(root);
    const realWriteFileSync = fs.writeFileSync;
    try {
      applyKiroV3GuardianHookToFile(hookFile, '/abs/old-adapter.js');
      const before = fs.readFileSync(hookFile, 'utf8');
      fs.writeFileSync = (target, data, ...rest) => {
        realWriteFileSync(target, String(data).slice(0, 3), ...rest);
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      };
      assert.throws(() => applyKiroV3GuardianHookToFile(hookFile, '/abs/new-adapter.js'), error => error.code === 'ENOSPC');
      fs.writeFileSync = realWriteFileSync;
      assert.strictEqual(fs.readFileSync(hookFile, 'utf8'), before, 'Kiro still reads the whole previous document');
      assert.deepStrictEqual(fs.readdirSync(path.dirname(hookFile)), [GUARDIAN_HOOK_FILE_NAME], 'no temporary sibling is left');
    } finally {
      fs.writeFileSync = realWriteFileSync;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }));

  tally(test('the registered command blocks a destructive execute_bash call with exit code 2, the code Kiro CLI 3.0 rejects a PreToolUse event on, and lets a safe one through', () => {
    const document = buildGuardianHookDocument(ADAPTER);
    const blocked = runRegisteredCommand(document, { hook_event_name: 'PreToolUse', tool_name: 'execute_bash', tool_input: { command: 'rm -rf /' } });
    assert.strictEqual(blocked.status, 2, `expected exit 2, got ${blocked.status}: ${blocked.stderr}`);
    assert.ok(blocked.stderr.trim().length > 0, 'the reason goes to stderr');

    const allowed = runRegisteredCommand(document, { hook_event_name: 'PreToolUse', tool_name: 'execute_bash', tool_input: { command: 'ls' } });
    assert.strictEqual(allowed.status, 0, `expected exit 0, got ${allowed.status}: ${allowed.stderr}`);
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
