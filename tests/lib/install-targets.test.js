/**
 * Tests for scripts/lib/install-targets/registry.js
 */

const assert = require('assert');
const path = require('path');

const {
  getInstallTargetAdapter,
  listInstallTargetAdapters,
  planInstallTargetScaffold,
} = require('../../scripts/lib/install-targets/registry');

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

function runTests() {
  console.log('\n=== Testing install-target adapters ===\n');

  let passed = 0;
  let failed = 0;

  if (test('lists supported target adapters', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(adapter => adapter.target);
    assert.ok(targets.includes('claude'), 'Should include claude target');
    assert.ok(targets.includes('cursor'), 'Should include cursor target');
    assert.ok(targets.includes('antigravity'), 'Should include antigravity target');
    assert.ok(targets.includes('codex'), 'Should include codex target');
    assert.ok(targets.includes('opencode'), 'Should include opencode target');
  })) passed++; else failed++;

  if (test('resolves cursor adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('cursor');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(root, path.join(projectRoot, '.cursor'));
    assert.strictEqual(statePath, path.join(projectRoot, '.cursor', 'ecc-install-state.json'));
  })) passed++; else failed++;

  if (test('resolves claude adapter root and install-state path from home dir', () => {
    const adapter = getInstallTargetAdapter('claude');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir, repoRoot: '/repo/ecc' });
    const statePath = adapter.getInstallStatePath({ homeDir, repoRoot: '/repo/ecc' });

    assert.strictEqual(root, path.join(homeDir, '.claude'));
    assert.strictEqual(statePath, path.join(homeDir, '.claude', 'ecc', 'install-state.json'));
  })) passed++; else failed++;

  if (test('plans scaffold operations and flattens native target roots', () => {
    const repoRoot = '/repo/ecc';
    const projectRoot = '/workspace/app';
    const modules = [
      {
        id: 'platform-configs',
        paths: ['.cursor', 'mcp-configs'],
      },
      {
        id: 'rules-core',
        paths: ['rules'],
      },
    ];

    const plan = planInstallTargetScaffold({
      target: 'cursor',
      repoRoot,
      projectRoot,
      modules,
    });

    assert.strictEqual(plan.adapter.id, 'cursor-project');
    assert.strictEqual(plan.targetRoot, path.join(projectRoot, '.cursor'));
    assert.strictEqual(plan.installStatePath, path.join(projectRoot, '.cursor', 'ecc-install-state.json'));

    const flattened = plan.operations.find(operation => operation.sourceRelativePath === '.cursor');
    const preserved = plan.operations.find(operation => operation.sourceRelativePath === 'rules');

    assert.ok(flattened, 'Should include .cursor scaffold operation');
    assert.strictEqual(flattened.strategy, 'sync-root-children');
    assert.strictEqual(flattened.destinationPath, path.join(projectRoot, '.cursor'));

    assert.ok(preserved, 'Should include rules scaffold operation');
    assert.strictEqual(preserved.strategy, 'preserve-relative-path');
    assert.strictEqual(preserved.destinationPath, path.join(projectRoot, '.cursor', 'rules'));
  })) passed++; else failed++;

  if (test('throws on unknown target adapter', () => {
    assert.throws(
      () => getInstallTargetAdapter('ghost-target'),
      /Unknown install target adapter/
    );
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
