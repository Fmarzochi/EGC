'use strict';

/**
 * Transcript discovery and JSONL reading for scripts/loop-status.js.
 */

const fs = require('node:fs');
const path = require('node:path');

const { getHomeDir, normalizeOptions } = require('./options');

function createWalkResult() {
  return { errors: [], files: [] };
}

function walkJsonlFiles(dir, result = createWalkResult()) {
  if (!fs.existsSync(dir)) {
    return result;
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    result.errors.push({
      code: error.code || null,
      message: error.message,
      transcriptPath: dir,
    });
    return result;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(fullPath, result);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      result.files.push(fullPath);
    }
  }
  return result;
}

function findTranscriptPaths(options = {}) {
  const normalizedOptions = normalizeOptions(options);

  if (options.transcriptPaths && options.transcriptPaths.length > 0) {
    return {
      errors: [],
      transcriptPaths: normalizedOptions.transcriptPaths.map(transcriptPath => path.resolve(transcriptPath)),
    };
  }

  const homeDir = getHomeDir(normalizedOptions);
  const transcriptRoot = path.join(homeDir, '.gemini', 'projects');
  const walkResult = walkJsonlFiles(transcriptRoot);
  const errors = [...walkResult.errors];
  const transcriptEntries = [];

  for (const transcriptPath of walkResult.files) {
    try {
      transcriptEntries.push({
        transcriptPath,
        mtimeMs: fs.statSync(transcriptPath).mtimeMs,
      });
    } catch (error) {
      errors.push({
        code: error.code || null,
        message: error.message,
        transcriptPath,
      });
    }
  }

  return {
    errors,
    transcriptPaths: transcriptEntries
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, normalizedOptions.limit)
    .map(entry => entry.transcriptPath),
  };
}

function parseTimestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function getEntryTimestamp(entry) {
  return parseTimestamp(entry.timestamp)
    || parseTimestamp(entry.createdAt)
    || parseTimestamp(entry.created_at)
    || parseTimestamp(entry.message?.timestamp);
}

function getSessionId(entry, transcriptPath) {
  return entry.sessionId
    || entry.session_id
    || entry.session?.id
    || entry.message?.sessionId
    || path.basename(transcriptPath, '.jsonl');
}

function getContentBlocks(entry) {
  const blocks = [];
  if (entry.message && Array.isArray(entry.message.content)) {
    blocks.push(...entry.message.content);
  }
  if (Array.isArray(entry.content)) {
    blocks.push(...entry.content);
  }
  return blocks;
}

function extractToolUses(entry) {
  const uses = [];

  for (const block of getContentBlocks(entry)) {
    if (block?.type === 'tool_use' && block.id) {
      uses.push({
        id: block.id,
        input: block.input || {},
        name: block.name || 'unknown',
      });
    }
  }

  const topLevelUse = entry.tool_use || entry.toolUse;
  if (topLevelUse?.id) {
    uses.push({
      id: topLevelUse.id,
      input: topLevelUse.input || {},
      name: topLevelUse.name || 'unknown',
    });
  }

  if (entry.type === 'tool_use' && entry.id) {
    uses.push({
      id: entry.id,
      input: entry.input || {},
      name: entry.name || 'unknown',
    });
  }

  return uses;
}

function extractToolResultIds(entry) {
  const resultIds = [];

  for (const block of getContentBlocks(entry)) {
    if (block?.type === 'tool_result') {
      const toolUseId = block.tool_use_id || block.toolUseId || block.id;
      if (toolUseId) {
        resultIds.push(toolUseId);
      }
    }
  }

  const topLevelResult = entry.tool_result || entry.toolResult || entry.toolUseResult;
  if (topLevelResult) {
    const toolUseId = topLevelResult.tool_use_id || topLevelResult.toolUseId || topLevelResult.id;
    if (toolUseId) {
      resultIds.push(toolUseId);
    }
  }

  if (entry.type === 'tool_result') {
    const toolUseId = entry.tool_use_id || entry.toolUseId || entry.id;
    if (toolUseId) {
      resultIds.push(toolUseId);
    }
  }

  return resultIds;
}

function isAssistantProgressEntry(entry) {
  return entry.type === 'assistant'
    || (entry.message?.role === 'assistant')
    || extractToolUses(entry).length > 0;
}

function readJsonlEntries(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const entries = [];
  let parseErrors = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      entries.push(JSON.parse(line));
    } catch (_error) { // NOSONAR: invalid line is counted in parseErrors, not silently dropped
      parseErrors += 1;
    }
  }

  return { entries, parseErrors };
}

function readDelaySeconds(input) {
  const delay = input && (
    input.delaySeconds
    || input.delay_seconds
    || input.seconds
    || input.delay
  );
  const number = Number(delay);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  return number;
}

function toIso(date) {
  return date ? date.toISOString() : null;
}

module.exports = {
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
};
