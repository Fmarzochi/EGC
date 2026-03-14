'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createClaudeHistoryAdapter } = require('../../scripts/lib/session-adapters/claude-history');
const { createDmuxTmuxAdapter } = require('../../scripts/lib/session-adapters/dmux-tmux');
const { createAdapterRegistry } = require('../../scripts/lib/session-adapters/registry');

console.log('=== Testing session-adapters ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
    failed += 1;
  }
}

function withHome(homeDir, fn) {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    fn();
  } finally {
    if (typeof previousHome === 'string') {
      process.env.HOME = previousHome;
    } else {
      delete process.env.HOME;
    }
  }
}

test('dmux adapter normalizes orchestration snapshots into canonical form', () => {
  const adapter = createDmuxTmuxAdapter({
    collectSessionSnapshotImpl: () => ({
      sessionName: 'workflow-visual-proof',
      coordinationDir: '/tmp/.claude/orchestration/workflow-visual-proof',
      repoRoot: '/tmp/repo',
      targetType: 'plan',
      sessionActive: true,
      paneCount: 1,
      workerCount: 1,
      workerStates: { running: 1 },
      panes: [{
        paneId: '%95',
        windowIndex: 1,
        paneIndex: 0,
        title: 'seed-check',
        currentCommand: 'codex',
        currentPath: '/tmp/worktree',
        active: false,
        dead: false,
        pid: 1234
      }],
      workers: [{
        workerSlug: 'seed-check',
        workerDir: '/tmp/.claude/orchestration/workflow-visual-proof/seed-check',
        status: {
          state: 'running',
          updated: '2026-03-13T00:00:00Z',
          branch: 'feature/seed-check',
          worktree: '/tmp/worktree',
          taskFile: '/tmp/task.md',
          handoffFile: '/tmp/handoff.md'
        },
        task: {
          objective: 'Inspect seeded files.',
          seedPaths: ['scripts/orchestrate-worktrees.js']
        },
        handoff: {
          summary: ['Pending'],
          validation: [],
          remainingRisks: ['No screenshot yet']
        },
        files: {
          status: '/tmp/status.md',
          task: '/tmp/task.md',
          handoff: '/tmp/handoff.md'
        },
        pane: {
          paneId: '%95',
          title: 'seed-check'
        }
      }]
    })
  });

  const snapshot = adapter.open('workflow-visual-proof').getSnapshot();

  assert.strictEqual(snapshot.schemaVersion, 'ecc.session.v1');
  assert.strictEqual(snapshot.adapterId, 'dmux-tmux');
  assert.strictEqual(snapshot.session.id, 'workflow-visual-proof');
  assert.strictEqual(snapshot.session.kind, 'orchestrated');
  assert.strictEqual(snapshot.session.sourceTarget.type, 'session');
  assert.strictEqual(snapshot.aggregates.workerCount, 1);
  assert.strictEqual(snapshot.workers[0].runtime.kind, 'tmux-pane');
  assert.strictEqual(snapshot.workers[0].outputs.remainingRisks[0], 'No screenshot yet');
});

test('claude-history adapter loads the latest recorded session', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-adapter-home-'));
  const sessionsDir = path.join(homeDir, '.claude', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const sessionPath = path.join(sessionsDir, '2026-03-13-a1b2c3d4-session.tmp');
  fs.writeFileSync(sessionPath, [
    '# Session Review',
    '',
    '**Date:** 2026-03-13',
    '**Started:** 09:00',
    '**Last Updated:** 11:30',
    '**Project:** everything-claude-code',
    '**Branch:** feat/session-adapter',
    '**Worktree:** /tmp/ecc-worktree',
    '',
    '### Completed',
    '- [x] Build snapshot prototype',
    '',
    '### In Progress',
    '- [ ] Add CLI wrapper',
    '',
    '### Notes for Next Session',
    'Need a second adapter.',
    '',
    '### Context to Load',
    '```',
    'scripts/lib/orchestration-session.js',
    '```'
  ].join('\n'));

  try {
    withHome(homeDir, () => {
      const adapter = createClaudeHistoryAdapter();
      const snapshot = adapter.open('claude:latest').getSnapshot();

      assert.strictEqual(snapshot.schemaVersion, 'ecc.session.v1');
      assert.strictEqual(snapshot.adapterId, 'claude-history');
      assert.strictEqual(snapshot.session.kind, 'history');
      assert.strictEqual(snapshot.session.state, 'recorded');
      assert.strictEqual(snapshot.workers.length, 1);
      assert.strictEqual(snapshot.workers[0].branch, 'feat/session-adapter');
      assert.strictEqual(snapshot.workers[0].worktree, '/tmp/ecc-worktree');
      assert.strictEqual(snapshot.workers[0].runtime.kind, 'claude-session');
      assert.strictEqual(snapshot.workers[0].artifacts.sessionFile, sessionPath);
      assert.ok(snapshot.workers[0].outputs.summary.includes('Build snapshot prototype'));
    });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('adapter registry routes plan files to dmux and explicit claude targets to history', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-registry-repo-'));
  const planPath = path.join(repoRoot, 'workflow.json');
  fs.writeFileSync(planPath, JSON.stringify({
    sessionName: 'workflow-visual-proof',
    repoRoot,
    coordinationRoot: path.join(repoRoot, '.claude', 'orchestration')
  }));

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-registry-home-'));
  const sessionsDir = path.join(homeDir, '.claude', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, '2026-03-13-z9y8x7w6-session.tmp'),
    '# History Session\n\n**Branch:** feat/history\n'
  );

  try {
    withHome(homeDir, () => {
      const registry = createAdapterRegistry({
        adapters: [
          createDmuxTmuxAdapter({
            collectSessionSnapshotImpl: () => ({
              sessionName: 'workflow-visual-proof',
              coordinationDir: path.join(repoRoot, '.claude', 'orchestration', 'workflow-visual-proof'),
              repoRoot,
              targetType: 'plan',
              sessionActive: false,
              paneCount: 0,
              workerCount: 0,
              workerStates: {},
              panes: [],
              workers: []
            })
          }),
          createClaudeHistoryAdapter()
        ]
      });

      const dmuxSnapshot = registry.open(planPath, { cwd: repoRoot }).getSnapshot();
      const claudeSnapshot = registry.open('claude:latest', { cwd: repoRoot }).getSnapshot();

      assert.strictEqual(dmuxSnapshot.adapterId, 'dmux-tmux');
      assert.strictEqual(claudeSnapshot.adapterId, 'claude-history');
    });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
