'use strict';

const { assertValidEntity } = require('../schema');

function mapSkillRunRow(row) {
  return {
    id: row.id,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    sessionId: row.session_id,
    taskDescription: row.task_description,
    outcome: row.outcome,
    failureReason: row.failure_reason,
    tokensUsed: row.tokens_used,
    durationMs: row.duration_ms,
    userFeedback: row.user_feedback,
    createdAt: row.created_at,
  };
}

function normalizeSkillRunInput(skillRun) {
  return {
    id: skillRun.id,
    skillId: skillRun.skillId,
    skillVersion: skillRun.skillVersion,
    sessionId: skillRun.sessionId,
    taskDescription: skillRun.taskDescription,
    outcome: skillRun.outcome,
    failureReason: skillRun.failureReason ?? null,
    tokensUsed: skillRun.tokensUsed ?? null,
    durationMs: skillRun.durationMs ?? null,
    userFeedback: skillRun.userFeedback ?? null,
    createdAt: skillRun.createdAt || new Date().toISOString(),
  };
}

function createSkillRunQueries(db) {
  const getSessionSkillRunsStatement = db.prepare(`
    SELECT *
    FROM skill_runs
    WHERE session_id = ?
    ORDER BY created_at DESC, id DESC
  `);
  const listRecentSkillRunsStatement = db.prepare(`
    SELECT *
    FROM skill_runs
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const insertSkillRunStatement = db.prepare(`
    INSERT INTO skill_runs (
      id,
      skill_id,
      skill_version,
      session_id,
      task_description,
      outcome,
      failure_reason,
      tokens_used,
      duration_ms,
      user_feedback,
      created_at
    ) VALUES (
      @id,
      @skill_id,
      @skill_version,
      @session_id,
      @task_description,
      @outcome,
      @failure_reason,
      @tokens_used,
      @duration_ms,
      @user_feedback,
      @created_at
    )
    ON CONFLICT(id) DO UPDATE SET
      skill_id = excluded.skill_id,
      skill_version = excluded.skill_version,
      session_id = excluded.session_id,
      task_description = excluded.task_description,
      outcome = excluded.outcome,
      failure_reason = excluded.failure_reason,
      tokens_used = excluded.tokens_used,
      duration_ms = excluded.duration_ms,
      user_feedback = excluded.user_feedback,
      created_at = excluded.created_at
  `);

  function listSkillRunsForSession(sessionId) {
    return getSessionSkillRunsStatement.all(sessionId).map(mapSkillRunRow);
  }

  function listRecentSkillRuns(limit) {
    return listRecentSkillRunsStatement.all(limit).map(mapSkillRunRow);
  }

  function insertSkillRun(skillRun) {
    const normalized = normalizeSkillRunInput(skillRun);
    assertValidEntity('skillRun', normalized);
    insertSkillRunStatement.run({
      id: normalized.id,
      skill_id: normalized.skillId,
      skill_version: normalized.skillVersion,
      session_id: normalized.sessionId,
      task_description: normalized.taskDescription,
      outcome: normalized.outcome,
      failure_reason: normalized.failureReason,
      tokens_used: normalized.tokensUsed,
      duration_ms: normalized.durationMs,
      user_feedback: normalized.userFeedback,
      created_at: normalized.createdAt,
    });
    return normalized;
  }

  return {
    listSkillRunsForSession,
    listRecentSkillRuns,
    insertSkillRun,
  };
}

module.exports = { mapSkillRunRow, normalizeSkillRunInput, createSkillRunQueries };
