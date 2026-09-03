'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getStateDir, detectBranch, resolveStateRead, resolveStateWrite } = require('./branch-state');
const { isEncryptedBuffer, decryptStateBuffer, encryptStateBuffer } = require('./state-crypto');
const { loadOrCreateIntegrityKey, writeHmac } = require('./state-integrity');

// Cross-process lock, same file-name convention as withStateMergeLock() in
// mcp/servers/egc-memory/src/index.ts, so this hook's direct write and the
// MCP server's own update_state can never race on the same state file.
// Removes a lock left behind by a process that no longer exists. Returns true
// when the stale lock was cleared, false when it is held by a live process or
// could not be inspected.
function clearStaleLock(lockFile) {
  try {
    const storedPid = Number(fs.readFileSync(lockFile, 'utf-8').trim());
    if (!Number.isInteger(storedPid)) return false;
    try {
      process.kill(storedPid, 0);
      return false;
    } catch {
      fs.unlinkSync(lockFile);
      return true;
    }
  } catch {
    return false; // lock file unreadable or gone between check and read: retry
  }
}

function sleepSync(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* busy-wait: this hook runs synchronously, no event loop to yield to */ }
}

function acquireLockSync(lockFile, retries = 50) {
  while (retries > 0) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      if (clearStaleLock(lockFile)) continue;
      retries -= 1;
      sleepSync(100);
    }
  }
  return false;
}

function withStateFileLockSync(stateFile, fn) {
  const lockFile = `${stateFile}.merge.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  // Matches withStateMergeLock()'s fail-closed behavior in index.ts: proceeding
  // unlocked here would let a hook's read-modify-write race the MCP server's
  // own update_state on the same file, risking a lost merge or a partially
  // overwritten ciphertext -- exactly what this lock exists to prevent.
  if (!acquireLockSync(lockFile)) {
    throw new Error(`Timeout acquiring state file lock: ${lockFile}`);
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockFile); } catch { /* already cleared */ }
  }
}

const MARKER_RE = /^- \[session-snapshot [^\]]+\]\n?/gm;

const SECTIONS = ['## Context', '## Active Decisions', '## Do Not Repeat', '## Preferences', '## Next Session'];

function updateTimestamp(content, ts) {
  if (/^updated: /m.test(content)) {
    return content.replace(/^updated: .*/m, `updated: ${ts}`);
  }
  return content.replace(/^(project: [^\n]*\n(?:branch: [^\n]*\n)?)/m, `$1updated: ${ts}\n`);
}

function injectSessionMarker(content, ts) {
  const marker = `- [session-snapshot ${ts}]`;
  const withoutStale = content.replace(MARKER_RE, '');
  if (/^## Next Session$/m.test(withoutStale)) {
    return withoutStale.replace(/^(## Next Session\n)/m, `$1${marker}\n`);
  }
  return withoutStale + `\n## Next Session\n${marker}\n`;
}

function buildSkeleton(projectPath, branch, ts) {
  return [
    '# Project State',
    `project: ${projectPath}`,
    ...(branch ? [`branch: ${branch}`] : []),
    `updated: ${ts}`,
    '',
    ...SECTIONS.flatMap(s => [s, '']),
  ].join('\n');
}

// Reads and decrypts if the file is encrypted (the common case: the MCP
// server always encrypts). undecryptable=true means the file exists, is
// marked encrypted, but couldn't be authenticated/decrypted -- callers must
// not treat that as "empty" and overwrite it; skipping the write is the
// only safe response, matching update_state's own "abort to prevent data
// loss" rule for the same failure.
function loadState(projectPath) {
  const branch = detectBranch(projectPath);
  const stateDir = getStateDir(process.env.HOME);
  const resolved = resolveStateRead(stateDir, projectPath, branch);
  const filePath = resolveStateWrite(stateDir, projectPath, branch);
  const ts = new Date().toISOString();

  if (resolved.source === 'none' || !fs.existsSync(resolved.filePath)) {
    return { content: buildSkeleton(projectPath, branch, ts), filePath, ts, undecryptable: false };
  }

  const raw = fs.readFileSync(resolved.filePath);
  if (!isEncryptedBuffer(raw)) {
    return { content: raw.toString('utf-8'), filePath, ts, undecryptable: false };
  }
  const decrypted = decryptStateBuffer(raw);
  if (decrypted === null) {
    return { content: '', filePath, ts, undecryptable: true };
  }
  return { content: decrypted, filePath, ts, undecryptable: false };
}

// Always encrypts (matching writeStateFile() in encryption.ts) and writes
// atomically via temp-file-then-rename so a reader never observes a
// partially-written file.
function saveState(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const encrypted = encryptStateBuffer(content);
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmpPath, encrypted);
    try { fs.chmodSync(tmpPath, 0o600); } catch { /* chmod not supported on Windows */ }
    fs.renameSync(tmpPath, filePath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* already renamed away */ }
  }
  // Same sidecar contract as writeHmac() in index.ts: without this, a hook
  // write here (PreCompact snapshot, mined-memory apply) leaves the old HMAC
  // in place and the next get_state reports a false tamper mismatch.
  writeHmac(filePath, content, loadOrCreateIntegrityKey());
}

function writeSnapshotToDisk(projectPath = process.env.PWD || process.cwd()) {
  const branch = detectBranch(projectPath);
  const stateDir = getStateDir(process.env.HOME);
  const filePath = resolveStateWrite(stateDir, projectPath, branch);
  return withStateFileLockSync(filePath, () => {
    const state = loadState(projectPath);
    if (state.undecryptable) return state.filePath;
    let content = updateTimestamp(state.content, state.ts);
    content = injectSessionMarker(content, state.ts);
    saveState(state.filePath, content);
    return state.filePath;
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function extractSection(content, heading) {
  const re = new RegExp(String.raw`^${escapeRegExp(heading)}\n([\s\S]*?)(?=^## |\Z)`, 'm');
  const match = content.match(re);
  return match ? match[1].trim() : '';
}

function appendToSection(content, heading, lines) {
  const existing = new Set(content.split('\n').map(l => l.trim()));
  const fresh = lines.map(l => l.trim()).filter(l => l && !existing.has(l));
  if (fresh.length === 0) return { content, added: 0 };

  const block = fresh.join('\n') + '\n';
  const escaped = escapeRegExp(heading);
  if (new RegExp(`^${escaped}$`, 'm').test(content)) {
    const updated = content.replace(
      new RegExp(String.raw`^(${escaped}\n)`, 'm'),
      `$1${block}`,
    );
    return { content: updated, added: fresh.length };
  }
  return { content: `${content}\n${heading}\n${block}`, added: fresh.length };
}

const MINED_SECTION_MAP = [
  ['decisions', '## Active Decisions'],
  ['avoid', '## Do Not Repeat'],
  ['preferences', '## Preferences'],
  ['next', '## Next Session'],
];

function minedToLines(items) {
  const lines = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item === 'string' && item.trim()) {
      lines.push(`- ${item.trim()}`);
    } else if (item && typeof item === 'object' && typeof item.what === 'string' && item.what.trim()) {
      lines.push(item.why ? `- ${item.what.trim()} -- ${String(item.why).trim()}` : `- ${item.what.trim()}`);
    }
  }
  return lines;
}

function applyMinedMemory(projectPath, mined) {
  const branch = detectBranch(projectPath);
  const stateDir = getStateDir(process.env.HOME);
  const filePath = resolveStateWrite(stateDir, projectPath, branch);

  return withStateFileLockSync(filePath, () => {
    const state = loadState(projectPath);
    if (state.undecryptable) return { filePath: state.filePath, added: 0 };

    let content = updateTimestamp(state.content, state.ts);
    let added = 0;

    for (const [key, heading] of MINED_SECTION_MAP) {
      const lines = minedToLines(mined?.[key]);
      if (lines.length === 0) continue;
      const result = appendToSection(content, heading, lines);
      content = result.content;
      added += result.added;
    }

    if (added > 0) saveState(state.filePath, content);
    return { filePath: state.filePath, added };
  });
}

module.exports = {
  SECTIONS,
  applyMinedMemory,
  buildSkeleton,
  loadState,
  saveState,
  writeSnapshotToDisk,
  withStateFileLockSync,
  extractSection,
  appendToSection,
  updateTimestamp,
  injectSessionMarker,
};
