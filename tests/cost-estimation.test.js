'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');

const MOCK_PRICES = {
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  'gemini-2.0-flash':  { input: 0.10,  output: 0.40,  cacheRead: 0.025, cacheWrite: 0.00  },
  '_default_claude':   { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  '_default_gemini':   { input: 0.10,  output: 0.40,  cacheRead: 0.025, cacheWrite: 0.00  },
  '_default_codex':    { input: 2.50,  output: 10.00, cacheRead: 1.25,  cacheWrite: 0.00  },
};
const IDE_PRICE_KEY = { claude:'_default_claude', gemini:'_default_gemini', codex:'_default_codex' };

function calcCost(ide, tokens, model, prices = MOCK_PRICES) {
  const pricing = prices[model] || prices[IDE_PRICE_KEY[ide]];
  if (!pricing) return null;
  return (tokens.input      || 0) * (pricing.input      || 0) / 1e6
       + (tokens.output     || 0) * (pricing.output     || 0) / 1e6
       + (tokens.cacheRead  || 0) * (pricing.cacheRead  || 0) / 1e6
       + (tokens.cacheWrite || 0) * (pricing.cacheWrite || 0) / 1e6;
}

test('claude 1M+1M = $18.00',       () => assert.equal(calcCost('claude',{input:1e6,output:1e6},          'claude-sonnet-4-6').toFixed(2), '18.00'));
test('gemini 1M+1M = $0.50',        () => assert.equal(calcCost('gemini',{input:1e6,output:1e6},          'gemini-2.0-flash').toFixed(2),  '0.50'));
test('codex default = $12.50',       () => assert.equal(calcCost('codex', {input:1e6,output:1e6},          null).toFixed(2),                '12.50'));
test('zero tokens = 0',              () => assert.equal(calcCost('claude',{input:0, output:0},             'claude-sonnet-4-6'),             0));
test('unknown IDE = null',           () => assert.equal(calcCost('unknown',{input:1e6},                    null),                           null));
test('doubling tokens doubles cost', () => assert.equal((calcCost('claude',{input:2e6,output:2e6},'claude-sonnet-4-6') / calcCost('claude',{input:1e6,output:1e6},'claude-sonnet-4-6')).toFixed(2), '2.00'));
