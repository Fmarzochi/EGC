/**
 * Tests for scripts/lib/antigravity-mesh-hooks.js and its wiring in the egc
 * and antigravity install targets: the session-mesh notice is the
 * egc-mesh-notice named hook on PreInvocation in Antigravity's hooks.json,
 * since Antigravity has no UserPromptSubmit, and no Token Crusher hook is
 * planned for Antigravity, whose hooks answer a decision and never a
 * rewritten command.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ANTIGRAVITY_MESH_HOOK_TAG,
  HOOK_NAME,
  applyAntigravityMeshHookToFile,
  inspectAntigravityMeshHookFile,
  meshNoticeHookDefinition,
  removeAntigravityMeshHookFromFile,
} = require('../../scripts/lib/antigravity-mesh-hooks');
const { applyManagedHookOperation } = require('../../scripts/lib/claude-settings-hooks');
const { planInstallTargetScaffold } = require('../../scripts/lib/install-targets/registry');

const repoRoot = path.join(__dirname, '..', '..');
const adapter = '/home/person/.gemini/scripts/hooks/antigravity-mesh-notice-adapter.js';
const CRUSHER_SOURCES = [
  'scripts/hooks/crusher-hook.js',
  'scripts/hooks/pre-bash-crusher-rewrite.js',
  'scripts/lib/crusher/engine.js',
];

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-mesh-test-'));
  const file = path.join(dir, 'config', 'hooks.json');
  if (initial !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(initial));
  }
  try {
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const TARGETS = [
  { target: 'egc', input: { homeDir: '/Users/example' }, root: path.join('/Users/example', '.gemini'), hooksFilePath: path.join('/Users/example', '.gemini', 'config', 'hooks.json') },
  { target: 'antigravity', input: { projectRoot: '/workspace/app' }, root: path.join('/workspace/app', '.agents'), hooksFilePath: path.join('/workspace/app', '.agents', 'hooks.json') },
];

function runTests() {
  console.log('\n=== Testing antigravity-mesh-hooks ===\n');
  const results = [];

  results.push(test('the hook is one PreInvocation group with no matcher, running the mesh adapter', () => {
    const definition = meshNoticeHookDefinition(adapter);
    assert.deepStrictEqual(Object.keys(definition), ['PreInvocation']);
    const [group] = definition.PreInvocation;
    assert.ok(!Object.hasOwn(group, 'matcher'), 'Antigravity ignores a matcher on this event');
    assert.strictEqual(group.hooks.length, 1);
    assert.ok(group.hooks[0].command.endsWith(`"${adapter}"`));
    assert.strictEqual(group.hooks[0].type, 'command');
    assert.strictEqual(group.hooks[0].timeout, 10);
  }));

  results.push(test('apply creates the named hook, keeps the other names, is idempotent and repairs drift; remove drops only it', () => {
    withHooksFile({ 'user-lint': { PostToolUse: [] } }, file => {
      assert.deepStrictEqual(applyAntigravityMeshHookToFile(file, adapter), { changed: true });
      assert.deepStrictEqual(read(file), { 'user-lint': { PostToolUse: [] }, [HOOK_NAME]: meshNoticeHookDefinition(adapter) });
      assert.deepStrictEqual(applyAntigravityMeshHookToFile(file, adapter), { changed: false });
      assert.strictEqual(inspectAntigravityMeshHookFile(file, adapter), 'ok');
      const drifted = read(file);
      drifted[HOOK_NAME].PreInvocation[0].hooks[0].timeout = 99;
      fs.writeFileSync(file, JSON.stringify(drifted));
      assert.strictEqual(inspectAntigravityMeshHookFile(file, adapter), 'drifted');
      assert.deepStrictEqual(applyAntigravityMeshHookToFile(file, adapter), { changed: true });
      assert.deepStrictEqual(removeAntigravityMeshHookFromFile(file), { changed: true });
      assert.deepStrictEqual(read(file), { 'user-lint': { PostToolUse: [] } });
      assert.deepStrictEqual(removeAntigravityMeshHookFromFile(file), { changed: false });
    });
  }));

  results.push(test('the managed-hook dispatch routes the mesh tag to this module', () => {
    withHooksFile(undefined, file => {
      applyManagedHookOperation({ hookEvent: ANTIGRAVITY_MESH_HOOK_TAG, destinationPath: file, hookScriptPath: adapter });
      assert.strictEqual(inspectAntigravityMeshHookFile(file, adapter), 'ok');
    });
  }));

  results.push(test('both Antigravity targets plan the notice as the named hook, with the shared script and the adapter copied, and no UserPromptSubmit entry', () => {
    for (const { target, input, root, hooksFilePath } of TARGETS) {
      const plan = planInstallTargetScaffold({ target, repoRoot, modules: [], ...input });
      const hook = plan.operations.find(op => op.hookEvent === ANTIGRAVITY_MESH_HOOK_TAG);
      assert.ok(hook, `${target}: the mesh named hook is planned`);
      assert.strictEqual(hook.destinationPath, hooksFilePath, `${target}: in the file Antigravity reads`);
      assert.strictEqual(hook.hookScriptPath, path.join(root, 'scripts', 'hooks', 'antigravity-mesh-notice-adapter.js'));
      const copied = new Set(plan.operations.filter(op => op.kind !== hook.kind).map(op => op.destinationPath));
      for (const script of ['antigravity-mesh-notice-adapter.js', 'mesh-events-inject.js']) {
        assert.ok(copied.has(path.join(root, 'scripts', 'hooks', script)), `${target}: ${script} is copied`);
      }
      assert.ok(!plan.operations.some(op => op.hookEvent === 'UserPromptSubmit'), `${target}: no UserPromptSubmit entry, Antigravity has no such event`);
    }
  }));

  results.push(test('neither Antigravity target plans a Token Crusher hook or copies the crusher scripts on its own', () => {
    for (const { target, input, root } of TARGETS) {
      const plan = planInstallTargetScaffold({ target, repoRoot, modules: [], ...input });
      const crusherHook = path.join(root, 'scripts', 'hooks', 'crusher-hook.js');
      assert.ok(!plan.operations.some(op => op.hookScriptPath === crusherHook), `${target}: no hook entry runs the crusher`);
      for (const source of CRUSHER_SOURCES) {
        assert.ok(!plan.operations.some(op => op.destinationPath === path.join(root, ...source.split('/'))), `${target}: ${source} is not copied for a hook that does not exist`);
      }
    }
  }));

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  return failed === 0;
}

process.exit(runTests() ? 0 : 1);
