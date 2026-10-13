'use strict';

/**
 * Tests for scripts/lib/kimi-hooks-toml.js
 *
 * Kimi Code CLI declares hooks as [[hooks]] tables in config.toml and loads
 * only the keys event, matcher, command and timeout. These tests verify the
 * EGC block is written, repaired, inspected and removed while everything the
 * person wrote in the file stays byte for byte.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TOML = require('@iarna/toml');

const {
  KIMI_GUARDIAN_MATCHER,
  KIMI_HOOK_TIMEOUT_SECONDS,
  KIMI_PRE_TOOL_EVENT,
  applyKimiHookToFile,
  createKimiGuardianHookMergeOperation,
  inspectKimiHookFile,
  parseHookBlocks,
  removeKimiHookFromFile,
  renderHookBlock,
  resolveKimiConfigTomlPath,
  resolveKimiGuardianAdapterDestination,
} = require('../../scripts/lib/kimi-hooks-toml');
const { buildHookCommand } = require('../../scripts/lib/flat-hooks-json-merge');

const OWN_CONFIG = [
  '# my Kimi configuration',
  'default_model = "kimi-k2"',
  '',
  '[[hooks]]',
  'event = "PreToolUse"',
  'matcher = "Bash"',
  'command = "python ./guard-bash.py"',
  'timeout = 5',
  '',
  '[providers.moonshot]',
  'base_url = "https://api.moonshot.ai/v1"',
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-kimi-hooks-'));
}

let passed = 0;
let failed = 0;
const tally = ok => { if (ok) passed++; else failed++; };

console.log('\n=== Testing kimi-hooks-toml ===\n');

tally(test('paths: config.toml under the root, the adapter under scripts/hooks', () => {
  const root = path.join('home', 'person', '.kimi-code');
  assert.strictEqual(resolveKimiConfigTomlPath(root), path.join(root, 'config.toml'));
  assert.strictEqual(resolveKimiGuardianAdapterDestination(root), path.join(root, 'scripts', 'hooks', 'kimi-guardian-adapter.js'));
}));

tally(test('renderHookBlock writes exactly the four keys Kimi loads, and the command survives as a TOML basic string', () => {
  const parsed = TOML.parse(renderHookBlock('C:\\node.exe "C:\\x\\a.js"', KIMI_GUARDIAN_MATCHER));
  assert.strictEqual(parsed.hooks.length, 1);
  assert.deepStrictEqual(Object.keys(parsed.hooks[0]).sort(), ['command', 'event', 'matcher', 'timeout']);
  assert.strictEqual(parsed.hooks[0].event, 'PreToolUse');
  assert.strictEqual(parsed.hooks[0].matcher, KIMI_GUARDIAN_MATCHER);
  assert.strictEqual(parsed.hooks[0].timeout, KIMI_HOOK_TIMEOUT_SECONDS);
  assert.strictEqual(parsed.hooks[0].command, 'C:\\node.exe "C:\\x\\a.js"');
  const odd = TOML.parse(renderHookBlock('node "/tmp/odd\nname\t/a.js"', KIMI_GUARDIAN_MATCHER));
  assert.strictEqual(odd.hooks[0].command, 'node "/tmp/odd\nname\t/a.js"');
}));

tally(test('the matcher names the shell and file tools, current and legacy, and nothing else', () => {
  const matcher = new RegExp(KIMI_GUARDIAN_MATCHER);
  for (const tool of ['Bash', 'Shell', 'Write', 'WriteFile', 'Edit', 'StrReplaceFile']) {
    assert.ok(matcher.test(tool), tool);
  }
  for (const tool of ['Read', 'ReadFile', 'Glob', 'Grep', 'BashOutput', 'MyBash']) {
    assert.ok(!matcher.test(tool), tool);
  }
}));

tally(test('apply creates config.toml with one block, is idempotent, and replaces the block when the matcher changes', () => {
  const root = tempRoot();
  try {
    const file = resolveKimiConfigTomlPath(root);
    const script = resolveKimiGuardianAdapterDestination(root);
    assert.deepStrictEqual(applyKimiHookToFile(file, script, KIMI_GUARDIAN_MATCHER), { changed: true });
    assert.deepStrictEqual(applyKimiHookToFile(file, script, KIMI_GUARDIAN_MATCHER), { changed: false }, 'a second run changes nothing');
    const once = TOML.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(once.hooks.length, 1);
    assert.strictEqual(once.hooks[0].command, buildHookCommand(script));
    assert.deepStrictEqual(applyKimiHookToFile(file, script, '^Bash$'), { changed: true });
    const hooks = TOML.parse(fs.readFileSync(file, 'utf8')).hooks;
    assert.strictEqual(hooks.length, 1, 'the old block is replaced, not duplicated');
    assert.strictEqual(hooks[0].matcher, '^Bash$');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

tally(test('install into a config with the person\'s own hook and settings keeps them byte for byte, uninstall removes only the EGC block', () => {
  const root = tempRoot();
  try {
    const file = resolveKimiConfigTomlPath(root);
    fs.writeFileSync(file, OWN_CONFIG);
    const script = resolveKimiGuardianAdapterDestination(root);
    applyKimiHookToFile(file, script, KIMI_GUARDIAN_MATCHER);
    const written = fs.readFileSync(file, 'utf8');
    assert.ok(written.startsWith(OWN_CONFIG.trimEnd()), 'the person\'s text comes first, unchanged');
    const parsed = TOML.parse(written);
    assert.deepStrictEqual(parsed.hooks.map(hook => hook.command), ['python ./guard-bash.py', buildHookCommand(script)]);
    assert.strictEqual(parsed.default_model, 'kimi-k2');
    assert.strictEqual(parsed.providers.moonshot.base_url, 'https://api.moonshot.ai/v1');
    assert.deepStrictEqual(removeKimiHookFromFile(file), { changed: true });
    assert.deepStrictEqual(removeKimiHookFromFile(file), { changed: false }, 'already gone');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), `${OWN_CONFIG.trimEnd()}\n`, 'only the person\'s text is left');
    assert.deepStrictEqual(removeKimiHookFromFile(path.join(root, 'missing.toml')), { changed: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

tally(test('uninstall of a config that held only the EGC block leaves an empty file', () => {
  const root = tempRoot();
  try {
    const file = resolveKimiConfigTomlPath(root);
    applyKimiHookToFile(file, resolveKimiGuardianAdapterDestination(root), KIMI_GUARDIAN_MATCHER);
    removeKimiHookFromFile(file);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

tally(test('a block left by an older install location is replaced by the one in the current root, not duplicated', () => {
  const root = tempRoot();
  try {
    const file = resolveKimiConfigTomlPath(root);
    const elsewhere = path.join(root, 'old', 'scripts', 'hooks', 'kimi-guardian-adapter.js');
    applyKimiHookToFile(file, elsewhere, KIMI_GUARDIAN_MATCHER);
    applyKimiHookToFile(file, resolveKimiGuardianAdapterDestination(root), KIMI_GUARDIAN_MATCHER);
    const hooks = TOML.parse(fs.readFileSync(file, 'utf8')).hooks;
    assert.strictEqual(hooks.length, 1);
    assert.strictEqual(hooks[0].command, buildHookCommand(resolveKimiGuardianAdapterDestination(root)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

tally(test('inspect: ok after apply, drifted when the matcher or timeout was edited or the file is missing, and repair rewrites it', () => {
  const root = tempRoot();
  try {
    const file = resolveKimiConfigTomlPath(root);
    const script = resolveKimiGuardianAdapterDestination(root);
    assert.strictEqual(inspectKimiHookFile(file, script, KIMI_GUARDIAN_MATCHER), 'drifted');
    applyKimiHookToFile(file, script, KIMI_GUARDIAN_MATCHER);
    assert.strictEqual(inspectKimiHookFile(file, script, KIMI_GUARDIAN_MATCHER), 'ok');
    assert.strictEqual(inspectKimiHookFile(file, script), 'ok', 'without a matcher the command decides');
    assert.strictEqual(inspectKimiHookFile(file, script, '^Bash$'), 'drifted');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(`timeout = ${KIMI_HOOK_TIMEOUT_SECONDS}`, 'timeout = 600'));
    assert.strictEqual(inspectKimiHookFile(file, script, KIMI_GUARDIAN_MATCHER), 'drifted', 'a timeout changed by hand is drift');
    assert.strictEqual(inspectKimiHookFile(file, script), 'ok', 'a retirement check only needs the command');
    assert.deepStrictEqual(applyKimiHookToFile(file, script, KIMI_GUARDIAN_MATCHER), { changed: true });
    assert.strictEqual(inspectKimiHookFile(file, script, KIMI_GUARDIAN_MATCHER), 'ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

tally(test('a config.toml that is not valid TOML is left untouched, on install and on uninstall', () => {
  const root = tempRoot();
  try {
    const file = resolveKimiConfigTomlPath(root);
    const broken = '[[hooks]\nevent = "oops"\n';
    fs.writeFileSync(file, broken);
    assert.throws(() => applyKimiHookToFile(file, resolveKimiGuardianAdapterDestination(root), KIMI_GUARDIAN_MATCHER), /not valid TOML - left untouched/);
    assert.throws(() => removeKimiHookFromFile(file), /not valid TOML - left untouched/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), broken);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

tally(test('apply refuses a script that is not the Kimi Guardian adapter', () => {
  const root = tempRoot();
  try {
    const file = resolveKimiConfigTomlPath(root);
    assert.throws(() => applyKimiHookToFile(file, path.join(root, 'other.js'), KIMI_GUARDIAN_MATCHER), /not an EGC hook script for Kimi Code/);
    assert.ok(!fs.existsSync(file));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

tally(test('parseHookBlocks reads the command of every [[hooks]] table and stops at the next table', () => {
  const { blocks } = parseHookBlocks(`${OWN_CONFIG}\n[[hooks]]\ncommand = "a \\"b\\" c"\n`);
  assert.deepStrictEqual(blocks.map(block => block.command), ['python ./guard-bash.py', 'a "b" c']);
}));

tally(test('a config.toml with CRLF line endings keeps them, stays idempotent and reads as ok', () => {
  const root = tempRoot();
  try {
    const file = resolveKimiConfigTomlPath(root);
    const script = resolveKimiGuardianAdapterDestination(root);
    fs.writeFileSync(file, OWN_CONFIG.replaceAll('\n', '\r\n'));
    assert.deepStrictEqual(applyKimiHookToFile(file, script, KIMI_GUARDIAN_MATCHER), { changed: true });
    assert.deepStrictEqual(applyKimiHookToFile(file, script, KIMI_GUARDIAN_MATCHER), { changed: false });
    const written = fs.readFileSync(file, 'utf8');
    assert.ok(!/(^|[^\r])\n/.test(written), 'every line ends in CRLF');
    assert.strictEqual(inspectKimiHookFile(file, script, KIMI_GUARDIAN_MATCHER), 'ok');
    assert.deepStrictEqual(removeKimiHookFromFile(file), { changed: true });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), OWN_CONFIG.replaceAll('\n', '\r\n').trimEnd() + '\r\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

tally(test('a comment that introduces the next table survives when the EGC block is replaced or removed', () => {
  const root = tempRoot();
  try {
    const file = resolveKimiConfigTomlPath(root);
    const script = resolveKimiGuardianAdapterDestination(root);
    applyKimiHookToFile(file, script, KIMI_GUARDIAN_MATCHER);
    const withComment = fs.readFileSync(file, 'utf8') + '\n# provider settings\n[providers.moonshot]\nbase_url = "https://api.moonshot.ai/v1"\n';
    fs.writeFileSync(file, withComment.replace('\n\n# provider', '\n# provider'));
    applyKimiHookToFile(file, script, '^Bash$');
    assert.ok(fs.readFileSync(file, 'utf8').includes('# provider settings\n[providers.moonshot]'));
    removeKimiHookFromFile(file);
    assert.ok(fs.readFileSync(file, 'utf8').includes('# provider settings\n[providers.moonshot]'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

tally(test('the merge operation names config.toml, the kimi:pre_tool event, the matcher and the adapter it runs', () => {
  const root = path.join('home', 'person', '.kimi-code');
  const operation = createKimiGuardianHookMergeOperation(root);
  assert.strictEqual(operation.kind, 'merge-claude-settings-hooks');
  assert.strictEqual(operation.destinationPath, path.join(root, 'config.toml'));
  assert.strictEqual(operation.hookEvent, KIMI_PRE_TOOL_EVENT);
  assert.strictEqual(operation.hookMatcher, KIMI_GUARDIAN_MATCHER);
  assert.strictEqual(operation.hookScriptPath, path.join(root, 'scripts', 'hooks', 'kimi-guardian-adapter.js'));
  assert.strictEqual(operation.moduleId, 'egc-bash-guardian-hook');
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
