#!/usr/bin/env node
/**
 * PreCompact Hook - Save state before context compaction
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Runs before Gemini compacts context, giving you a chance to
 * preserve important state that might get lost in summarization.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  getSessionsDir,
  getDateTimeString,
  getTimeString,
  findFiles,
  ensureDir,
  appendFile,
  log
} = require('../lib/utils');

const SESSION_SIZE_CAP = 100 * 1024;
const MARKER_KEEP = 10;
const COMPACTION_RE = /\n?---\n\*\*\[Compaction occurred at [^\]]+\]\*\* - Context was summarized\n/g;

function rotateCompactionMarkers(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (_err) { // NOSONAR: unreadable session file is skipped
    return;
  }

  const markers = content.match(COMPACTION_RE) || [];
  if (markers.length <= MARKER_KEEP) return;

  const stripped = content.replace(COMPACTION_RE, '');
  const trailing = markers.slice(-MARKER_KEEP).join('');
  try {
    fs.writeFileSync(filePath, `${stripped.trimEnd()}\n${trailing}`);
    log(`[PreCompact] Rotated compaction markers: kept last ${MARKER_KEEP} of ${markers.length}`);
  } catch (err) {
    log(`[PreCompact] Warning: failed to rotate markers in ${filePath}: ${err.message}`);
  }
}

function shouldSkipDuplicate(filePath, newMarkerLine) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (_err) { // NOSONAR: unreadable file cannot already contain the marker
    return false;
  }
  return content.trimEnd().endsWith(newMarkerLine.trimEnd());
}

async function main() {
  const sessionsDir = getSessionsDir();
  const compactionLog = path.join(sessionsDir, 'compaction-log.txt');

  ensureDir(sessionsDir);

  const timestamp = getDateTimeString();
  appendFile(compactionLog, `[${timestamp}] Context compaction triggered\n`);

  const sessions = findFiles(sessionsDir, '*-session.tmp');

  if (sessions.length > 0) {
    const activeSession = sessions[0].path;
    const timeStr = getTimeString();
    const markerLine = `\n---\n**[Compaction occurred at ${timeStr}]** - Context was summarized\n`;

    if (!shouldSkipDuplicate(activeSession, markerLine)) {
      appendFile(activeSession, markerLine);
    } else {
      log('[PreCompact] Duplicate compaction marker: skipped');
    }

    let stats;
    try {
      stats = fs.statSync(activeSession);
    } catch (_err) { // NOSONAR: missing session file stats disable the size cap check
      stats = null;
    }
    if (stats && stats.size > SESSION_SIZE_CAP) {
      rotateCompactionMarkers(activeSession);
    }
  }

  log('[PreCompact] State saved before compaction');
  process.exit(0);
}

main().catch(err => {
  console.error('[PreCompact] Error:', err.message);
  process.exit(1);
});
