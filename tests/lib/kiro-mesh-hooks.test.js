/**
 * Tests for scripts/lib/kiro-mesh-hooks.js
 *
 * Kiro's hook panel reads any .json file under .kiro/hooks/, so the mesh
 * notice ships as a dedicated whole-file document owned by EGC. These tests
 * pin the document shape (v1, UserPromptSubmit, command action with
 * --format=text), apply idempotency, whole-file removal, and drift
 * detection when a user edits the command by hand.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MESH_HOOK_FILE_NAME,
  applyKiroMeshHookToFile,
  buildMeshHookCommand,
  inspectKiroMeshHookFile,
  removeKiroMeshHookFromFile,
  resolveMeshHookFilePath,
} = require('../../scripts/lib/kiro-mesh-hooks');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-kiro-mesh-'));
}

let passed = 0;
let failed = 0;
const run = (name, fn) => { test(name, fn) ? passed++ : failed++; };

console.log('\n=== Testing kiro-mesh-hooks ===\n');

run('resolves the hook document path under <root>/hooks', () => {
  const root = makeRoot();
  try {
    assert.strictEqual(
      resolveMeshHookFilePath(root),
      path.join(root, 'hooks', MESH_HOOK_FILE_NAME)
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

run('apply writes the v1 UserPromptSubmit command document and is idempotent', () => {
  const root = makeRoot();
  try {
    const hookFile = resolveMeshHookFilePath(root);
    const scriptPath = path.join(root, 'scripts', 'hooks', 'mesh-events-inject.js');

    const first = applyKiroMeshHookToFile(hookFile, scriptPath);
    assert.strictEqual(first.changed, true, 'first apply writes the file');

    const parsed = JSON.parse(fs.readFileSync(hookFile, 'utf8'));
    assert.strictEqual(parsed.version, 'v1');
    assert.strictEqual(parsed.hooks.length, 1);
    assert.strictEqual(parsed.hooks[0].trigger, 'UserPromptSubmit');
    assert.strictEqual(parsed.hooks[0].action.type, 'command');
    assert.strictEqual(parsed.hooks[0].action.command, buildMeshHookCommand(scriptPath));
    assert.ok(parsed.hooks[0].action.command.endsWith(' --format=text'), 'raw-stdout host gets the bare notice');
    assert.strictEqual(parsed.hooks[0].enabled, true);

    const second = applyKiroMeshHookToFile(hookFile, scriptPath);
    assert.strictEqual(second.changed, false, 'unchanged content reports changed:false');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

run('remove deletes the dedicated file and tolerates absence', () => {
  const root = makeRoot();
  try {
    const hookFile = resolveMeshHookFilePath(root);
    const scriptPath = path.join(root, 'scripts', 'hooks', 'mesh-events-inject.js');
    applyKiroMeshHookToFile(hookFile, scriptPath);

    assert.strictEqual(removeKiroMeshHookFromFile(hookFile).changed, true);
    assert.strictEqual(fs.existsSync(hookFile), false, 'whole file is gone');
    assert.strictEqual(removeKiroMeshHookFromFile(hookFile).changed, false, 'second remove is a no-op');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

run('inspect reports ok when intact and drifted after a manual edit or when missing', () => {
  const root = makeRoot();
  try {
    const hookFile = resolveMeshHookFilePath(root);
    const scriptPath = path.join(root, 'scripts', 'hooks', 'mesh-events-inject.js');

    assert.strictEqual(inspectKiroMeshHookFile(hookFile, scriptPath), 'drifted', 'missing file is drift');

    applyKiroMeshHookToFile(hookFile, scriptPath);
    assert.strictEqual(inspectKiroMeshHookFile(hookFile, scriptPath), 'ok');

    const parsed = JSON.parse(fs.readFileSync(hookFile, 'utf8'));
    parsed.hooks[0].action.command = 'echo tampered';
    fs.writeFileSync(hookFile, JSON.stringify(parsed));
    assert.strictEqual(inspectKiroMeshHookFile(hookFile, scriptPath), 'drifted', 'edited command is drift');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
