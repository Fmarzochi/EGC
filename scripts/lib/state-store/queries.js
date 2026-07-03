'use strict';

const { assertValidEntity } = require('./schema');

const ACTIVE_SESSION_STATES = ['active', 'running', 'idle'];
const SUCCESS_OUTCOMES = new Set(['success', 'succeeded', 'passed']);
const FAILURE_OUTCOMES = new Set(['failure', 'failed', 'error']);

function normalizeLimit(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid limit: ${value}`);
  }

  return parsed;
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  return JSON.parse(value);
}

function stringifyJson(value, label) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new Error(`Failed to serialize ${label}: ${error.message}`, { cause: error });
  }
}

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
    workerCount: Array.isArray(snapshot && snapshot.workers) ? snapshot.workers.length : 0,
    inputTokens: row.input_tokens ?? null,
    outputTokens: row.output_tokens ?? null,
    totalTokens: row.total_tokens ?? null,
    tokenCost: row.token_cost ?? null,
  };
}

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

function mapInstallStateRow(row) {
  const modules = parseJsonColumn(row.modules, []);
  const operations = parseJsonColumn(row.operations, []);
  const status = row.source_version && row.installed_at ? 'healthy' : 'warning';

  return {
    targetId: row.target_id,
    targetRoot: row.target_root,
    profile: row.profile,
    modules,
    operations,
    installedAt: row.installed_at,
    sourceVersion: row.source_version,
    moduleCount: Array.isArray(modules) ? modules.length : 0,
    operationCount: Array.isArray(operations) ? operations.length : 0,
    status,
  };
}

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

function mapRuntimeEventRow(row) {
  return {
    id: row.id,
    sessionId: row.session_id ?? null,
    eventType: row.event_type,
    payload: parseJsonColumn(row.payload, null),
    timestamp: row.timestamp,
  };
}

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

function classifyOutcome(outcome) {
  const normalized = String(outcome || '').toLowerCase();
  if (SUCCESS_OUTCOMES.has(normalized)) {
    return 'success';
  }

  if (FAILURE_OUTCOMES.has(normalized)) {
    return 'failure';
  }

  return 'unknown';
}

function toPercent(numerator, denominator) {
  if (denominator === 0) {
    return null;
  }

  return Number(((numerator / denominator) * 100).toFixed(1));
}

function summarizeSkillRuns(skillRuns) {
  const summary = {
    totalCount: skillRuns.length,
    knownCount: 0,
    successCount: 0,
    failureCount: 0,
    unknownCount: 0,
    successRate: null,
    failureRate: null,
  };

  for (const skillRun of skillRuns) {
    const classification = classifyOutcome(skillRun.outcome);
    if (classification === 'success') {
      summary.successCount += 1;
      summary.knownCount += 1;
    } else if (classification === 'failure') {
      summary.failureCount += 1;
      summary.knownCount += 1;
    } else {
      summary.unknownCount += 1;
    }
  }

  summary.successRate = toPercent(summary.successCount, summary.knownCount);
  summary.failureRate = toPercent(summary.failureCount, summary.knownCount);
  return summary;
}

function summarizeInstallHealth(installations) {
  if (installations.length === 0) {
    return {
      status: 'missing',
      totalCount: 0,
      healthyCount: 0,
      warningCount: 0,
      installations: [],
    };
  }

  const summary = installations.reduce((result, installation) => {
    if (installation.status === 'healthy') {
      result.healthyCount += 1;
    } else {
      result.warningCount += 1;
    }
    return result;
  }, {
    totalCount: installations.length,
    healthyCount: 0,
    warningCount: 0,
  });

  return {
    status: summary.warningCount > 0 ? 'warning' : 'healthy',
    ...summary,
    installations,
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

function normalizeInstallStateInput(installState) {
  return {
    targetId: installState.targetId,
    targetRoot: installState.targetRoot,
    profile: installState.profile ?? null,
    modules: installState.modules === undefined || installState.modules === null
      ? []
      : installState.modules,
    operations: installState.operations === undefined || installState.operations === null
      ? []
      : installState.operations,
    installedAt: installState.installedAt || new Date().toISOString(),
    sourceVersion: installState.sourceVersion ?? null,
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

function normalizeInstinctInput(instinct) {
  let confidence = 0.5;
  if (typeof instinct.confidence === 'number') {
    if (!Number.isFinite(instinct.confidence)) {
      throw new Error(`Invalid instinct.confidence: must be a finite number (got ${instinct.confidence})`);
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

function normalizeRuntimeEventInput(event) {
  return {
    id: event.id,
    sessionId: event.sessionId ?? null,
    eventType: event.eventType,
    payload: event.payload ?? null,
    timestamp: event.timestamp || new Date().toISOString(),
  };
}

const REINFORCE_DELTA = 0.15;
const DECAY_DELTA_PER_WEEK = 0.05;
const DECAY_GRACE_DAYS = 30;
const ARCHIVE_THRESHOLD = 0.2;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

function createQueryApi(db) {
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
  const getSessionSkillRunsStatement = db.prepare(`
    SELECT *
    FROM skill_runs
    WHERE session_id = ?
    ORDER BY created_at DESC, id DESC
  `);
  const getSessionDecisionsStatement = db.prepare(`
    SELECT *
    FROM decisions
    WHERE session_id = ?
    ORDER BY created_at DESC, id DESC
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
  const listRecentSkillRunsStatement = db.prepare(`
    SELECT *
    FROM skill_runs
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const listInstallStateStatement = db.prepare(`
    SELECT *
    FROM install_state
    ORDER BY installed_at DESC, target_id ASC
  `);
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
  const getSkillVersionStatement = db.prepare(`
    SELECT *
    FROM skill_versions
    WHERE skill_id = ? AND version = ?
  `);
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

  const upsertInstallStateStatement = db.prepare(`
    INSERT INTO install_state (
      target_id,
      target_root,
      profile,
      modules,
      operations,
      installed_at,
      source_version
    ) VALUES (
      @target_id,
      @target_root,
      @profile,
      @modules,
      @operations,
      @installed_at,
      @source_version
    )
    ON CONFLICT(target_id, target_root) DO UPDATE SET
      profile = excluded.profile,
      modules = excluded.modules,
      operations = excluded.operations,
      installed_at = excluded.installed_at,
      source_version = excluded.source_version
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

  const updateLessonDecayStatement = db.prepare(`
    UPDATE lessons SET confidence = @confidence, archived = @archived WHERE id = @id
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

  function getSessionDetail(id) {
    const session = getSessionById(id);
    if (!session) {
      return null;
    }

    const workers = Array.isArray(session.snapshot && session.snapshot.workers)
      ? session.snapshot.workers.map(worker => ({ ...worker }))
      : [];

    return {
      session,
      workers,
      skillRuns: getSessionSkillRunsStatement.all(id).map(mapSkillRunRow),
      decisions: getSessionDecisionsStatement.all(id).map(mapDecisionRow),
    };
  }

  function getStatus(options = {}) {
    const activeLimit = normalizeLimit(options.activeLimit, 5);
    const recentSkillRunLimit = normalizeLimit(options.recentSkillRunLimit, 20);
    const pendingLimit = normalizeLimit(options.pendingLimit, 5);

    const activeSessions = listActiveSessionsStatement.all(activeLimit).map(mapSessionRow);
    const recentSkillRuns = listRecentSkillRunsStatement.all(recentSkillRunLimit).map(mapSkillRunRow);
    const installations = listInstallStateStatement.all().map(mapInstallStateRow);
    const pendingGovernanceEvents = listPendingGovernanceStatement.all(pendingLimit).map(mapGovernanceEventRow);

    return {
      generatedAt: new Date().toISOString(),
      activeSessions: {
        activeCount: countActiveSessionsStatement.get().total_count,
        sessions: activeSessions,
      },
      skillRuns: {
        windowSize: recentSkillRunLimit,
        summary: summarizeSkillRuns(recentSkillRuns),
        recent: recentSkillRuns,
      },
      installHealth: summarizeInstallHealth(installations),
      governance: {
        pendingCount: countPendingGovernanceStatement.get().total_count,
        events: pendingGovernanceEvents,
      },
    };
  }

  return {
    getSessionById,
    getSessionDetail,
    getStatus,
    insertDecision(decision) {
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
    },
    insertGovernanceEvent(governanceEvent) {
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
    },
    insertSkillRun(skillRun) {
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
    },
    listRecentSessions,
    upsertInstallState(installState) {
      const normalized = normalizeInstallStateInput(installState);
      assertValidEntity('installState', normalized);
      upsertInstallStateStatement.run({
        target_id: normalized.targetId,
        target_root: normalized.targetRoot,
        profile: normalized.profile,
        modules: stringifyJson(normalized.modules, 'installState.modules'),
        operations: stringifyJson(normalized.operations, 'installState.operations'),
        installed_at: normalized.installedAt,
        source_version: normalized.sourceVersion,
      });
      return normalized;
    },
    upsertSession(session) {
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
    },
    upsertSkillVersion(skillVersion) {
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
    },
    upsertInstinct(instinct) {
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
    },
    listInstincts(options = {}) {
      const projectId = options.projectId;
      if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
        throw new Error('listInstincts requires a non-empty projectId');
      }
      const limit = normalizeLimit(options.limit, 20);
      return {
        totalCount: countInstinctsStatement.get(projectId).total_count,
        instincts: listInstinctsStatement.all(projectId, limit).map(mapInstinctRow),
      };
    },
    insertRuntimeEvent(event) {
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
    },
    listRecentEvents(options = {}) {
      const limit = normalizeLimit(options.limit, 50);
      if (options.sessionId) {
        return listEventsBySessionStatement.all(options.sessionId, limit).map(mapRuntimeEventRow);
      }
      if (options.eventType) {
        return listEventsByTypeStatement.all(options.eventType, limit).map(mapRuntimeEventRow);
      }
      return listRecentEventsStatement.all(limit).map(mapRuntimeEventRow);
    },
    upsertLesson(lesson) {
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
    },
    getLessonById(id) {
      const row = getLessonStatement.get(id);
      return row ? mapLessonRow(row) : null;
    },
    listLessons(options = {}) {
      const minConfidence = typeof options.minConfidence === 'number' ? options.minConfidence : 0.2;
      const limit = normalizeLimit(options.limit, 20);
      return listActiveLessonsStatement.all(minConfidence, limit).map(mapLessonRow);
    },
    reinforceLesson(id, nowIso) {
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
    },
    applyDecaySweep(nowIso) {
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
    },
    listEventsInWindow(cutoffTimestamp) {
      return listEventsInWindowStatement.all(cutoffTimestamp).map(mapRuntimeEventRow);
    },
    upsertPattern(pattern) {
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
    },
    listPatterns(options = {}) {
      const limit = normalizeLimit(options.limit, 100);
      return listPatternsStatement.all(limit).map(mapPatternRow);
    },
  };
}

module.exports = {
  ACTIVE_SESSION_STATES,
  FAILURE_OUTCOMES,
  SUCCESS_OUTCOMES,
  REINFORCE_DELTA,
  DECAY_DELTA_PER_WEEK,
  DECAY_GRACE_DAYS,
  ARCHIVE_THRESHOLD,
  createQueryApi,
};
