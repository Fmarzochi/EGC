'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getStateDir, detectBranch, resolveStateRead, resolveStateWrite } = require('./branch-state');

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

function loadState(projectPath) {
  const branch = detectBranch(projectPath);
  const stateDir = getStateDir(process.env.HOME);
  const resolved = resolveStateRead(stateDir, projectPath, branch);
  const filePath = resolveStateWrite(stateDir, projectPath, branch);
  const ts = new Date().toISOString();

  const content = (resolved.source !== 'none' && fs.existsSync(resolved.filePath))
    ? fs.readFileSync(resolved.filePath, 'utf-8')
    : buildSkeleton(projectPath, branch, ts);

  return { content, filePath, ts };
}

function saveState(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  try { fs.chmodSync(filePath, 0o600); } catch { /* chmod not supported on Windows */ }
}

function writeSnapshotToDisk(projectPath = process.env.PWD || process.cwd()) {
  const state = loadState(projectPath);
  let content = updateTimestamp(state.content, state.ts);
  content = injectSessionMarker(content, state.ts);
  saveState(state.filePath, content);
  return state.filePath;
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
  const state = loadState(projectPath);
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
}

module.exports = {
  SECTIONS,
  applyMinedMemory,
  buildSkeleton,
  loadState,
  saveState,
  writeSnapshotToDisk,
  extractSection,
  appendToSection,
  updateTimestamp,
  injectSessionMarker,
};
