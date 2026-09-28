'use strict';

/**
 * The cost figures EGC's trackers estimate with, kept in one place: the
 * per-million-token rates of each model tier (the cost-tracker hook) and the
 * tokens a tool call is estimated to spend, priced at one blended rate (the
 * budget tracker). Approximate and conservative by design.
 */

// Per-million-token rates of each model tier, in US dollars.
const MODEL_TIER_RATES = {
  lite: { in: 0.8, out: 4.0 },
  flash: { in: 3.0, out: 15.0 },
  pro: { in: 15.0, out: 75.0 },
};

// The blended per-million-token rate a tool call is priced at, and the
// tokens each tool is estimated to spend.
const TOOL_CALL_RATE_PER_MILLION = 2.0;
const TOOL_CALL_TOKENS = { Read: 500, Write: 1500, Edit: 2000, Bash: 3000, Glob: 300, Grep: 800, Task: 10000 };
const DEFAULT_TOOL_CALL_TOKENS = 1000;

const roundMicro = value => Math.round(value * 1e6) / 1e6;

// The tier a model name falls in: lite, pro, or flash by default.
function modelTier(model) {
  const normalized = String(model || '').toLowerCase();
  if (normalized.includes('lite') || normalized.includes('8b') || normalized.includes('haiku')) return 'lite';
  if (normalized.includes('pro') || normalized.includes('ultra') || normalized.includes('opus')) return 'pro';
  return 'flash';
}

function estimateModelCost(model, inputTokens, outputTokens) {
  const rates = MODEL_TIER_RATES[modelTier(model)];
  return roundMicro((inputTokens / 1_000_000) * rates.in + (outputTokens / 1_000_000) * rates.out);
}

// The tokens and the cost a call of `toolName` is estimated at; a name the
// table does not list (a prototype key such as `constructor` included) gets
// the default.
function toolCallEstimate(toolName) {
  const tokens = Object.hasOwn(TOOL_CALL_TOKENS, toolName) ? TOOL_CALL_TOKENS[toolName] : DEFAULT_TOOL_CALL_TOKENS;
  return { tokens, cost: roundMicro((tokens / 1_000_000) * TOOL_CALL_RATE_PER_MILLION) };
}

module.exports = {
  MODEL_TIER_RATES,
  TOOL_CALL_RATE_PER_MILLION,
  TOOL_CALL_TOKENS,
  DEFAULT_TOOL_CALL_TOKENS,
  modelTier,
  estimateModelCost,
  toolCallEstimate,
};
