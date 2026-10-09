'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { propagateStateContent } = require('./propagate-state');
const {
  projectSlug,
  resolveHeadState,
  branchStateFile,
  detachedStateFile,
  legacyBranchStateFile,
} = require('./branch-state');
const { isEncryptedBuffer } = require('./state-crypto');

const EGC_START = '<!-- egc:start -->';
const EGC_END = '<!-- egc:end -->';

const DEBOUNCE_MS = 400;

// Files that EGC manages, keyed by tool name.
// Each entry is a function (projectPath) -> filePath | null.
const TOOL_FILE_RESOLVERS = {
  cursor: (p) => {
    const f = path.join(p, '.cursor', 'rules', 'egc-context.mdc');
    return fs.existsSync(f) ? f : null;
  },
  copilot: (p) => {
    const f = path.join(p, '.github', 'copilot-instructions.md');
    return fs.existsSync(f) ? f : null;
  },
  gemini: (p) => {
    const f = path.join(p, 'GEMINI.md');
    return fs.existsSync(f) ? f : null;
  },
  windsurf: (p) => {
    // The one mirror propagate-state.js writes: under .windsurf/ while that
    // directory exists, under .devin/ in a project on .devin/ alone.
    let dir = '.devin';
    try {
      if (fs.statSync(path.join(p, '.windsurf')).isDirectory()) dir = '.windsurf';
    } catch {
      dir = '.devin';
    }
    const f = path.join(p, dir, 'rules', 'egc-context.md');
    return fs.existsSync(f) ? f : null;
  },
  trae: (p) => {
    const f = path.join(p, '.trae', 'rules', 'egc-context.md');
    return fs.existsSync(f) ? f : null;
  },
  zed: (p) => {
    const f = path.join(p, '.rules');
    return fs.existsSync(f) ? f : null;
  },
  cline: (p) => {
    const f = path.join(p, '.clinerules');
    return fs.existsSync(f) ? f : null;
  },
  aider: (p) => {
    const f = path.join(p, 'CONVENTIONS.md');
    return fs.existsSync(f) ? f : null;
  },
  cursorrules: (p) => {
    const f = path.join(p, '.cursorrules');
    return fs.existsSync(f) ? f : null;
  },
  agents: (p) => {
    const f = path.join(p, 'AGENTS.md');
    return fs.existsSync(f) ? f : null;
  },
  llms: (p) => {
    const f = path.join(p, 'llms.txt');
    return fs.existsSync(f) ? f : null;
  },
};

function extractEgcBlock(content) {
  const start = content.indexOf(EGC_START);
  const end = content.indexOf(EGC_END);
  if (start === -1 || end === -1 || end <= start) return null;
  return content.slice(start + EGC_START.length, end).trim();
}

function processH2Line(h2, state) {
  const key = h2[1].trim();
  const val = h2[2].trim();
  if (key === 'Context') { state.context = val; state.section = 'context'; return true; }
  if (key === 'Active decisions') { state.section = 'decisions'; return true; }
  if (key === 'Next session') { state.section = 'next'; return true; }
  return false;
}

function appendStateSection(lines, title, items, asText = false) {
  if (!items || (Array.isArray(items) ? items.length === 0 : !items)) return;
  lines.push(`## ${title}`);
  if (asText) {
    lines.push(items);
  } else {
    for (const item of items) lines.push(`- ${item}`);
  }
  lines.push('');
}

function parseBlockToStateContent(block, updatedIso) { // NOSONAR: line-oriented state parser kept inline; sections and invariants read top-to-bottom
  const header = ['# Project State'];
  if (updatedIso) header.push(`updated: ${updatedIso}`);
  header.push('');

  const state = { context: '', section: '' };
  const decisions = [];
  const next = [];

  for (const line of block.split('\n')) {
    if (line.trimStart().startsWith('<!--')) continue;
    const h2 = line.match(/^\*\*(.+?):\*\*\s*(.*)/);
    if (h2 && processH2Line(h2, state)) continue;

    if (state.section === 'context' && !state.context && line.trim()) {
      state.context = line.trim();
      continue;
    }
    const item = line.replace(/^-\s*/, '').trim();
    if (!item) continue;
    if (state.section === 'decisions') decisions.push(item);
    if (state.section === 'next') next.push(item);
  }

  const lines = [...header];
  appendStateSection(lines, 'Context', state.context, true);
  appendStateSection(lines, 'Active Decisions', decisions);
  appendStateSection(lines, 'Next Session', next);

  return lines.join('\n');
}

function resolveRealpathOrNull(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

// True only when the candidate's parent directory resolves, through any
// intermediate symlinks, to somewhere at or under stateDir: lstat on the
// final component alone (existsAsPlainFile) does not catch a symlinked
// ancestor, since the kernel still follows a linked parent directory to
// open a path through it. Comparing realpaths here closes that gap.
// Scoped to resolveStateFilePath, which alone knows the real stateDir a
// candidate must stay under; mergeBlockIntoStateFile accepts a path
// directly and cannot assume one.
function hasTrustedAncestry(candidatePath, stateDir) {
  const realStateDir = resolveRealpathOrNull(stateDir);
  if (!realStateDir) return false;
  const realParent = resolveRealpathOrNull(path.dirname(candidatePath));
  if (!realParent) return false;
  const prefix = realStateDir.endsWith(path.sep) ? realStateDir : realStateDir + path.sep;
  return realParent === realStateDir || realParent.startsWith(prefix);
}

// True only for a plain file sitting directly at `f`: lstat (unlike
// fs.existsSync/fs.statSync) does not follow a symlink, so a link planted at
// any candidate path is refused here instead of being picked and later
// written through to whatever it points at.
function existsAsPlainFile(f) {
  try {
    return fs.lstatSync(f).isFile();
  } catch {
    return false;
  }
}

// A resolveStateFilePath candidate is accepted only when it is a plain file
// (existsAsPlainFile) reached entirely through stateDir, with no symlink at
// the final component or at any ancestor directory in between
// (hasTrustedAncestry): a linked ~/.egc/state/<slug> would otherwise pass
// the plain-file check on every file inside it.
function isTrustedStateCandidate(f, stateDir) {
  return existsAsPlainFile(f) && hasTrustedAncestry(f, stateDir);
}

function resolveStateFilePath(projectPath) {
  const stateDir = path.join(os.homedir(), '.egc', 'state');
  const slug = projectSlug(projectPath);
  const { branch, detachedCommit } = resolveHeadState(projectPath);

  if (branch) {
    const branchFile = branchStateFile(stateDir, projectPath, branch);
    if (isTrustedStateCandidate(branchFile, stateDir)) return branchFile;

    const legacyBranchFile = legacyBranchStateFile(stateDir, projectPath, branch);
    if (isTrustedStateCandidate(legacyBranchFile, stateDir)) return legacyBranchFile;
  } else if (detachedCommit) {
    // A detached HEAD never falls through to the shared flat file below:
    // every detached checkout of the project used to collide there. Each
    // commit gets its own file, checked here before the project-wide
    // defaults.
    const detachedFile = detachedStateFile(stateDir, projectPath, detachedCommit);
    if (isTrustedStateCandidate(detachedFile, stateDir)) return detachedFile;
    return null;
  }

  const defaultFile = path.join(stateDir, slug, 'main.md');
  if (isTrustedStateCandidate(defaultFile, stateDir)) return defaultFile;

  const flatFile = path.join(stateDir, `${slug}.md`);
  if (isTrustedStateCandidate(flatFile, stateDir)) return flatFile;

  return null;
}

// Writes atomically via a temp-file-then-rename, matching saveState() in
// state-snapshot.js: the temp name is short and random, in the same
// directory as the target rather than built from its full name, so a long
// legacy branch-state filename plus the temp suffix cannot exceed the
// filesystem's component-length limit (the watcher would otherwise fail the
// write silently). It is exclusive (wx) so it is never written through an
// existing link, and rename replaces whatever sits at stateFilePath (a
// plain file or a symlink) instead of following it.
function writeStateFileAtomic(stateFilePath, content) {
  const tmpPath = path.join(path.dirname(stateFilePath), `.egc-tmp-${crypto.randomBytes(8).toString('hex')}`);
  try {
    fs.writeFileSync(tmpPath, content, { flag: 'wx', mode: 0o600, encoding: 'utf-8' });
    fs.renameSync(tmpPath, stateFilePath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* already renamed away */ }
  }
}

function mergeBlockIntoStateFile(stateFilePath, block) {
  const parsed = parseBlockToStateContent(block);
  if (!parsed.trim()) return false;

  // Refuse a symlink here too: resolveStateFilePath already screens its own
  // candidates, but a caller may pass a path directly (as the tests do).
  if (!existsAsPlainFile(stateFilePath)) return false;

  const rawState = fs.readFileSync(stateFilePath);
  // Encrypted state is owned by the memory server: appending plaintext here
  // would corrupt the ciphertext and invalidate its HMAC sidecar.
  if (isEncryptedBuffer(rawState)) return false;
  const existing = rawState.toString('utf-8');

  // Only update Context and Next Session sections if they differ
  const contextMatch = /## Context\n([^\n]+)/.exec(parsed);
  const nextMatch = /## Next Session\n([\s\S]*?)(?=\n##|$)/.exec(parsed);

  if (!contextMatch && !nextMatch) return false;

  let updated = existing;

  if (contextMatch) {
    const newCtx = contextMatch[1].trim();
    if (updated.includes('## Context\n')) {
      updated = updated.replace(/## Context\n[\s\S]*?(?=\n##|$)/, `## Context\n${newCtx}\n`);
    }
  }

  if (nextMatch) {
    const newNext = nextMatch[1].trim();
    const nextSection = `## Next Session\n${newNext}`;
    if (updated.includes('## Next Session\n')) {
      updated = updated.replace(/## Next Session\n[\s\S]*?(?=\n##|$)/, `${nextSection}\n`);
    } else {
      updated = `${updated.trimEnd()}\n\n${nextSection}\n`;
    }
  }

  if (updated === existing) return false;

  writeStateFileAtomic(stateFilePath, updated);
  return true;
}

class StateWatcher {
  constructor(projectPath, { onSync, onError } = {}) {
    this._projectPath = path.resolve(projectPath);
    this._onSync = onSync || (() => {});
    this._onError = onError || (() => {});
    this._watchers = new Map();
    this._timers = new Map();
    // Track last write time per file to skip our own propagations
    this._lastWriteMs = new Map();
  }

  start() {
    const files = this._discoverFiles();
    for (const [tool, filePath] of files) {
      this._watchFile(tool, filePath);
    }
    return this._watchers.size;
  }

  stop() {
    for (const watcher of this._watchers.values()) {
      try { watcher.close(); } catch (_) { /* ignore */ } // NOSONAR
    }
    this._watchers.clear();
    for (const timer of this._timers.values()) {
      clearTimeout(timer);
    }
    this._timers.clear();
  }

  _discoverFiles() {
    const found = new Map();
    for (const [tool, resolve] of Object.entries(TOOL_FILE_RESOLVERS)) {
      const filePath = resolve(this._projectPath);
      if (filePath) found.set(tool, filePath);
    }
    return found;
  }

  _reattach(tool, filePath, oldWatcher) {
    if (oldWatcher) { try { oldWatcher.close(); } catch { /* watcher already closed */ } }
    this._watchers.delete(tool);
    this._watchFile(tool, filePath);
    this._schedule(tool, filePath);
  }

  _watchFile(tool, filePath) {
    try {
      const watcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'rename') {
          setTimeout(() => this._reattach(tool, filePath, watcher), 150);
          return;
        }
        if (eventType !== 'change') return;
        this._schedule(tool, filePath);
      });
      // Windows emits 'error' (EPERM) instead of 'rename' on atomic file replacement
      watcher.on('error', () => setTimeout(() => this._reattach(tool, filePath, null), 150));
      this._watchers.set(tool, watcher);
    } catch {
      // File may have been deleted -- skip silently
    }
  }

  _schedule(tool, filePath) {
    if (this._timers.has(tool)) clearTimeout(this._timers.get(tool));
    this._timers.set(tool, setTimeout(() => {
      this._timers.delete(tool);
      this._handleChange(tool, filePath);
    }, DEBOUNCE_MS));
  }

  _handleChange(tool, filePath) {
    // Skip if we wrote this file recently (within 2s -- our own propagation)
    const lastWrite = this._lastWriteMs.get(filePath) || 0;
    if (Date.now() - lastWrite < 2000) return;

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (_) { // NOSONAR: unreadable state file is skipped by design
      return;
    }

    const block = extractEgcBlock(content);
    if (!block) return;

    // A manual edit to a mirror is the freshest source there is: stamping the
    // synthetic state with "now" lets the freshness guard in propagate-state
    // treat the fanned-out mirrors as newer than any stale state file.
    const stateContent = parseBlockToStateContent(block, new Date().toISOString());
    if (!stateContent.includes('## Context') && !stateContent.includes('## Active Decisions')) return;

    // Propagate to all other tools
    const written = propagateStateContent(this._projectPath, stateContent);

    // Track our own writes to avoid loop-back
    for (const fp of Object.values(written)) {
      if (fp) this._lastWriteMs.set(fp, Date.now());
    }

    // Update state file if found
    let stateUpdated = false;
    const stateFilePath = resolveStateFilePath(this._projectPath);
    if (stateFilePath) {
      try {
        stateUpdated = mergeBlockIntoStateFile(stateFilePath, block);
        if (stateUpdated) this._lastWriteMs.set(stateFilePath, Date.now());
      } catch (_) { /* non-critical */ } // NOSONAR
    }

    const syncedTools = Object.entries(written)
      .filter(([, fp]) => fp)
      .map(([t]) => t)
      .filter((t) => t !== tool);

    this._onSync({ sourceTool: tool, sourceFile: filePath, syncedTools, stateUpdated });
  }
}

module.exports = { StateWatcher, TOOL_FILE_RESOLVERS, extractEgcBlock, parseBlockToStateContent, mergeBlockIntoStateFile, resolveStateFilePath };
