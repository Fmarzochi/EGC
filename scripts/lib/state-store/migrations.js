'use strict';

const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  state TEXT NOT NULL,
  repo_root TEXT,
  started_at TEXT,
  ended_at TEXT,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot))
);

CREATE INDEX IF NOT EXISTS idx_sessions_state_started_at
  ON sessions (state, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at
  ON sessions (started_at DESC);

CREATE TABLE IF NOT EXISTS skill_runs (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_description TEXT NOT NULL,
  outcome TEXT NOT NULL,
  failure_reason TEXT,
  tokens_used INTEGER,
  duration_ms INTEGER,
  user_feedback TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_skill_runs_session_id_created_at
  ON skill_runs (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_runs_created_at
  ON skill_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_runs_outcome_created_at
  ON skill_runs (outcome, created_at DESC);

CREATE TABLE IF NOT EXISTS skill_versions (
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  amendment_reason TEXT,
  promoted_at TEXT,
  rolled_back_at TEXT,
  PRIMARY KEY (skill_id, version)
);

CREATE INDEX IF NOT EXISTS idx_skill_versions_promoted_at
  ON skill_versions (promoted_at DESC);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  alternatives TEXT NOT NULL CHECK (json_valid(alternatives)),
  supersedes TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
  FOREIGN KEY (supersedes) REFERENCES decisions (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_session_id_created_at
  ON decisions (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_status_created_at
  ON decisions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS install_state (
  target_id TEXT NOT NULL,
  target_root TEXT NOT NULL,
  profile TEXT,
  modules TEXT NOT NULL CHECK (json_valid(modules)),
  operations TEXT NOT NULL CHECK (json_valid(operations)),
  installed_at TEXT NOT NULL,
  source_version TEXT,
  PRIMARY KEY (target_id, target_root)
);

CREATE INDEX IF NOT EXISTS idx_install_state_installed_at
  ON install_state (installed_at DESC);

CREATE TABLE IF NOT EXISTS governance_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  resolved_at TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_governance_events_resolved_at_created_at
  ON governance_events (resolved_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_events_session_id_created_at
  ON governance_events (session_id, created_at DESC);
`;

const INSTINCTS_AND_EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS instincts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_instincts_project_id
  ON instincts (project_id);
CREATE INDEX IF NOT EXISTS idx_instincts_confidence_created_at
  ON instincts (confidence DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  timestamp TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session_id_timestamp
  ON events (session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_event_type_timestamp
  ON events (event_type, timestamp DESC);
`;

const LESSONS_SQL = `
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  context TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  last_reinforced TEXT,
  last_recalled TEXT,
  created_at TEXT NOT NULL,
  tags TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lessons_confidence_created_at
  ON lessons (confidence DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lessons_archived_confidence
  ON lessons (archived, confidence DESC);
`;

const PATTERNS_SQL = `
CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,
  pattern_type TEXT NOT NULL,
  key TEXT NOT NULL,
  description TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  frequency REAL NOT NULL DEFAULT 0,
  last_seen TEXT NOT NULL,
  suggested_automation TEXT,
  first_seen TEXT NOT NULL,
  window_days INTEGER NOT NULL DEFAULT 7
);

CREATE INDEX IF NOT EXISTS idx_patterns_type_key
  ON patterns (pattern_type, key);
CREATE INDEX IF NOT EXISTS idx_patterns_last_seen
  ON patterns (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_occurrences
  ON patterns (occurrences DESC);
`;

const MIGRATIONS = [
  {
    version: 1,
    name: '001_initial_state_store',
    sql: INITIAL_SCHEMA_SQL,
  },
  {
    version: 2,
    name: '002_instincts_and_events',
    sql: INSTINCTS_AND_EVENTS_SQL,
  },
  {
    version: 3,
    name: '003_lessons_confidence_decay',
    sql: LESSONS_SQL,
  },
  {
    version: 4,
    name: '004_patterns',
    sql: PATTERNS_SQL,
  },
];

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function getAppliedMigrations(db) {
  ensureMigrationTable(db);
  return db
    .prepare(`
      SELECT version, name, applied_at
      FROM schema_migrations
      ORDER BY version ASC
    `)
    .all()
    .map(row => ({
      version: row.version,
      name: row.name,
      appliedAt: row.applied_at,
    }));
}

function applyMigrations(db) {
  ensureMigrationTable(db);

  const appliedVersions = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version)
  );
  const insertMigration = db.prepare(`
    INSERT INTO schema_migrations (version, name, applied_at)
    VALUES (@version, @name, @applied_at)
  `);

  const applyPending = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      db.exec(migration.sql);
      insertMigration.run({
        version: migration.version,
        name: migration.name,
        applied_at: new Date().toISOString(),
      });
    }
  });

  applyPending();
  return getAppliedMigrations(db);
}

module.exports = {
  MIGRATIONS,
  applyMigrations,
  getAppliedMigrations,
};
