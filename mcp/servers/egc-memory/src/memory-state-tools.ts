import { Database } from 'sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { log, ensurePrivateDir, hideEgcRootOnWindows } from './memory-logging';
import { writeArbitrator, getMaintenanceState, setMaintenanceState, clearStaleMigrationLock, acquireMigrationLock } from './memory-db';
import { resolveProjectPath } from './memory-project-path';
import { resolveHeadState, resolveStateRead, resolveStateWrite } from './branch-state';
import { GLOBAL_APPENDIX_SECTIONS, buildGlobalAppendix, globalStateFilePath } from './global-state';
import { resolveHome } from './home';
import { announcePresenceBestEffort } from './memory-session-bus';
import { loadOrCreateKey, writeHmac, verifyHmac } from './integrity';
import { loadOrCreateEncKey, readStateFile, writeStateFile, quarantineUndecryptableStateFile } from './encryption';
import { propagateStateToTools } from './propagate';
import { sweepExpired } from './working-memory';
import { sanitizeStateFields, scrubPresentedLines, scrubStateFields } from './sanitize.js';
import { runLessonDecaySweep } from './memory-lessons';

function getIntegrityKey(): Buffer {
  return loadOrCreateKey();
}
function getEncKey(): Buffer {
  return loadOrCreateEncKey();
}

export function getStateDir(): string {
  const dir = path.join(resolveHome(), '.egc', 'state');
  ensurePrivateDir(dir);
  hideEgcRootOnWindows();
  return dir;
}

export function getGlobalStateFile(): string {
  const file = globalStateFilePath();
  ensurePrivateDir(path.dirname(file));
  return file;
}

async function withStateMergeLock<T>(stateFile: string, fn: () => T | Promise<T>): Promise<T> {
  const lockFile = `${stateFile}.merge.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  clearStaleMigrationLock(lockFile);
  await acquireMigrationLock(lockFile);
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lockFile); } catch (_) { /* NOSONAR: already cleared by a stale sweep */ }
  }
}

const H2_RE = /^## (.+)/;
function readStateDoc(filePath: string): Record<string, string[]|string> {
  if (!fs.existsSync(filePath)) return {};
  const content = readStateFile(filePath, getEncKey());
  const result: Record<string, string[]|string> = {};
  let currentSection = '';
  for (const line of content.split('\n')) {
    const h2 = H2_RE.exec(line);
    if (h2) { currentSection = h2[1].trim(); result[currentSection] = result[currentSection] || []; continue; }
    if (currentSection && line.trim() && !line.startsWith('#')) {
      const arr = result[currentSection];
      if (Array.isArray(arr)) arr.push(line.replace(/^- /, '').trim());
      else result[currentSection] = line.trim();
    }
  }
  return result;
}

function writeStateDoc(filePath: string, projectPath: string, data: {
  context?: string;
  decisions?: {what: string; why?: string}[];
  avoid?: {what: string; why?: string}[];
  preferences?: string[];
  next?: string[];
}, existing: Record<string, string[]|string>, branch: string | null = null) {
  const author = process.env.USER || process.env.USERNAME || 'unknown';
  const mergedDecisions = [
    ...(data.decisions || []).map(d => `- ${d.what}${d.why ? ': ' + d.why : ''}`),
    ...((existing['Active Decisions'] as string[]) || []).map(l => `- ${l}`)
  ].slice(0, 15);

  const mergedAvoid = [
    ...(data.avoid || []).map(d => `- ${d.what}${d.why ? ': ' + d.why : ''}`),
    ...((existing['Do Not Repeat'] as string[]) || []).map(l => `- ${l}`)
  ].slice(0, 10);

  const mergedPrefs = [
    ...(data.preferences || []).map(p => `- ${p}`),
    ...((existing['Preferences'] as string[]) || []).map(l => `- ${l}`)
  ].slice(0, 15);

  const nextItems = (data.next || []).map(n => `- ${n}`);

  const context = data.context || (existing['Context'] as string) || '';

  const lines = [
    `# Project State`,
    `project: ${projectPath}`,
    ...(branch ? [`branch: ${branch}`] : []),
    `author: ${author}`,
    `updated: ${new Date().toISOString()}`,
    ``,
    `## Context`,
    context,
    ``,
    `## Active Decisions`,
    ...mergedDecisions,
    ``,
    `## Do Not Repeat`,
    ...mergedAvoid,
    ``,
    `## Preferences`,
    ...mergedPrefs,
    ``,
    `## Next Session`,
    ...nextItems,
    ``
  ];

  writeStateFile(filePath, lines.join('\n'), getEncKey());
}

export const GetStateSchema = z.object({
  project_path: z.string().optional()
});

export const UpdateStateSchema = z.object({
  project_path: z.string().optional(),
  context: z.string().max(2000).optional(),
  decisions: z.array(z.object({
    what: z.string().max(500),
    why: z.string().max(500).optional()
  })).max(20).optional(),
  avoid: z.array(z.object({
    what: z.string().max(500),
    why: z.string().max(500).optional()
  })).max(20).optional(),
  preferences: z.array(z.string().max(300)).max(20).optional(),
  next: z.array(z.string().max(500)).max(10).optional(),
  force: z.boolean().optional(),
  scope: z.enum(['project', 'global']).optional().default('project')
});

// Sweep expired working memory entries throttled to once per hour, and run
// the confidence decay sweep throttled to once per day. Neither may block a
// memory read.
async function runThrottledMaintenance(db: Database): Promise<void> {
  try {
    const lastWmSweep = await getMaintenanceState(db, 'last_working_memory_sweep');
    const wmSweepDue = !lastWmSweep || Date.now() - new Date(lastWmSweep).getTime() > 60 * 60 * 1000;
    if (wmSweepDue) {
      const swept = await sweepExpired(db);
      await setMaintenanceState(db, 'last_working_memory_sweep', new Date().toISOString());
      if (swept > 0) log('INFO', 'Swept expired working memory entries', { count: swept });
    }
  } catch (e) {
    log('WARN', 'Working memory sweep failed, continuing', { error: String(e) });
  }

  try {
    const lastDecay = await getMaintenanceState(db, 'last_decay_sweep');
    const decayDue = !lastDecay || Date.now() - new Date(lastDecay).getTime() > 24 * 60 * 60 * 1000;
    if (decayDue) {
      const affected = await runLessonDecaySweep(db);
      await setMaintenanceState(db, 'last_decay_sweep', new Date().toISOString());
      if (affected > 0) log('INFO', 'Lesson decay sweep ran', { affected });
    }
  } catch (e) {
    log('WARN', 'Lesson decay sweep failed, continuing', { error: String(e) });
  }
}

// Open a session record for time-aware session tracking.
async function openSessionRecordBestEffort(db: Database, projPath: string): Promise<void> {
  try {
    const sessionId = `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await writeArbitrator.enqueue(async () => {
      await db.run(
        'INSERT INTO sessions (id, project_path, tool, started_at) VALUES (?, ?, ?, ?)',
        [sessionId, projPath, 'get_state', new Date().toISOString()]
      );
      await db.run('INSERT OR REPLACE INTO operational_state (id, value) VALUES (?, ?)', ['current_session_id', sessionId]);
    });
  } catch (_) { /* non-fatal */ } // NOSONAR: session id persistence is best-effort
}

export async function handleGetState(db: Database, toolArgs: unknown) {
  const { project_path } = GetStateSchema.parse(toolArgs || {});
  const projPath = resolveProjectPath(project_path);
  const { branch, detachedCommit } = resolveHeadState(projPath);
  const resolved = resolveStateRead(getStateDir(), projPath, branch, detachedCommit);

  await announcePresenceBestEffort(db, projPath);
  await runThrottledMaintenance(db);
  await openSessionRecordBestEffort(db, projPath);

  if (resolved.source === 'none') {
    const branchLine = branch ? `Branch: ${branch}\n` : '';
    const emptyStateText = `No state found for this project yet.\n${branchLine}Path: ${resolved.filePath}\n\nCall update_state at the end of this session to start building project memory.`;
    const appendix = readGlobalAppendix('');
    return { content: [{ type: "text", text: appendix ? `${emptyStateText}\n${appendix}` : emptyStateText }] };
  }

  let content: string;
  try {
    content = readStateFile(resolved.filePath, getEncKey());
  } catch (err) {
    log('ERROR', '[EGC encryption] Failed to decrypt state file', { file: resolved.filePath, error: String(err) });
    return { content: [{ type: "text", text: `State file exists but could not be decrypted. The encryption key may have changed.\nPath: ${resolved.filePath}` }] };
  }
  const verify = verifyHmac(resolved.filePath, content, getIntegrityKey());
  if (!verify.ok) {
    log('WARN', '[EGC integrity] State file integrity check failed', { file: resolved.filePath, reason: (verify as { ok: false; reason: string }).reason });
    log('INFO', 'Project state retrieved', { project: projPath, branch: branch || 'none', source: resolved.source, integrity: (verify as { ok: false; reason: string }).reason });
  } else {
    log('INFO', 'Project state retrieved', { project: projPath, branch: branch || 'none', source: resolved.source, integrity: 'ok' });
  }
  const appendix = readGlobalAppendix(content);
  return { content: [{ type: "text", text: appendix ? `${content}\n${appendix}` : content }] };
}

function readGlobalAppendix(projectContent: string): string | null {
  try {
    const globalFile = getGlobalStateFile();
    if (!fs.existsSync(globalFile)) return null;
    const globalDoc = readStateDoc(globalFile);
    const presented: Record<string, string[]> = {};
    for (const { heading } of GLOBAL_APPENDIX_SECTIONS) {
      const lines = globalDoc[heading];
      if (Array.isArray(lines)) presented[heading] = lines;
    }
    const scrubbed = scrubPresentedLines(presented);
    if (scrubbed.reasons.length > 0) {
      log('WARN', 'get_state: suspicious global entries withheld from the appendix', { reasons: scrubbed.reasons });
    }
    return buildGlobalAppendix({ ...globalDoc, ...scrubbed.sections }, projectContent);
  } catch (err) {
    log('WARN', 'Failed to read global state, returning project state only', { error: String(err) });
    return null;
  }
}

function readExistingStateOrRecover(filePath: string, force: boolean | undefined, label: 'global' | 'project'): Record<string, string[]|string> {
  try {
    return readStateDoc(filePath);
  } catch (err) {
    if (force && fs.existsSync(filePath)) {
      const backupPath = quarantineUndecryptableStateFile(filePath);
      log('WARN', `update_state: force=true, undecryptable ${label} state backed up and replaced`, { file: filePath, backup: backupPath, error: String(err) });
      return {};
    }
    log('ERROR', `[EGC encryption] Cannot read existing ${label} state, aborting update to prevent data loss`, { file: filePath, error: String(err) });
    throw new McpError(ErrorCode.InternalError, `Failed to decrypt existing ${label === 'global' ? 'global ' : ''}state file. The encryption key may have changed. Path: ${filePath}. Retry with force: true to back up the unreadable file and start fresh -- only do this after confirming the failure is persistent, not a transient lock from another process writing at the same moment.`);
  }
}

export async function handleUpdateState(db: Database, toolArgs: unknown) {
  const args = UpdateStateSchema.parse(toolArgs || {});
  const check = sanitizeStateFields(args);
  if (check.flagged) {
    log('WARN', 'update_state: suspicious content blocked', { reasons: check.reasons });
    return { content: [{ type: "text", text: `Blocked: ${check.reasons.join('; ')}` }] };
  }
  const projPath = resolveProjectPath(args.project_path);
  const { branch, detachedCommit } = resolveHeadState(projPath);

  await announcePresenceBestEffort(db, projPath);

  try {
    const sessionId = await getMaintenanceState(db, 'current_session_id');
    if (sessionId) {
      await writeArbitrator.enqueue(async () => {
        await db.run('UPDATE sessions SET ended_at = ? WHERE id = ?', [new Date().toISOString(), sessionId]);
        await db.run('DELETE FROM operational_state WHERE id = ?', ['current_session_id']);
      });
    }
  } catch (_) { /* non-fatal */ } // NOSONAR: legacy flat-state merge is best-effort

  if (args.scope === 'global') {
    const globalFile = getGlobalStateFile();
    return withStateMergeLock(globalFile, () => {
      const existingGlobal = readExistingStateOrRecover(globalFile, args.force, 'global');
      writeStateDoc(globalFile, 'global', args, existingGlobal, null);
      const writtenGlobal = readStateFile(globalFile, getEncKey());
      writeHmac(globalFile, writtenGlobal, getIntegrityKey());
      log('INFO', 'Global state updated', { decisions: args.decisions?.length || 0 });
      return { content: [{ type: "text", text: `Global memory updated (shared across all projects).\nFile: ${globalFile}\nDecisions saved: ${args.decisions?.length || 0}` }] };
    });
  }

  const filePath = resolveStateWrite(getStateDir(), projPath, branch, detachedCommit);

  await withStateMergeLock(filePath, () => {
    const resolved = resolveStateRead(getStateDir(), projPath, branch, detachedCommit);
    const existing = readExistingStateOrRecover(resolved.filePath, args.force, 'project');

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeStateDoc(filePath, projPath, args, existing, branch);
    const writtenContent = readStateFile(filePath, getEncKey());
    writeHmac(filePath, writtenContent, getIntegrityKey());
  });
  const mergedForPropagation = readStateDoc(filePath);
  const scrubbed = scrubStateFields({
    context: ((mergedForPropagation['Context'] as string[] | undefined) ?? []).join('\n') || undefined,
    decisions: ((mergedForPropagation['Active Decisions'] as string[]) || []).map(what => ({ what })),
    next: (mergedForPropagation['Next Session'] as string[]) || undefined,
  });
  if (scrubbed.reasons.length > 0) {
    log('WARN', 'update_state: suspicious stored entries withheld from propagation', { reasons: scrubbed.reasons });
  }
  const propagated = propagateStateToTools({ projectPath: projPath, ...scrubbed.fields });
  const propagatedTools = Object.entries(propagated)
    .filter(([, p]) => p !== null)
    .map(([tool]) => tool);

  log('INFO', 'Project state updated', { project: projPath, branch: branch || 'none', decisions: args.decisions?.length || 0, propagated: propagatedTools });
  const branchLine = branch ? `Branch: ${branch}\n` : '';
  const toolsLine = propagatedTools.length > 0 ? `Tools updated: ${propagatedTools.join(', ')}\n` : '';
  return { content: [{ type: "text", text: `Project memory updated.\n${branchLine}${toolsLine}File: ${filePath}\nDecisions saved: ${args.decisions?.length || 0}\nNext session items: ${args.next?.length || 0}` }] };
}
