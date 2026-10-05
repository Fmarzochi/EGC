'use strict';

function recallAtK(rankedPaths, expectedPaths, k) {
  if (expectedPaths.length === 0) return 1;
  const top = new Set(rankedPaths.slice(0, k));
  const hit = expectedPaths.filter(p => top.has(p)).length;
  return hit / expectedPaths.length;
}

function reciprocalRank(rankedPaths, expectedPaths) {
  const expected = new Set(expectedPaths);
  const idx = rankedPaths.findIndex(p => expected.has(p));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

module.exports = { recallAtK, reciprocalRank, percentile, estimateTokens, mean };
