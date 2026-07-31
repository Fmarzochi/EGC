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
  record,
  readAll,
  aggregateBreakdown,
} = require('../scripts/lib/crusher/metrics');

const ROOT = path.join(__dirname, '..');
const GAIN = path.join(ROOT, 'scripts', 'gain.js');

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

function withProcessContext({ home, cwd, session }, fn) {
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    EGC_SESSION_ID: process.env.EGC_SESSION_ID,
    cwd: process.cwd(),
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (session === undefined) delete process.env.EGC_SESSION_ID;
  else process.env.EGC_SESSION_ID = session;
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(previous.cwd);
    for (const key of ['HOME', 'USERPROFILE', 'EGC_SESSION_ID']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
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
  const previousTZ = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const report = aggregateBreakdown([
      { ts: '2026-07-31T07:30:00Z', tokensSaved: 100 },
      { ts: '2026-07-31T06:30:00Z', tokensSaved: 200 },
    ], {
      now: '2026-07-31T08:30:00Z',
      project: UNKNOWN_SCOPE,
      session: UNKNOWN_SCOPE,
    });
    assert.strictEqual(report.today.runs, 1);
    assert.strictEqual(report.today.tokensSaved, 100);
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

run('records attribution and exposes the scoped gain panel without breaking legacy JSON', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-scoped-gain-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-scoped-gain-project-'));

  withProcessContext({ home, cwd: project, session: 'ses_cli' }, () => {
    record({ cmd: 'git', kind: 'git-log', bytesIn: 1000, bytesOut: 100, tokensSaved: 225 });
    const first = readAll()[0];
    assert.strictEqual(first.project, path.resolve(project));
    assert.strictEqual(first.session, 'ses_cli');
  });

  const ledger = path.join(home, '.egc', 'metrics', 'crusher.jsonl');
  fs.appendFileSync(ledger, `${JSON.stringify({
    ts: new Date().toISOString(),
    cmd: 'legacy',
    kind: 'generic',
    bytesIn: 500,
    bytesOut: 100,
    tokensSaved: 75,
  })}\n`);

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    EGC_SESSION_ID: 'ses_cli',
  };
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
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
