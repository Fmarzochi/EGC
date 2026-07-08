'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { projectSlug } = require('./branch-state');

const RECEIPT_SCHEMA_VERSION = 'egc.verify.v1';
const VERIFY_DIR_ENV = 'EGC_VERIFY_DIR';

function resolveVerifyDir(options = {}) {
  if (options.baseDir) {
    return options.baseDir;
  }
  if (process.env[VERIFY_DIR_ENV]) {
    return process.env[VERIFY_DIR_ENV];
  }
  return path.join(os.homedir(), '.egc', 'verify');
}

function receiptPath(projectPath, options = {}) {
  return path.join(resolveVerifyDir(options), `${projectSlug(projectPath)}.json`);
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout;
}

/**
 * Binds a verification result to the exact working-tree content: HEAD
 * commit plus the porcelain status and the diff against HEAD. Any change
 * to tracked content after a verify run produces a different fingerprint.
 * Returns null outside a git repository or before the first commit.
 */
function computeTreeFingerprint(projectPath) {
  const head = runGit(projectPath, ['rev-parse', 'HEAD']);
  if (head === null) {
    return null;
  }
  const status = runGit(projectPath, ['status', '--porcelain']) || '';
  const diff = runGit(projectPath, ['diff', 'HEAD']) || '';

  return crypto.createHash('sha256')
    .update(head)
    .update('\0')
    .update(status)
    .update('\0')
    .update(diff)
    .digest('hex');
}

function writeReceipt(projectPath, data, options = {}) {
  const filePath = receiptPath(projectPath, options);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    projectPath,
    fingerprint: computeTreeFingerprint(projectPath),
    ...data,
    finishedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return receipt;
}

function readReceipt(projectPath, options = {}) {
  const filePath = receiptPath(projectPath, options);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Evaluates the stored receipt against the current tree.
 * Statuses: "unbound" (not a git repo or no HEAD, gate cannot bind),
 * "missing" (no receipt yet), "stale" (tree changed since the run),
 * "failed" (last run did not pass), "ok".
 */
function evaluateReceipt(projectPath, options = {}) {
  const fingerprint = computeTreeFingerprint(projectPath);
  if (fingerprint === null) {
    return { status: 'unbound', receipt: null };
  }

  const receipt = readReceipt(projectPath, options);
  if (!receipt) {
    return { status: 'missing', receipt: null };
  }
  if (receipt.fingerprint !== fingerprint) {
    return { status: 'stale', receipt };
  }
  if (receipt.exitCode !== 0) {
    return { status: 'failed', receipt };
  }
  return { status: 'ok', receipt };
}

module.exports = {
  RECEIPT_SCHEMA_VERSION,
  VERIFY_DIR_ENV,
  computeTreeFingerprint,
  evaluateReceipt,
  readReceipt,
  receiptPath,
  writeReceipt,
};
