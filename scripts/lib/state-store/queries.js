'use strict';

// Composes the per-entity query modules under queries/ into the single API
// object the rest of the state store consumes. Was a single 742-line
// createQueryApi before EGC-539 audit Finding 6; split so each entity's
// prepared statements and methods live next to each other instead of all
// flattened into one closure. getSessionDetail and getStatus are the two
// genuinely cross-entity reads and stay here, composed from the per-entity
// APIs rather than touching any prepared statement directly.

const {
  normalizeLimit,
  summarizeSkillRuns,
  summarizeInstallHealth,
  SUCCESS_OUTCOMES,
  FAILURE_OUTCOMES,
} = require('./queries/shared');
const { createSessionQueries } = require('./queries/sessions');
const { createSkillRunQueries } = require('./queries/skill-runs');
const { createSkillVersionQueries } = require('./queries/skill-versions');
const { createDecisionQueries } = require('./queries/decisions');
const { createInstallStateQueries } = require('./queries/install-state');
const { createGovernanceEventQueries } = require('./queries/governance-events');
const { createInstinctQueries } = require('./queries/instincts');
const { createRuntimeEventQueries } = require('./queries/runtime-events');
const {
  REINFORCE_DELTA,
  DECAY_DELTA_PER_WEEK,
  DECAY_GRACE_DAYS,
  ARCHIVE_THRESHOLD,
  createLessonQueries,
} = require('./queries/lessons');
const { createPatternQueries } = require('./queries/patterns');

// Unused by any query (the sessions table filter is inlined as a SQL
// literal), kept only because it was already part of the public export
// surface -- not touched, per EGC-539 Finding 6 scope.
const ACTIVE_SESSION_STATES = ['active', 'running', 'idle'];

function createQueryApi(db) {
  const sessions = createSessionQueries(db);
  const skillRuns = createSkillRunQueries(db);
  const skillVersions = createSkillVersionQueries(db);
  const decisions = createDecisionQueries(db);
  const installState = createInstallStateQueries(db);
  const governanceEvents = createGovernanceEventQueries(db);
  const instincts = createInstinctQueries(db);
  const runtimeEvents = createRuntimeEventQueries(db);
  const lessons = createLessonQueries(db);
  const patterns = createPatternQueries(db);

  function getSessionDetail(id) {
    const session = sessions.getSessionById(id);
    if (!session) {
      return null;
    }

    const workers = Array.isArray(session.snapshot?.workers)
      ? session.snapshot.workers.map(worker => ({ ...worker }))
      : [];

    return {
      session,
      workers,
      skillRuns: skillRuns.listSkillRunsForSession(id),
      decisions: decisions.listDecisionsForSession(id),
    };
  }

  function getStatus(options = {}) {
    const activeLimit = normalizeLimit(options.activeLimit, 5);
    const recentSkillRunLimit = normalizeLimit(options.recentSkillRunLimit, 20);
    const pendingLimit = normalizeLimit(options.pendingLimit, 5);

    const activeSessions = sessions.listActiveSessions(activeLimit);
    const recentSkillRuns = skillRuns.listRecentSkillRuns(recentSkillRunLimit);
    const installations = installState.listInstallState();
    const pendingGovernanceEvents = governanceEvents.listPendingGovernanceEvents(pendingLimit);

    return {
      generatedAt: new Date().toISOString(),
      activeSessions: {
        activeCount: sessions.countActiveSessions(),
        sessions: activeSessions,
      },
      skillRuns: {
        windowSize: recentSkillRunLimit,
        summary: summarizeSkillRuns(recentSkillRuns),
        recent: recentSkillRuns,
      },
      installHealth: summarizeInstallHealth(installations),
      governance: {
        pendingCount: governanceEvents.countPendingGovernanceEvents(),
        events: pendingGovernanceEvents,
      },
    };
  }

  return {
    getSessionById: sessions.getSessionById,
    getSessionDetail,
    getStatus,
    countDecisions: decisions.countDecisions,
    insertDecision: decisions.insertDecision,
    insertGovernanceEvent: governanceEvents.insertGovernanceEvent,
    insertSkillRun: skillRuns.insertSkillRun,
    listRecentSessions: sessions.listRecentSessions,
    upsertInstallState: installState.upsertInstallState,
    upsertSession: sessions.upsertSession,
    upsertSkillVersion: skillVersions.upsertSkillVersion,
    upsertInstinct: instincts.upsertInstinct,
    listInstincts: instincts.listInstincts,
    insertRuntimeEvent: runtimeEvents.insertRuntimeEvent,
    listRecentEvents: runtimeEvents.listRecentEvents,
    countLessons: lessons.countLessons,
    upsertLesson: lessons.upsertLesson,
    getLessonById: lessons.getLessonById,
    listLessons: lessons.listLessons,
    reinforceLesson: lessons.reinforceLesson,
    applyDecaySweep: lessons.applyDecaySweep,
    listEventsInWindow: runtimeEvents.listEventsInWindow,
    countPatterns: patterns.countPatterns,
    upsertPattern: patterns.upsertPattern,
    listPatterns: patterns.listPatterns,
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
  normalizeLimit,
};
