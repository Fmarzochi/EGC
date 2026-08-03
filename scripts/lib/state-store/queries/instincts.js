'use strict';

const { assertValidEntity } = require('../schema');
const { normalizeLimit } = require('./shared');

function mapInstinctRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    trigger: row.trigger,
    content: row.content,
    confidence: typeof row.confidence === 'number' ? row.confidence : 0.5,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

function normalizeInstinctInput(instinct) {
  let confidence = 0.5;
  if (typeof instinct.confidence === 'number') {
    if (!Number.isFinite(instinct.confidence)) {
      throw new TypeError(`Invalid instinct.confidence: must be a finite number (got ${instinct.confidence})`);
    }
    confidence = Math.min(1, Math.max(0, instinct.confidence));
  }

  return {
    id: instinct.id,
    projectId: instinct.projectId,
    trigger: instinct.trigger,
    content: instinct.content,
    confidence,
    createdAt: instinct.createdAt || new Date().toISOString(),
    updatedAt: instinct.updatedAt ?? null,
  };
}

function createInstinctQueries(db) {
  const listInstinctsStatement = db.prepare(`
    SELECT *
    FROM instincts
    WHERE project_id = ?
    ORDER BY confidence DESC, created_at DESC
    LIMIT ?
  `);
  const countInstinctsStatement = db.prepare(`
    SELECT COUNT(*) AS total_count
    FROM instincts
    WHERE project_id = ?
  `);
  const getInstinctStatement = db.prepare(`
    SELECT *
    FROM instincts
    WHERE id = ?
  `);
  const upsertInstinctStatement = db.prepare(`
    INSERT INTO instincts (
      id,
      project_id,
      trigger,
      content,
      confidence,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @project_id,
      @trigger,
      @content,
      @confidence,
      @created_at,
      @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id,
      trigger = excluded.trigger,
      content = excluded.content,
      confidence = excluded.confidence,
      updated_at = excluded.updated_at
  `);

  function listInstincts(options = {}) {
    const projectId = options.projectId;
    if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
      throw new Error('listInstincts requires a non-empty projectId');
    }
    const limit = normalizeLimit(options.limit, 20);
    return {
      totalCount: countInstinctsStatement.get(projectId).total_count,
      instincts: listInstinctsStatement.all(projectId, limit).map(mapInstinctRow),
    };
  }

  function upsertInstinct(instinct) {
    const normalized = normalizeInstinctInput(instinct);
    assertValidEntity('instinct', normalized);
    upsertInstinctStatement.run({
      id: normalized.id,
      project_id: normalized.projectId,
      trigger: normalized.trigger,
      content: normalized.content,
      confidence: normalized.confidence,
      created_at: normalized.createdAt,
      updated_at: normalized.updatedAt,
    });
    const row = getInstinctStatement.get(normalized.id);
    return row ? mapInstinctRow(row) : null;
  }

  return { listInstincts, upsertInstinct };
}

module.exports = { mapInstinctRow, normalizeInstinctInput, createInstinctQueries };
