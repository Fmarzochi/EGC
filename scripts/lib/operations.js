'use strict';

/**
 * EGC Operations Library (Slice 1 & 3)
 * Provides token-gated operation handlers for panel and API routes.
 */

const { readAll, aggregateBreakdown } = require('./crusher/metrics');

/**
 * Validate that an incoming HTTP request satisfies the /ops token gate.
 * Checks process.env.EGC_OPS_TOKEN (or process.env.OPS_TOKEN).
 * Accepts token from:
 * 1. Header 'x-ops-token' or 'X-Ops-Token'
 * 2. Header 'authorization' ('Bearer <token>')
 * 3. Query string parameter 'token' or 'ops_token'
 */
function validateOpsToken(req) {
  const expectedToken = process.env.EGC_OPS_TOKEN || process.env.OPS_TOKEN;
  if (!expectedToken || !expectedToken.trim()) {
    return true; // No token gate set: allow local access
  }

  let token = null;
  if (req && req.headers) {
    token = req.headers['x-ops-token'] || req.headers['X-Ops-Token'];
    if (!token && req.headers['authorization']) {
      const auth = String(req.headers['authorization']);
      if (auth.startsWith('Bearer ')) {
        token = auth.slice(7).trim();
      } else {
        token = auth.trim();
      }
    }
  }

  if (!token && req && req.url) {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      token = urlObj.searchParams.get('token') || urlObj.searchParams.get('ops_token');
    } catch (_) {
      // Ignore invalid URL parse errors
    }
  }

  return token === expectedToken.trim();
}

/**
 * Operation handler: Read operation over aggregateBreakdown for egc gain.
 * Reads the crusher metrics ledger and aggregates by time and scope ranges.
 */
function getGainBreakdown(options = {}) {
  const entries = readAll(options.ledgerPath || options.filePath);
  return aggregateBreakdown(entries, options);
}

module.exports = {
  validateOpsToken,
  getGainBreakdown,
};
