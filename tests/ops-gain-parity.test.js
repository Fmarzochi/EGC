'use strict';

/**
 * Parity and integration tests for egc gain panel screen and /ops/gain operation route.
 * Verifies that for any given range (today, session, 7d, 30d, since install),
 * the panel's numbers equal egc gain's output for that range when comparing
 * both against the same fixture ledger.
 * Also verifies uniform /ops token gating.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { savingsLedger: savingsLedgerOp } = require('../scripts/lib/operations/index');
const { loadOrCreateOpsToken, validateOpsToken, createOpsHandler } = require('../dashboard/ops');

const ROOT = path.join(__dirname, '..');
const GAIN_CLI = path.join(ROOT, 'scripts', 'gain.js');

function createFixtureLedger(nowDate) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-ops-gain-test-'));
  const ledgerPath = path.join(tmpDir, 'crusher.jsonl');
  const sessionId = 'test-session-123';
  const projectPath = path.resolve(tmpDir);

  const nowMs = nowDate.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  // Ledger entries across different time spans
  const entries = [
    {
      ts: new Date(nowMs - 1000 * 60).toISOString(), // Today & Session
      kind: 'git-log',
      cmd: 'git log -n 5',
      tokensSaved: 1200,
      bytesIn: 8000,
      bytesOut: 1200,
      session: sessionId,
      project: projectPath,
    },
    {
      ts: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString(), // Today
      kind: 'npm-install',
      cmd: 'npm install',
      tokensSaved: 3500,
      bytesIn: 25000,
      bytesOut: 5000,
      session: sessionId,
      project: projectPath,
    },
    {
      ts: new Date(nowMs - 3 * dayMs).toISOString(), // Within 7d & 30d & sinceInstall
      kind: 'pytest',
      cmd: 'pytest tests/',
      tokensSaved: 8000,
      bytesIn: 45000,
      bytesOut: 9000,
      session: 'older-session',
      project: projectPath,
    },
    {
      ts: new Date(nowMs - 15 * dayMs).toISOString(), // Within 30d & sinceInstall
      kind: 'git-diff',
      cmd: 'git diff HEAD~1',
      tokensSaved: 5400,
      bytesIn: 30000,
      bytesOut: 6000,
      session: 'older-session',
      project: projectPath,
    },
    {
      ts: new Date(nowMs - 45 * dayMs).toISOString(), // Only sinceInstall
      kind: 'cargo-test',
      cmd: 'cargo test',
      tokensSaved: 15000,
      bytesIn: 100000,
      bytesOut: 20000,
      session: 'ancient-session',
      project: projectPath,
    },
  ];

  fs.writeFileSync(ledgerPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

  return { tmpDir, ledgerPath, sessionId, projectPath };
}

test('loadOrCreateOpsToken loads environment token or auto-creates token file', () => {
  const origToken = process.env.EGC_OPS_TOKEN;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-token-test-'));
  const tokenFile = path.join(tmpDir, 'ops_token');

  try {
    delete process.env.EGC_OPS_TOKEN;
    delete process.env.OPS_TOKEN;

    const token = loadOrCreateOpsToken({ tokenPath: tokenFile });
    assert.ok(token, 'Generates non-empty token');
    assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), token, 'Persists generated token to file');
    assert.equal(process.env.EGC_OPS_TOKEN, token, 'Populates process.env.EGC_OPS_TOKEN');

    // Reloading returns the existing token from environment / file
    const reloaded = loadOrCreateOpsToken({ tokenPath: tokenFile });
    assert.equal(reloaded, token, 'Reloads identical token');
  } finally {
    if (origToken !== undefined) process.env.EGC_OPS_TOKEN = origToken;
    else delete process.env.EGC_OPS_TOKEN;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validateOpsToken handles token gate configuration and request headers', () => {
  const origToken = process.env.EGC_OPS_TOKEN;
  try {
    delete process.env.EGC_OPS_TOKEN;
    delete process.env.OPS_TOKEN;
    assert.equal(validateOpsToken({}), false, 'fail closed when no token configured');

    process.env.EGC_OPS_TOKEN = 'secret-ops-key-42';
    assert.equal(validateOpsToken({}), false, 'refused when token missing');
    assert.equal(validateOpsToken({ headers: { 'x-ops-token': 'wrong-key' } }), false, 'refused on wrong token');
    assert.equal(validateOpsToken({ headers: { 'x-ops-token': 'secret-ops-key-42' } }), true, 'accepted on x-ops-token');
    assert.equal(validateOpsToken({ headers: { authorization: 'Bearer secret-ops-key-42' } }), true, 'accepted on Bearer token');
    assert.equal(validateOpsToken({ url: '/ops/gain?token=secret-ops-key-42' }), false, 'refused on query string token per security policy');
  } finally {
    if (origToken !== undefined) process.env.EGC_OPS_TOKEN = origToken;
    else delete process.env.EGC_OPS_TOKEN;
  }
});

test('savingsLedger operation reads environment-configured metrics ledger without client path parameter exposure', () => {
  const origFile = process.env.EGC_CRUSHER_METRICS_FILE;
  const metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-metrics-dir-'));
  const validLedger = path.join(metricsDir, 'crusher.jsonl');
  
  fs.writeFileSync(validLedger, JSON.stringify({ ts: new Date().toISOString(), tokensSaved: 100 }) + '\n');

  try {
    process.env.EGC_CRUSHER_METRICS_FILE = validLedger;

    const reportValid = savingsLedgerOp();
    assert.equal(reportValid.runs, 1);
    assert.equal(reportValid.sinceInstall.tokensSaved, 100);
  } finally {
    if (origFile !== undefined) process.env.EGC_CRUSHER_METRICS_FILE = origFile;
    else delete process.env.EGC_CRUSHER_METRICS_FILE;
    fs.rmSync(metricsDir, { recursive: true, force: true });
  }
});

test('Parity test: panel numbers equal egc gain output for every range against the same fixture ledger', () => {
  const testNow = new Date();
  const { tmpDir, ledgerPath, sessionId, projectPath } = createFixtureLedger(testNow);
  const origFile = process.env.EGC_CRUSHER_METRICS_FILE;
  process.env.EGC_CRUSHER_METRICS_FILE = ledgerPath;

  try {
    // 1. Get CLI output using egc gain --json
    const cliRes = spawnSync('node', [GAIN_CLI, '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EGC_CRUSHER_METRICS_FILE: ledgerPath,
        EGC_SESSION_ID: sessionId,
        EGC_PROJECT_ROOT: projectPath,
      },
    });

    assert.equal(cliRes.status, 0, `CLI failed: ${cliRes.stderr}`);
    const cliOutput = JSON.parse(cliRes.stdout);

    // 2. Get panel / operation output via savingsLedgerOp
    const panelReport = savingsLedgerOp({
      now: testNow,
      session: sessionId,
      project: projectPath,
    });

    // 3. Parity comparison for all CLI ranges: today, session, 7d, 30d, since install
    const ranges = [
      { name: 'today', cliKey: 'today', panelKey: 'today' },
      { name: 'session', cliKey: 'currentSession', panelKey: 'currentSession' },
      { name: '7d', cliKey: 'last7Days', panelKey: 'last7Days' },
      { name: '30d', cliKey: 'last30Days', panelKey: 'last30Days' },
      { name: 'since install', cliKey: 'sinceInstall', panelKey: 'sinceInstall' },
    ];

    for (const range of ranges) {
      const cliData = cliOutput[range.cliKey];
      const panelData = panelReport[range.panelKey];

      assert.ok(cliData, `CLI should produce range ${range.name}`);
      assert.ok(panelData, `Panel should produce range ${range.name}`);

      assert.equal(
        panelData.tokensSaved,
        cliData.tokensSaved,
        `Range ${range.name}: tokensSaved parity mismatch`
      );
      assert.equal(
        panelData.runs,
        cliData.runs,
        `Range ${range.name}: runs parity mismatch`
      );
      assert.equal(
        panelData.bytesIn,
        cliData.bytesIn,
        `Range ${range.name}: bytesIn parity mismatch`
      );
      assert.equal(
        panelData.bytesOut,
        cliData.bytesOut,
        `Range ${range.name}: bytesOut parity mismatch`
      );
    }

    // Top level aggregate parity checks
    assert.equal(panelReport.runs, cliOutput.runs, 'Total runs parity mismatch');
    assert.equal(panelReport.averagePerRun, cliOutput.averagePerRun, 'Average per run parity mismatch');
    if (cliOutput.biggest) {
      assert.equal(panelReport.biggest.tokensSaved, cliOutput.biggest.tokensSaved, 'Biggest crush tokensSaved parity mismatch');
      assert.equal(panelReport.biggest.cmd, cliOutput.biggest.cmd, 'Biggest crush cmd parity mismatch');
    }
  } finally {
    if (origFile !== undefined) process.env.EGC_CRUSHER_METRICS_FILE = origFile;
    else delete process.env.EGC_CRUSHER_METRICS_FILE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HTTP /ops/gain route responds with 401 when token invalid, and 200 with parity report when authorized', async () => {
  const http = require('node:http');

  const origToken = process.env.EGC_OPS_TOKEN;
  const origFile = process.env.EGC_CRUSHER_METRICS_FILE;
  process.env.EGC_OPS_TOKEN = 'test-token-777';

  const testNow = new Date();
  const { tmpDir, ledgerPath, sessionId, projectPath } = createFixtureLedger(testNow);
  process.env.EGC_CRUSHER_METRICS_FILE = ledgerPath;

  const handleOps = createOpsHandler({
    savingsLedger: (opts) => savingsLedgerOp({ ...opts, now: testNow, session: sessionId, project: projectPath }),
  });

  const server = http.createServer((req, res) => {
    if (handleOps(req, res)) return;
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. Unauthorized request (no token header)
    const res401 = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/ops/gain`, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
      }).on('error', reject);
    });

    assert.equal(res401.status, 401);
    assert.equal(res401.data.error, 'Unauthorized');

    // 2. Authorized request (X-Ops-Token header)
    const res200 = await new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port,
        path: '/ops/gain',
        headers: { 'X-Ops-Token': 'test-token-777' },
      };
      http.get(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
      }).on('error', reject);
    });

    assert.equal(res200.status, 200);
    assert.equal(res200.data.ok, true);
    assert.ok(res200.data.report);
    assert.equal(res200.data.report.today.tokensSaved, 4700);
  } finally {
    server.close();
    if (origToken !== undefined) process.env.EGC_OPS_TOKEN = origToken;
    else delete process.env.EGC_OPS_TOKEN;
    if (origFile !== undefined) process.env.EGC_CRUSHER_METRICS_FILE = origFile;
    else delete process.env.EGC_CRUSHER_METRICS_FILE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

