/**
 * Tests for scripts/hooks/run-with-flags.js
 *
 * run-with-flags.js is the central dispatcher every hook in hooks/hooks.json
 * is wired through (EGC-539): it resolves EGC_PLUGIN_ROOT, gates execution
 * via isHookEnabled(), then requires the target hook and calls run(raw).
 * Before doing any of that it calls assertSafeScriptPath() to reject a
 * scriptPath that escapes the resolved plugin root, either via a literal
 * '../' traversal or via a symlink whose real target lives outside the
 * root. Until now it was only exercised indirectly through other hooks'
 * test files (e.g. tests/hooks/pre-bash-guardian-validate.test.js), never
 * directly against its own path-safety and dispatch logic.
 *
 * Run with: node tests/hooks/run-with-flags.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runner = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'run-with-flags.js');

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

/**
 * Spawns run-with-flags.js against a given plugin root / hookId / relative
 * script path, feeding `input` on stdin. profilesCsv defaults to
 * 'minimal,standard,strict' so the hook always passes the isHookEnabled()
 * gate regardless of the ambient EGC_HOOK_PROFILE.
 *
 * EGC_HOOK_PROFILE and EGC_DISABLED_HOOKS are pinned to fixed, known-safe
 * values here rather than left to inherit from the developer's shell
 * (cubic review, EGC-539 PR #1143): isHookEnabled() reads both from
 * process.env, so an ambient EGC_HOOK_PROFILE=strict would make the
 * profile-gating test below spuriously enable should-not-run.js, and an
 * ambient EGC_DISABLED_HOOKS containing 'test-hook'/'evil-hook'/
 * 'symlink-hook' would silently skip the path-safety assertions these
 * tests exist to exercise. Callers may still override either via `env`.
 */
function runDispatcher({ pluginRoot, hookId = 'test-hook', relScriptPath, profilesCsv = 'minimal,standard,strict', input = 'raw-input', env = {} }) {
  const result = spawnSync('node', [runner, hookId, relScriptPath, profilesCsv], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      EGC_HOOK_PROFILE: 'standard',
      EGC_DISABLED_HOOKS: '',
      EGC_PLUGIN_ROOT: pluginRoot,
      ...env,
    },
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function makeTempPluginRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-539-run-with-flags-'));
}

function runTests() {
  console.log('\n=== Testing run-with-flags.js ===\n');

  let passed = 0;
  let failed = 0;

  console.log('assertSafeScriptPath - valid path:');

  if (test('a script inside the plugin root that exports run() is required and executed', () => {
    const pluginRoot = makeTempPluginRoot();
    try {
      fs.writeFileSync(
        path.join(pluginRoot, 'good-hook.js'),
        "module.exports = { run: (raw) => `PROCESSED:${raw}` };\n"
      );
      const result = runDispatcher({ pluginRoot, relScriptPath: 'good-hook.js', input: 'hello' });
      assert.strictEqual(result.code, 0, `Expected exit 0, got ${result.code}: ${result.stderr}`);
      assert.strictEqual(result.stdout, 'PROCESSED:hello');
      assert.strictEqual(result.stderr, '', `Expected no stderr, got: ${result.stderr}`);
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('a nested valid path (subdirectory) inside the plugin root is accepted', () => {
    const pluginRoot = makeTempPluginRoot();
    try {
      fs.mkdirSync(path.join(pluginRoot, 'nested', 'dir'), { recursive: true });
      fs.writeFileSync(
        path.join(pluginRoot, 'nested', 'dir', 'good-hook.js'),
        "module.exports = { run: (raw) => `NESTED:${raw}` };\n"
      );
      const result = runDispatcher({ pluginRoot, relScriptPath: path.join('nested', 'dir', 'good-hook.js'), input: 'hi' });
      assert.strictEqual(result.code, 0, `Expected exit 0, got ${result.code}: ${result.stderr}`);
      assert.strictEqual(result.stdout, 'NESTED:hi');
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log('\nassertSafeScriptPath - path traversal:');

  if (test('rejects a relative path that escapes the plugin root via ../', () => {
    const pluginRoot = makeTempPluginRoot();
    try {
      // Outside pluginRoot, one level up, so '../secret.js' resolves to a
      // real file -- proving the rejection is the traversal guard itself,
      // not just a missing-file fallthrough.
      const outsideFile = path.join(pluginRoot, '..', `egc-539-secret-${path.basename(pluginRoot)}.js`);
      fs.writeFileSync(outsideFile, "module.exports = { run: () => 'LEAKED' };\n");
      try {
        const result = runDispatcher({ pluginRoot, hookId: 'evil-hook', relScriptPath: `../${path.basename(outsideFile)}`, input: 'stdin-passthrough' });
        assert.strictEqual(result.code, 0, 'run-with-flags always fails open with exit 0 after rejecting a path');
        assert.ok(result.stderr.includes('Path traversal rejected'), `Expected traversal rejection on stderr, got: ${result.stderr}`);
        assert.ok(result.stderr.includes('evil-hook'), `Expected hookId in the error, got: ${result.stderr}`);
        assert.strictEqual(result.stdout, 'stdin-passthrough', 'Expected raw stdin passed through unchanged, not the leaked hook output');
      } finally {
        fs.rmSync(outsideFile, { force: true });
      }
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('rejects an absolute scriptPath outside the plugin root', () => {
    const pluginRoot = makeTempPluginRoot();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-539-outside-'));
    try {
      const outsideFile = path.join(outsideDir, 'absolute-secret.js');
      fs.writeFileSync(outsideFile, "module.exports = { run: () => 'LEAKED' };\n");
      const result = runDispatcher({ pluginRoot, relScriptPath: outsideFile, input: 'stdin-passthrough' });
      assert.strictEqual(result.code, 0);
      assert.ok(result.stderr.includes('Path traversal rejected'), `Expected traversal rejection on stderr, got: ${result.stderr}`);
      assert.strictEqual(result.stdout, 'stdin-passthrough');
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('rejects a scriptPath that resolves to the plugin root itself (empty relative path)', () => {
    const pluginRoot = makeTempPluginRoot();
    try {
      const result = runDispatcher({ pluginRoot, relScriptPath: '.', input: 'stdin-passthrough' });
      assert.strictEqual(result.code, 0);
      assert.ok(result.stderr.includes('Path traversal rejected'), `Expected traversal rejection on stderr, got: ${result.stderr}`);
      assert.strictEqual(result.stdout, 'stdin-passthrough');
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log('\nassertSafeScriptPath - missing script:');

  if (test('rejects a relative path inside the root that does not exist', () => {
    const pluginRoot = makeTempPluginRoot();
    try {
      const result = runDispatcher({ pluginRoot, relScriptPath: 'does-not-exist.js', input: 'stdin-passthrough' });
      assert.strictEqual(result.code, 0);
      assert.ok(result.stderr.includes('Script not found'), `Expected not-found rejection on stderr, got: ${result.stderr}`);
      assert.strictEqual(result.stdout, 'stdin-passthrough');
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log('\nassertSafeScriptPath - symlink traversal:');

  const canSymlink = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-539-symlink-probe-'));
    try {
      const target = path.join(dir, 'target.txt');
      fs.writeFileSync(target, 'x');
      fs.symlinkSync(target, path.join(dir, 'link.txt'));
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();

  if (!canSymlink) {
    console.log('  - skipped symlink traversal tests; this environment cannot create symlinks (no permission).');
  } else {
    if (test('rejects a symlink inside the plugin root whose real target lives outside it', () => {
      const pluginRoot = makeTempPluginRoot();
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-539-symlink-target-'));
      try {
        const outsideFile = path.join(outsideDir, 'secret.js');
        fs.writeFileSync(outsideFile, "module.exports = { run: () => 'LEAKED' };\n");
        fs.symlinkSync(outsideFile, path.join(pluginRoot, 'link-hook.js'));

        const result = runDispatcher({ pluginRoot, hookId: 'symlink-hook', relScriptPath: 'link-hook.js', input: 'stdin-passthrough' });
        assert.strictEqual(result.code, 0);
        assert.ok(result.stderr.includes('Symlink traversal rejected'), `Expected symlink rejection on stderr, got: ${result.stderr}`);
        assert.ok(result.stderr.includes('symlink-hook'), `Expected hookId in the error, got: ${result.stderr}`);
        assert.strictEqual(result.stdout, 'stdin-passthrough', 'Expected raw stdin passed through unchanged, not the leaked hook output');
      } finally {
        fs.rmSync(pluginRoot, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    })) passed++; else failed++;

    if (test('accepts a symlink inside the plugin root whose real target also lives inside it', () => {
      const pluginRoot = makeTempPluginRoot();
      try {
        fs.mkdirSync(path.join(pluginRoot, 'real'));
        const realFile = path.join(pluginRoot, 'real', 'hook.js');
        fs.writeFileSync(realFile, "module.exports = { run: (raw) => `LINKED:${raw}` };\n");
        fs.symlinkSync(realFile, path.join(pluginRoot, 'link-hook.js'));

        const result = runDispatcher({ pluginRoot, relScriptPath: 'link-hook.js', input: 'hi' });
        assert.strictEqual(result.code, 0, `Expected exit 0, got ${result.code}: ${result.stderr}`);
        assert.strictEqual(result.stdout, 'LINKED:hi');
        assert.strictEqual(result.stderr, '');
      } finally {
        fs.rmSync(pluginRoot, { recursive: true, force: true });
      }
    })) passed++; else failed++;
  }

  console.log('\nHook profile gating:');

  if (test('passes stdin through unchanged without requiring the script when the hook is disabled for the active profile', () => {
    const pluginRoot = makeTempPluginRoot();
    try {
      // A script that would blow up if it were ever required, so the test
      // fails loudly if the profile gate is bypassed.
      fs.writeFileSync(path.join(pluginRoot, 'should-not-run.js'), "throw new Error('should never be required');\n");
      const result = runDispatcher({ pluginRoot, relScriptPath: 'should-not-run.js', profilesCsv: 'strict', input: 'stdin-passthrough' });
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout, 'stdin-passthrough');
      assert.strictEqual(result.stderr, '');
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('passes stdin through unchanged when hookId or scriptPath argv is missing', () => {
    const result = spawnSync('node', [runner], {
      input: 'stdin-passthrough',
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, 'stdin-passthrough');
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
