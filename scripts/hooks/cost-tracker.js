#!/usr/bin/env node
/**
 * Cost Tracker Hook
 *
 * Appends lightweight session usage metrics to ~/.gemini/metrics/costs.jsonl.
 */

'use strict';

const path = require('node:path');
const {
  ensureDir,
  appendFile,
  getEGCDir,
} = require('../lib/utils');
const { estimateModelCost } = require('../lib/llm-costs');

const MAX_STDIN = 1024 * 1024;
let raw = '';

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) {
    const remaining = MAX_STDIN - raw.length;
    raw += chunk.substring(0, remaining);
  }
});

process.stdin.on('end', () => {
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    const usage = input.usage || input.token_usage || {};
    const inputTokens = toNumber(usage.input_tokens || usage.prompt_tokens || 0);
    const outputTokens = toNumber(usage.output_tokens || usage.completion_tokens || 0);

    const model = String(input.model || input._cursor?.model || process.env.GEMINI_MODEL || 'unknown');
    const sessionId = String(process.env.EGC_SESSION_ID || process.env.ECC_SESSION_ID || 'default');

    const metricsDir = path.join(getEGCDir(), 'metrics');
    ensureDir(metricsDir);

    const row = {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: estimateModelCost(model, inputTokens, outputTokens),
    };

    appendFile(path.join(metricsDir, 'costs.jsonl'), `${JSON.stringify(row)}\n`);
  } catch {
    // Keep hook non-blocking.
  }

  process.stdout.write(raw);
});
