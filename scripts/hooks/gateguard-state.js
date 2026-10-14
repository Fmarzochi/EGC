'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Session state: scoped per session to avoid cross-session races.
const STATE_DIR = process.env.GATEGUARD_STATE_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.gateguard');
let activeStateFile = null;

// State expires after 30 minutes of inactivity
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const READ_HEARTBEAT_MS = 60 * 1000;

// Maximum checked entries to prevent unbounded growth
const MAX_CHECKED_ENTRIES = 500;
const MAX_SESSION_KEYS = 50;
const ROUTINE_BASH_SESSION_KEY = '__bash_session__';
const EGC_DISABLE_VALUES = new Set(['0', 'false', 'off', 'disabled', 'disable']);

function pendingKey(key) {
  return `pending:${key}`;
}

function presentedKey(key) {
  return `presented:${key}`;
}

function normalizeEnvValue(value) {
  return String(value || '').trim().toLowerCase();
}

function isGateGuardDisabled() {
  if (normalizeEnvValue(process.env.GATEGUARD_DISABLED) === '1') {
    return true;
  }

  return EGC_DISABLE_VALUES.has(normalizeEnvValue(process.env.EGC_GATEGUARD || process.env.ECC_GATEGUARD));
}

function sanitizeSessionKey(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (sanitized && sanitized.length <= 64) {
    return sanitized;
  }

  return hashSessionKey('sid', raw);
}

function hashSessionKey(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;
}

function resolveSessionKey(data) {
  const directCandidates = [data?.session_id, data?.sessionId, data?.session?.id, process.env.EGC_SESSION_ID, process.env.ECC_SESSION_ID];

  for (const candidate of directCandidates) {
    const sanitized = sanitizeSessionKey(candidate);
    if (sanitized) {
      return sanitized;
    }
  }

  const transcriptPath = (data && (data.transcript_path || data.transcriptPath)) || process.env.GEMINI_TRANSCRIPT_PATH;
  if (transcriptPath && String(transcriptPath).trim()) {
    return hashSessionKey('tx', path.resolve(String(transcriptPath).trim()));
  }

  const projectFingerprint = process.env.GEMINI_PROJECT_DIR || process.cwd();
  return hashSessionKey('proj', path.resolve(projectFingerprint));
}

function resetActiveStateFile() {
  activeStateFile = null;
}

function getStateFile(data) {
  if (!activeStateFile) {
    const sessionKey = resolveSessionKey(data);
    activeStateFile = path.join(STATE_DIR, `state-${sessionKey}.json`);
  }
  return activeStateFile;
}

function loadState() {
  const stateFile = getStateFile();
  try {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const lastActive = state.last_active || 0;
      if (Date.now() - lastActive > SESSION_TIMEOUT_MS) {
        try {
          fs.unlinkSync(stateFile);
        } catch (_) { // NOSONAR
          /* ignore */
        }
        return { checked: [], last_active: Date.now() };
      }
      return state;
    }
  } catch (_) { // NOSONAR
    /* ignore */
  }
  return { checked: [], last_active: Date.now() };
}

function pruneCheckedEntries(checked) {
  if (checked.length <= MAX_CHECKED_ENTRIES) {
    return checked;
  }

  const preserved = checked.includes(ROUTINE_BASH_SESSION_KEY) ? [ROUTINE_BASH_SESSION_KEY] : [];
  const sessionKeys = checked.filter(k => k.startsWith('__') && k !== ROUTINE_BASH_SESSION_KEY);
  const fileKeys = checked.filter(k => !k.startsWith('__'));
  const remainingSessionSlots = Math.max(MAX_SESSION_KEYS - preserved.length, 0);
  const cappedSession = sessionKeys.slice(-remainingSessionSlots);
  const remainingFileSlots = Math.max(MAX_CHECKED_ENTRIES - preserved.length - cappedSession.length, 0);
  const cappedFiles = fileKeys.slice(-remainingFileSlots);
  return [...preserved, ...cappedSession, ...cappedFiles];
}

function mergeStateWithDisk(stateFile, checked, lastActive) {
  try {
    if (!fs.existsSync(stateFile)) return { checked, lastActive };
    const diskState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return {
      checked: Array.isArray(diskState.checked) ? Array.from(new Set([...diskState.checked, ...checked])) : checked,
      lastActive: typeof diskState.last_active === 'number' ? Math.max(lastActive, diskState.last_active) : lastActive,
    };
  } catch (_) { // NOSONAR: unreadable disk state falls back to the in-memory state
    return { checked, lastActive };
  }
}

function atomicRenameFile(tmpFile, stateFile) {
  try {
    fs.renameSync(tmpFile, stateFile);
  } catch (error) {
    if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
      try { fs.unlinkSync(stateFile); } catch (_) { /* ignore: best-effort unlink before retry, subsequent renameSync will handle failures */ } // NOSONAR
      fs.renameSync(tmpFile, stateFile);
    } else {
      throw error;
    }
  }
}

function saveState(state) {
  const stateFile = getStateFile();
  let tmpFile = null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });

    const rawChecked = Array.isArray(state.checked) ? state.checked : [];
    const rawLastActive = typeof state.last_active === 'number' ? state.last_active : 0;
    const merged = mergeStateWithDisk(stateFile, rawChecked, rawLastActive);

    const finalState = {
      checked: pruneCheckedEntries(merged.checked),
      last_active: Math.max(merged.lastActive, Date.now()),
    };

    // Atomic write: temp file + rename prevents partial reads
    tmpFile = `${stateFile}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmpFile, JSON.stringify(finalState, null, 2), 'utf8');
    atomicRenameFile(tmpFile, stateFile);
    tmpFile = null;
    return true;
  } catch (_) { // NOSONAR: failed save returns false after best-effort tmp cleanup
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_2) { /* ignore: best-effort cleanup of temporary state file during save failure */ } } // NOSONAR
    return false;
  }
}

function markChecked(key) {
  const state = loadState();
  if (!state.checked.includes(key)) {
    state.checked.push(key);
    return saveState(state);
  }
  return true;
}

function isChecked(key) {
  const state = loadState();
  const found = state.checked.includes(key);
  if (found && Date.now() - (state.last_active || 0) > READ_HEARTBEAT_MS) {
    saveState(state);
  }
  return found;
}

// Prune stale session files older than 1 hour. Every other piece of work in
// this module checks isGateGuardDisabled() first; this module-load-time scan
// used to run unconditionally, so a disabled GateGuard still paid the
// synchronous readdir/stat/unlink cost on every process start (EGC-539 audit).
if (!isGateGuardDisabled()) {
  (function pruneStaleFiles() {
    try {
      const files = fs.readdirSync(STATE_DIR);
      const now = Date.now();
      for (const f of files) {
        const isStateFile = f.startsWith('state-') && (f.endsWith('.json') || f.includes('.json.tmp.'));
        if (!isStateFile) continue;
        const fp = path.join(STATE_DIR, f);
        try {
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > SESSION_TIMEOUT_MS * 2) {
            fs.unlinkSync(fp);
          }
        } catch (_) { // NOSONAR
          // Ignore files that disappear between readdir/stat/unlink.
        }
      }
    } catch (_) { // NOSONAR
      /* ignore */
    }
  })();
}

// This gateguard-state.js module is the session-state slice of the
// gateguard-fact-force.js split (part of #1712): the keys, the disabled
// check and the bounded, atomic, multi-process-safe persistence it already
// had, moved as is.
module.exports = {
  STATE_DIR,
  SESSION_TIMEOUT_MS,
  ROUTINE_BASH_SESSION_KEY,
  pendingKey,
  presentedKey,
  isGateGuardDisabled,
  resetActiveStateFile,
  getStateFile,
  markChecked,
  isChecked,
};
