/**
 * Tests for the SQLite-backed EGC state store and CLI commands.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  createStateStore,
  resolveStateStorePath,
} = require('../../scripts/lib/state-store');

const ECC_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'egc.js');
const STATUS_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'status.js');
const SESSIONS_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'sessions-cli.js');

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function runNode(scriptPath, args = [], options = {}) {
  return spawnSync('node', [scriptPath, ...args], {
    encoding: 'utf8',
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });
}

function parseJson(stdout) {
  return JSON.parse(stdout.trim());
}

async function seedStore(dbPath) {
  const store = await createStateStore({ dbPath });

  store.upsertSession({
    id: 'session-active',
    adapterId: 'dmux-tmux',
    harness: 'egc',
    state: 'active',
    repoRoot: '/tmp/egc-repo',
    startedAt: '2026-03-15T08:00:00.000Z',
    endedAt: null,
    snapshot: {
      schemaVersion: 'egc.session.v1',
      adapterId: 'dmux-tmux',
      session: {
        id: 'session-active',
        kind: 'orchestrated',
        state: 'active',
        repoRoot: '/tmp/egc-repo',
      },
      workers: [
        {
          id: 'worker-1',
          label: 'Worker 1',
          state: 'active',
          branch: 'feat/state-store',
          worktree: '/tmp/egc-repo/.worktrees/worker-1',
        },
        {
          id: 'worker-2',
          label: 'Worker 2',
          state: 'idle',
          branch: 'feat/state-store',
          worktree: '/tmp/egc-repo/.worktrees/worker-2',
        },
      ],
      aggregates: {
        workerCount: 2,
        states: {
          active: 1,
          idle: 1,
        },
      },
    },
  });

  store.upsertSession({
    id: 'session-recorded',
    adapterId: 'egc-history',
    harness: 'egc',
    state: 'recorded',
    repoRoot: '/tmp/egc-repo',
    startedAt: '2026-03-14T18:00:00.000Z',
    endedAt: '2026-03-14T19:00:00.000Z',
    snapshot: {
      schemaVersion: 'egc.session.v1',
      adapterId: 'egc-history',
      session: {
        id: 'session-recorded',
        kind: 'history',
        state: 'recorded',
        repoRoot: '/tmp/egc-repo',
      },
      workers: [
        {
          id: 'worker-hist',
          label: 'History Worker',
          state: 'recorded',
          branch: 'main',
          worktree: '/tmp/egc-repo',
        },
      ],
      aggregates: {
        workerCount: 1,
        states: {
          recorded: 1,
        },
      },
    },
  });

  store.insertSkillRun({
    id: 'skill-run-1',
    skillId: 'tdd-workflow',
    skillVersion: '1.0.0',
    sessionId: 'session-active',
    taskDescription: 'Write store tests',
    outcome: 'success',
    failureReason: null,
    tokensUsed: 1200,
    durationMs: 3500,
    userFeedback: 'useful',
    createdAt: '2026-03-15T08:05:00.000Z',
  });

  store.insertSkillRun({
    id: 'skill-run-2',
    skillId: 'security-review',
    skillVersion: '1.0.0',
    sessionId: 'session-active',
    taskDescription: 'Review state-store design',
    outcome: 'failed',
    failureReason: 'timeout',
    tokensUsed: 800,
    durationMs: 1800,
    userFeedback: null,
    createdAt: '2026-03-15T08:06:00.000Z',
  });

  store.insertSkillRun({
    id: 'skill-run-3',
    skillId: 'code-reviewer',
    skillVersion: '1.0.0',
    sessionId: 'session-recorded',
    taskDescription: 'Inspect CLI formatting',
    outcome: 'success',
    failureReason: null,
    tokensUsed: 500,
    durationMs: 900,
    userFeedback: 'clear',
    createdAt: '2026-03-15T08:07:00.000Z',
  });

  store.insertSkillRun({
    id: 'skill-run-4',
    skillId: 'planner',
    skillVersion: '1.0.0',
    sessionId: 'session-recorded',
    taskDescription: 'Outline EGC 2.0 work',
    outcome: 'unknown',
    failureReason: null,
    tokensUsed: 300,
    durationMs: 500,
    userFeedback: null,
    createdAt: '2026-03-15T08:08:00.000Z',
  });

  store.upsertSkillVersion({
    skillId: 'tdd-workflow',
    version: '1.0.0',
    contentHash: 'abc123',
    amendmentReason: 'initial',
    promotedAt: '2026-03-10T00:00:00.000Z',
    rolledBackAt: null,
  });

  store.insertDecision({
    id: 'decision-1',
    sessionId: 'session-active',
    title: 'Use SQLite for durable state',
    rationale: 'Need queryable local state for EGC control plane',
    alternatives: ['json-files', 'memory-only'],
    supersedes: null,
    status: 'active',
    createdAt: '2026-03-15T08:09:00.000Z',
  });

  store.upsertInstallState({
    targetId: 'egc-home',
    targetRoot: '/tmp/home/.gemini',
    profile: 'developer',
    modules: ['rules-core', 'orchestration'],
    operations: [
      {
        kind: 'copy-file',
        destinationPath: '/tmp/home/.gemini/agents/planner.md',
      },
    ],
    installedAt: '2026-03-15T07:00:00.000Z',
    sourceVersion: '1.8.0',
  });

  store.insertGovernanceEvent({
    id: 'gov-1',
    sessionId: 'session-active',
    eventType: 'policy-review-required',
    payload: {
      severity: 'warning',
      owner: 'security-reviewer',
    },
    resolvedAt: null,
    resolution: null,
    createdAt: '2026-03-15T08:10:00.000Z',
  });

  store.insertGovernanceEvent({
    id: 'gov-2',
    sessionId: 'session-recorded',
    eventType: 'decision-accepted',
    payload: {
      severity: 'info',
    },
    resolvedAt: '2026-03-15T08:11:00.000Z',
    resolution: 'accepted',
    createdAt: '2026-03-15T08:09:30.000Z',
  });

  store.close();
}

async function runTests() {
  console.log('\n=== Testing state-store ===\n');

  let passed = 0;
  let failed = 0;

  if (await test('creates the default state.db path and applies migrations idempotently', async () => {
    const homeDir = createTempDir('egc-state-home-');

    try {
      const expectedPath = path.join(homeDir, '.egc', 'egc', 'state.db');
      assert.strictEqual(resolveStateStorePath({ homeDir }), expectedPath);

      const firstStore = await createStateStore({ homeDir });
      const firstMigrations = firstStore.getAppliedMigrations();
      firstStore.close();

      assert.strictEqual(firstMigrations.length, 4);
      assert.strictEqual(firstMigrations[0].version, 1);
      assert.strictEqual(firstMigrations[1].version, 2);
      assert.strictEqual(firstMigrations[2].version, 3);
      assert.strictEqual(firstMigrations[3].version, 4);
      assert.ok(fs.existsSync(expectedPath));

      const secondStore = await createStateStore({ homeDir });
      const secondMigrations = secondStore.getAppliedMigrations();
      secondStore.close();

      assert.strictEqual(secondMigrations.length, 4);
      assert.strictEqual(secondMigrations[0].version, 1);
      assert.strictEqual(secondMigrations[1].version, 2);
      assert.strictEqual(secondMigrations[2].version, 3);
      assert.strictEqual(secondMigrations[3].version, 4);
    } finally {
      cleanupTempDir(homeDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('preserves SQLite special database names like :memory:', async () => {
    const tempDir = createTempDir('egc-state-memory-');
    const previousCwd = process.cwd();

    try {
      process.chdir(tempDir);
      assert.strictEqual(resolveStateStorePath({ dbPath: ':memory:' }), ':memory:');

      const store = await createStateStore({ dbPath: ':memory:' });
      assert.strictEqual(store.dbPath, ':memory:');
      assert.strictEqual(store.getAppliedMigrations().length, 4);
      store.close();

      assert.ok(!fs.existsSync(path.join(tempDir, ':memory:')));
    } finally {
      process.chdir(previousCwd);
      cleanupTempDir(tempDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('stores sessions and returns detailed session views with workers, skill runs, and decisions', async () => {
    const testDir = createTempDir('egc-state-db-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      await seedStore(dbPath);

      const store = await createStateStore({ dbPath });
      const listResult = store.listRecentSessions({ limit: 10 });
      const detail = store.getSessionDetail('session-active');
      store.close();

      assert.strictEqual(listResult.totalCount, 2);
      assert.strictEqual(listResult.sessions[0].id, 'session-active');
      assert.strictEqual(detail.session.id, 'session-active');
      assert.strictEqual(detail.workers.length, 2);
      assert.strictEqual(detail.skillRuns.length, 2);
      assert.strictEqual(detail.decisions.length, 1);
      assert.deepStrictEqual(detail.decisions[0].alternatives, ['json-files', 'memory-only']);
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('builds a status snapshot with active sessions, skill rates, install health, and pending governance', async () => {
    const testDir = createTempDir('egc-state-db-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      await seedStore(dbPath);

      const store = await createStateStore({ dbPath });
      const status = store.getStatus();
      store.close();

      assert.strictEqual(status.activeSessions.activeCount, 1);
      assert.strictEqual(status.activeSessions.sessions[0].id, 'session-active');
      assert.strictEqual(status.skillRuns.summary.totalCount, 4);
      assert.strictEqual(status.skillRuns.summary.successCount, 2);
      assert.strictEqual(status.skillRuns.summary.failureCount, 1);
      assert.strictEqual(status.skillRuns.summary.unknownCount, 1);
      assert.strictEqual(status.installHealth.status, 'healthy');
      assert.strictEqual(status.installHealth.totalCount, 1);
      assert.strictEqual(status.governance.pendingCount, 1);
      assert.strictEqual(status.governance.events[0].id, 'gov-1');
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('builds an empty status snapshot with null rates and missing install health', async () => {
    const testDir = createTempDir('egc-state-empty-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      const store = await createStateStore({ dbPath });
      const status = store.getStatus({ activeLimit: 1, recentSkillRunLimit: 1, pendingLimit: 1 });
      const missingDetail = store.getSessionDetail('missing-session');
      store.close();

      assert.strictEqual(missingDetail, null);
      assert.strictEqual(status.activeSessions.activeCount, 0);
      assert.deepStrictEqual(status.activeSessions.sessions, []);
      assert.strictEqual(status.skillRuns.summary.totalCount, 0);
      assert.strictEqual(status.skillRuns.summary.knownCount, 0);
      assert.strictEqual(status.skillRuns.summary.successRate, null);
      assert.strictEqual(status.skillRuns.summary.failureRate, null);
      assert.strictEqual(status.installHealth.status, 'missing');
      assert.strictEqual(status.installHealth.totalCount, 0);
      assert.deepStrictEqual(status.installHealth.installations, []);
      assert.strictEqual(status.governance.pendingCount, 0);
      assert.deepStrictEqual(status.governance.events, []);
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('normalizes default optional fields and reports warning install health', async () => {
    const testDir = createTempDir('egc-state-defaults-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      const store = await createStateStore({ dbPath });
      const session = store.upsertSession({
        id: 'session-defaults',
        adapterId: 'manual',
        harness: 'codex',
        state: 'running',
      });

      store.insertSkillRun({
        id: 'skill-run-defaults',
        skillId: 'planner',
        skillVersion: '1.0.0',
        sessionId: 'session-defaults',
        taskDescription: 'Exercise defaults',
        outcome: 'passed',
      });

      const version = store.upsertSkillVersion({
        skillId: 'planner',
        version: '1.0.0',
        contentHash: 'hash-defaults',
      });

      store.insertDecision({
        id: 'decision-defaults',
        sessionId: 'session-defaults',
        title: 'Use defaults',
        rationale: 'Optional decision fields should normalize',
        status: 'active',
      });

      const installState = store.upsertInstallState({
        targetId: 'egc-project',
        targetRoot: path.join(testDir, '.gemini'),
      });

      store.insertGovernanceEvent({
        id: 'gov-defaults',
        eventType: 'manual-review',
      });

      const detail = store.getSessionDetail('session-defaults');
      const status = store.getStatus();
      store.close();

      assert.strictEqual(session.repoRoot, null);
      assert.strictEqual(session.startedAt, null);
      assert.strictEqual(session.endedAt, null);
      assert.deepStrictEqual(session.snapshot, {});
      assert.strictEqual(session.workerCount, 0);

      assert.strictEqual(version.amendmentReason, null);
      assert.strictEqual(version.promotedAt, null);
      assert.strictEqual(version.rolledBackAt, null);

      assert.deepStrictEqual(detail.workers, []);
      assert.strictEqual(detail.skillRuns[0].failureReason, null);
      assert.strictEqual(detail.skillRuns[0].tokensUsed, null);
      assert.strictEqual(detail.skillRuns[0].durationMs, null);
      assert.strictEqual(detail.skillRuns[0].userFeedback, null);
      assert.deepStrictEqual(detail.decisions[0].alternatives, []);
      assert.strictEqual(detail.decisions[0].supersedes, null);

      assert.strictEqual(installState.profile, null);
      assert.deepStrictEqual(installState.modules, []);
      assert.deepStrictEqual(installState.operations, []);
      assert.strictEqual(installState.sourceVersion, null);

      assert.strictEqual(status.activeSessions.activeCount, 1);
      assert.strictEqual(status.skillRuns.summary.successRate, 100);
      assert.strictEqual(status.installHealth.status, 'warning');
      assert.strictEqual(status.installHealth.warningCount, 1);
      assert.strictEqual(status.installHealth.installations[0].status, 'warning');
      assert.strictEqual(status.governance.pendingCount, 1);
      assert.strictEqual(status.governance.events[0].payload, null);
      assert.strictEqual(status.governance.events[0].sessionId, null);
      assert.strictEqual(status.governance.events[0].resolution, null);
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('validates entity payloads before writing to the database', async () => {
    const testDir = createTempDir('egc-state-db-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      const store = await createStateStore({ dbPath });
      assert.throws(() => {
        store.upsertSession({
          id: '',
          adapterId: 'dmux-tmux',
          harness: 'egc',
          state: 'active',
          repoRoot: '/tmp/repo',
          startedAt: '2026-03-15T08:00:00.000Z',
          endedAt: null,
          snapshot: {},
        });
      }, /Invalid session/);

      assert.throws(() => {
        store.insertDecision({
          id: 'decision-invalid',
          sessionId: 'missing-session',
          title: 'Reject non-array alternatives',
          rationale: 'alternatives must be an array',
          alternatives: { unexpected: true },
          supersedes: null,
          status: 'active',
          createdAt: '2026-03-15T08:15:00.000Z',
        });
      }, /Invalid decision/);

      assert.throws(() => {
        store.upsertInstallState({
          targetId: 'egc-home',
          targetRoot: '/tmp/home/.gemini',
          profile: 'developer',
          modules: 'rules-core',
          operations: [],
          installedAt: '2026-03-15T07:00:00.000Z',
          sourceVersion: '1.8.0',
        });
      }, /Invalid installState/);

      store.close();
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('rejects invalid limits and unserializable JSON payloads', async () => {
    const testDir = createTempDir('egc-state-errors-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      const store = await createStateStore({ dbPath });
      const circularSnapshot = {};
      circularSnapshot.self = circularSnapshot;

      assert.throws(
        () => store.listRecentSessions({ limit: 0 }),
        /Invalid limit: 0/
      );
      assert.throws(
        () => store.getStatus({ activeLimit: 'many' }),
        /Invalid limit: many/
      );
      assert.throws(
        () => store.upsertSession({
          id: 'session-circular',
          adapterId: 'manual',
          harness: 'codex',
          state: 'active',
          snapshot: circularSnapshot,
        }),
        /Failed to serialize session\.snapshot/
      );

      store.close();
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('status CLI supports human-readable and --json output', async () => {
    const testDir = createTempDir('egc-state-cli-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      await seedStore(dbPath);

      const jsonResult = runNode(STATUS_SCRIPT, ['--db', dbPath, '--json']);
      assert.strictEqual(jsonResult.status, 0, jsonResult.stderr);
      const jsonPayload = parseJson(jsonResult.stdout);
      assert.strictEqual(jsonPayload.activeSessions.activeCount, 1);
      assert.strictEqual(jsonPayload.governance.pendingCount, 1);

      const humanResult = runNode(STATUS_SCRIPT, ['--db', dbPath]);
      assert.strictEqual(humanResult.status, 0, humanResult.stderr);
      assert.match(humanResult.stdout, /Active sessions: 1/);
      assert.match(humanResult.stdout, /Skill runs \(last 20\):/);
      assert.match(humanResult.stdout, /Install health: healthy/);
      assert.match(humanResult.stdout, /Pending governance events: 1/);
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('sessions CLI supports list and detail views in human-readable and --json output', async () => {
    const testDir = createTempDir('egc-state-cli-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      await seedStore(dbPath);

      const listJsonResult = runNode(SESSIONS_SCRIPT, ['--db', dbPath, '--json']);
      assert.strictEqual(listJsonResult.status, 0, listJsonResult.stderr);
      const listPayload = parseJson(listJsonResult.stdout);
      assert.strictEqual(listPayload.totalCount, 2);
      assert.strictEqual(listPayload.sessions[0].id, 'session-active');

      const detailJsonResult = runNode(SESSIONS_SCRIPT, ['session-active', '--db', dbPath, '--json']);
      assert.strictEqual(detailJsonResult.status, 0, detailJsonResult.stderr);
      const detailPayload = parseJson(detailJsonResult.stdout);
      assert.strictEqual(detailPayload.session.id, 'session-active');
      assert.strictEqual(detailPayload.workers.length, 2);
      assert.strictEqual(detailPayload.skillRuns.length, 2);
      assert.strictEqual(detailPayload.decisions.length, 1);

      const detailHumanResult = runNode(SESSIONS_SCRIPT, ['session-active', '--db', dbPath]);
      assert.strictEqual(detailHumanResult.status, 0, detailHumanResult.stderr);
      assert.match(detailHumanResult.stdout, /Session:.*session-active/);
      assert.match(detailHumanResult.stdout, /Workers: 2/);
      assert.match(detailHumanResult.stdout, /Skill runs: 2/);
      assert.match(detailHumanResult.stdout, /Decisions: 1/);
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('egc CLI delegates the new status and sessions subcommands', async () => {
    const testDir = createTempDir('egc-state-cli-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      await seedStore(dbPath);

      const statusResult = runNode(ECC_SCRIPT, ['status', '--db', dbPath, '--json']);
      assert.strictEqual(statusResult.status, 0, statusResult.stderr);
      const statusPayload = parseJson(statusResult.stdout);
      assert.strictEqual(statusPayload.activeSessions.activeCount, 1);

      const sessionsResult = runNode(ECC_SCRIPT, ['sessions', 'session-active', '--db', dbPath, '--json']);
      assert.strictEqual(sessionsResult.status, 0, sessionsResult.stderr);
      const sessionsPayload = parseJson(sessionsResult.stdout);
      assert.strictEqual(sessionsPayload.session.id, 'session-active');
      assert.strictEqual(sessionsPayload.skillRuns.length, 2);
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('persists instincts with confidence scoring and project scoping', async () => {
    const testDir = createTempDir('egc-state-instincts-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      const store = await createStateStore({ dbPath });

      const instinct = store.upsertInstinct({
        id: 'instinct-1',
        projectId: 'proj-abc',
        trigger: 'PostToolUse:Edit',
        content: 'Always run tsc after editing TypeScript files',
        confidence: 0.85,
        createdAt: '2026-05-15T10:00:00.000Z',
      });

      store.upsertInstinct({
        id: 'instinct-2',
        projectId: 'proj-abc',
        trigger: 'PostToolUse:Write',
        content: 'Run prettier after writing JS/TS files',
        confidence: 0.7,
      });

      store.upsertInstinct({
        id: 'instinct-3',
        projectId: 'proj-other',
        trigger: 'Stop',
        content: 'Audit console.log before committing',
        confidence: 0.9,
      });

      const result = store.listInstincts({ projectId: 'proj-abc' });
      store.close();

      assert.strictEqual(instinct.id, 'instinct-1');
      assert.strictEqual(instinct.projectId, 'proj-abc');
      assert.strictEqual(instinct.trigger, 'PostToolUse:Edit');
      assert.strictEqual(instinct.confidence, 0.85);
      assert.strictEqual(instinct.updatedAt, null);

      assert.strictEqual(result.totalCount, 2);
      assert.strictEqual(result.instincts[0].id, 'instinct-1');
      assert.strictEqual(result.instincts[0].confidence, 0.85);
      assert.strictEqual(result.instincts[1].id, 'instinct-2');
      assert.strictEqual(result.instincts[1].confidence, 0.7);
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('upserts instinct updates content and confidence without changing created_at', async () => {
    const testDir = createTempDir('egc-state-instinct-upsert-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      const store = await createStateStore({ dbPath });

      store.upsertInstinct({
        id: 'instinct-evolve',
        projectId: 'proj-abc',
        trigger: 'PreToolUse:Bash',
        content: 'Check for git push before execution',
        confidence: 0.5,
        createdAt: '2026-05-01T00:00:00.000Z',
      });

      const evolved = store.upsertInstinct({
        id: 'instinct-evolve',
        projectId: 'proj-abc',
        trigger: 'PreToolUse:Bash',
        content: 'Warn about git push --force before execution',
        confidence: 0.95,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-15T10:00:00.000Z',
      });

      const result = store.listInstincts({ projectId: 'proj-abc' });
      store.close();

      assert.strictEqual(result.totalCount, 1);
      assert.strictEqual(evolved.confidence, 0.95);
      assert.strictEqual(evolved.updatedAt, '2026-05-15T10:00:00.000Z');
      assert.strictEqual(evolved.createdAt, '2026-05-01T00:00:00.000Z');
      assert.ok(evolved.content.includes('force'));
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('clamps instinct confidence to [0, 1] and rejects missing projectId', async () => {
    const testDir = createTempDir('egc-state-instinct-validation-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      const store = await createStateStore({ dbPath });

      const clamped = store.upsertInstinct({
        id: 'instinct-clamp',
        projectId: 'proj-abc',
        trigger: 'Stop',
        content: 'Confidence clamping test',
        confidence: 1.5,
      });

      assert.throws(
        () => store.listInstincts({ projectId: '' }),
        /listInstincts requires a non-empty projectId/
      );

      store.close();

      assert.strictEqual(clamped.confidence, 1);
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  if (await test('persists runtime events and supports filtering by session and type', async () => {
    const testDir = createTempDir('egc-state-events-');
    const dbPath = path.join(testDir, 'state.db');

    try {
      const store = await createStateStore({ dbPath });

      store.upsertSession({
        id: 'session-events',
        adapterId: 'manual',
        harness: 'egc',
        state: 'active',
      });

      store.insertRuntimeEvent({
        id: 'evt-1',
        sessionId: 'session-events',
        eventType: 'PreToolUse',
        payload: { tool: 'Edit', file: 'src/index.ts' },
        timestamp: '2026-05-15T10:01:00.000Z',
      });

      store.insertRuntimeEvent({
        id: 'evt-2',
        sessionId: 'session-events',
        eventType: 'PostToolUse',
        payload: { tool: 'Edit', result: 'ok' },
        timestamp: '2026-05-15T10:01:01.000Z',
      });

      store.insertRuntimeEvent({
        id: 'evt-3',
        sessionId: null,
        eventType: 'SessionStart',
        payload: { profile: 'standard' },
        timestamp: '2026-05-15T10:00:00.000Z',
      });

      const allEvents = store.listRecentEvents({ limit: 10 });
      const sessionEvents = store.listRecentEvents({ sessionId: 'session-events' });
      const typeEvents = store.listRecentEvents({ eventType: 'PreToolUse' });
      store.close();

      assert.strictEqual(allEvents.length, 3);
      assert.strictEqual(allEvents[0].id, 'evt-2');

      assert.strictEqual(sessionEvents.length, 2);
      assert.ok(sessionEvents.every(e => e.sessionId === 'session-events'));

      assert.strictEqual(typeEvents.length, 1);
      assert.strictEqual(typeEvents[0].id, 'evt-1');
      assert.deepStrictEqual(typeEvents[0].payload, { tool: 'Edit', file: 'src/index.ts' });

      assert.strictEqual(allEvents[2].sessionId, null);
    } finally {
      cleanupTempDir(testDir);
    }
  })) passed += 1; else failed += 1;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
