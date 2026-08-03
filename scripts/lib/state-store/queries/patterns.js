'use strict';

const { normalizeLimit } = require('./shared');

function mapPatternRow(row) {
  return {
    id: row.id,
    patternType: row.pattern_type,
    key: row.key,
    description: row.description,
    occurrences: row.occurrences,
    frequency: row.frequency,
    lastSeen: row.last_seen,
    suggestedAutomation: row.suggested_automation ?? null,
    firstSeen: row.first_seen,
    windowDays: row.window_days,
  };
}

function normalizePatternInput(pattern) {
  return {
    id: pattern.id,
    patternType: pattern.patternType,
    key: pattern.key,
    description: pattern.description,
    occurrences: typeof pattern.occurrences === 'number' ? pattern.occurrences : 1,
    frequency: typeof pattern.frequency === 'number' ? pattern.frequency : 0,
    lastSeen: pattern.lastSeen || new Date().toISOString(),
    suggestedAutomation: pattern.suggestedAutomation ?? null,
    firstSeen: pattern.firstSeen || new Date().toISOString(),
    windowDays: typeof pattern.windowDays === 'number' ? pattern.windowDays : 7,
  };
}

function createPatternQueries(db) {
  const upsertPatternStatement = db.prepare(`
    INSERT INTO patterns (
      id,
      pattern_type,
      key,
      description,
      occurrences,
      frequency,
      last_seen,
      suggested_automation,
      first_seen,
      window_days
    ) VALUES (
      @id,
      @pattern_type,
      @key,
      @description,
      @occurrences,
      @frequency,
      @last_seen,
      @suggested_automation,
      @first_seen,
      @window_days
    )
    ON CONFLICT(id) DO UPDATE SET
      pattern_type = excluded.pattern_type,
      key = excluded.key,
      description = excluded.description,
      occurrences = excluded.occurrences,
      frequency = excluded.frequency,
      last_seen = excluded.last_seen,
      suggested_automation = excluded.suggested_automation,
      first_seen = MIN(patterns.first_seen, excluded.first_seen),
      window_days = excluded.window_days
  `);
  const listPatternsStatement = db.prepare(`
    SELECT *
    FROM patterns
    ORDER BY occurrences DESC, last_seen DESC
    LIMIT ?
  `);

  function upsertPattern(pattern) {
    const normalized = normalizePatternInput(pattern);
    upsertPatternStatement.run({
      id: normalized.id,
      pattern_type: normalized.patternType,
      key: normalized.key,
      description: normalized.description,
      occurrences: normalized.occurrences,
      frequency: normalized.frequency,
      last_seen: normalized.lastSeen,
      suggested_automation: normalized.suggestedAutomation,
      first_seen: normalized.firstSeen,
      window_days: normalized.windowDays,
    });
    return normalized;
  }

  function listPatterns(options = {}) {
    const limit = normalizeLimit(options.limit, 100);
    return listPatternsStatement.all(limit).map(mapPatternRow);
  }

  return { upsertPattern, listPatterns };
}

module.exports = { mapPatternRow, normalizePatternInput, createPatternQueries };
