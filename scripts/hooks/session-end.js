#!/usr/bin/env node
/**
 * Stop Hook (Session End) - Persist learnings during active sessions
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Runs on Stop events (after each response). Extracts a meaningful summary
 * from the session transcript (via stdin JSON transcript_path) and updates a
 * session file for cross-session continuity.
 */

const path = require('node:path');
const fs = require('node:fs');
const {
  getSessionsDir,
  getDateString,
  getTimeString,
  getSessionIdShort,
  sanitizeSessionId,
  getProjectName,
  ensureDir,
  readFile,
  writeFile,
  runCommand,
  stripAnsi,
  log
} = require('../lib/utils');

const SUMMARY_START_MARKER = '<!-- EGC:SUMMARY:START -->';
const SUMMARY_END_MARKER = '<!-- EGC:SUMMARY:END -->';
const SESSION_SEPARATOR = '\n---\n';

function extractUserMessage(entry) {
  if (entry.type !== 'user' && entry.role !== 'user' && entry.message?.role !== 'user') {
    return '';
  }
  const rawContent = entry.message?.content ?? entry.content;
  const text = typeof rawContent === 'string'
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map(c => (c && c.text) || '').join(' ')
      : '';
  return stripAnsi(text).trim();
}

function extractDirectToolUse(entry, toolsUsed, filesModified) {
  if (entry.type !== 'tool_use' && !entry.tool_name) return;
  const toolName = entry.tool_name || entry.name || '';
  if (toolName) toolsUsed.add(toolName);
  const filePath = entry.tool_input?.file_path || entry.input?.file_path || '';
  if (filePath && (toolName === 'Edit' || toolName === 'Write')) {
    filesModified.add(filePath);
  }
}

function extractAssistantBlockToolUse(entry, toolsUsed, filesModified) {
  if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return;
  for (const block of entry.message.content) {
    if (block.type !== 'tool_use') continue;
    const toolName = block.name || '';
    if (toolName) toolsUsed.add(toolName);
    const filePath = block.input?.file_path || '';
    if (filePath && (toolName === 'Edit' || toolName === 'Write')) {
      filesModified.add(filePath);
    }
  }
}

/**
 * Extract a meaningful summary from the session transcript.
 * Reads the JSONL transcript and pulls out key information:
 * - User messages (tasks requested)
 * - Tools used
 * - Files modified
 */
function extractSessionSummary(transcriptPath) {
  const content = readFile(transcriptPath);
  if (!content) return null;

  const lines = content.split('\n').filter(Boolean);
  const userMessages = [];
  const toolsUsed = new Set();
  const filesModified = new Set();
  let parseErrors = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      const userText = extractUserMessage(entry);
      if (userText) {
        userMessages.push(userText.slice(0, 200));
      }

      extractDirectToolUse(entry, toolsUsed, filesModified);
      extractAssistantBlockToolUse(entry, toolsUsed, filesModified);
    } catch {
      parseErrors++;
    }
  }

  if (parseErrors > 0) {
    log(`[SessionEnd] Skipped ${parseErrors}/${lines.length} unparseable transcript lines`);
  }

  if (userMessages.length === 0) return null;

  return {
    userMessages: userMessages.slice(-10),
    toolsUsed: Array.from(toolsUsed).slice(0, 20),
    filesModified: Array.from(filesModified).slice(0, 30),
    totalMessages: userMessages.length
  };
}

const MAX_STDIN = 1024 * 1024;
let stdinData = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', chunk => {
  if (stdinData.length < MAX_STDIN) {
    const remaining = MAX_STDIN - stdinData.length;
    stdinData += chunk.substring(0, remaining);
  }
});

process.stdin.on('end', () => {
  runMain();
});

function runMain() {
  main().catch(() => {
    console.error('[SessionEnd] Unexpected error');
    process.exit(1);
  });
}

function getSessionMetadata() {
  const branchResult = runCommand('git rev-parse --abbrev-ref HEAD');

  return {
    project: getProjectName() || 'unknown',
    branch: branchResult.success ? branchResult.output : 'unknown',
    worktree: process.cwd()
  };
}

function extractHeaderField(header, label) {
  const match = header.match(new RegExp(`\\*\\*${escapeRegExp(label)}:\\*\\*\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

function buildSessionHeader(today, currentTime, metadata, existingContent = '') {
  const headingMatch = existingContent.match(/^#\s+.+$/m);
  const heading = headingMatch ? headingMatch[0] : `# Session: ${today}`;
  const date = extractHeaderField(existingContent, 'Date') || today;
  const started = extractHeaderField(existingContent, 'Started') || currentTime;

  return [
    heading,
    `**Date:** ${date}`,
    `**Started:** ${started}`,
    `**Last Updated:** ${currentTime}`,
    `**Project:** ${metadata.project}`,
    `**Branch:** ${metadata.branch}`,
    `**Worktree:** ${metadata.worktree}`,
    ''
  ].join('\n');
}

function mergeSessionHeader(content, today, currentTime, metadata) {
  const separatorIndex = content.indexOf(SESSION_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }

  const existingHeader = content.slice(0, separatorIndex);
  const body = content.slice(separatorIndex + SESSION_SEPARATOR.length);
  const nextHeader = buildSessionHeader(today, currentTime, metadata, existingHeader);
  return `${nextHeader}${SESSION_SEPARATOR}${body}`;
}

function resolveTranscriptPath(stdin) {
  // Parse stdin JSON to get transcript_path; fall back to env var on missing,
  // empty, or non-string values as well as on malformed JSON.
  try {
    const input = JSON.parse(stdin);
    if (input && typeof input.transcript_path === 'string' && input.transcript_path.length > 0) {
      return input.transcript_path;
    }
  } catch {
    // Malformed stdin: fall through to the env-var fallback below.
  }
  const envPath = process.env.GEMINI_TRANSCRIPT_PATH;
  return typeof envPath === 'string' && envPath.length > 0 ? envPath : null;
}

function resolveShortId(transcriptPath) {
  // Derive shortId from transcript_path UUID when available, using the SAME
  // last-8-chars convention as getSessionIdShort(sessionId.slice(-8)). This keeps
  // backward compatibility for normal sessions (the derived shortId matches what
  // getSessionIdShort() would have produced from the same UUID), while making
  // every session map to a unique filename based on its own transcript UUID.
  //
  // Without this, a parent session and any `egc -p ...` subprocess spawned by
  // another Stop hook share the project-name fallback filename, and the subprocess
  // overwrites the parent's summary. See issue #1494 for full repro details.
  if (transcriptPath) {
    const m = path.basename(transcriptPath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (m) {
      return sanitizeSessionId(m[1].slice(-8).toLowerCase());
    }
  }
  return getSessionIdShort();
}

function injectSummaryIntoContent(updatedContent, summary) {
  const summaryBlock = buildSummaryBlock(summary);
  if (updatedContent.includes(SUMMARY_START_MARKER) && updatedContent.includes(SUMMARY_END_MARKER)) {
    return updatedContent.replace(
      new RegExp(`${escapeRegExp(SUMMARY_START_MARKER)}[\\s\\S]*?${escapeRegExp(SUMMARY_END_MARKER)}`),
      summaryBlock
    );
  }
  // Migration path for files created before summary markers existed.
  return updatedContent.replace(
    /## (?:Session Summary|Current State)[\s\S]*?$/,
    `${summaryBlock}\n\n### Notes for Next Session\n-\n\n### Context to Load\n\`\`\`\n[relevant files]\n\`\`\`\n`
  );
}

function updateExistingSession(sessionFile, today, currentTime, sessionMetadata, summary) {
  const existing = readFile(sessionFile);
  let updatedContent = existing;

  if (existing) {
    const merged = mergeSessionHeader(existing, today, currentTime, sessionMetadata);
    if (merged) {
      updatedContent = merged;
    } else {
      log('[SessionEnd] Failed to normalize session file header');
    }
  }

  if (summary && updatedContent) {
    updatedContent = injectSummaryIntoContent(updatedContent, summary);
  }

  if (updatedContent) writeFile(sessionFile, updatedContent);
  log('[SessionEnd] Updated session file');
}

function createNewSession(sessionFile, today, currentTime, sessionMetadata, summary) {
  const summarySection = summary
    ? `${buildSummaryBlock(summary)}\n\n### Notes for Next Session\n-\n\n### Context to Load\n\`\`\`\n[relevant files]\n\`\`\``
    : `## Current State\n\n[Session context goes here]\n\n### Completed\n- [ ]\n\n### In Progress\n- [ ]\n\n### Notes for Next Session\n-\n\n### Context to Load\n\`\`\`\n[relevant files]\n\`\`\``;

  const template = `${buildSessionHeader(today, currentTime, sessionMetadata)}${SESSION_SEPARATOR}${summarySection}\n`;
  writeFile(sessionFile, template);
  log('[SessionEnd] Created session file');
}

async function main() {
  const transcriptPath = resolveTranscriptPath(stdinData);
  const sessionsDir = getSessionsDir();
  const today = getDateString();
  const shortId = resolveShortId(transcriptPath);
  const sessionFile = path.join(sessionsDir, `${today}-${shortId}-session.tmp`);
  const sessionMetadata = getSessionMetadata();

  ensureDir(sessionsDir);

  const currentTime = getTimeString();

  let summary = null;
  if (transcriptPath) {
    if (fs.existsSync(transcriptPath)) {
      summary = extractSessionSummary(transcriptPath);
    } else {
      log('[SessionEnd] Transcript not found');
    }
  }

  if (fs.existsSync(sessionFile)) {
    updateExistingSession(sessionFile, today, currentTime, sessionMetadata, summary);
  } else {
    createNewSession(sessionFile, today, currentTime, sessionMetadata, summary);
  }

  process.exit(0);
}

function buildSummarySection(summary) {
  let section = '## Session Summary\n\n';

  // Tasks (from user messages: collapse newlines and escape backticks to prevent markdown breaks)
  section += '### Tasks\n';
  for (const msg of summary.userMessages) {
    section += `- ${msg.replace(/\\/g, '\\\\').replace(/\n/g, ' ').replaceAll('`', '\\`')}\n`;
  }
  section += '\n';

  // Files modified
  if (summary.filesModified.length > 0) {
    section += '### Files Modified\n';
    for (const f of summary.filesModified) {
      section += `- ${f.replace(/\\/g, '\\\\').replaceAll('`', '\\`')}\n`;
    }
    section += '\n';
  }

  // Tools used
  if (summary.toolsUsed.length > 0) {
    section += `### Tools Used\n${summary.toolsUsed.map(t => t.replace(/\\/g, '\\\\').replaceAll('`', '\\`')).join(', ')}\n\n`;
  }

  section += `### Stats\n- Total user messages: ${summary.totalMessages}\n`;

  return section;
}

function buildSummaryBlock(summary) {
  return `${SUMMARY_START_MARKER}\n${buildSummarySection(summary).trim()}\n${SUMMARY_END_MARKER}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
