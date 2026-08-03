'use strict';

const { assertValidEntity } = require('../schema');

function mapSkillVersionRow(row) {
  return {
    skillId: row.skill_id,
    version: row.version,
    contentHash: row.content_hash,
    amendmentReason: row.amendment_reason,
    promotedAt: row.promoted_at,
    rolledBackAt: row.rolled_back_at,
  };
}

function normalizeSkillVersionInput(skillVersion) {
  return {
    skillId: skillVersion.skillId,
    version: skillVersion.version,
    contentHash: skillVersion.contentHash,
    amendmentReason: skillVersion.amendmentReason ?? null,
    promotedAt: skillVersion.promotedAt ?? null,
    rolledBackAt: skillVersion.rolledBackAt ?? null,
  };
}

function createSkillVersionQueries(db) {
  const getSkillVersionStatement = db.prepare(`
    SELECT *
    FROM skill_versions
    WHERE skill_id = ? AND version = ?
  `);
  const upsertSkillVersionStatement = db.prepare(`
    INSERT INTO skill_versions (
      skill_id,
      version,
      content_hash,
      amendment_reason,
      promoted_at,
      rolled_back_at
    ) VALUES (
      @skill_id,
      @version,
      @content_hash,
      @amendment_reason,
      @promoted_at,
      @rolled_back_at
    )
    ON CONFLICT(skill_id, version) DO UPDATE SET
      content_hash = excluded.content_hash,
      amendment_reason = excluded.amendment_reason,
      promoted_at = excluded.promoted_at,
      rolled_back_at = excluded.rolled_back_at
  `);

  function upsertSkillVersion(skillVersion) {
    const normalized = normalizeSkillVersionInput(skillVersion);
    assertValidEntity('skillVersion', normalized);
    upsertSkillVersionStatement.run({
      skill_id: normalized.skillId,
      version: normalized.version,
      content_hash: normalized.contentHash,
      amendment_reason: normalized.amendmentReason,
      promoted_at: normalized.promotedAt,
      rolled_back_at: normalized.rolledBackAt,
    });
    const row = getSkillVersionStatement.get(normalized.skillId, normalized.version);
    return row ? mapSkillVersionRow(row) : null;
  }

  return { upsertSkillVersion };
}

module.exports = { mapSkillVersionRow, normalizeSkillVersionInput, createSkillVersionQueries };
