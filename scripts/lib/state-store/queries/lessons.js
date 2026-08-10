'use strict';

const { assertValidEntity } = require('../schema');
const { normalizeLimit } = require('./shared');

const REINFORCE_DELTA = 0.15;
const DECAY_DELTA_PER_WEEK = 0.05;
const DECAY_GRACE_DAYS = 30;
const ARCHIVE_THRESHOLD = 0.2;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function mapLessonRow(row) {
  return {
    id: row.id,
    content: row.content,
    context: row.context,
    confidence: typeof row.confidence === 'number' ? row.confidence : 0.7,
    lastReinforced: row.last_reinforced ?? null,
    lastRecalled: row.last_recalled ?? null,
    createdAt: row.created_at,
    tags: row.tags ?? null,
    archived: row.archived === 1 ? 1 : 0,
  };
}

function normalizeLessonInput(lesson) {
  let confidence = 0.7;
  if (typeof lesson.confidence === 'number') {
    if (!Number.isFinite(lesson.confidence)) {
      throw new TypeError(`Invalid lesson.confidence: must be a finite number (got ${lesson.confidence})`);
    }
    confidence = Math.min(1, Math.max(0, lesson.confidence));
  }

  return {
    id: lesson.id,
    content: lesson.content,
    context: lesson.context,
    confidence,
    lastReinforced: lesson.lastReinforced ?? null,
    lastRecalled: lesson.lastRecalled ?? null,
    createdAt: lesson.createdAt || new Date().toISOString(),
    tags: lesson.tags ?? null,
    archived: lesson.archived === 1 ? 1 : 0,
  };
}

function computeDecayedConfidence(lesson, nowMs) {
  const recalledMs = lesson.lastRecalled ? new Date(lesson.lastRecalled).getTime() : new Date(lesson.createdAt).getTime();
  const elapsedMs = nowMs - recalledMs;
  const gracePeriodMs = DECAY_GRACE_DAYS * MS_PER_DAY;
  if (elapsedMs <= gracePeriodMs) {
    return lesson.confidence;
  }
  const weeksOverGrace = Math.floor((elapsedMs - gracePeriodMs) / MS_PER_WEEK);
  const decayed = lesson.confidence - weeksOverGrace * DECAY_DELTA_PER_WEEK;
  return Math.max(0, decayed);
}

function createLessonQueries(db) {
  const upsertLessonStatement = db.prepare(`
    INSERT INTO lessons (
      id,
      content,
      context,
      confidence,
      last_reinforced,
      last_recalled,
      created_at,
      tags,
      archived
    ) VALUES (
      @id,
      @content,
      @context,
      @confidence,
      @last_reinforced,
      @last_recalled,
      @created_at,
      @tags,
      @archived
    )
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      context = excluded.context,
      confidence = excluded.confidence,
      last_reinforced = excluded.last_reinforced,
      last_recalled = excluded.last_recalled,
      tags = excluded.tags,
      archived = excluded.archived
  `);

  const getLessonStatement = db.prepare(`
    SELECT * FROM lessons WHERE id = ?
  `);

  const listActiveLessonsStatement = db.prepare(`
    SELECT * FROM lessons
    WHERE archived = 0 AND confidence >= ?
    ORDER BY confidence DESC, created_at DESC
    LIMIT ?
  `);

  const listAllLessonsForDecayStatement = db.prepare(`
    SELECT * FROM lessons WHERE archived = 0
  `);

  const countLessonsStatement = db.prepare(`
    SELECT COUNT(*) AS total_count
    FROM lessons
    WHERE archived = 0
  `);

  const updateLessonDecayStatement = db.prepare(`
    UPDATE lessons SET confidence = @confidence, archived = @archived WHERE id = @id
  `);

  function getLessonById(id) {
    const row = getLessonStatement.get(id);
    return row ? mapLessonRow(row) : null;
  }

  function upsertLesson(lesson) {
    const normalized = normalizeLessonInput(lesson);
    assertValidEntity('lesson', normalized);
    upsertLessonStatement.run({
      id: normalized.id,
      content: normalized.content,
      context: normalized.context,
      confidence: normalized.confidence,
      last_reinforced: normalized.lastReinforced,
      last_recalled: normalized.lastRecalled,
      created_at: normalized.createdAt,
      tags: normalized.tags,
      archived: normalized.archived,
    });
    const row = getLessonStatement.get(normalized.id);
    return row ? mapLessonRow(row) : null;
  }

  function countLessons() {
    return countLessonsStatement.get().total_count;
  }

  function listLessons(options = {}) {
    const minConfidence = typeof options.minConfidence === 'number' ? options.minConfidence : 0.2;
    const limit = normalizeLimit(options.limit, 20);
    return listActiveLessonsStatement.all(minConfidence, limit).map(mapLessonRow);
  }

  function reinforceLesson(id, nowIso) {
    const row = getLessonStatement.get(id);
    if (!row) {
      return null;
    }
    const lesson = mapLessonRow(row);
    const newConfidence = Math.min(1, lesson.confidence + REINFORCE_DELTA);
    const reinforcedAt = nowIso || new Date().toISOString();
    upsertLessonStatement.run({
      id: lesson.id,
      content: lesson.content,
      context: lesson.context,
      confidence: newConfidence,
      last_reinforced: reinforcedAt,
      last_recalled: lesson.lastRecalled,
      created_at: lesson.createdAt,
      tags: lesson.tags,
      archived: 0,
    });
    const updated = getLessonStatement.get(id);
    return updated ? mapLessonRow(updated) : null;
  }

  function applyDecaySweep(nowIso) {
    const now = nowIso ? new Date(nowIso).getTime() : Date.now();
    const rows = listAllLessonsForDecayStatement.all().map(mapLessonRow);
    let affected = 0;
    const applyAll = db.transaction(() => {
      for (const lesson of rows) {
        const decayed = computeDecayedConfidence(lesson, now);
        if (decayed === lesson.confidence) {
          continue;
        }
        const archived = decayed < ARCHIVE_THRESHOLD ? 1 : 0;
        updateLessonDecayStatement.run({
          id: lesson.id,
          confidence: decayed,
          archived,
        });
        affected++;
      }
    });
    applyAll();
    return affected;
  }

  return { countLessons, upsertLesson, getLessonById, listLessons, reinforceLesson, applyDecaySweep };
}

module.exports = {
  REINFORCE_DELTA,
  DECAY_DELTA_PER_WEEK,
  DECAY_GRACE_DAYS,
  ARCHIVE_THRESHOLD,
  mapLessonRow,
  normalizeLessonInput,
  computeDecayedConfidence,
  createLessonQueries,
};
