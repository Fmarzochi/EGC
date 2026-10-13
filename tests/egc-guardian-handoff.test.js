'use strict';
/**
 * prepare_handoff builds a bounded context packet for a subagent: it ranks
 * excerpts by relevance to the objective, drops exact and near-duplicate
 * chunks, keeps critical chunks whole, and fits everything else inside
 * context_budget_tokens, truncating (never silently discarding) when the
 * budget runs out.
 *
 * Run with: node tests/egc-guardian-handoff.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'handoff.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const {
  prepareHandoff,
  estimateTokens,
  truncateToTokens,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  MIN_CONTEXT_BUDGET_TOKENS,
  MAX_CONTEXT_BUDGET_TOKENS,
  MIN_OUTPUT_BUDGET_TOKENS,
  MAX_OUTPUT_BUDGET_TOKENS,
} = require(buildPath);

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.stack || err.message}`);
    failed++;
  }
}

run('estimateTokens: empty string is zero, otherwise chars/4 rounded up', () => {
  assert.strictEqual(estimateTokens(''), 0);
  assert.strictEqual(estimateTokens('abcd'), 1);
  assert.strictEqual(estimateTokens('abcde'), 2);
});

run('truncateToTokens: text under budget is untouched', () => {
  assert.strictEqual(truncateToTokens('short', 100), 'short');
});

run('truncateToTokens: text over budget is cut with a marker, never left over budget', () => {
  const text = 'line one\nline two\nline three\nline four\n'.repeat(10);
  const out = truncateToTokens(text, 20);
  assert.ok(out.endsWith('[truncated]'));
  assert.ok(estimateTokens(out) <= 20 + 5);
});

run('rejects an empty objective', () => {
  assert.throws(() => prepareHandoff({ objective: '   ' }), RangeError);
});

run('rejects a context_budget_tokens outside the allowed range', () => {
  assert.throws(() => prepareHandoff({ objective: 'x', context_budget_tokens: MIN_CONTEXT_BUDGET_TOKENS - 1 }), RangeError);
  assert.throws(() => prepareHandoff({ objective: 'x', context_budget_tokens: MAX_CONTEXT_BUDGET_TOKENS + 1 }), RangeError);
  assert.throws(() => prepareHandoff({ objective: 'x', context_budget_tokens: 1.5 }), RangeError);
});

run('rejects an output_budget_tokens outside the allowed range', () => {
  assert.throws(() => prepareHandoff({ objective: 'x', output_budget_tokens: MIN_OUTPUT_BUDGET_TOKENS - 1 }), RangeError);
  assert.throws(() => prepareHandoff({ objective: 'x', output_budget_tokens: MAX_OUTPUT_BUDGET_TOKENS + 1 }), RangeError);
});

run('defaults context_budget_tokens when omitted', () => {
  const result = prepareHandoff({ objective: 'do the thing' });
  assert.strictEqual(result.metrics.context_budget_tokens, DEFAULT_CONTEXT_BUDGET_TOKENS);
  assert.strictEqual(result.metrics.output_budget_tokens, null);
});

run('empty chunks still produces a well-formed packet with objective and response format', () => {
  const result = prepareHandoff({ objective: 'investigate the login bug' });
  assert.ok(result.packet.includes('## Objective\ninvestigate the login bug'));
  assert.ok(result.packet.includes('## Response format'));
  assert.strictEqual(result.metrics.chunks_received, 0);
  assert.strictEqual(result.metrics.chunks_included, 0);
});

run('ranks chunks by relevance to the objective, most relevant first', () => {
  const result = prepareHandoff({
    objective: 'fix the payment charge card bug',
    chunks: [
      { text: 'function unrelatedHelper() { return formatDate(new Date()); }', source: 'date-utils.ts' },
      { text: 'function chargeCard(amount) { return gateway.charge(amount); }', source: 'billing/payments.ts' },
    ],
  });
  const order = result.packet.indexOf('billing/payments.ts');
  const otherOrder = result.packet.indexOf('date-utils.ts');
  assert.ok(order >= 0 && otherOrder >= 0);
  assert.ok(order < otherOrder, 'more relevant chunk should appear first');
});

run('critical chunks are always included even when they rank low', () => {
  const result = prepareHandoff({
    objective: 'fix the payment charge card bug',
    chunks: [
      { text: 'important constraint: never retry a charge without idempotency key', source: 'NOTES.md', critical: true },
      { text: 'function chargeCard(amount) { return gateway.charge(amount); }', source: 'billing/payments.ts' },
    ],
  });
  assert.ok(result.packet.includes('idempotency key'));
  assert.strictEqual(result.metrics.critical_chunks, 1);
});

run('exact duplicate chunks are deduplicated', () => {
  const text = 'function chargeCard(amount) { return gateway.charge(amount); }';
  const result = prepareHandoff({
    objective: 'fix billing',
    chunks: [
      { text, source: 'a.ts' },
      { text, source: 'b.ts' },
    ],
  });
  assert.strictEqual(result.metrics.duplicates_removed, 1);
  assert.strictEqual(result.metrics.chunks_included, 1);
});

run('near-duplicate chunks (same tokens, different whitespace/case) are deduplicated', () => {
  const result = prepareHandoff({
    objective: 'fix billing',
    chunks: [
      { text: 'function chargeCard(amount) {\n  return gateway.charge(amount);\n}', source: 'a.ts' },
      { text: 'FUNCTION CHARGECARD(AMOUNT) { RETURN GATEWAY.CHARGE(AMOUNT); }', source: 'b.ts' },
    ],
  });
  assert.strictEqual(result.metrics.duplicates_removed, 1);
});

run('a critical duplicate survives over its non-critical twin', () => {
  const text = 'function chargeCard(amount) { return gateway.charge(amount); }';
  const result = prepareHandoff({
    objective: 'fix billing',
    chunks: [
      { text, source: 'non-critical.ts' },
      { text, source: 'critical.ts', critical: true },
    ],
  });
  assert.ok(result.packet.includes('critical.ts'));
  assert.ok(!result.packet.includes('non-critical.ts'));
});

run('low-ranked chunks that do not fit the budget are excluded, not discarded silently', () => {
  const big = 'x'.repeat(4000);
  const result = prepareHandoff({
    objective: 'alpha',
    context_budget_tokens: MIN_CONTEXT_BUDGET_TOKENS,
    chunks: [
      { text: `alpha alpha alpha ${big}`, source: 'relevant.ts' },
      { text: `unrelated content ${big} zzz`, source: 'irrelevant.ts' },
    ],
  });
  assert.ok(result.metrics.chunks_excluded >= 1);
  assert.ok(result.omitted_sources.length >= 1);
  assert.ok(result.warnings.some(w => w.includes('did not fit the budget')));
  assert.ok(result.metrics.context_truncated);
});

run('a single oversized chunk is partially included and truncated rather than dropped entirely', () => {
  const huge = 'alpha '.repeat(5000);
  const result = prepareHandoff({
    objective: 'alpha',
    context_budget_tokens: MIN_CONTEXT_BUDGET_TOKENS,
    chunks: [{ text: huge, source: 'only.ts' }],
  });
  assert.strictEqual(result.metrics.chunks_truncated, 1);
  assert.ok(result.packet.includes('only.ts'));
  assert.ok(result.packet.includes('[truncated]'));
});

run('critical context that alone exceeds the budget is kept whole and flagged, never cut', () => {
  const huge = 'critical fact '.repeat(5000);
  const result = prepareHandoff({
    objective: 'alpha',
    context_budget_tokens: MIN_CONTEXT_BUDGET_TOKENS,
    chunks: [{ text: huge, source: 'critical.ts', critical: true }],
  });
  assert.ok(result.packet.includes('critical fact'));
  assert.ok(!result.packet.includes('[truncated]'));
  assert.ok(result.metrics.budget_exceeded_by_critical_tokens > 0);
  assert.ok(result.warnings.some(w => w.includes('Critical context alone')));
});

run('parent_summary is truncated when it would blow the budget, and flagged', () => {
  const longSummary = 'decision: '.repeat(3000);
  const result = prepareHandoff({
    objective: 'alpha',
    context_budget_tokens: MIN_CONTEXT_BUDGET_TOKENS,
    parent_summary: longSummary,
  });
  assert.strictEqual(result.metrics.parent_summary_truncated, true);
  assert.ok(result.warnings.some(w => w.includes('parent_summary')));
});

run('scope_paths, constraints and completion_criteria are rendered as their own sections', () => {
  const result = prepareHandoff({
    objective: 'alpha',
    scope_paths: ['src/billing/payments.ts'],
    constraints: ['never log card numbers'],
    completion_criteria: ['all tests pass', 'no new lint errors'],
  });
  assert.ok(result.packet.includes('## Scope'));
  assert.ok(result.packet.includes('src/billing/payments.ts'));
  assert.ok(result.packet.includes('## Constraints and decisions to preserve'));
  assert.ok(result.packet.includes('never log card numbers'));
  assert.ok(result.packet.includes('## Completion criteria'));
  assert.ok(result.packet.includes('all tests pass'));
});

run('response format section always present, mentions output_budget_tokens when given', () => {
  const withBudget = prepareHandoff({ objective: 'alpha', output_budget_tokens: 500 });
  assert.ok(withBudget.packet.includes('## Response format'));
  assert.ok(withBudget.packet.includes('500'));
  const withoutBudget = prepareHandoff({ objective: 'alpha' });
  assert.ok(withoutBudget.packet.includes('## Response format'));
});

run('metrics report before/after token estimates and a reduction percentage', () => {
  const result = prepareHandoff({
    objective: 'alpha',
    chunks: [{ text: 'alpha '.repeat(200), source: 'a.ts' }],
  });
  assert.ok(result.metrics.tokens_before_estimate > 0);
  assert.ok(result.metrics.tokens_after_estimate > 0);
  assert.strictEqual(typeof result.metrics.reduction_pct, 'number');
  assert.ok(result.metrics.estimation.toLowerCase().includes('estimate'));
});

run('duplicate scope_paths are deduplicated in the Scope section', () => {
  const result = prepareHandoff({
    objective: 'alpha',
    scope_paths: ['src/a.ts', 'src/a.ts'],
  });
  const matches = result.packet.match(/src\/a\.ts/g) ?? [];
  assert.strictEqual(matches.length, 1);
});

run('whitespace-only chunk text is dropped as empty', () => {
  const result = prepareHandoff({
    objective: 'alpha',
    chunks: [{ text: '   \n\n  ', source: 'blank.ts' }],
  });
  assert.strictEqual(result.metrics.chunks_received, 1);
  assert.strictEqual(result.metrics.chunks_included, 0);
  assert.ok(!result.packet.includes('blank.ts'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
