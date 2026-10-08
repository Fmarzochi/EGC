'use strict';

/**
 * Per-transcript analysis and the status payload for scripts/loop-status.js.
 */

const path = require('node:path');

const { getHomeDir, getNow, normalizeOptions } = require('./options');
const {
  extractToolResultIds,
  extractToolUses,
  findTranscriptPaths,
  getEntryTimestamp,
  getSessionId,
  isAssistantProgressEntry,
  parseTimestamp,
  readDelaySeconds,
  readJsonlEntries,
  toIso,
} = require('./transcript');

function buildSignals(latestWake, latestAssistantProgressAt, pendingToolList, parseErrors, nowMs, normalizedOptions) {
  const signals = [];
  if (latestWake) {
    const scheduledAt = parseTimestamp(latestWake.scheduledAt);
    const dueAt = parseTimestamp(latestWake.dueAt);
    const thresholdMs = scheduledAt
      ? scheduledAt.getTime() + latestWake.delaySeconds * normalizedOptions.wakeGraceMultiplier * 1000
      : null;
    const hasAssistantProgressAfterDue = Boolean(
      dueAt
      && latestAssistantProgressAt
      && latestAssistantProgressAt.getTime() >= dueAt.getTime()
    );

    if (thresholdMs && nowMs >= thresholdMs && !hasAssistantProgressAfterDue) {
      signals.push({
        delaySeconds: latestWake.delaySeconds,
        dueAt: latestWake.dueAt,
        overdueSeconds: dueAt ? Math.max(0, Math.floor((nowMs - dueAt.getTime()) / 1000)) : null,
        scheduledAt: latestWake.scheduledAt,
        toolUseId: latestWake.toolUseId,
        type: 'schedule_wakeup_overdue',
      });
    }
  }

  for (const tool of pendingToolList) {
    if (
      tool.name === 'Bash'
      && tool.ageSeconds !== null
      && tool.ageSeconds >= normalizedOptions.bashTimeoutSeconds
    ) {
      signals.push({
        ageSeconds: tool.ageSeconds,
        command: tool.command,
        startedAt: tool.startedAt,
        thresholdSeconds: normalizedOptions.bashTimeoutSeconds,
        toolUseId: tool.toolUseId,
        type: 'pending_bash_tool_result',
      });
    }
  }

  if (parseErrors > 0) {
    signals.push({
      count: parseErrors,
      type: 'transcript_parse_errors',
    });
  }

  return signals;
}

function buildRecommendation(signals) {
  if (signals.some(signal => signal.type === 'pending_bash_tool_result')) {
    return 'Open the transcript or interrupt the parked session; the Bash result appears stale.';
  }

  if (signals.some(signal => signal.type === 'schedule_wakeup_overdue')) {
    return 'Open the transcript or interrupt the parked session; the scheduled wake is overdue.';
  }

  if (signals.some(signal => signal.type === 'transcript_parse_errors')) {
    return 'Inspect the transcript; some JSONL lines could not be parsed.';
  }

  return 'No stale ScheduleWakeup or Bash waits detected.';
}

function updateTimestamps(entry, state) {
  const timestamp = getEntryTimestamp(entry);
  if (!timestamp) return null;

  if (!state.lastEventAt || timestamp.getTime() > state.lastEventAt.getTime()) {
    state.lastEventAt = timestamp;
  }
  if (
    isAssistantProgressEntry(entry)
    && (!state.latestAssistantProgressAt || timestamp.getTime() > state.latestAssistantProgressAt.getTime())
  ) {
    state.latestAssistantProgressAt = timestamp;
  }
  return timestamp;
}

function processToolUses(entry, timestamp, lastEventAt, pendingTools, state) {
  for (const toolUse of extractToolUses(entry)) {
    const startedAt = timestamp || lastEventAt;
    pendingTools.set(toolUse.id, {
      command: toolUse.input?.command ? String(toolUse.input.command) : null,
      input: toolUse.input || {},
      name: toolUse.name,
      startedAt: toIso(startedAt),
      toolUseId: toolUse.id,
    });

    if (toolUse.name === 'ScheduleWakeup') {
      const delaySeconds = readDelaySeconds(toolUse.input);
      if (delaySeconds && startedAt) {
        const dueAt = new Date(startedAt.getTime() + delaySeconds * 1000);
        state.latestWake = {
          delaySeconds,
          dueAt: dueAt.toISOString(),
          reason: toolUse.input?.reason ? String(toolUse.input.reason) : null,
          scheduledAt: startedAt.toISOString(),
          toolUseId: toolUse.id,
        };
      }
    }
  }
}

function processTranscriptEntries(entries, absoluteTranscriptPath) {
  const pendingTools = new Map();
  const state = {
    lastEventAt: null,
    latestAssistantProgressAt: null,
    latestWake: null,
    sessionId: path.basename(absoluteTranscriptPath, '.jsonl')
  };

  for (const entry of entries) {
    state.sessionId = getSessionId(entry, absoluteTranscriptPath) || state.sessionId;
    const timestamp = updateTimestamps(entry, state);
    processToolUses(entry, timestamp, state.lastEventAt, pendingTools, state);

    for (const toolUseId of extractToolResultIds(entry)) {
      pendingTools.delete(toolUseId);
    }
  }

  return {
    sessionId: state.sessionId,
    lastEventAt: state.lastEventAt,
    latestAssistantProgressAt: state.latestAssistantProgressAt,
    pendingTools,
    latestWake: state.latestWake
  };
}

function analyzeTranscript(transcriptPath, options = {}) {
  const normalizedOptions = normalizeOptions(options);
  const absoluteTranscriptPath = path.resolve(transcriptPath);
  const now = normalizedOptions.nowDate || getNow(normalizedOptions);
  const nowMs = now.getTime();
  const { entries, parseErrors } = readJsonlEntries(absoluteTranscriptPath);

  const {
    sessionId,
    lastEventAt,
    latestAssistantProgressAt,
    pendingTools,
    latestWake
  } = processTranscriptEntries(entries, absoluteTranscriptPath);

  const pendingToolList = Array.from(pendingTools.values()).map(tool => {
    const startedAt = parseTimestamp(tool.startedAt);
    return {
      ...tool,
      ageSeconds: startedAt ? Math.max(0, Math.floor((nowMs - startedAt.getTime()) / 1000)) : null,
    };
  });

  const signals = buildSignals(latestWake, latestAssistantProgressAt, pendingToolList, parseErrors, nowMs, normalizedOptions);

  return {
    eventCount: entries.length,
    lastEventAt: toIso(lastEventAt),
    latestWake,
    parseErrors,
    pendingTools: pendingToolList,
    projectSlug: path.basename(path.dirname(absoluteTranscriptPath)),
    recommendedAction: buildRecommendation(signals),
    sessionId,
    signals,
    state: signals.length > 0 ? 'attention' : 'ok',
    transcriptPath: absoluteTranscriptPath,
  };
}

function buildStatus(options = {}) {
  const normalizedOptions = normalizeOptions(options);
  const nowDate = getNow(normalizedOptions);
  const mergedOptions = {
    ...normalizedOptions,
    nowDate,
  };
  const homeDir = getHomeDir(normalizedOptions);
  const { errors, transcriptPaths } = findTranscriptPaths(normalizedOptions);
  const sessions = [];

  for (const transcriptPath of transcriptPaths) {
    try {
      sessions.push(analyzeTranscript(transcriptPath, mergedOptions));
    } catch (error) {
      errors.push({
        code: error.code || null,
        message: error.message,
        transcriptPath,
      });
    }
  }

  sessions.sort((left, right) => {
    if (left.state !== right.state) {
      return left.state === 'attention' ? -1 : 1;
    }
    return String(right.lastEventAt || '').localeCompare(String(left.lastEventAt || ''));
  });

  return {
    generatedAt: nowDate.toISOString(),
    errors,
    schemaVersion: 'egc.loop-status.v1',
    sessions,
    source: {
      bashTimeoutSeconds: normalizedOptions.bashTimeoutSeconds,
      homeDir,
      limit: normalizedOptions.limit,
      transcriptCount: transcriptPaths.length,
      transcriptRoot: path.join(homeDir, '.gemini', 'projects'),
      wakeGraceMultiplier: normalizedOptions.wakeGraceMultiplier,
    },
  };
}

module.exports = {
  analyzeTranscript,
  buildStatus,
};
