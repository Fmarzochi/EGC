/**
 * Tests for scripts/hooks/opencode-egc-plugin.js
 *
 * Unlike every other host's hooks.json subprocess adapter, this plugin's
 * require() calls are DESTINATION-relative (`../scripts/hooks/...`), not
 * sibling-relative -- they only resolve once installed at
 * <targetRoot>/plugins/opencode-egc-plugin.js alongside a real
 * <targetRoot>/scripts/hooks and <targetRoot>/scripts/lib tree (see the
 * plugin's own header comment). So these tests drive the real
 * opencode-home.js install plan to materialize that exact shape in a temp
 * dir, then require() the plugin from ITS INSTALLED location -- this
 * exercises the real require-path contract, not a stand-in.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { planInstallTargetScaffold } = require('../../scripts/lib/install-targets/registry');

const REPO_ROOT = path.join(__dirname, '..', '..');
const FAKE_CLI = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');

function installOpenCodePlugin(homeDir) {
  const plan = planInstallTargetScaffold({ target: 'opencode', repoRoot: REPO_ROOT, homeDir, modules: [] });
  for (const operation of plan.operations) {
    const sourcePath = path.join(REPO_ROOT, operation.sourceRelativePath);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
    fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, operation.destinationPath);
  }
  return path.join(homeDir, '.config', 'opencode', 'plugins', 'opencode-egc-plugin.js');
}

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
  console.log('\n=== Testing opencode-egc-plugin ===\n');

  let passed = 0;
  let failed = 0;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-'));
  const originalGuardianCli = process.env.EGC_GUARDIAN_CLI;
  const originalAssumeEgcCli = process.env.EGC_ASSUME_EGC_CLI;
  process.env.EGC_GUARDIAN_CLI = FAKE_CLI;
  process.env.EGC_ASSUME_EGC_CLI = '0';

  let EgcGuardianCrusher;
  try {
    const installedPluginPath = installOpenCodePlugin(tempDir);

    if (test('installs the plugin and its Guardian/Crusher dependency tree so require() resolves', () => {
      assert.ok(fs.existsSync(installedPluginPath), 'plugin file should be copied to plugins/');
      // Throws if any destination-relative require() target is missing.
      delete require.cache[require.resolve(installedPluginPath)];
      ({ EgcGuardianCrusher } = require(installedPluginPath));
      assert.strictEqual(typeof EgcGuardianCrusher, 'function');
    })) passed++; else failed++;

    if (test('ignores non-bash tools (no-op, does not throw)', async () => {
      const hooks = await EgcGuardianCrusher({ directory: tempDir });
      const output = { args: { filePath: '/tmp/x' } };
      await hooks['tool.execute.before']({ tool: 'read' }, output);
      assert.deepStrictEqual(output.args, { filePath: '/tmp/x' });
    })) passed++; else failed++;

    if (test('ignores a bash input with no command arg (no-op, does not throw)', async () => {
      const hooks = await EgcGuardianCrusher({ directory: tempDir });
      const output = { args: {} };
      await hooks['tool.execute.before']({ tool: 'bash' }, output);
      assert.deepStrictEqual(output.args, {});
    })) passed++; else failed++;

    if (test('blocks a destructive command by throwing (Guardian runs before the Crusher rewrite)', async () => {
      const hooks = await EgcGuardianCrusher({ directory: tempDir });
      const output = { args: { command: 'rm -rf /' } };
      await assert.rejects(
        () => hooks['tool.execute.before']({ tool: 'bash' }, output),
        /EGC Guardian BLOCKED/
      );
      assert.strictEqual(output.args.command, 'rm -rf /', 'must not rewrite a command that gets blocked');
    })) passed++; else failed++;

    if (test('allows a safe command through unmodified when the Crusher has no CLI to route through', async () => {
      const hooks = await EgcGuardianCrusher({ directory: tempDir });
      const output = { args: { command: 'git status' } };
      await hooks['tool.execute.before']({ tool: 'bash' }, output);
      assert.strictEqual(output.args.command, 'git status');
    })) passed++; else failed++;

    if (test('rewrites a crushable safe command through `egc run` when the Crusher CLI is available', async () => {
      process.env.EGC_ASSUME_EGC_CLI = '1';
      try {
        const hooks = await EgcGuardianCrusher({ directory: tempDir });
        const output = { args: { command: 'npm test' } };
        await hooks['tool.execute.before']({ tool: 'bash' }, output);
        assert.strictEqual(output.args.command, 'egc run npm test');
      } finally {
        process.env.EGC_ASSUME_EGC_CLI = '0';
      }
    })) passed++; else failed++;
  } finally {
    if (originalGuardianCli === undefined) delete process.env.EGC_GUARDIAN_CLI;
    else process.env.EGC_GUARDIAN_CLI = originalGuardianCli;
    if (originalAssumeEgcCli === undefined) delete process.env.EGC_ASSUME_EGC_CLI;
    else process.env.EGC_ASSUME_EGC_CLI = originalAssumeEgcCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
