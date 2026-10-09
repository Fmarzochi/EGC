'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const OBSERVATION_SCHEMA_VERSION = 'egc.skill-observation.v1';

function resolveProjectRoot(options = {}) {
  return path.resolve(options.projectRoot || options.cwd || process.cwd());
}

// The telemetry of a project lives in its .egc folder, the tool-neutral
// home of what EGC writes next to the code.
function getSkillTelemetryRoot(options = {}) {
  return path.join(resolveProjectRoot(options), '.egc', 'skills');
}

function getSkillObservationsPath(options = {}) {
  return path.join(getSkillTelemetryRoot(options), 'observations.jsonl');
}

// Observations recorded before the folder moved out of the fixed .gemini
// are read from there and never written again.
function getLegacySkillObservationsPath(options = {}) {
  return path.join(resolveProjectRoot(options), '.gemini', 'egc', 'skills', 'observations.jsonl');
}

function ensureString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function createObservationId() {
  return `obs-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
}

function createSkillObservation(input) {
  const task = ensureString(input.task, 'task');
  const skillId = ensureString(input.skill?.id, 'skill.id');
  const skillPath = typeof input.skill?.path === 'string' && input.skill.path.trim().length > 0
    ? input.skill.path.trim()
    : null;
  const success = Boolean(input.success);
  const error = input.error === null || input.error === undefined ? null : String(input.error);
  const feedback = input.feedback === null || input.feedback === undefined ? null : String(input.feedback);
  const variant = typeof input.variant === 'string' && input.variant.trim().length > 0
    ? input.variant.trim()
    : 'baseline';

  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    observationId: typeof input.observationId === 'string' && input.observationId.length > 0
      ? input.observationId
      : createObservationId(),
    timestamp: typeof input.timestamp === 'string' && input.timestamp.length > 0
      ? input.timestamp
      : new Date().toISOString(),
    task,
    skill: {
      id: skillId,
      path: skillPath
    },
    outcome: {
      success,
      status: success ? 'success' : 'failure',
      error,
      feedback
    },
    run: {
      variant,
      amendmentId: input.amendmentId || null,
      sessionId: input.sessionId || null,
      source: input.source || 'manual'
    }
  };
}

function appendSkillObservation(observation, options = {}) {
  const outputPath = getSkillObservationsPath(options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.appendFileSync(outputPath, `${JSON.stringify(observation)}${os.EOL}`, 'utf8');
  return outputPath;
}

function readObservationFile(observationPath) {
  let content;
  try {
    content = fs.readFileSync(observationPath, 'utf8');
  } catch {
    // A missing, unreadable or stale file means no observations, not a crash.
    return [];
  }

  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(record => record?.schemaVersion === OBSERVATION_SCHEMA_VERSION);
}

// A record copied from the old file into the new one counts once; the first
// occurrence (the older file) wins.
function dedupeObservations(records) {
  const seen = new Set();
  return records.filter(record => {
    const key = typeof record.observationId === 'string' ? record.observationId : null;
    if (key === null) {
      return true;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function readSkillObservations(options = {}) {
  if (options.observationsPath) {
    return readObservationFile(path.resolve(options.observationsPath));
  }

  return dedupeObservations([
    ...readObservationFile(getLegacySkillObservationsPath(options)),
    ...readObservationFile(getSkillObservationsPath(options))
  ]);
}

module.exports = {
  OBSERVATION_SCHEMA_VERSION,
  appendSkillObservation,
  createSkillObservation,
  getSkillObservationsPath,
  getSkillTelemetryRoot,
  readSkillObservations,
  resolveProjectRoot
};
