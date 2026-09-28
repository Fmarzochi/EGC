/**
 * ck — Context Keeper v2
 * shared.mjs — common utilities for all command scripts
 *
 * No external dependencies. Node.js stdlib only.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';

// ─── Paths ────────────────────────────────────────────────────────────────────

export const CK_HOME          = resolve(homedir(), '.gemini', 'ck');
export const CONTEXTS_DIR     = resolve(CK_HOME, 'contexts');
export const PROJECTS_FILE    = resolve(CK_HOME, 'projects.json');
export const CURRENT_SESSION  = resolve(CK_HOME, 'current-session.json');
export const SKILL_FILE       = resolve(homedir(), '.gemini', 'skills', 'ck', 'SKILL.md');

// ─── JSON I/O ─────────────────────────────────────────────────────────────────

export function readJson(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJson(filePath, data) {
  const dir = resolve(filePath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function readProjects() {
  return readJson(PROJECTS_FILE) || {};
}

export function writeProjects(projects) {
  writeJson(PROJECTS_FILE, projects);
}

// ─── Context I/O ──────────────────────────────────────────────────────────────

export function contextPath(contextDir) {
  return resolve(CONTEXTS_DIR, contextDir, 'context.json');
}

export function contextMdPath(contextDir) {
  return resolve(CONTEXTS_DIR, contextDir, 'CONTEXT.md');
}

export function loadContext(contextDir) {
  return readJson(contextPath(contextDir));
}

export function saveContext(contextDir, data) {
  const dir = resolve(CONTEXTS_DIR, contextDir);
  mkdirSync(dir, { recursive: true });
  writeJson(contextPath(contextDir), data);
  writeFileSync(contextMdPath(contextDir), renderContextMd(data), 'utf8');
}

/**
 * Resolve which project to operate on.
 * @param {string|undefined} arg  — undefined = cwd match, number string = alphabetical index, else name search
 * @param {string} cwd
 * @returns {{ name, contextDir, projectPath, context } | null}
 */
export function resolveContext(arg, cwd) {
  const projects = readProjects();
  const entries = Object.entries(projects); // [path, {name, contextDir, lastUpdated}]

  if (!arg) {
    const entry = projects[cwd];
    if (!entry) return null;
    const context = loadContext(entry.contextDir);
    if (!context) return null;
    return { name: entry.name, contextDir: entry.contextDir, projectPath: cwd, context };
  }

  // Collect all contexts sorted alphabetically by contextDir
  const sorted = entries
    .map(([path, info]) => ({ path, ...info }))
    .sort((a, b) => a.contextDir.localeCompare(b.contextDir));

  const asNumber = parseInt(arg, 10);
  if (!isNaN(asNumber) && String(asNumber) === arg) {
    // Number-based lookup (1-indexed)
    const item = sorted[asNumber - 1];
    if (!item) return null;
    const context = loadContext(item.contextDir);
    if (!context) return null;
    return { name: item.name, contextDir: item.contextDir, projectPath: item.path, context };
  }

  // Name-based lookup: exact > prefix > substring (case-insensitive)
  const lower = arg.toLowerCase();
  let match =
    sorted.find(e => e.name.toLowerCase() === lower) ||
    sorted.find(e => e.name.toLowerCase().startsWith(lower)) ||
    sorted.find(e => e.name.toLowerCase().includes(lower));

  if (!match) return null;
  const context = loadContext(match.contextDir);
  if (!context) return null;
  return { name: match.name, contextDir: match.contextDir, projectPath: match.path, context };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function daysAgoLabel(dateStr) {
  if (!dateStr) return 'unknown';
  const diff = Math.floor((Date.now() - new Date(dateStr)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return '1 day ago';
  return `${diff} days ago`;
}

export function stalenessIcon(dateStr) {
  if (!dateStr) return '○';
  const diff = Math.floor((Date.now() - new Date(dateStr)) / 86_400_000);
  if (diff < 1) return '●';
  if (diff <= 5) return '◐';
  return '○';
}

// ─── ID generation ────────────────────────────────────────────────────────────

export function shortId() {
  return randomBytes(4).toString('hex');
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function runGit(args, cwd) {
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      timeout: 3000,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (result.status !== 0) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

export function gitLogSince(projectPath, sinceDate) {
  if (!sinceDate) return null;
  return runGit(['log', '--oneline', `--since=${sinceDate}`], projectPath);
}

export function gitSummary(projectPath, sinceDate) {
  const log = gitLogSince(projectPath, sinceDate);
  if (!log) return null;
  const commits = log.split('\n').filter(Boolean).length;
  if (commits === 0) return null;

  // Count unique files changed: use a separate runGit call to avoid nested shell substitution
  const countStr = runGit(['rev-list', '--count', 'HEAD', `--since=${sinceDate}`], projectPath);
  const revCount = countStr ? parseInt(countStr, 10) : commits;
  const diff = runGit(['diff', '--shortstat', `HEAD~${Math.min(revCount, 50)}..HEAD`], projectPath);

  if (diff) {
    const filesMatch = diff.match(/(\d+) file/);
    const files = filesMatch ? parseInt(filesMatch[1]) : '?';
    return `${commits} commit${commits !== 1 ? 's' : ''}, ${files} file${files !== 1 ? 's' : ''} changed`;
  }
  return `${commits} commit${commits !== 1 ? 's' : ''}`;
}

// ─── Native memory path encoding ──────────────────────────────────────────────

export function encodeProjectPath(absolutePath) {
  // "/Users/sree/dev/app" -> "-Users-sree-dev-app"
  return absolutePath.replace(/\//g, '-');
}

export function nativeMemoryDir(absolutePath) {
  const encoded = encodeProjectPath(absolutePath);
  return resolve(homedir(), '.gemini', 'projects', encoded, 'memory');
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const stackText = (stack, empty) => (Array.isArray(stack) ? stack.join(', ') : (stack || empty));

// A section's lines, or its placeholder when it has none.
const listOr = (items, render, placeholder) => (items?.length ? items.map(render) : [placeholder]);

function contextHeader(ctx) {
  const sessionCount = ctx.sessions?.length || 0;
  const lines = [
    `# Project: ${ctx.displayName ?? ctx.name}`,
    `> Path: ${ctx.path}`,
  ];
  if (ctx.repo) lines.push(`> Repo: ${ctx.repo}`);
  lines.push(`> Last Session: ${ctx.sessions?.[sessionCount - 1]?.date || 'never'} | Sessions: ${sessionCount}`, ``);
  return lines;
}

// Every decision across the sessions, as table rows.
function decisionRows(sessions) {
  const allDecisions = (sessions || []).flatMap(s =>
    (s.decisions || []).map(d => ({ ...d, date: s.date }))
  );
  return listOr(allDecisions, d => `| ${d.what} | ${d.why || ''} | ${d.date || ''} |`, `| _(none yet)_ | | |`);
}

// The session history, most recent first, when there is more than one.
function sessionHistory(sessions) {
  if (!(sessions?.length > 1)) return [];
  const lines = [`## Session History`];
  for (const s of [...sessions].reverse()) {
    lines.push(`### ${s.date} — ${s.summary || 'Session'}`);
    if (s.gitActivity) lines.push(`_${s.gitActivity}_`);
    if (s.leftOff) lines.push(`**Left off:** ${s.leftOff}`);
  }
  lines.push(``);
  return lines;
}

/** Render the human-readable CONTEXT.md from context.json */
export function renderContextMd(ctx) {
  const latest = ctx.sessions?.[ctx.sessions.length - 1] || null;
  return [
    ...contextHeader(ctx),
    `## What This Is`,
    ctx.description || '_Not set._',
    ``,
    `## Tech Stack`,
    stackText(ctx.stack, '_Not set._'),
    ``,
    `## Current Goal`,
    ctx.goal || '_Not set._',
    ``,
    `## Where I Left Off`,
    latest?.leftOff || '_Not yet recorded. Run /ck:save after your first session._',
    ``,
    `## Next Steps`,
    ...listOr(latest?.nextSteps, (s, i) => `${i + 1}. ${s}`, `_Not yet recorded._`),
    ``,
    `## Blockers`,
    ...listOr(latest?.blockers, b => `- ${b}`, `- None`),
    ``,
    `## Do Not Do`,
    ...listOr(ctx.constraints, c => `- ${c}`, `- None specified`),
    ``,
    `## Decisions Made`,
    `| Decision | Why | Date |`,
    `|----------|-----|------|`,
    ...decisionRows(ctx.sessions),
    ``,
    ...sessionHistory(ctx.sessions),
  ].join('\n');
}

const BRIEFING_WIDTH = 57;
const briefingRule = (left, right) => `${left}${'─'.repeat(BRIEFING_WIDTH)}${right}`;

function padCell(str, w) {
  const s = String(str || '');
  return s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w);
}

const briefingRow = (label, value) => `│  ${label} → ${padCell(value, BRIEFING_WIDTH - label.length - 7)}│`;

// The briefing's title and what the project is.
function briefingProject(ctx, latest) {
  const W = BRIEFING_WIDTH;
  const when = daysAgoLabel(ctx.sessions?.[ctx.sessions.length - 1]?.date);
  const sessions = ctx.sessions?.length || 0;
  const shortSessId = latest.id?.slice(0, 8) || null;
  const lastSeen = `${when}  |  Sessions: ${sessions}`;

  const lines = [
    briefingRule('┌', '┐'),
    `│  RESUMING: ${padCell(ctx.displayName ?? ctx.name, W - 12)}│`,
    `│  Last session: ${padCell(lastSeen, W - 16)}│`,
  ];
  if (shortSessId) lines.push(`│  Session ID: ${padCell(shortSessId, W - 14)}│`);
  lines.push(briefingRule('├', '┤'));
  lines.push(briefingRow('WHAT IT IS', ctx.description || '—'));
  lines.push(briefingRow('STACK     ', stackText(ctx.stack, '—')));
  lines.push(briefingRow('PATH      ', ctx.path));
  if (ctx.repo) lines.push(briefingRow('REPO      ', ctx.repo));
  lines.push(briefingRow('GOAL      ', ctx.goal || '—'));
  return lines;
}

// Where the last session left off, what comes next, and what blocks it.
function briefingProgress(latest) {
  const W = BRIEFING_WIDTH;
  const lines = [briefingRule('├', '┤'), `│  WHERE I LEFT OFF${' '.repeat(W - 18)}│`];
  const leftOffLines = (latest.leftOff || '—').split('\n').filter(Boolean);
  leftOffLines.forEach(l => lines.push(`│    • ${padCell(l, W - 7)}│`));
  lines.push(briefingRule('├', '┤'), `│  NEXT STEPS${' '.repeat(W - 12)}│`);
  lines.push(...listOr(latest.nextSteps || [], (s, i) => `│    ${i + 1}. ${padCell(s, W - 8)}│`, `│    —${' '.repeat(W - 5)}│`));
  const blockers = latest.blockers?.length ? latest.blockers.join(', ') : 'None';
  lines.push(`│  BLOCKERS → ${padCell(blockers, W - 13)}│`);
  if (latest.gitActivity) {
    lines.push(`│  GIT      → ${padCell(latest.gitActivity, W - 13)}│`);
  }
  lines.push(briefingRule('└', '┘'));
  return lines;
}

/** Render the bordered briefing box used by /ck:resume */
export function renderBriefingBox(ctx, _meta = {}) {
  const latest = ctx.sessions?.[ctx.sessions.length - 1] || {};
  return [...briefingProject(ctx, latest), ...briefingProgress(latest)].join('\n');
}

/** Render compact info block used by /ck:info */
export function renderInfoBlock(ctx) {
  const latest = ctx.sessions?.[ctx.sessions.length - 1] || {};
  const sep = '─'.repeat(44);
  const lines = [
    `ck: ${ctx.displayName ?? ctx.name}`,
    sep,
  ];
  lines.push(`PATH     ${ctx.path}`);
  if (ctx.repo) lines.push(`REPO     ${ctx.repo}`);
  if (latest.id) lines.push(`SESSION  ${latest.id.slice(0, 8)}`);
  lines.push(`GOAL     ${ctx.goal || '—'}`);
  lines.push(sep);
  lines.push(`WHERE I LEFT OFF`);
  (latest.leftOff || '—').split('\n').filter(Boolean).forEach(l => lines.push(`  • ${l}`));
  lines.push(`NEXT STEPS`);
  (latest.nextSteps || []).forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  if (!latest.nextSteps?.length) lines.push(`  —`);
  lines.push(`BLOCKERS`);
  if (latest.blockers?.length) {
    latest.blockers.forEach(b => lines.push(`  • ${b}`));
  } else {
    lines.push(`  • None`);
  }
  return lines.join('\n');
}

/** Render ASCII list table used by /ck:list */
export function renderListTable(entries, cwd, _todayStr) {
  // entries: [{name, contextDir, path, context, lastUpdated}]
  // Sorted alphabetically by contextDir before calling
  const rows = entries.map((e, i) => {
    const isHere = e.path === cwd;
    const latest = e.context?.sessions?.[e.context.sessions.length - 1] || {};
    const when = daysAgoLabel(latest.date);
    const icon = stalenessIcon(latest.date);
    const statusLabel = icon === '●' ? '● Active' : icon === '◐' ? '◐ Warm' : '○ Stale';
    const sessId = latest.id ? latest.id.slice(0, 8) : '—';
    const summary = (latest.summary || '—').slice(0, 34);
    const displayName = ((e.context?.displayName ?? e.name) + (isHere ? ' <-' : '')).slice(0, 18);
    return {
      num: String(i + 1),
      name: displayName,
      status: statusLabel,
      when: when.slice(0, 10),
      sessId,
      summary,
    };
  });

  const cols = {
    num:     Math.max(1, ...rows.map(r => r.num.length)),
    name:    Math.max(7, ...rows.map(r => r.name.length)),
    status:  Math.max(6, ...rows.map(r => r.status.length)),
    when:    Math.max(9, ...rows.map(r => r.when.length)),
    sessId:  Math.max(7, ...rows.map(r => r.sessId.length)),
    summary: Math.max(12, ...rows.map(r => r.summary.length)),
  };

  const hr = `+${'-'.repeat(cols.num + 2)}+${'-'.repeat(cols.name + 2)}+${'-'.repeat(cols.status + 2)}+${'-'.repeat(cols.when + 2)}+${'-'.repeat(cols.sessId + 2)}+${'-'.repeat(cols.summary + 2)}+`;
  const cell = (val, width) => ` ${val.padEnd(width)} `;
  const headerRow = `|${cell('#', cols.num)}|${cell('Project', cols.name)}|${cell('Status', cols.status)}|${cell('Last Seen', cols.when)}|${cell('Session', cols.sessId)}|${cell('Last Summary', cols.summary)}|`;

  const dataRows = rows.map(r =>
    `|${cell(r.num, cols.num)}|${cell(r.name, cols.name)}|${cell(r.status, cols.status)}|${cell(r.when, cols.when)}|${cell(r.sessId, cols.sessId)}|${cell(r.summary, cols.summary)}|`
  );

  return [hr, headerRow, hr, ...dataRows, hr].join('\n');
}
