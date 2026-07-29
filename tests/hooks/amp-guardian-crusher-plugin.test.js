/**
 * Tests for scripts/hooks/amp-guardian-crusher-plugin.ts
 *
 * Amp (Sourcegraph) loads this plugin IN-PROCESS from .amp/plugins/*.ts
 * (project) or ~/.config/amp/plugins/*.ts (home), executed by Amp's own
 * Bun runtime (confirmed against https://ampcode.com/manual/plugin-api,
 * design reviewed with the Multica squad -- EGC-507). Same in-process
 * pattern as OpenCode's plugin: no stdin/stdout translation adapter, this
 * file requires the shared run() functions directly.
 *
 * Requires `bun` on PATH to actually execute the .ts plugin (Amp's real
 * runtime) -- skips gracefully everywhere else, same as this repo's other
 * build-artifact-dependent tests.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');
const pluginSource = path.join(repoRoot, 'scripts', 'hooks', 'amp-guardian-crusher-plugin.ts');

function bunAvailable() {
  const result = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

// Without this build, runGuardian() fails open (returns { exitCode: 0 }),
// same fallback every other Guardian-dependent test in this repo checks for
// (tests/guardian-smart-crusher.test.js et al.) -- so this test would
// falsely observe 'allow' on the destructive-command case.
const guardianBuildPath = path.join(repoRoot, 'mcp', 'servers', 'egc-guardian', 'build', 'guardian-cli.js');

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

const tempRoots = [];

// Reproduces the exact layout createAmpGuardianCrusherOperations installs:
// <root>/plugins/egc-guardian-crusher.ts requiring
// <root>/scripts/hooks|lib/... as siblings one level up -- not the plugin's
// own source-tree location, which has a different relative structure and
// would MODULE_NOT_FOUND (confirmed empirically while building this test).
function buildInstalledLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-amp-plugin-test-'));
  tempRoots.push(root);

  const pluginDestination = path.join(root, 'plugins', 'egc-guardian-crusher.ts');
  fs.mkdirSync(path.dirname(pluginDestination), { recursive: true });
  fs.copyFileSync(pluginSource, pluginDestination);

  for (const relativePath of [
    'scripts/hooks/pre-bash-guardian-validate.js',
    'scripts/lib/guardian-bin.js',
    'scripts/lib/shell-split.js',
    'scripts/hooks/pre-bash-crusher-rewrite.js',
    'scripts/lib/crusher/engine.js',
  ]) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relativePath), destination);
  }

  return pluginDestination;
}

function cleanupTempRoots() {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A tiny Bun ESM harness that mimics Amp's own plugin loader: import the
// default export, call it with a fake `amp` (on/helpers), then drive the
// registered tool.call handler through allow/deny/modify/non-shell cases.
// Runs as a temp .mjs file so `bun <file>` executes it directly.
function runPluginHarness(pluginPath, toolEvent) {
  const harnessPath = path.join(os.tmpdir(), `egc-amp-harness-${process.pid}-${Date.now()}.mjs`);
  const harnessSource = `
    const pluginModule = (await import(${JSON.stringify(pluginPath)})).default;
    let handler = null;
    const fakeAmp = {
      on(name, fn) { handler = fn; },
      helpers: {
        shellCommandFromToolCall(event) {
          if (event.tool !== 'Bash' && event.tool !== 'shell_command') return null;
          if (typeof event.input?.command !== 'string') return null;
          return { command: event.input.command, dir: event.input.dir };
        },
      },
    };
    pluginModule(fakeAmp);
    const result = await handler(${JSON.stringify(toolEvent)});
    process.stdout.write(JSON.stringify(result));
  `;
  fs.writeFileSync(harnessPath, harnessSource);
  try {
    const result = spawnSync('bun', [harnessPath], {
      encoding: 'utf8',
      env: { ...process.env, EGC_ASSUME_EGC_CLI: '1' },
      timeout: 15000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`bun harness failed: ${result.error?.message || result.stderr}`);
    }
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(harnessPath, { force: true });
  }
}

function runTests() {
  console.log('\n=== Testing amp-guardian-crusher-plugin ===\n');

  if (!bunAvailable()) {
    console.log('  [SKIP] bun not found on PATH -- this is Amp\'s actual runtime, cannot verify without it');
    process.exit(0);
  }

  if (!fs.existsSync(guardianBuildPath)) {
    console.log('  [SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
    process.exit(0);
  }

  let passed = 0;
  let failed = 0;
  const pluginPath = buildInstalledLayout();

  if (test('allows a safe Bash command', () => {
    const result = runPluginHarness(pluginPath, { tool: 'Bash', input: { command: 'git status' } });
    assert.deepStrictEqual(result, { action: 'allow' });
  })) passed++; else failed++;

  if (test('blocks a destructive Bash command via reject-and-continue', () => {
    const result = runPluginHarness(pluginPath, { tool: 'Bash', input: { command: 'rm -rf /' } });
    assert.strictEqual(result.action, 'reject-and-continue');
    assert.ok(result.message && result.message.length > 0);
  })) passed++; else failed++;

  if (test('rewrites a crushable command via modify', () => {
    const result = runPluginHarness(pluginPath, { tool: 'Bash', input: { command: 'git log --stat -n 300' } });
    assert.strictEqual(result.action, 'modify');
    assert.strictEqual(result.input.command, 'egc run git log --stat -n 300');
  })) passed++; else failed++;

  if (test('leaves a non-shell tool call untouched', () => {
    const result = runPluginHarness(pluginPath, { tool: 'edit_file', input: { path: '/foo' } });
    assert.deepStrictEqual(result, { action: 'allow' });
  })) passed++; else failed++;

  cleanupTempRoots();

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
