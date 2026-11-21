import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Database } from 'sqlite';

import { projectIdentity } from '../branch-state';
import { loadOrCreateMachine } from '../relay/machine';
import { openEnvelope, sealEnvelope } from './envelope';

// The memory that is not a state document, carried by the team sync as one
// sealed record per row: the lessons, the decisions of the history and the
// working memory. Each record travels under records/<kind>/<id>.json, sealed
// for its path as a state document is, and merges by id on the other
// machine: a lesson reinforced on two machines keeps the higher confidence
// and the later dates, a decision is written once, a working memory entry
// is taken only when newer and never once expired. Every record names the
// machine it was written on, and the project by the key of its remote, so
// the same repository under two folders meets.
export type RecordKind = 'lesson' | 'decision' | 'working-memory';
export const RECORD_KINDS: readonly RecordKind[] = ['lesson', 'decision', 'working-memory'];
export const RECORDS_DIR = 'records';
export const MAX_RECORD_BYTES = 64 * 1024;
const RECORD_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;

export interface SyncRecord {
  kind: RecordKind;
  id: string;
  machine: string | null;
  body: Record<string, unknown>;
}

export interface RecordsRefusal {
  path: string;
  reason: string;
}

export interface RecordsStaging {
  staged: number;
  written: number;
  refused: RecordsRefusal[];
}

export interface RecordsMerge {
  opened: number;
  merged: number;
  rejected: string[];
  unopened: string[];
}

export interface RecordsOptions {
  // The refusal of the team sync for a text that looks like a credential.
  secretShape?: (text: string) => string | null;
  // The write arbiter of the server; the writes run in order through it.
  enqueue?: <T>(work: () => Promise<T>) => Promise<T>;
  now?: () => number;
}

// The key of a project as the records name it: the key of its remote when
// it has one, null for a project without one (its records still travel,
// under the path of the machine that wrote them).
export function projectKeyOf(projectPath: string | null | undefined): string | null {
  if (!projectPath) return null;
  try {
    const identity = projectIdentity(projectPath);
    return identity.kind === 'remote' ? identity.key : null;
  } catch {
    return null;
  }
}

// One id for the same working memory key of the same repository on every
// machine, so the entry merges instead of doubling.
export function workingMemoryRecordId(projectKey: string | null, projectPath: string, key: string): string {
  return crypto.createHash('sha256').update(`${projectKey ?? projectPath}\0${key}`).digest('hex').slice(0, 32);
}

export function newRecordId(): string {
  return crypto.randomBytes(16).toString('hex');
}

// The name of this machine as the other machines see it, written into each
// record at its birth; null when the identity cannot be read or created.
export function machineLabel(): string | null {
  try {
    return loadOrCreateMachine().label;
  } catch {
    return null;
  }
}

interface LessonRow { id: string; content: string; context: string; confidence: number; last_reinforced: string | null; last_recalled: string | null; created_at: string; tags: string | null; archived: number; project_path: string | null; project_key: string | null; author: string | null; machine_label: string | null }
interface DecisionRow { record_id: string; context: string | null; decision: string | null; timestamp: string; project_path: string | null; project_key: string | null; machine_label: string | null }
interface WorkingMemoryRow { project_path: string; project_key: string | null; key: string; value: string; expires_at: number; machine_label: string | null }

// Every record this machine holds, the way it travels; a record that came
// from another machine keeps that machine's name.
export async function collectRecords(db: Database, machine: string, now: number = Date.now()): Promise<SyncRecord[]> {
  const records: SyncRecord[] = [];
  const lessons = await db.all<LessonRow[]>('SELECT id, content, context, confidence, last_reinforced, last_recalled, created_at, tags, archived, project_path, project_key, author, machine_label FROM lessons');
  for (const row of lessons) {
    records.push({ kind: 'lesson', id: row.id, machine: row.machine_label ?? machine, body: { content: row.content, context: row.context, confidence: row.confidence, lastReinforced: row.last_reinforced, lastRecalled: row.last_recalled, createdAt: row.created_at, tags: row.tags, archived: row.archived === 1, author: row.author, projectPath: row.project_path, projectKey: row.project_key } });
  }
  const decisions = await db.all<DecisionRow[]>('SELECT record_id, context, decision, timestamp, project_path, project_key, machine_label FROM decisions WHERE record_id IS NOT NULL');
  for (const row of decisions) {
    records.push({ kind: 'decision', id: row.record_id, machine: row.machine_label ?? machine, body: { context: row.context, decision: row.decision, timestamp: row.timestamp, projectPath: row.project_path, projectKey: row.project_key } });
  }
  // The working memory keeps its expiry in seconds since the epoch.
  const working = await db.all<WorkingMemoryRow[]>('SELECT project_path, project_key, key, value, expires_at, machine_label FROM working_memory WHERE expires_at > ?', [Math.floor(now / 1000)]);
  for (const row of working) {
    records.push({ kind: 'working-memory', id: workingMemoryRecordId(row.project_key, row.project_path, row.key), machine: row.machine_label ?? machine, body: { projectPath: row.project_path, projectKey: row.project_key, key: row.key, value: row.value, expiresAt: row.expires_at } });
  }
  return records.filter(record => RECORD_ID_RE.test(record.id));
}

function recordPath(record: Pick<SyncRecord, 'kind' | 'id'>): string {
  return `${record.kind}/${record.id}.json`;
}

function alreadySealed(target: string, plaintext: string, teamKey: Buffer, relativePath: string): boolean {
  try {
    if (!fs.lstatSync(target).isFile()) return false;
    return openEnvelope(fs.readFileSync(target, 'utf8'), teamKey, relativePath) === plaintext;
  } catch {
    return false;
  }
}

// The records sealed into the sync tree, one file each; a file already
// holding the same record is left as it is, so a sync with nothing new
// writes nothing.
export function stageRecords(records: readonly SyncRecord[], recordsDir: string, teamKey: Buffer, options: RecordsOptions = {}): RecordsStaging {
  const outcome: RecordsStaging = { staged: 0, written: 0, refused: [] };
  for (const record of records) {
    const relativePath = recordPath(record);
    const plaintext = JSON.stringify(record);
    const shape = options.secretShape?.(plaintext) ?? null;
    if (shape) {
      outcome.refused.push({ path: relativePath, reason: `holds what looks like ${shape}` });
      continue;
    }
    const bytes = Buffer.byteLength(plaintext, 'utf8');
    if (bytes > MAX_RECORD_BYTES) {
      outcome.refused.push({ path: relativePath, reason: `is ${bytes} bytes, above the ${MAX_RECORD_BYTES} bytes one record may carry` });
      continue;
    }
    const target = path.join(recordsDir, record.kind, `${record.id}.json`);
    if (!alreadySealed(target, plaintext, teamKey, relativePath)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, sealEnvelope(plaintext, teamKey, relativePath), 'utf8');
      outcome.written += 1;
    }
    outcome.staged += 1;
  }
  return outcome;
}

function cleanRecord(value: unknown, kind: RecordKind, id: string): SyncRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<SyncRecord>;
  if (record.kind !== kind || record.id !== id || !record.body || typeof record.body !== 'object') return null;
  return { kind, id, machine: typeof record.machine === 'string' ? record.machine.slice(0, 80) : null, body: record.body as Record<string, unknown> };
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

async function mergeLesson(db: Database, record: SyncRecord): Promise<boolean> {
  const body = record.body;
  const content = text(body.content);
  const context = text(body.context);
  const createdAt = text(body.createdAt);
  if (!content || !context || !createdAt) return false;
  await db.run(
    `INSERT INTO lessons (id, content, context, confidence, last_reinforced, last_recalled, created_at, tags, archived, project_path, project_key, author, machine_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       confidence = MAX(lessons.confidence, excluded.confidence),
       last_reinforced = NULLIF(MAX(COALESCE(lessons.last_reinforced, ''), COALESCE(excluded.last_reinforced, '')), ''),
       last_recalled = NULLIF(MAX(COALESCE(lessons.last_recalled, ''), COALESCE(excluded.last_recalled, '')), ''),
       archived = MIN(lessons.archived, excluded.archived),
       tags = COALESCE(lessons.tags, excluded.tags),
       project_key = COALESCE(lessons.project_key, excluded.project_key),
       machine_label = COALESCE(lessons.machine_label, excluded.machine_label)`,
    [record.id, content, context, number(body.confidence) ?? 0.7, text(body.lastReinforced), text(body.lastRecalled), createdAt, text(body.tags), body.archived === true ? 1 : 0, text(body.projectPath), text(body.projectKey), text(body.author), record.machine]
  );
  return true;
}

async function mergeDecision(db: Database, record: SyncRecord): Promise<boolean> {
  const body = record.body;
  const timestamp = text(body.timestamp);
  if (!timestamp || (!text(body.decision) && !text(body.context))) return false;
  await db.run(
    'INSERT INTO decisions (record_id, context, decision, timestamp, project_path, project_key, machine_label) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(record_id) DO NOTHING',
    [record.id, text(body.context), text(body.decision), timestamp, text(body.projectPath), text(body.projectKey), record.machine]
  );
  return true;
}

async function mergeWorkingMemory(db: Database, record: SyncRecord, now: number): Promise<boolean> {
  const body = record.body;
  const projectPath = text(body.projectPath);
  const key = text(body.key);
  const value = text(body.value);
  const expiresAt = number(body.expiresAt);
  if (!projectPath || !key || value === null || expiresAt === null) return false;
  // Expired on the way: it never comes back (the expiry is in seconds).
  if (expiresAt <= Math.floor(now / 1000)) return false;
  await db.run(
    `INSERT INTO working_memory (id, project_path, project_key, key, value, expires_at, machine_label) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_path, key) DO UPDATE SET
       value = excluded.value, expires_at = excluded.expires_at, project_key = excluded.project_key, machine_label = excluded.machine_label
     WHERE excluded.expires_at > working_memory.expires_at`,
    [record.id, projectPath, text(body.projectKey), key, value, expiresAt, record.machine]
  );
  return true;
}

interface RecordEntry { kind: RecordKind; dir: string; name: string; relativePath: string }

// The files of the records tree, kind by kind; anything that is not a
// regular file is reported, never followed.
function listRecordEntries(recordsDir: string): { entries: RecordEntry[]; rejected: string[] } {
  const entries: RecordEntry[] = [];
  const rejected: string[] = [];
  for (const kind of RECORD_KINDS) {
    const dir = path.join(recordsDir, kind);
    let found: fs.Dirent[];
    try {
      found = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      found = [];
    }
    for (const entry of found) {
      const relativePath = `${kind}/${entry.name}`;
      if (!entry.isFile()) rejected.push(relativePath);
      else if (entry.name.endsWith('.json')) entries.push({ kind, dir, name: entry.name, relativePath });
    }
  }
  return { entries, rejected };
}

type OpenedRecord = { record: SyncRecord } | { rejected: string } | { unopened: string };

// One file of the tree opened with the team key and read as the record its
// path names; a file that does not open, or opens to something else, is told apart.
function openRecord(entry: RecordEntry, teamKey: Buffer): OpenedRecord {
  const id = entry.name.slice(0, -'.json'.length);
  if (!RECORD_ID_RE.test(id)) return { rejected: entry.relativePath };
  let plaintext: string | null;
  try {
    plaintext = openEnvelope(fs.readFileSync(path.join(entry.dir, entry.name), 'utf8'), teamKey, entry.relativePath);
  } catch {
    plaintext = null;
  }
  if (plaintext === null) return { unopened: entry.relativePath };
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { rejected: entry.relativePath };
  }
  const record = cleanRecord(parsed, entry.kind, id);
  return record ? { record } : { rejected: entry.relativePath };
}

// The records of the sync tree, merged into the memory of this machine by
// id. A file that does not open with the team key, or opens to something
// that is not the record its path names, is reported and left alone. The
// writes go through the arbiter of the server, in order.
export async function mergeRecords(db: Database, recordsDir: string, teamKey: Buffer, options: RecordsOptions = {}): Promise<RecordsMerge> {
  const now = options.now?.() ?? Date.now();
  const enqueue = options.enqueue ?? (<T>(work: () => Promise<T>): Promise<T> => work());
  const listed = listRecordEntries(recordsDir);
  const outcome: RecordsMerge = { opened: 0, merged: 0, rejected: [...listed.rejected], unopened: [] };
  await Promise.all(listed.entries.map(entry => openRecord(entry, teamKey)).map(async opened => {
    if ('unopened' in opened) {
      outcome.unopened.push(opened.unopened);
      return;
    }
    if ('rejected' in opened) {
      outcome.rejected.push(opened.rejected);
      return;
    }
    outcome.opened += 1;
    const written = await enqueue(() => mergeOne(db, opened.record, now));
    if (written) outcome.merged += 1;
    else outcome.rejected.push(recordPath(opened.record));
  }));
  return outcome;
}

function mergeOne(db: Database, record: SyncRecord, now: number): Promise<boolean> {
  if (record.kind === 'lesson') return mergeLesson(db, record);
  if (record.kind === 'decision') return mergeDecision(db, record);
  return mergeWorkingMemory(db, record, now);
}
