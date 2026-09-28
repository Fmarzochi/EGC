#!/usr/bin/env node
/**
 * ck — Context Keeper v2
 * session-start.mjs — inject compact project context on session start.
 *
 * Injects ~100 tokens (not ~2,500 like v1).
 * SKILL.md is injected separately (still small at ~50 lines).
 *
 * Features:
 * - Compact 5-line summary for registered projects
 * - Unsaved session detection → "Last session wasn't saved. Run /ck:save."
 * - Git activity since last session
 * - Goal mismatch detection vs GEMINI.md
 * - Mini portfolio for unregistered directories
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

const CK_HOME         = resolve(homedir(), '.gemini', 'ck');
const PROJECTS_FILE   = resolve(CK_HOME, 'projects.json');
const CURRENT_SESSION = resolve(CK_HOME, 'current-session.json');
const SKILL_FILE      = resolve(homedir(), '.gemini', 'skills', 'ck', 'SKILL.md');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function daysAgo(dateStr) {
  if (!dateStr) return 'unknown';
  const diff = Math.floor((Date.now() - new Date(dateStr)) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return '1 day ago';
  return `${diff} days ago`;
}

function stalenessIcon(dateStr) {
  if (!dateStr) return '○';
  const diff = Math.floor((Date.now() - new Date(dateStr)) / 86_400_000);
  return diff < 1 ? '●' : diff <= 5 ? '◐' : '○';
}

function gitLogSince(projectPath, sinceDate) {
  if (!sinceDate || !existsSync(resolve(projectPath, '.git'))) return null;
  try {
    const result = spawnSync(
      'git',
      ['-C', projectPath, 'log', '--oneline', `--since=${sinceDate}`],
      { timeout: 3000, stdio: 'pipe', encoding: 'utf8' },
    );
    if (result.status !== 0) return null;
    const output = result.stdout.trim();
    const commits = output.split('\n').filter(Boolean).length;
    return commits > 0 ? `${commits} commit${commits !== 1 ? 's' : ''} since last session` : null;
  } catch { return null; }
}

function extractGeminiMdGoal(projectPath) {
  const p = resolve(projectPath, 'GEMINI.md');
  if (!existsSync(p)) return null;
  try {
    const md = readFileSync(p, 'utf8');
    const m = md.match(/## Current Goal\n([\s\S]*?)(?=\n## |$)/);
    return m ? m[1].trim().split('\n')[0].trim() : null;
  } catch { return null; }
}

// ─── Session ID from stdin ────────────────────────────────────────────────────

function readSessionId() {
  try {
    const raw = readFileSync(0, 'utf8');
    return JSON.parse(raw).session_id || null;
  } catch { return null; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function recordCurrentSession(cwd, sessionId, entry) {
  try {
    writeFileSync(CURRENT_SESSION, JSON.stringify({
      sessionId,
      projectPath: cwd,
      projectName: entry?.name || null,
      startedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch { /* non-fatal */ }
}

function unsavedWarning(context, sessionId, prevSession) {
  if (!prevSession?.sessionId || prevSession.sessionId === sessionId) return [];
  const alreadySaved = context.sessions?.some(s => s.id === prevSession.sessionId);
  return alreadySaved ? [] : [`WARNING Last session wasn't saved — run /ck:save to capture it`];
}

function goalMismatchWarning(context, cwd) {
  const geminiMdGoal = extractGeminiMdGoal(cwd);
  if (!geminiMdGoal || !context.goal ||
      geminiMdGoal.toLowerCase().trim() === context.goal.toLowerCase().trim()) return [];
  return [
    `WARNING Goal mismatch — ck: "${context.goal.slice(0, 40)}" · GEMINI.md: "${geminiMdGoal.slice(0, 40)}"`,
    `   Run /ck:save with updated goal to sync`,
  ];
}

// The compact summary of a registered project (~100 tokens).
function summaryLinesFor(context, { cwd, sessionId, prevSession }) {
  const latest = context.sessions?.[context.sessions.length - 1] || {};
  const sessionDate = latest.date || context.createdAt;
  const sessionCount = context.sessions?.length || 0;
  const displayName = context.displayName ?? context.name;

  const summaryLines = [
    `ck: ${displayName} | ${daysAgo(sessionDate)} | ${sessionCount} session${sessionCount !== 1 ? 's' : ''}`,
    `Goal: ${context.goal || '—'}`,
    latest.leftOff ? `Left off: ${latest.leftOff.split('\n')[0]}` : null,
    latest.nextSteps?.length ? `Next: ${latest.nextSteps.slice(0, 2).join(' · ')}` : null,
  ].filter(Boolean);
  summaryLines.push(...unsavedWarning(context, sessionId, prevSession));
  const gitLine = gitLogSince(cwd, sessionDate);
  if (gitLine) summaryLines.push(`Git: ${gitLine}`);
  summaryLines.push(...goalMismatchWarning(context, cwd));
  return summaryLines;
}

// The context of a registered project and the instruction to show its
// summary first, or null when this folder is not one.
function registeredProjectParts(entry, session) {
  if (!entry?.contextDir) return null;
  const context = readJson(resolve(CK_HOME, 'contexts', entry.contextDir, 'context.json'));
  if (!context) return null;

  const displayName = context.displayName ?? context.name;
  const summary = summaryLinesFor(context, session).join('\n');
  return [
    [
      `---`,
      `## ck: ${displayName}`,
      ``,
      summary,
    ].join('\n'),
    // Instruct Gemini to display compact briefing at session start
    [
      `---`,
      `## ck: SESSION START`,
      ``,
      `IMPORTANT: Display the following as your FIRST message, verbatim:`,
      ``,
      '```',
      summary,
      '```',
      ``,
      `After the block, add one line: "Ready — what are we working on?"`,
      `If you see WARNING lines above, mention them briefly after the block.`,
    ].join('\n'),
  ];
}

// The three most recent registered projects, or null when there are none.
function recentProjectsPart(projects) {
  const entries = Object.entries(projects);
  if (entries.length === 0) return null;

  const recent = entries
    .map(([path, info]) => {
      const ctx = readJson(resolve(CK_HOME, 'contexts', info.contextDir, 'context.json'));
      const latest = ctx?.sessions?.[ctx.sessions.length - 1] || {};
      return { name: info.name, path, lastDate: latest.date || '', summary: latest.summary || '—', ctx };
    })
    .sort((a, b) => (b.lastDate > a.lastDate ? 1 : -1))
    .slice(0, 3);

  const miniRows = recent.map(p => {
    const icon = stalenessIcon(p.lastDate);
    const when = daysAgo(p.lastDate);
    const name = p.name.padEnd(16).slice(0, 16);
    const whenStr = when.padEnd(12).slice(0, 12);
    const summary = p.summary.slice(0, 32);
    return `  ${name}  ${icon}  ${whenStr}  ${summary}`;
  });

  const miniStatus = [
    `ck — recent projects:`,
    `  ${'PROJECT'.padEnd(16)}  S  ${'LAST SEEN'.padEnd(12)}  LAST SESSION`,
    `  ${'─'.repeat(68)}`,
    ...miniRows,
    ``,
    `Run /ck:list · /ck:resume <name> · /ck:init to register this folder`,
  ].join('\n');

  return [
    `---`,
    `## ck: SESSION START`,
    ``,
    `IMPORTANT: Display the following as your FIRST message, verbatim:`,
    ``,
    '```',
    miniStatus,
    '```',
  ].join('\n');
}

function main() {
  const cwd = process.env.PWD || process.cwd();
  const sessionId = readSessionId();

  const skill = existsSync(SKILL_FILE) ? readFileSync(SKILL_FILE, 'utf8') : '';

  const projects = readJson(PROJECTS_FILE) || {};
  const entry = projects[cwd];

  // Read previous session BEFORE overwriting current-session.json
  const prevSession = readJson(CURRENT_SESSION);
  recordCurrentSession(cwd, sessionId, entry);

  const parts = skill ? [skill] : [];
  const registered = registeredProjectParts(entry, { cwd, sessionId, prevSession });
  if (registered) return [...parts, ...registered];
  const recent = recentProjectsPart(projects);
  return recent ? [...parts, recent] : parts;
}

const parts = main();
if (parts.length > 0) {
  console.log(JSON.stringify({ additionalContext: parts.join('\n\n---\n\n') }));
}
