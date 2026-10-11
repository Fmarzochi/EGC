'use strict';

/**
 * Tests for scripts/lib/vibe-hooks-toml.js
 *
 * Mistral Vibe declares hooks as [[hooks]] tables in hooks.toml. These tests
 * verify the EGC blocks are written, replaced, inspected and removed by
 * name while everything the person wrote in the file stays byte for byte.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TOML = require('@iarna/toml');

const {
  VIBE_CRUSHER_MATCHER,
  VIBE_GUARDIAN_MATCHER,
  VIBE_PRE_TOOL_EVENT,
  applyVibeHookToFile,
  createVibeCrusherHookMergeOperation,
  createVibeGuardianHookMergeOperation,
  inspectVibeHookFile,
  parseHookBlocks,
  removeVibeHookFromFile,
  renderHookBlock,
  resolveVibeCrusherAdapterDestination,
  resolveVibeGuardianAdapterDestination,
  resolveVibeHooksTomlPath,
} = require('../../scripts/lib/vibe-hooks-toml');
const { buildHookCommand } = require('../../scripts/lib/flat-hooks-json-merge');

const OWN_BLOCK = [
  '# hooks of my own',
  '[[hooks]]',
  'name = "deny-rm-rf"',
  'type = "pre_tool"',
  'match = "bash"',
  'command = "python ./.vibe/hooks/guard-bash.py"',
  'strict = true',
  '',
  '[other]',
  'key = "value"',
  '',
].join('\n');

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-vibe-hooks-'));
}

let passed = 0;
let failed = 0;
const tally = ok => { if (ok) passed++; else failed++; };

console.log('\n=== Testing vibe-hooks-toml ===\n');

tally(test('paths: hooks.toml under the root, the adapters under scripts/hooks', () => {
  const root = path.join('home', 'person', '.vibe');
  assert.strictEqual(resolveVibeHooksTomlPath(root), path.join(root, 'hooks.toml'));
  assert.strictEqual(resolveVibeGuardianAdapterDestination(root), path.join(root, 'scripts', 'hooks', 'vibe-guardian-adapter.js'));
  assert.strictEqual(resolveVibeCrusherAdapterDestination(root), path.join(root, 'scripts', 'hooks', 'vibe-crusher-adapter.js'));
}));

tally(test('renderHookBlock: the Guardian is strict, the Crusher is not, and the command is a TOML basic string', () => {
  const guardian = renderHookBlock('egc-guardian', 'C:\\node.exe "C:\\x\\a.js"', VIBE_GUARDIAN_MATCHER);
  const odd = TOML.parse(renderHookBlock('egc-crusher', 'node "/tmp/odd\nname\t/a.js"', VIBE_CRUSHER_MATCHER));
  assert.strictEqual(odd.hooks[0].command, 'node "/tmp/odd\nname\t/a.js"', 'a newline and a tab in a path survive as TOML escapes');
  const parsed = TOML.parse(guardian);
  assert.strictEqual(parsed.hooks[0].name, 'egc-guardian');
  assert.strictEqual(parsed.hooks[0].type, 'pre_tool');
  assert.strictEqual(parsed.hooks[0].match, VIBE_GUARDIAN_MATCHER);
  assert.strictEqual(parsed.hooks[0].command, 'C:\\node.exe "C:\\x\\a.js"', 'backslashes and quotes survive the round trip');
  assert.strictEqual(parsed.hooks[0].strict, true);
  const crusher = TOML.parse(renderHookBlock('egc-crusher', 'node a.js', VIBE_CRUSHER_MATCHER));
  assert.strictEqual(crusher.hooks[0].strict, false);
  assert.strictEqual(crusher.hooks[0].match, VIBE_CRUSHER_MATCHER);
}));

tally(test('apply creates hooks.toml with one block, is idempotent, and replaces the block when the matcher changes', () => {
  const root = tempRoot();
  try {
    const file = resolveVibeHooksTomlPath(root);
    const script = resolveVibeGuardianAdapterDestination(root);
    assert.deepStrictEqual(applyVibeHookToFile(file, script, VIBE_GUARDIAN_MATCHER), { changed: true });
    assert.deepStrictEqual(applyVibeHookToFile(file, script, VIBE_GUARDIAN_MATCHER), { changed: false }, 'a second run changes nothing');
    const once = fs.readFileSync(file, 'utf8');
    assert.strictEqual(TOML.parse(once).hooks.length, 1);
    assert.strictEqual(TOML.parse(once).hooks[0].command, buildHookCommand(script));
    assert.deepStrictEqual(applyVibeHookToFile(file, script, 're:^bash$'), { changed: true });
    const hooks = TOML.parse(fs.readFileSync(file, 'utf8')).hooks;
    assert.strictEqual(hooks.length, 1, 'the old block is replaced, not duplicated');
    assert.strictEqual(hooks[0].match, 're:^bash$');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

tally(test('apply and remove leave a block and a table of the person\'s own byte for byte', () => {
  const root = tempRoot();
  try {
    const file = resolveVibeHooksTomlPath(root);
    fs.writeFileSync(file, OWN_BLOCK);
    const guardian = resolveVibeGuardianAdapterDestination(root);
    const crusher = resolveVibeCrusherAdapterDestination(root);
    applyVibeHookToFile(file, guardian, VIBE_GUARDIAN_MATCHER);
    applyVibeHookToFile(file, crusher, VIBE_CRUSHER_MATCHER);
    const written = fs.readFileSync(file, 'utf8');
    assert.ok(written.startsWith(OWN_BLOCK.trimEnd()), 'the person\'s text comes first, unchanged');
    const parsed = TOML.parse(written);
    assert.deepStrictEqual(parsed.hooks.map(hook => hook.name), ['deny-rm-rf', 'egc-guardian', 'egc-crusher']);
    assert.deepStrictEqual(parsed.other, { key: 'value' });
    assert.deepStrictEqual(removeVibeHookFromFile(file, guardian), { changed: true });
    assert.deepStrictEqual(removeVibeHookFromFile(file, guardian), { changed: false }, 'already gone');
    const after = TOML.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(after.hooks.map(hook => hook.name), ['deny-rm-rf', 'egc-crusher']);
    assert.deepStrictEqual(removeVibeHookFromFile(file, crusher), { changed: true });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), `${OWN_BLOCK.trimEnd()}\n`, 'only the person\'s text is left');
    assert.deepStrictEqual(removeVibeHookFromFile(path.join(root, 'missing.toml'), crusher), { changed: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

tally(test('inspect: ok after apply, drifted when the matcher or the command differs or the file is missing', () => {
  const root = tempRoot();
  try {
    const file = resolveVibeHooksTomlPath(root);
    const script = resolveVibeGuardianAdapterDestination(root);
    assert.strictEqual(inspectVibeHookFile(file, script, VIBE_GUARDIAN_MATCHER), 'drifted');
    applyVibeHookToFile(file, script, VIBE_GUARDIAN_MATCHER);
    assert.strictEqual(inspectVibeHookFile(file, script, VIBE_GUARDIAN_MATCHER), 'ok');
    assert.strictEqual(inspectVibeHookFile(file, script), 'ok', 'without a matcher the name and command decide');
    assert.strictEqual(inspectVibeHookFile(file, script, 're:^bash$'), 'drifted');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('strict = true', 'strict = false'));
    assert.strictEqual(inspectVibeHookFile(file, script, VIBE_GUARDIAN_MATCHER), 'drifted', 'a strict flag flipped by hand is drift');
    assert.strictEqual(inspectVibeHookFile(file, script), 'ok', 'a retirement check only needs the name and the command');
    assert.deepStrictEqual(applyVibeHookToFile(file, script, VIBE_GUARDIAN_MATCHER), { changed: true }, 'repair rewrites the block');
    assert.strictEqual(inspectVibeHookFile(file, script, VIBE_GUARDIAN_MATCHER), 'ok');
    assert.strictEqual(inspectVibeHookFile(file, path.join(root, 'elsewhere', 'vibe-guardian-adapter.js'), VIBE_GUARDIAN_MATCHER), 'drifted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

tally(test('a hooks.toml that is not valid TOML is left untouched', () => {
  const root = tempRoot();
  try {
    const file = resolveVibeHooksTomlPath(root);
    const broken = '[[hooks]\nname = "oops"\n';
    fs.writeFileSync(file, broken);
    assert.throws(() => applyVibeHookToFile(file, resolveVibeGuardianAdapterDestination(root), VIBE_GUARDIAN_MATCHER), /not valid TOML - left untouched/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), broken);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

tally(test('parseHookBlocks reads the name, command and match of every [[hooks]] table and stops at the next table', () => {
  const { blocks } = parseHookBlocks(`${OWN_BLOCK}\n[[hooks]]\nname = 'single'\ncommand = "a \\"b\\" c"\n`);
  assert.deepStrictEqual(blocks.map(block => [block.name, block.command, block.match]), [
    ['deny-rm-rf', 'python ./.vibe/hooks/guard-bash.py', 'bash'],
    ['single', 'a "b" c', null],
  ]);
}));

tally(test('the merge operations name the hooks.toml, the vibe:pre_tool event, the matcher and the adapter each runs', () => {
  const root = path.join('home', 'person', '.vibe');
  const guardian = createVibeGuardianHookMergeOperation(root);
  assert.strictEqual(guardian.kind, 'merge-claude-settings-hooks');
  assert.strictEqual(guardian.destinationPath, path.join(root, 'hooks.toml'));
  assert.strictEqual(guardian.hookEvent, VIBE_PRE_TOOL_EVENT);
  assert.strictEqual(guardian.hookMatcher, VIBE_GUARDIAN_MATCHER);
  assert.strictEqual(guardian.hookScriptPath, path.join(root, 'scripts', 'hooks', 'vibe-guardian-adapter.js'));
  assert.strictEqual(guardian.moduleId, 'egc-bash-guardian-hook');
  const crusher = createVibeCrusherHookMergeOperation(root);
  assert.strictEqual(crusher.hookMatcher, VIBE_CRUSHER_MATCHER);
  assert.strictEqual(crusher.hookScriptPath, path.join(root, 'scripts', 'hooks', 'vibe-crusher-adapter.js'));
  assert.strictEqual(crusher.moduleId, 'egc-crusher-hook');
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
