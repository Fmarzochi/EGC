/**
 * The cost figures both trackers estimate with come from one module
 * (scripts/lib/llm-costs.js): the model tiers the cost-tracker hook prices a
 * session with, and the tool-call estimates the budget tracker counts.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const costs = require('../../scripts/lib/llm-costs');
const { getToolCost } = require('../../scripts/lib/budget-tracker');

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
  console.log('\n=== Testing the shared cost figures ===\n');
  let passed = 0;
  let failed = 0;
  const tally = ok => (ok ? passed++ : failed++);

  tally(test('a model name falls in its tier, flash by default', () => {
    for (const [model, tier] of [
      ['gemini-2.5-flash-lite', 'lite'], ['gemini-1.5-flash-8b', 'lite'], ['claude-haiku-4-5', 'lite'],
      ['gemini-2.5-pro', 'pro'], ['gemini-ultra', 'pro'], ['claude-opus-4-6', 'pro'],
      ['gemini-2.5-flash', 'flash'], ['', 'flash'], [undefined, 'flash'], ['some-new-model', 'flash'],
    ]) {
      assert.strictEqual(costs.modelTier(model), tier, String(model));
    }
  }));

  tally(test('a session is priced at its tier per million tokens, to the micro-dollar', () => {
    assert.strictEqual(costs.estimateModelCost('gemini-2.5-flash', 1_000_000, 1_000_000), 18);
    assert.strictEqual(costs.estimateModelCost('claude-opus-4-6', 2_000_000, 0), 30);
    assert.strictEqual(costs.estimateModelCost('claude-haiku-4-5', 0, 1_000_000), 4);
    assert.strictEqual(costs.estimateModelCost('gemini-2.5-flash', 1, 1), 0.000018);
  }));

  tally(test('a tool call is estimated at its tokens, priced at the one blended rate', () => {
    for (const [tool, tokens] of Object.entries(costs.TOOL_CALL_TOKENS)) {
      assert.deepStrictEqual(costs.toolCallEstimate(tool), { tokens, cost: tokens * costs.TOOL_CALL_RATE_PER_MILLION / 1_000_000 }, tool);
    }
    assert.deepStrictEqual(costs.toolCallEstimate('Bash'), { tokens: 3000, cost: 0.006 });
  }));

  tally(test('a tool the table does not list, a prototype key included, gets the default', () => {
    const fallback = { tokens: costs.DEFAULT_TOOL_CALL_TOKENS, cost: costs.DEFAULT_TOOL_CALL_TOKENS * costs.TOOL_CALL_RATE_PER_MILLION / 1_000_000 };
    for (const tool of ['WebFetch', 'constructor', 'toString', '__proto__', undefined]) {
      assert.deepStrictEqual(costs.toolCallEstimate(tool), fallback, String(tool));
    }
  }));

  tally(test('both trackers take their figures from this module and keep no table of their own', () => {
    assert.deepStrictEqual(getToolCost('Edit'), costs.toolCallEstimate('Edit'));
    assert.deepStrictEqual(getToolCost('constructor'), costs.toolCallEstimate('constructor'));
    const root = path.join(__dirname, '..', '..');
    const hook = fs.readFileSync(path.join(root, 'scripts', 'hooks', 'cost-tracker.js'), 'utf8');
    const budget = fs.readFileSync(path.join(root, 'scripts', 'lib', 'budget-tracker.js'), 'utf8');
    assert.match(hook, /require\('\.\.\/lib\/llm-costs'\)/);
    assert.match(budget, /require\('\.\/llm-costs'\)/);
    assert.doesNotMatch(hook, /\bin:\s*\d/, 'cost-tracker keeps no rate table');
    assert.doesNotMatch(budget, /\btokens:\s*\d+,\s*cost:/, 'budget-tracker keeps no tool table');
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
