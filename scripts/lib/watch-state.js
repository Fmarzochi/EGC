'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { propagateStateContent } = require('./propagate-state');
const { projectSlug, sanitizeBranchName, detectBranch } = require('./branch-state');

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
    const f = path.join(p, '.windsurf', 'rules', 'egc-context.md');
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

function parseBlockToStateContent(block) {
  const lines = ['# Project State', ''];
  let context = '';
  const decisions = [];
  const next = [];

  let section = '';
  for (const line of block.split('\n')) {
    const h2 = line.match(/^\*\*(.+?):\*\*\s*(.*)/);
    if (h2) {
      const key = h2[1].trim();
      const val = h2[2].trim();
      if (key === 'Context') { context = val; section = 'context'; continue; }
      if (key === 'Active decisions') { section = 'decisions'; continue; }
      if (key === 'Next session') { section = 'next'; continue; }
    }
    if (section === 'context' && !context && line.trim()) {
      context = line.trim();
      continue;
    }
    const item = line.replace(/^-\s*/, '').trim();
    if (!item) continue;
    if (section === 'decisions') decisions.push(item);
    if (section === 'next') next.push(item);
  }

  if (context) {
    lines.push('## Context');
    lines.push(context);
    lines.push('');
  }
  if (decisions.length > 0) {
    lines.push('## Active Decisions');
    for (const d of decisions) lines.push(`- ${d}`);
    lines.push('');
  }
  if (next.length > 0) {
    lines.push('## Next Session');
    for (const n of next) lines.push(`- ${n}`);
    lines.push('');
  }

  return lines.join('\n');
}

function resolveStateFilePath(projectPath) {
  const stateDir = path.join(os.homedir(), '.egc', 'state');
  const slug = projectSlug(projectPath);
  const branch = detectBranch(projectPath);

  if (branch) {
    const branchFile = path.join(stateDir, slug, `${sanitizeBranchName(branch)}.md`);
    if (fs.existsSync(branchFile)) return branchFile;
  }

  const defaultFile = path.join(stateDir, slug, 'main.md');
  if (fs.existsSync(defaultFile)) return defaultFile;

  const flatFile = path.join(stateDir, `${slug}.md`);
  if (fs.existsSync(flatFile)) return flatFile;

  return null;
}

function mergeBlockIntoStateFile(stateFilePath, block) {
  const parsed = parseBlockToStateContent(block);
  if (!parsed.trim()) return false;

  const existing = fs.readFileSync(stateFilePath, 'utf-8');

  // Only update Context and Next Session sections if they differ
  const contextMatch = parsed.match(/## Context\n([^\n]+)/);
  const nextMatch = parsed.match(/## Next Session\n([\s\S]*?)(?=\n##|$)/);

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

  fs.writeFileSync(stateFilePath, updated, 'utf-8');
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
      try { watcher.close(); } catch (_) { /* ignore */ }
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

  _watchFile(tool, filePath) {
    try {
      const watcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'rename') {
          setTimeout(() => {
            try { watcher.close(); } catch (_) { /* watcher already replaced on rename */ }
            this._watchers.delete(tool);
            this._watchFile(tool, filePath);
            this._schedule(tool, filePath);
          }, 150);
          return;
        }
        if (eventType !== 'change') return;
        this._schedule(tool, filePath);
      });
      // Windows emits 'error' (EPERM) instead of 'rename' on atomic file replacement
      watcher.on('error', () => {
        this._watchers.delete(tool);
        setTimeout(() => {
          this._watchFile(tool, filePath);
          this._schedule(tool, filePath);
        }, 150);
      });
      this._watchers.set(tool, watcher);
    } catch (_) {
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
    } catch (_) {
      return;
    }

    const block = extractEgcBlock(content);
    if (!block || !block.trim()) return;

    const stateContent = parseBlockToStateContent(block);
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
      } catch (_) { /* non-critical */ }
    }

    const syncedTools = Object.entries(written)
      .filter(([, fp]) => fp)
      .map(([t]) => t)
      .filter((t) => t !== tool);

    this._onSync({ sourceTool: tool, sourceFile: filePath, syncedTools, stateUpdated });
  }
}

module.exports = { StateWatcher, extractEgcBlock, parseBlockToStateContent, mergeBlockIntoStateFile, resolveStateFilePath };
