'use strict';

const { assertValidEntity } = require('../schema');
const { normalizeLimit, parseJsonColumn, stringifyJson } = require('./shared');

function mapSessionRow(row) {
  const snapshot = parseJsonColumn(row.snapshot, {});
  return {
    id: row.id,
    adapterId: row.adapter_id,
    harness: row.harness,
    state: row.state,
    repoRoot: row.repo_root,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    snapshot,
    workerCount: Array.isArray(snapshot?.workers) ? snapshot.workers.length : 0,
    inputTokens: row.input_tokens ?? null,
    outputTokens: row.output_tokens ?? null,
    totalTokens: row.total_tokens ?? null,
    tokenCost: row.token_cost ?? null,
  };
}

function normalizeSessionInput(session) {
  return {
    id: session.id,
    adapterId: session.adapterId,
    harness: session.harness,
    state: session.state,
    repoRoot: session.repoRoot ?? null,
    startedAt: session.startedAt ?? null,
    endedAt: session.endedAt ?? null,
    snapshot: session.snapshot ?? {},
    inputTokens: Number.isFinite(session.inputTokens) ? session.inputTokens : null,
    outputTokens: Number.isFinite(session.outputTokens) ? session.outputTokens : null,
    totalTokens: Number.isFinite(session.totalTokens) ? session.totalTokens : null,
    tokenCost: Number.isFinite(session.tokenCost) ? session.tokenCost : null,
  };
}

function createSessionQueries(db) {
  const listRecentSessionsStatement = db.prepare(`
    SELECT *
    FROM sessions
    ORDER BY COALESCE(started_at, ended_at, '') DESC, id DESC
    LIMIT ?
  `);
  const countSessionsStatement = db.prepare(`
    SELECT COUNT(*) AS total_count
    FROM sessions
  `);
  const getSessionStatement = db.prepare(`
    SELECT *
    FROM sessions
    WHERE id = ?
  `);
  const listActiveSessionsStatement = db.prepare(`
    SELECT *
    FROM sessions
    WHERE ended_at IS NULL
      AND state IN ('active', 'running', 'idle')
    ORDER BY COALESCE(started_at, ended_at, '') DESC, id DESC
    LIMIT ?
  `);
  const countActiveSessionsStatement = db.prepare(`
    SELECT COUNT(*) AS total_count
    FROM sessions
    WHERE ended_at IS NULL
      AND state IN ('active', 'running', 'idle')
  `);
  const upsertSessionStatement = db.prepare(`
    INSERT INTO sessions (
      id,
      adapter_id,
      harness,
      state,
      repo_root,
      started_at,
      ended_at,
      snapshot,
      input_tokens,
      output_tokens,
      total_tokens,
      token_cost
    ) VALUES (
      @id,
      @adapter_id,
      @harness,
      @state,
      @repo_root,
      @started_at,
      @ended_at,
      @snapshot,
      @input_tokens,
      @output_tokens,
      @total_tokens,
      @token_cost
    )
    ON CONFLICT(id) DO UPDATE SET
      adapter_id = excluded.adapter_id,
      harness = excluded.harness,
      state = excluded.state,
      repo_root = excluded.repo_root,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      snapshot = excluded.snapshot,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens,
      token_cost = excluded.token_cost
  `);

  function getSessionById(id) {
    const row = getSessionStatement.get(id);
    return row ? mapSessionRow(row) : null;
  }

  function listRecentSessions(options = {}) {
    const limit = normalizeLimit(options.limit, 10);
    return {
      totalCount: countSessionsStatement.get().total_count,
      sessions: listRecentSessionsStatement.all(limit).map(mapSessionRow),
    };
  }

  function listActiveSessions(limit) {
    return listActiveSessionsStatement.all(limit).map(mapSessionRow);
  }

  function countActiveSessions() {
    return countActiveSessionsStatement.get().total_count;
  }

  function upsertSession(session) {
    const normalized = normalizeSessionInput(session);
    assertValidEntity('session', normalized);
    upsertSessionStatement.run({
      id: normalized.id,
      adapter_id: normalized.adapterId,
      harness: normalized.harness,
      state: normalized.state,
      repo_root: normalized.repoRoot,
      started_at: normalized.startedAt,
      ended_at: normalized.endedAt,
      snapshot: stringifyJson(normalized.snapshot, 'session.snapshot'),
      input_tokens: normalized.inputTokens,
      output_tokens: normalized.outputTokens,
      total_tokens: normalized.totalTokens,
      token_cost: normalized.tokenCost,
    });
    return getSessionById(normalized.id);
  }

  return {
    getSessionById,
    listRecentSessions,
    listActiveSessions,
    countActiveSessions,
    upsertSession,
  };
}

module.exports = { mapSessionRow, normalizeSessionInput, createSessionQueries };
