'use strict';

const path = require('path');

const SESSION_SCHEMA_VERSION = 'ecc.session.v1';

function buildAggregates(workers) {
  const states = workers.reduce((accumulator, worker) => {
    const state = worker.state || 'unknown';
    accumulator[state] = (accumulator[state] || 0) + 1;
    return accumulator;
  }, {});

  return {
    workerCount: workers.length,
    states
  };
}

function deriveDmuxSessionState(snapshot) {
  if (snapshot.sessionActive) {
    return 'active';
  }

  if (snapshot.workerCount > 0) {
    return 'idle';
  }

  return 'missing';
}

function normalizeDmuxSnapshot(snapshot, sourceTarget) {
  const workers = (snapshot.workers || []).map(worker => ({
    id: worker.workerSlug,
    label: worker.workerSlug,
    state: worker.status.state || 'unknown',
    branch: worker.status.branch || null,
    worktree: worker.status.worktree || null,
    runtime: {
      kind: 'tmux-pane',
      command: worker.pane ? worker.pane.currentCommand || null : null,
      pid: worker.pane ? worker.pane.pid || null : null,
      active: worker.pane ? Boolean(worker.pane.active) : false,
      dead: worker.pane ? Boolean(worker.pane.dead) : false,
    },
    intent: {
      objective: worker.task.objective || '',
      seedPaths: Array.isArray(worker.task.seedPaths) ? worker.task.seedPaths : []
    },
    outputs: {
      summary: Array.isArray(worker.handoff.summary) ? worker.handoff.summary : [],
      validation: Array.isArray(worker.handoff.validation) ? worker.handoff.validation : [],
      remainingRisks: Array.isArray(worker.handoff.remainingRisks) ? worker.handoff.remainingRisks : []
    },
    artifacts: {
      statusFile: worker.files.status,
      taskFile: worker.files.task,
      handoffFile: worker.files.handoff
    }
  }));

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    adapterId: 'dmux-tmux',
    session: {
      id: snapshot.sessionName,
      kind: 'orchestrated',
      state: deriveDmuxSessionState(snapshot),
      repoRoot: snapshot.repoRoot || null,
      sourceTarget
    },
    workers,
    aggregates: buildAggregates(workers)
  };
}

function deriveClaudeWorkerId(session) {
  if (session.shortId && session.shortId !== 'no-id') {
    return session.shortId;
  }

  return path.basename(session.filename || session.sessionPath || 'session', '.tmp');
}

function normalizeClaudeHistorySession(session, sourceTarget) {
  const metadata = session.metadata || {};
  const workerId = deriveClaudeWorkerId(session);
  const worker = {
    id: workerId,
    label: metadata.title || session.filename || workerId,
    state: 'recorded',
    branch: metadata.branch || null,
    worktree: metadata.worktree || null,
    runtime: {
      kind: 'claude-session',
      command: 'claude',
      pid: null,
      active: false,
      dead: true,
    },
    intent: {
      objective: metadata.inProgress && metadata.inProgress.length > 0
        ? metadata.inProgress[0]
        : (metadata.title || ''),
      seedPaths: []
    },
    outputs: {
      summary: Array.isArray(metadata.completed) ? metadata.completed : [],
      validation: [],
      remainingRisks: metadata.notes ? [metadata.notes] : []
    },
    artifacts: {
      sessionFile: session.sessionPath,
      context: metadata.context || null
    }
  };

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    adapterId: 'claude-history',
    session: {
      id: workerId,
      kind: 'history',
      state: 'recorded',
      repoRoot: metadata.worktree || null,
      sourceTarget
    },
    workers: [worker],
    aggregates: buildAggregates([worker])
  };
}

module.exports = {
  SESSION_SCHEMA_VERSION,
  buildAggregates,
  normalizeClaudeHistorySession,
  normalizeDmuxSnapshot
};
