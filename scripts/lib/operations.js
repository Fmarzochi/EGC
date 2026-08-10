'use strict';

/**
 * EGC Operations Library (Slice 1 & 3)
 * Provides token-gated operation handlers for panel and API routes.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { readAll, aggregateBreakdown, metricsFilePath } = require('./crusher/metrics');

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
    return false; // Fail closed by default if no token is configured
  }

  const expectedTrimmed = expectedToken.trim();

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

  if (!token) {
    return false;
  }

  const a = Buffer.from(String(token));
  const b = Buffer.from(expectedTrimmed);

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

/**
 * Constrains a caller-supplied ledger path to the configured metrics ledger directory.
 * Resolves relative to the directory containing metricsFilePath() and rejects any path outside it.
 */
function resolveSafeLedgerPath(targetPath) {
  const defaultPath = path.resolve(metricsFilePath());
  if (!targetPath || typeof targetPath !== 'string') {
    return defaultPath;
  }
  const baseDir = path.dirname(defaultPath);
  const resolved = path.resolve(baseDir, targetPath);

  if (resolved === defaultPath) {
    return resolved;
  }

  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null; // Reject: path is outside the allowed metrics directory
  }

  return resolved;
}

/**
 * Operation handler: Read operation over aggregateBreakdown for egc gain.
 * Reads the crusher metrics ledger and aggregates by time and scope ranges.
 */
function getGainBreakdown(options = {}) {
  const rawPath = options.ledgerPath || options.filePath;
  const safePath = resolveSafeLedgerPath(rawPath);
  if (!safePath) {
    return aggregateBreakdown([], options);
  }
  const entries = readAll(safePath);
  return aggregateBreakdown(entries, options);
}

module.exports = {
  validateOpsToken,
  getGainBreakdown,
  resolveSafeLedgerPath,
};

