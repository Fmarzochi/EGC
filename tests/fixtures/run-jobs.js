'use strict';

/**
 * The worker pool behind `node tests/run-all.js --jobs N` (opt-in; the plain
 * command stays serial). Each test file is its own process, so the pool only
 * decides how many run at once and gives each one a private home and temp
 * folder. EGC_DIR stays unset, as in the serial run: tests/fixtures/suite-env.js
 * clears it so that the home alone decides where a file lands, and the private
 * home keeps that true per file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { removeDirWithRetries } = require('./remove-dir');

const MAX_JOBS = 64;

function flagValue(argv, name) {
  const index = argv.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return null;
  const arg = argv[index];
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : (argv[index + 1] ?? '');
}

function parseJobsFlag(argv) {
  const value = flagValue(argv, '--jobs');
  if (value === null) return null;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_JOBS) {
    throw new Error(`--jobs needs a whole number from 1 to ${MAX_JOBS}, e.g. --jobs 4`);
  }
  return Number(value);
}

function parseReportFlag(argv) {
  const value = flagValue(argv, '--report');
  if (value === null) return null;
  if (!value || value.startsWith('--')) {
    throw new Error('--report needs a file path, e.g. --report report.json');
  }
  return value;
}

function compareNames(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// Longest first by file size, the one number known before a file has run, so a
// slow file starts early instead of finishing last and alone.
function orderLongestFirst(files, sizeOf) {
  return [...files].sort((a, b) => sizeOf(b) - sizeOf(a) || compareNames(a, b));
}

function privateEnv(baseEnv, dir) {
  const home = path.join(dir, 'home');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  return { ...baseEnv, HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
}

function runNode(testPath, env) {
  return new Promise(resolve => {
    const startedAt = process.hrtime.bigint();
    const chunks = { out: [], err: [] };
    let error = null;
    const child = spawn(process.execPath, [testPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', data => chunks.out.push(data));
    child.stderr.setEncoding('utf8').on('data', data => chunks.err.push(data));
    child.on('error', spawnError => { error = spawnError; });
    child.on('close', status => resolve({
      status,
      error,
      stdout: chunks.out.join(''),
      stderr: chunks.err.join(''),
      ms: Number((process.hrtime.bigint() - startedAt) / 1000000n)
    }));
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

async function runInPrivateEnv(testPath, baseEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-suite-job-'));
  try {
    return await runNode(testPath, privateEnv(baseEnv, dir));
  } finally {
    removeDirWithRetries(dir);
  }
}

function didFail(result) {
  return Boolean(result.error) || result.status !== 0;
}

async function runPool(items, jobs, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, lane));
  return results;
}

module.exports = {
  MAX_JOBS,
  parseJobsFlag,
  parseReportFlag,
  orderLongestFirst,
  privateEnv,
  runNode,
  runInPrivateEnv,
  didFail,
  runPool
};
