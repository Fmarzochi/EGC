'use strict';

const { assertValidEntity } = require('../schema');
const { parseJsonColumn, stringifyJson } = require('./shared');

function mapDecisionRow(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    rationale: row.rationale,
    alternatives: parseJsonColumn(row.alternatives, []),
    supersedes: row.supersedes,
    status: row.status,
    createdAt: row.created_at,
  };
}

function normalizeDecisionInput(decision) {
  return {
    id: decision.id,
    sessionId: decision.sessionId,
    title: decision.title,
    rationale: decision.rationale,
    alternatives: decision.alternatives === undefined || decision.alternatives === null
      ? []
      : decision.alternatives,
    supersedes: decision.supersedes ?? null,
    status: decision.status,
    createdAt: decision.createdAt || new Date().toISOString(),
  };
}

function createDecisionQueries(db) {
  const getSessionDecisionsStatement = db.prepare(`
    SELECT *
    FROM decisions
    WHERE session_id = ?
    ORDER BY created_at DESC, id DESC
  `);
  const insertDecisionStatement = db.prepare(`
    INSERT INTO decisions (
      id,
      session_id,
      title,
      rationale,
      alternatives,
      supersedes,
      status,
      created_at
    ) VALUES (
      @id,
      @session_id,
      @title,
      @rationale,
      @alternatives,
      @supersedes,
      @status,
      @created_at
    )
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id,
      title = excluded.title,
      rationale = excluded.rationale,
      alternatives = excluded.alternatives,
      supersedes = excluded.supersedes,
      status = excluded.status,
      created_at = excluded.created_at
  `);

  const countDecisionsStatement = db.prepare(`
    SELECT COUNT(*) AS total_count
    FROM decisions
  `);

  function countDecisions() {
    return countDecisionsStatement.get().total_count;
  }

  function listDecisionsForSession(sessionId) {
    return getSessionDecisionsStatement.all(sessionId).map(mapDecisionRow);
  }

  function insertDecision(decision) {
    const normalized = normalizeDecisionInput(decision);
    assertValidEntity('decision', normalized);
    insertDecisionStatement.run({
      id: normalized.id,
      session_id: normalized.sessionId,
      title: normalized.title,
      rationale: normalized.rationale,
      alternatives: stringifyJson(normalized.alternatives, 'decision.alternatives'),
      supersedes: normalized.supersedes,
      status: normalized.status,
      created_at: normalized.createdAt,
    });
    return normalized;
  }

  return { countDecisions, listDecisionsForSession, insertDecision };
}

module.exports = { mapDecisionRow, normalizeDecisionInput, createDecisionQueries };
