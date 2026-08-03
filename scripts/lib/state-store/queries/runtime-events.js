'use strict';

const { assertValidEntity } = require('../schema');
const { normalizeLimit, parseJsonColumn, stringifyJson } = require('./shared');

function mapRuntimeEventRow(row) {
  return {
    id: row.id,
    sessionId: row.session_id ?? null,
    eventType: row.event_type,
    payload: parseJsonColumn(row.payload, null),
    timestamp: row.timestamp,
  };
}

function normalizeRuntimeEventInput(event) {
  return {
    id: event.id,
    sessionId: event.sessionId ?? null,
    eventType: event.eventType,
    payload: event.payload ?? null,
    timestamp: event.timestamp || new Date().toISOString(),
  };
}

function createRuntimeEventQueries(db) {
  const listRecentEventsStatement = db.prepare(`
    SELECT *
    FROM events
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `);
  const listEventsBySessionStatement = db.prepare(`
    SELECT *
    FROM events
    WHERE session_id = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `);
  const listEventsByTypeStatement = db.prepare(`
    SELECT *
    FROM events
    WHERE event_type = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `);
  const listEventsInWindowStatement = db.prepare(`
    SELECT *
    FROM events
    WHERE timestamp >= ?
    ORDER BY timestamp ASC, id ASC
  `);
  const insertRuntimeEventStatement = db.prepare(`
    INSERT INTO events (
      id,
      session_id,
      event_type,
      payload,
      timestamp
    ) VALUES (
      @id,
      @session_id,
      @event_type,
      @payload,
      @timestamp
    )
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id,
      event_type = excluded.event_type,
      payload = excluded.payload,
      timestamp = excluded.timestamp
  `);

  function insertRuntimeEvent(event) {
    const normalized = normalizeRuntimeEventInput(event);
    assertValidEntity('runtimeEvent', normalized);
    insertRuntimeEventStatement.run({
      id: normalized.id,
      session_id: normalized.sessionId,
      event_type: normalized.eventType,
      payload: stringifyJson(normalized.payload, 'runtimeEvent.payload'),
      timestamp: normalized.timestamp,
    });
    return normalized;
  }

  function listRecentEvents(options = {}) {
    const limit = normalizeLimit(options.limit, 50);
    if (options.sessionId) {
      return listEventsBySessionStatement.all(options.sessionId, limit).map(mapRuntimeEventRow);
    }
    if (options.eventType) {
      return listEventsByTypeStatement.all(options.eventType, limit).map(mapRuntimeEventRow);
    }
    return listRecentEventsStatement.all(limit).map(mapRuntimeEventRow);
  }

  function listEventsInWindow(cutoffTimestamp) {
    return listEventsInWindowStatement.all(cutoffTimestamp).map(mapRuntimeEventRow);
  }

  return { insertRuntimeEvent, listRecentEvents, listEventsInWindow };
}

module.exports = { mapRuntimeEventRow, normalizeRuntimeEventInput, createRuntimeEventQueries };
