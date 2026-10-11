/**
 * Tests for scripts/lib/antigravity-gateguard-hooks.js and its wiring in the
 * egc and antigravity install targets: the GateGuard fact-forcing gate is
 * the egc-gateguard named hook in Antigravity's hooks.json, beside
 * egc-guardian, and the Claude-format entries that never fired are gone.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ANTIGRAVITY_GATEGUARD_HOOK_TAG,
  HOOK_NAME,
  applyAntigravityGateGuardHookToFile,
  gateguardHookDefinition,
  inspectAntigravityGateGuardHookFile,
  removeAntigravityGateGuardHookFromFile,
} = require('../../scripts/lib/antigravity-gateguard-hooks');
const {
  ANTIGRAVITY_GUARDIAN_HOOK_TAG,
  GUARDED_TOOLS_MATCHER,
  HOOK_NAME: GUARDIAN_HOOK_NAME,
  applyAntigravityGuardianHookToFile,
} = require('../../scripts/lib/antigravity-guardian-hooks');
const { applyManagedHookOperation } = require('../../scripts/lib/claude-settings-hooks');
const { planInstallTargetScaffold } = require('../../scripts/lib/install-targets/registry');

const repoRoot = path.join(__dirname, '..', '..');
const adapter = '/home/person/.gemini/scripts/hooks/antigravity-gateguard-adapter.js';
const guardianAdapter = '/home/person/.gemini/scripts/hooks/antigravity-guardian-adapter.js';
const CLAUDE_FORMAT_EVENTS = new Set(['PreToolUse', 'UserPromptSubmit']);
// What the gate requires at load time, beside the adapter that runs it.
const GATE_SOURCES = [
  'scripts/hooks/antigravity-gateguard-adapter.js',
  'scripts/hooks/gateguard-fact-force.js',
  'scripts/lib/utils.js',
  'scripts/lib/shell-split.js',
  'scripts/lib/wrapper-options.js',
  'scripts/lib/adapter-stdin-json.js',
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-gateguard-test-'));
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

function planFor(input) {
  return planInstallTargetScaffold({ repoRoot, modules: [], ...input });
}

function claudeFormatEntries(plan, hooksFilePath) {
  return plan.operations.filter(op => (
    op.kind === 'merge-claude-settings-hooks' && op.destinationPath === hooksFilePath && CLAUDE_FORMAT_EVENTS.has(op.hookEvent)
  ));
}

function runTests() {
  console.log('\n=== Testing antigravity-gateguard-hooks ===\n');
  const results = [];

  results.push(test('the hook matches the same shell and write tools as the Guardian and runs the GateGuard adapter', () => {
    const [group] = gateguardHookDefinition(adapter).PreToolUse;
    assert.strictEqual(group.matcher, GUARDED_TOOLS_MATCHER);
    assert.strictEqual(group.hooks.length, 1);
    assert.ok(group.hooks[0].command.endsWith(`"${adapter}"`));
    assert.strictEqual(group.hooks[0].type, 'command');
    assert.strictEqual(group.hooks[0].timeout, 30);
  }));

  results.push(test('apply writes the named hook beside the Guardian\'s and leaves every other name alone', () => {
    const userHooks = { 'user-lint': { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] } };
    withHooksFile(userHooks, file => {
      applyAntigravityGuardianHookToFile(file, guardianAdapter);
      assert.deepStrictEqual(applyAntigravityGateGuardHookToFile(file, adapter), { changed: true });
      const written = read(file);
      assert.deepStrictEqual(Object.keys(written).sort(), [HOOK_NAME, GUARDIAN_HOOK_NAME, 'user-lint'].sort());
      assert.deepStrictEqual(written['user-lint'], userHooks['user-lint']);
      assert.deepStrictEqual(written[HOOK_NAME], gateguardHookDefinition(adapter));
      assert.strictEqual(inspectAntigravityGateGuardHookFile(file, adapter), 'ok');
    });
  }));

  results.push(test('apply is a no-op when current, repairs drift, and remove drops only this name', () => {
    withHooksFile(undefined, file => {
      applyAntigravityGateGuardHookToFile(file, adapter);
      assert.deepStrictEqual(applyAntigravityGateGuardHookToFile(file, adapter), { changed: false });
      const drifted = read(file);
      drifted[HOOK_NAME].PreToolUse[0].matcher = 'run_command';
      fs.writeFileSync(file, JSON.stringify(drifted));
      assert.strictEqual(inspectAntigravityGateGuardHookFile(file, adapter), 'drifted');
      assert.deepStrictEqual(applyAntigravityGateGuardHookToFile(file, adapter), { changed: true });
      applyAntigravityGuardianHookToFile(file, guardianAdapter);
      assert.deepStrictEqual(removeAntigravityGateGuardHookFromFile(file), { changed: true });
      assert.deepStrictEqual(Object.keys(read(file)), [GUARDIAN_HOOK_NAME]);
      assert.deepStrictEqual(removeAntigravityGateGuardHookFromFile(file), { changed: false });
    });
  }));

  results.push(test('the managed-hook dispatch routes the GateGuard tag to this module', () => {
    withHooksFile(undefined, file => {
      applyManagedHookOperation({ hookEvent: ANTIGRAVITY_GATEGUARD_HOOK_TAG, destinationPath: file, hookScriptPath: adapter });
      assert.strictEqual(inspectAntigravityGateGuardHookFile(file, adapter), 'ok');
    });
  }));

  results.push(test('the egc target plans the hook in the shared ~/.gemini/config/hooks.json, copies what it runs, and writes nothing under antigravity-cli', () => {
    const homeDir = '/Users/example';
    const plan = planFor({ target: 'egc', homeDir });
    const hooksFilePath = path.join(homeDir, '.gemini', 'config', 'hooks.json');
    const hook = plan.operations.find(op => op.hookEvent === ANTIGRAVITY_GATEGUARD_HOOK_TAG);
    assert.ok(hook, 'the egc target plans the GateGuard named hook');
    assert.strictEqual(hook.destinationPath, hooksFilePath);
    assert.strictEqual(hook.hookScriptPath, path.join(homeDir, '.gemini', 'scripts', 'hooks', 'antigravity-gateguard-adapter.js'));
    assert.ok(plan.operations.some(op => op.hookEvent === ANTIGRAVITY_GUARDIAN_HOOK_TAG && op.destinationPath === hooksFilePath), 'beside the Guardian named hook');
    const copied = new Set(plan.operations.filter(op => op.kind !== hook.kind).map(op => op.destinationPath));
    for (const source of GATE_SOURCES) {
      assert.ok(copied.has(path.join(homeDir, '.gemini', ...source.split('/'))), `${source} is copied`);
    }
    assert.deepStrictEqual(claudeFormatEntries(plan, hooksFilePath), [], 'no Claude-format entry in the file Antigravity reads');
    const legacyFile = path.join(homeDir, '.gemini', 'antigravity-cli', 'hooks.json');
    assert.ok(!plan.operations.some(op => op.destinationPath === legacyFile), 'nothing is planned for antigravity-cli/hooks.json, which Antigravity never read');
  }));

  results.push(test('the antigravity target plans the hook in the project .agents/hooks.json and no Claude-format entry beside it', () => {
    const projectRoot = '/workspace/app';
    const plan = planFor({ target: 'antigravity', projectRoot });
    const hooksFilePath = path.join(projectRoot, '.agents', 'hooks.json');
    const hook = plan.operations.find(op => op.hookEvent === ANTIGRAVITY_GATEGUARD_HOOK_TAG);
    assert.ok(hook, 'the antigravity target plans the GateGuard named hook');
    assert.strictEqual(hook.destinationPath, hooksFilePath);
    assert.strictEqual(hook.hookScriptPath, path.join(projectRoot, '.agents', 'scripts', 'hooks', 'antigravity-gateguard-adapter.js'));
    const copied = new Set(plan.operations.filter(op => op.kind !== hook.kind).map(op => op.destinationPath));
    for (const source of GATE_SOURCES) {
      assert.ok(copied.has(path.join(projectRoot, '.agents', ...source.split('/'))), `${source} is copied`);
    }
    assert.deepStrictEqual(claudeFormatEntries(plan, hooksFilePath), [], 'no Claude-format entry in .agents/hooks.json');
  }));

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  return failed === 0;
}

process.exit(runTests() ? 0 : 1);
