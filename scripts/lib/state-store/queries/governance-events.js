'use strict';

const { assertValidEntity } = require('../schema');
const { parseJsonColumn, stringifyJson } = require('./shared');

function mapGovernanceEventRow(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type,
    payload: parseJsonColumn(row.payload, null),
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    createdAt: row.created_at,
  };
}

function normalizeGovernanceEventInput(governanceEvent) {
  return {
    id: governanceEvent.id,
    sessionId: governanceEvent.sessionId ?? null,
    eventType: governanceEvent.eventType,
    payload: governanceEvent.payload ?? null,
    resolvedAt: governanceEvent.resolvedAt ?? null,
    resolution: governanceEvent.resolution ?? null,
    createdAt: governanceEvent.createdAt || new Date().toISOString(),
  };
}

function createGovernanceEventQueries(db) {
  const countPendingGovernanceStatement = db.prepare(`
    SELECT COUNT(*) AS total_count
    FROM governance_events
    WHERE resolved_at IS NULL
  `);
  const listPendingGovernanceStatement = db.prepare(`
    SELECT *
    FROM governance_events
    WHERE resolved_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const insertGovernanceEventStatement = db.prepare(`
    INSERT INTO governance_events (
      id,
      session_id,
      event_type,
      payload,
      resolved_at,
      resolution,
      created_at
    ) VALUES (
      @id,
      @session_id,
      @event_type,
      @payload,
      @resolved_at,
      @resolution,
      @created_at
    )
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id,
      event_type = excluded.event_type,
      payload = excluded.payload,
      resolved_at = excluded.resolved_at,
      resolution = excluded.resolution,
      created_at = excluded.created_at
  `);

  function listPendingGovernanceEvents(limit) {
    return listPendingGovernanceStatement.all(limit).map(mapGovernanceEventRow);
  }

  function countPendingGovernanceEvents() {
    return countPendingGovernanceStatement.get().total_count;
  }

  function insertGovernanceEvent(governanceEvent) {
    const normalized = normalizeGovernanceEventInput(governanceEvent);
    assertValidEntity('governanceEvent', normalized);
    insertGovernanceEventStatement.run({
      id: normalized.id,
      session_id: normalized.sessionId,
      event_type: normalized.eventType,
      payload: stringifyJson(normalized.payload, 'governanceEvent.payload'),
      resolved_at: normalized.resolvedAt,
      resolution: normalized.resolution,
      created_at: normalized.createdAt,
    });
    return normalized;
  }

  return { listPendingGovernanceEvents, countPendingGovernanceEvents, insertGovernanceEvent };
}

module.exports = { mapGovernanceEventRow, normalizeGovernanceEventInput, createGovernanceEventQueries };
