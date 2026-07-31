'use strict';
/**
 * Tests for Token Crusher ledger attribution and scoped gain aggregates.
 *
 * Run with: node tests/crusher-metrics.test.js
 */
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  UNKNOWN_SCOPE,
  normalizeEntry,
  resolveMetricContext,
  aggregateBreakdown,
} = require('../scripts/lib/crusher/metrics');

const ROOT = path.join(__dirname, '..');
const GAIN = path.join(ROOT, 'scripts', 'gain.js');
const METRICS = path.join(ROOT, 'scripts', 'lib', 'crusher', 'metrics.js');

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

function runNode(script, options = {}) {
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    ...options,
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result;
}

console.log('\n=== Testing Token Crusher scoped metrics ===\n');

run('resolves project and existing EGC session conventions', () => {
  const cwd = path.join(os.tmpdir(), 'egc-project-context');
  const context = resolveMetricContext({
    cwd,
    env: { EGC_SESSION_ID: 'ses_test' },
  });
  assert.strictEqual(context.project, path.resolve(cwd));
  assert.strictEqual(context.session, 'ses_test');

  const fallback = resolveMetricContext({ cwd, env: {} });
  assert.strictEqual(fallback.session, UNKNOWN_SCOPE);
});

run('normalizes legacy rows into unknown attribution buckets', () => {
  const legacy = normalizeEntry({ ts: '2026-07-31T00:00:00Z', tokensSaved: 10 });
  assert.strictEqual(legacy.project, UNKNOWN_SCOPE);
  assert.strictEqual(legacy.session, UNKNOWN_SCOPE);
});

run('computes project, session, rolling-window, average, and biggest totals', () => {
  const projectA = path.resolve(path.join(os.tmpdir(), 'egc-project-a'));
  const projectB = path.resolve(path.join(os.tmpdir(), 'egc-project-b'));
  const entries = [
    { ts: '2026-07-31T10:00:00Z', project: projectA, session: 'ses_a', kind: 'git-log', cmd: 'git', tokensSaved: 100, bytesIn: 1000, bytesOut: 100 },
    { ts: '2026-07-30T12:00:00Z', project: projectA, session: 'ses_b', kind: 'tests', cmd: 'npm', tokensSaved: 300, bytesIn: 3000, bytesOut: 300 },
    { ts: '2026-07-20T12:00:00Z', project: projectB, session: 'ses_a', kind: 'diff', cmd: 'git', tokensSaved: 700, bytesIn: 7000, bytesOut: 700 },
    { ts: '2026-07-31T11:00:00Z', kind: 'generic', cmd: 'legacy', tokensSaved: 50, bytesIn: 500, bytesOut: 50 },
  ];
  const report = aggregateBreakdown(entries, {
    now: '2026-07-31T12:00:00Z',
    project: projectA,
    session: 'ses_a',
  });

  assert.strictEqual(report.runs, 4);
  assert.strictEqual(report.sinceInstall.tokensSaved, 1150);
  assert.strictEqual(report.averagePerRun, 288);
  assert.strictEqual(report.biggest.tokensSaved, 700);
  assert.strictEqual(report.biggest.cmd, 'git');
  assert.strictEqual(report.currentProject.tokensSaved, 400);
  assert.strictEqual(report.currentSession.tokensSaved, 800);
  assert.strictEqual(report.last7Days.tokensSaved, 450);
  assert.strictEqual(report.last30Days.tokensSaved, 1150);
});

run('uses the local calendar boundary instead of the UTC date boundary', () => {
  const now = new Date(2026, 6, 31, 1, 30);
  const today = new Date(2026, 6, 31, 0, 30);
  const previousDay = new Date(2026, 6, 30, 23, 30);
  const report = aggregateBreakdown([
    { ts: today.toISOString(), tokensSaved: 100 },
    { ts: previousDay.toISOString(), tokensSaved: 200 },
  ], {
    now,
    project: UNKNOWN_SCOPE,
    session: UNKNOWN_SCOPE,
  });
  assert.strictEqual(report.today.runs, 1);
  assert.strictEqual(report.today.tokensSaved, 100);
});

run('records attribution and exposes the scoped gain panel without breaking legacy JSON', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-scoped-gain-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-scoped-gain-project-'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    EGC_SESSION_ID: 'ses_cli',
    EGC_TEST_METRICS_MODULE: METRICS,
  };

  try {
    runNode(
      "const { record } = require(process.env.EGC_TEST_METRICS_MODULE); record({ cmd: 'git', kind: 'git-log', bytesIn: 1000, bytesOut: 100, tokensSaved: 225 });",
      { cwd: project, env }
    );

    const ledger = path.join(home, '.egc', 'metrics', 'crusher.jsonl');
    const first = JSON.parse(fs.readFileSync(ledger, 'utf8').trim());
    assert.strictEqual(fs.realpathSync(first.project), fs.realpathSync(project));
    assert.strictEqual(first.session, 'ses_cli');

    fs.appendFileSync(ledger, `${JSON.stringify({
      ts: new Date().toISOString(),
      cmd: 'legacy',
      kind: 'generic',
      bytesIn: 500,
      bytesOut: 100,
      tokensSaved: 75,
    })}\n`);

    const jsonResult = spawnSync(process.execPath, [GAIN, '--json'], {
      cwd: project,
      env,
      encoding: 'utf8',
    });
    assert.strictEqual(jsonResult.status, 0, jsonResult.stderr);
    const report = JSON.parse(jsonResult.stdout);
    assert.strictEqual(report.tokensSaved, 300, 'legacy top-level lifetime total remains available');
    assert.strictEqual(report.currentProject.tokensSaved, 225);
    assert.strictEqual(report.currentSession.tokensSaved, 225);
    assert.strictEqual(report.sinceInstall.tokensSaved, 300);

    const historyResult = spawnSync(process.execPath, [GAIN, '--history', '--json'], {
      cwd: project,
      env,
      encoding: 'utf8',
    });
    assert.strictEqual(historyResult.status, 0, historyResult.stderr);
    const history = JSON.parse(historyResult.stdout);
    assert.strictEqual(history[1].project, UNKNOWN_SCOPE);
    assert.strictEqual(history[1].session, UNKNOWN_SCOPE);

    const panel = spawnSync(process.execPath, [GAIN], {
      cwd: project,
      env,
      encoding: 'utf8',
    });
    assert.strictEqual(panel.status, 0, panel.stderr);
    assert.match(panel.stdout, /Today/);
    assert.match(panel.stdout, /Current session/);
    assert.match(panel.stdout, /Current project/);
    assert.match(panel.stdout, /Last 7 days/);
    assert.match(panel.stdout, /Last 30 days/);
    assert.match(panel.stdout, /Biggest crush:.*git/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
