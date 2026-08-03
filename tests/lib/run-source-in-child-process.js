'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Writes `source` to a throwaway .js file and runs it via `node` in a child
 * process, so a process.exit() call inside the code under test doesn't kill
 * the parent test runner. Shared by tests/ci/validators.test.js (validator
 * scripts) and tests/lib/validator-cli.test.js (the shared
 * skipIfMissing/finishValidation helpers those validators delegate to) --
 * both previously kept their own copy of this same temp-file + execFileSync +
 * error-code + finally-unlink scaffolding (cubic review, EGC-539 PR #1151).
 * @param {string} source - full Node.js source to execute
 * @param {object} [options]
 * @param {string} [options.cwd] - directory to write the temp file into and run from; defaults to the repo root
 * @param {string} [options.filePrefix] - temp filename prefix, so concurrent suites can't collide on the same name
 * @param {Record<string,string>} [options.env] - extra environment variables merged over process.env
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function runSourceInChildProcess(source, options = {}) {
  const cwd = options.cwd || path.join(__dirname, '..', '..');
  const filePrefix = options.filePrefix || '.tmp-child-process-test-';
  const tmpFile = path.join(cwd, `${filePrefix}${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  try {
    fs.writeFileSync(tmpFile, source, 'utf8');
    const stdout = execFileSync('node', [tmpFile], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
      cwd,
      env: { ...process.env, ...(options.env || {}) },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore cleanup errors */ }
  }
}

module.exports = { runSourceInChildProcess };
