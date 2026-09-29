/**
 * Tests for scripts/lib/antigravity-guardian-hooks.js and its wiring in the
 * egc and antigravity install targets: EGC owns one named hook,
 * egc-guardian, in Antigravity's hooks.json and never touches the others.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ANTIGRAVITY_GUARDIAN_HOOK_TAG,
  GUARDED_TOOLS_MATCHER,
  HOOK_NAME,
  applyAntigravityGuardianHookToFile,
  guardianHookDefinition,
  inspectAntigravityGuardianHookFile,
  removeAntigravityGuardianHookFromFile,
} = require('../../scripts/lib/antigravity-guardian-hooks');
const { applyManagedHookOperation } = require('../../scripts/lib/claude-settings-hooks');
const { planInstallTargetScaffold } = require('../../scripts/lib/install-targets/registry');

const repoRoot = path.join(__dirname, '..', '..');
const adapter = '/home/person/.gemini/scripts/hooks/antigravity-guardian-adapter.js';

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

function withHooksFile(initial, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-hooks-test-'));
  const file = path.join(dir, 'config', 'hooks.json');
  if (initial !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial));
  }
  try {
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function runTests() {
  console.log('\n=== Testing antigravity-guardian-hooks ===\n');
  const results = [];

  results.push(test('the hook matches the Antigravity shell and write tools and runs the adapter', () => {
    const [group] = guardianHookDefinition(adapter).PreToolUse;
    assert.strictEqual(group.matcher, GUARDED_TOOLS_MATCHER);
    for (const tool of ['run_command', 'write_to_file', 'replace_file_content', 'multi_replace_file_content']) {
      assert.ok(new RegExp(`^(${group.matcher})$`).test(tool), `${tool} is guarded`);
    }
    assert.ok(!new RegExp(`^(${group.matcher})$`).test('view_file'), 'reads are not guarded');
    assert.strictEqual(group.hooks.length, 1);
    assert.ok(group.hooks[0].command.endsWith(`"${adapter}"`));
    assert.strictEqual(group.hooks[0].type, 'command');
  }));

  results.push(test('apply creates the file with the named hook when it does not exist', () => {
    withHooksFile(undefined, file => {
      assert.deepStrictEqual(applyAntigravityGuardianHookToFile(file, adapter), { changed: true });
      assert.deepStrictEqual(read(file), { [HOOK_NAME]: guardianHookDefinition(adapter) });
      assert.strictEqual(inspectAntigravityGuardianHookFile(file, adapter), 'ok');
    });
  }));

  results.push(test('apply keeps every other named hook, including a Claude-format hooks key', () => {
    const userHooks = { 'user-lint': { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] }, hooks: { PreToolUse: [] } };
    withHooksFile(userHooks, file => {
      applyAntigravityGuardianHookToFile(file, adapter);
      const written = read(file);
      assert.deepStrictEqual(written['user-lint'], userHooks['user-lint']);
      assert.deepStrictEqual(written.hooks, userHooks.hooks);
      assert.deepStrictEqual(written[HOOK_NAME], guardianHookDefinition(adapter));
    });
  }));

  results.push(test('apply is a no-op when the hook is already current, and repairs it when it drifted', () => {
    withHooksFile(undefined, file => {
      applyAntigravityGuardianHookToFile(file, adapter);
      assert.deepStrictEqual(applyAntigravityGuardianHookToFile(file, adapter), { changed: false });
      const drifted = read(file);
      drifted[HOOK_NAME].PreToolUse[0].matcher = 'run_command';
      fs.writeFileSync(file, JSON.stringify(drifted));
      assert.strictEqual(inspectAntigravityGuardianHookFile(file, adapter), 'drifted');
      assert.deepStrictEqual(applyAntigravityGuardianHookToFile(file, adapter), { changed: true });
      assert.strictEqual(inspectAntigravityGuardianHookFile(file, adapter), 'ok');
    });
  }));

  results.push(test('remove drops only the egc-guardian hook and is a no-op when it is absent', () => {
    withHooksFile({ 'user-lint': { PostToolUse: [] } }, file => {
      assert.deepStrictEqual(removeAntigravityGuardianHookFromFile(file), { changed: false });
      applyAntigravityGuardianHookToFile(file, adapter);
      assert.deepStrictEqual(removeAntigravityGuardianHookFromFile(file), { changed: true });
      assert.deepStrictEqual(read(file), { 'user-lint': { PostToolUse: [] } });
    });
    withHooksFile(undefined, file => {
      assert.deepStrictEqual(removeAntigravityGuardianHookFromFile(file), { changed: false });
    });
  }));

  results.push(test('a file that is not a JSON object of named hooks is refused, and inspects as drifted', () => {
    withHooksFile('{ not json', file => {
      assert.throws(() => applyAntigravityGuardianHookToFile(file, adapter), /Failed to parse the Antigravity hooks file/);
      assert.strictEqual(inspectAntigravityGuardianHookFile(file, adapter), 'drifted');
    });
    withHooksFile([], file => {
      assert.throws(() => applyAntigravityGuardianHookToFile(file, adapter), /expected a JSON object of named hooks/);
    });
  }));

  results.push(test('the managed-hook dispatch routes the Antigravity operation to this module', () => {
    withHooksFile(undefined, file => {
      applyManagedHookOperation({ hookEvent: ANTIGRAVITY_GUARDIAN_HOOK_TAG, destinationPath: file, hookScriptPath: adapter });
      assert.strictEqual(inspectAntigravityGuardianHookFile(file, adapter), 'ok');
    });
  }));

  results.push(test('the egc target registers the hook in the shared ~/.gemini/config/hooks.json and copies what it runs', () => {
    const homeDir = '/Users/example';
    const plan = planInstallTargetScaffold({ target: 'egc', repoRoot, homeDir, modules: [] });
    const hook = plan.operations.find(op => op.hookEvent === ANTIGRAVITY_GUARDIAN_HOOK_TAG);
    assert.ok(hook, 'the egc target plans the Antigravity Guardian hook');
    assert.strictEqual(hook.destinationPath, path.join(homeDir, '.gemini', 'config', 'hooks.json'));
    assert.strictEqual(hook.hookScriptPath, path.join(homeDir, '.gemini', 'scripts', 'hooks', 'antigravity-guardian-adapter.js'));
    const copied = new Set(plan.operations.filter(op => op.kind !== hook.kind).map(op => op.destinationPath));
    for (const script of ['scripts/hooks/antigravity-guardian-adapter.js', 'scripts/hooks/pre-bash-guardian-validate.js', 'scripts/hooks/pre-write-guardian-validate.js', 'scripts/lib/adapter-stdin-json.js', 'scripts/lib/guardian-bin.js']) {
      assert.ok(copied.has(path.join(homeDir, '.gemini', ...script.split('/'))), `${script} is copied`);
    }
  }));

  results.push(test('the antigravity target registers the hook in the project .agents/hooks.json', () => {
    const projectRoot = '/workspace/app';
    const plan = planInstallTargetScaffold({ target: 'antigravity', repoRoot, projectRoot, modules: [] });
    const hook = plan.operations.find(op => op.hookEvent === ANTIGRAVITY_GUARDIAN_HOOK_TAG);
    assert.ok(hook, 'the antigravity target plans the Antigravity Guardian hook');
    assert.strictEqual(hook.destinationPath, path.join(projectRoot, '.agents', 'hooks.json'));
  }));

  results.push(test('neither Antigravity target plans the same copy destination twice', () => {
    for (const input of [{ target: 'egc', homeDir: '/Users/example' }, { target: 'antigravity', projectRoot: '/workspace/app' }]) {
      const plan = planInstallTargetScaffold({ repoRoot, modules: [], ...input });
      const copies = plan.operations.filter(op => !op.hookEvent).map(op => op.destinationPath);
      assert.strictEqual(new Set(copies).size, copies.length, `${input.target}: duplicated copy destinations`);
    }
  }));

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  return failed === 0;
}

process.exit(runTests() ? 0 : 1);
