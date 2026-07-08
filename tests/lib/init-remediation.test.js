/**
 * Tests for scripts/lib/init-remediation.js
 */

const assert = require('assert');

const { planDriftReinstalls } = require('../../scripts/lib/init-remediation');

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

function buildResult(overrides = {}) {
  return {
    adapter: { id: 'claude-home', target: 'claude', kind: 'home' },
    state: {
      request: {
        profile: 'full',
        modules: [],
        includeComponents: [],
        excludeComponents: [],
        legacyMode: false,
      },
    },
    issues: [{ severity: 'warning', code: 'resolution-drift', message: 'drift' }],
    ...overrides,
  };
}

function main() {
  let passed = 0;
  let failed = 0;

  console.log('Testing init-remediation...\n');

  if (test('plans a profile reinstall for a drifted non-legacy target', () => {
    const plans = planDriftReinstalls({ results: [buildResult()] });
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].adapterId, 'claude-home');
    assert.strictEqual(plans[0].target, 'claude');
    assert.deepStrictEqual(plans[0].args, ['--target', 'claude', '--profile', 'full']);
  })) passed++; else failed++;

  if (test('plans a modules reinstall when no profile is recorded', () => {
    const result = buildResult();
    result.state.request.profile = null;
    result.state.request.modules = ['hooks-runtime', 'database'];
    const plans = planDriftReinstalls({ results: [result] });
    assert.strictEqual(plans.length, 1);
    assert.deepStrictEqual(
      plans[0].args,
      ['--target', 'claude', '--modules', 'hooks-runtime,database']
    );
  })) passed++; else failed++;

  if (test('carries include and exclude components into the plan', () => {
    const result = buildResult();
    result.state.request.includeComponents = ['alpha'];
    result.state.request.excludeComponents = ['beta'];
    const plans = planDriftReinstalls({ results: [result] });
    assert.deepStrictEqual(
      plans[0].args,
      ['--target', 'claude', '--profile', 'full', '--with', 'alpha', '--without', 'beta']
    );
  })) passed++; else failed++;

  if (test('skips legacy states, healthy targets, and empty requests', () => {
    const legacy = buildResult();
    legacy.state.request.legacyMode = true;

    const healthy = buildResult({ issues: [] });

    const otherIssue = buildResult({
      issues: [{ severity: 'warning', code: 'drifted-managed-files', message: 'files' }],
    });

    const emptyRequest = buildResult();
    emptyRequest.state.request.profile = null;
    emptyRequest.state.request.modules = [];

    const missingState = buildResult({ state: null });

    const plans = planDriftReinstalls({
      results: [legacy, healthy, otherIssue, emptyRequest, missingState],
    });
    assert.strictEqual(plans.length, 0);
  })) passed++; else failed++;

  if (test('returns no plans for empty or malformed reports', () => {
    assert.deepStrictEqual(planDriftReinstalls(null), []);
    assert.deepStrictEqual(planDriftReinstalls({}), []);
    assert.deepStrictEqual(planDriftReinstalls({ results: 'invalid' }), []);
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
