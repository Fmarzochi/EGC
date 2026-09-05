/**
 * Tests for the doctor summary that `egc init` prints: one headline, the
 * targets that need attention, and the exact command for each case.
 */

const assert = require('assert');
const path = require('path');
const { summarizeDoctorReport, summarizeRepairResult, targetName } = require('../../scripts/lib/doctor-summary');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

function target(id, name, status, issues = []) {
  return { adapter: { id, target: name, kind: 'home' }, status, installStatePath: `/home/user/${id}/install-state.json`, issues };
}

function report(results, extra = {}) {
  return {
    results,
    summary: {
      checkedCount: results.length,
      okCount: results.filter(result => result.status === 'ok').length,
      warningCount: results.filter(result => result.status === 'warning').length,
      errorCount: results.filter(result => result.status === 'error').length,
    },
    ...extra,
  };
}

const TWELVE = ['egc', 'claude', 'codex', 'goose', 'openhands', 'opencode', 'kiro', 'windsurf', 'amp', 'copilot', 'zed', 'junie']
  .map(name => target(`${name}-home`, name, 'ok'));

test('twelve healthy targets collapse into one headline with no commands', () => {
  const summary = summarizeDoctorReport(report(TWELVE), { repoRoot: '/repo' });
  assert.strictEqual(summary.status, 'ok');
  assert.strictEqual(summary.headline, '12 targets healthy');
  assert.deepStrictEqual(summary.details, []);
  assert.deepStrictEqual(summary.commands, []);
  assert.deepStrictEqual(summary.notes, []);
});

test('a single healthy target is not pluralized', () => {
  const summary = summarizeDoctorReport(report([target('egc-home', 'egc', 'ok')]));
  assert.strictEqual(summary.headline, '1 target healthy');
});

test('warnings list each target once and point at egc repair', () => {
  const results = TWELVE.slice();
  results[7] = target('windsurf-home', 'windsurf', 'warning', [
    { severity: 'warning', code: 'drifted-managed-files', message: '2 managed file(s) differ from the source repo', paths: ['a', 'b'] },
  ]);
  results[10] = target('zed-home', 'zed', 'warning', [
    { severity: 'warning', code: 'drifted-managed-files', message: '1 managed file(s) differ from the source repo', paths: ['a'] },
  ]);
  results[11] = target('junie-home', 'junie', 'warning', [
    { severity: 'warning', code: 'repo-version-mismatch', message: 'Recorded repo version 1.1.20 differs from current repo version 1.1.21' },
  ]);
  const summary = summarizeDoctorReport(report(results));
  assert.strictEqual(summary.status, 'warning');
  assert.strictEqual(summary.headline, '9 of 12 targets healthy, 3 need an update');
  assert.deepStrictEqual(summary.commands, ['egc repair']);
  assert.strictEqual(summary.details.length, 3);
  assert.strictEqual(summary.details[0].adapterId, 'windsurf-home');
  assert.strictEqual(summary.details[0].text, '2 managed file(s) differ from the source repo');
  assert.strictEqual(summary.details[2].text, 'recorded version 1.1.20, current 1.1.21');
});

const BROKEN = TWELVE.slice();
BROKEN[7] = target('windsurf-home', 'windsurf', 'error', [
  { severity: 'error', code: 'missing-target-root', message: 'Target root does not exist: /home/user/.codeium/windsurf' },
]);
BROKEN[8] = target('amp-home', 'amp', 'error', [
  { severity: 'error', code: 'missing-source-files', message: "3 source file(s) referenced by install-state are missing (run 'egc repair' to prune orphaned entries)", paths: [] },
]);

test('errors before the automatic repair carry no command yet', () => {
  const summary = summarizeDoctorReport(report(BROKEN));
  assert.strictEqual(summary.status, 'error');
  assert.strictEqual(summary.headline, '10 of 12 targets healthy, 2 with errors');
  assert.deepStrictEqual(summary.commands, []);
  assert.deepStrictEqual(summary.notes, []);
});

test('errors that survive the automatic repair get one reinstall command per target and the uninstall hint', () => {
  const summary = summarizeDoctorReport(report(BROKEN), { afterRepair: true });
  assert.strictEqual(summary.status, 'error');
  assert.strictEqual(summary.headline, '10 of 12 targets healthy, 2 still broken after automatic repair');
  assert.deepStrictEqual(summary.commands, [
    'egc install --target windsurf --profile full',
    'egc install --target amp --profile full',
  ]);
  assert.deepStrictEqual(summary.notes, ['No longer using one of these tools? Run: egc uninstall --target <name>']);
  assert.strictEqual(summary.details[0].text, 'target folder does not exist: /home/user/.codeium/windsurf');
  assert.strictEqual(summary.details[1].text, '3 source file(s) referenced by install-state are missing');
});

test('the command uses the CLI target name, never the adapter id', () => {
  const summary = summarizeDoctorReport(report([
    { adapter: { id: 'kiro-project' }, status: 'error', installStatePath: '/p/x.json', issues: [
      { severity: 'error', code: 'missing-managed-files', message: '1 managed file(s) are missing', paths: ['a'] },
    ] },
  ]), { afterRepair: true });
  assert.deepStrictEqual(summary.commands, ['egc install --target kiro --profile full']);
  assert.strictEqual(targetName({ id: 'claude-home' }), 'claude');
  assert.strictEqual(targetName({ id: 'cursor-project', target: 'cursor' }), 'cursor');
  assert.strictEqual(targetName({}), '<target>');
});

test('zero targets is the bare install, with the full-profile command', () => {
  const summary = summarizeDoctorReport(report([]));
  assert.strictEqual(summary.status, 'empty');
  assert.strictEqual(summary.bare, true);
  assert.ok(summary.headline.includes('no managed target profile installed'));
  assert.deepStrictEqual(summary.commands, ['egc install --target <target> --profile full']);
  assert.ok(summary.hint.includes('optional'));
  assert.deepStrictEqual(summary.notes, []);
});

test('a bare install with a state store finding is a warning, not a clean run', () => {
  const stateDb = { missing: true, dbPath: '/home/user/.egc/egc/state.db', memoryDbPath: '/x', hasHarnessDb: false, hasMemoryDb: false, cliStoreMisplaced: false, fragments: [] };
  const summary = summarizeDoctorReport(report([], { stateDb }));
  assert.strictEqual(summary.status, 'warning');
  assert.strictEqual(summary.bare, true);
  assert.strictEqual(summary.notes.length, 1);
  assert.ok(summary.notes[0].startsWith('state store not found at'));
});

test('a target with several issues is one line, and counts stay per target', () => {
  const results = TWELVE.slice();
  results[1] = target('claude-home', 'claude', 'warning', [
    { severity: 'warning', code: 'drifted-managed-files', message: '2 managed file(s) differ from the source repo', paths: ['a', 'b'] },
    { severity: 'warning', code: 'repo-version-mismatch', message: 'Recorded repo version 1.1.20 differs from current repo version 1.1.21' },
  ]);
  const summary = summarizeDoctorReport(report(results));
  assert.strictEqual(summary.headline, '11 of 12 targets healthy, 1 need an update');
  assert.strictEqual(summary.details.length, 1);
  assert.strictEqual(summary.details[0].text, '2 managed file(s) differ from the source repo; recorded version 1.1.20, current 1.1.21');
  assert.deepStrictEqual(summary.details[0].codes, ['drifted-managed-files', 'repo-version-mismatch']);
});

test('warnings that sit next to residual errors still get egc repair', () => {
  const results = BROKEN.slice();
  results[10] = target('zed-home', 'zed', 'warning', [
    { severity: 'warning', code: 'drifted-managed-files', message: '1 managed file(s) differ from the source repo', paths: ['a'] },
  ]);
  const summary = summarizeDoctorReport(report(results), { afterRepair: true });
  assert.strictEqual(summary.headline, '9 of 12 targets healthy, 2 still broken after automatic repair');
  assert.deepStrictEqual(summary.commands, [
    'egc install --target windsurf --profile full',
    'egc install --target amp --profile full',
    'egc repair',
  ]);
});

test('refused manifests are an error with the reason in the headline', () => {
  const summary = summarizeDoctorReport(report(TWELVE, { manifestError: 'manifest schema 9 is newer than this package' }));
  assert.strictEqual(summary.status, 'error');
  assert.ok(summary.headline.startsWith('install manifests refused: manifest schema 9'));
  assert.ok(summary.errors >= 1);
});

test('state store findings become notes with the consolidation command, and downgrade a healthy run to a warning', () => {
  const stateDb = {
    missing: false, dbPath: '/home/user/.egc/egc/state.db', memoryDbPath: '/home/user/.egc/memory/state.db',
    hasHarnessDb: true, hasMemoryDb: true, cliStoreMisplaced: false,
    fragments: [{ path: '/home/user/.claude/egc/state.db', sizeBytes: 4096, modifiedAt: '2026-09-05T18:00:00.000Z' }],
  };
  const summary = summarizeDoctorReport(report(TWELVE, { stateDb }), { repoRoot: '/repo' });
  assert.strictEqual(summary.status, 'warning');
  assert.strictEqual(summary.notes.length, 1);
  assert.ok(summary.notes[0].startsWith('1 stray state.db copy left by older versions'));
  assert.ok(summary.notes[0].includes(path.join('/repo', 'scripts', 'maintenance', 'merge-fragmented-state-dbs.js')));
  assert.deepStrictEqual(summary.commands, []);
});

test('a healthy two-store layout adds no note', () => {
  const stateDb = { missing: false, dbPath: '/a', memoryDbPath: '/b', hasHarnessDb: true, hasMemoryDb: false, cliStoreMisplaced: false, fragments: [] };
  const summary = summarizeDoctorReport(report(TWELVE, { stateDb }));
  assert.strictEqual(summary.status, 'ok');
  assert.deepStrictEqual(summary.notes, []);
});

test('the repair summary counts files, not targets, and flags what stayed unrepairable', () => {
  const restored = summarizeRepairResult({
    results: [{ adapter: { id: 'amp-home' }, status: 'repaired', repairedPaths: ['a', 'b', 'c', 'd'], prunedPaths: [] }],
    summary: { checkedCount: 1, repairedCount: 1, prunedCount: 0, unrepairableCount: 0, errorCount: 0 },
  });
  assert.strictEqual(restored.text, 'restored 4 files in 1 target');
  assert.strictEqual(restored.failed, false);

  const pluginBroken = summarizeRepairResult({
    results: [{ adapter: { id: 'amp-home' }, status: 'ok', repairedPaths: [], prunedPaths: [] }],
    summary: { checkedCount: 1, repairedCount: 0, prunedCount: 0, unrepairableCount: 0, errorCount: 0 },
    pluginRepairs: [{ name: 'egc-tools', success: false, errors: ['git clone failed'] }],
  });
  assert.strictEqual(pluginBroken.text, 'nothing to restore; 1 plugin reinstall failed');
  assert.strictEqual(pluginBroken.failed, true);

  const stuck = summarizeRepairResult({
    results: [{ adapter: { id: 'amp-home' }, status: 'error', repairedPaths: [], prunedPaths: ['x'], unrepairable: [{ path: 'y' }] }],
    summary: { checkedCount: 1, repairedCount: 0, prunedCount: 1, unrepairableCount: 1, errorCount: 1 },
  });
  assert.strictEqual(stuck.text, 'pruned 1 stale entry in 1 target; 1 unrepairable');
  assert.strictEqual(stuck.failed, true);

  assert.strictEqual(summarizeRepairResult(null).text, 'nothing to restore');

  const refused = summarizeRepairResult({ manifestError: 'manifest schema 9 is newer than this package', results: [], summary: { checkedCount: 0, repairedCount: 0, prunedCount: 0, unrepairableCount: 0, errorCount: 1 } });
  assert.strictEqual(refused.failed, true);
  assert.ok(refused.text.startsWith('install manifests refused: manifest schema 9'));
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
