import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Database } from 'sqlite';

import { projectIdentity } from '../branch-state';
import { loadOrCreateMachine } from '../relay/machine';
import { openEnvelope, sealEnvelope } from './envelope';

// The memory that is not a state document, carried by the team sync as one
// sealed record per row: the lessons, the decisions of the history and the
// working memory. Each record sits under records/<kind>/<id>.json in the
// team repository, signed over its path within that tree (<kind>/<id>.json)
// as a state document is over its own, and merges by id on the other
// machine: a lesson reinforced on two machines keeps the higher confidence
// and the later dates, a decision is written once, a working memory entry
// is taken only when written later and never once expired. Every record
// names the machine it was written on, and the project by the key of its
// remote, so the same repository under two folders meets.
export type RecordKind = 'lesson' | 'decision' | 'working-memory';
export const RECORD_KINDS: readonly RecordKind[] = ['lesson', 'decision', 'working-memory'];
export const RECORDS_DIR = 'records';
export const MAX_RECORD_BYTES = 64 * 1024;
// A sealed record is its text in base64 inside the envelope; a file in the
// tree past this size is not even opened.
const MAX_SEALED_RECORD_BYTES = MAX_RECORD_BYTES * 2;
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
  // The files of expired records that left the tree.
  removed: number;
  refused: RecordsRefusal[];
}

export interface RecordsMerge {
  opened: number;
  merged: number;
  // Records opened and left as they were: already here, or no later than
  // the row they met.
  unchanged: number;
  // Verified records of working memory found expired: ignored, and removed
  // from the tree by the staging that follows.
  expired: string[];
  rejected: string[];
  unopened: string[];
}

// The bytes one push may carry and what this push holds already, shared
// with the state documents staged for the same push.
export interface PushBudget { pushBytes: number; ledger: { stagedBytes: number } }

export interface RecordsOptions {
  // The refusal of the team sync for a text that looks like a credential.
  secretShape?: (text: string) => string | null;
  // The write arbiter of the server; the writes run in order through it.
  enqueue?: <T>(work: () => Promise<T>) => Promise<T>;
  now?: () => number;
  // The directory every record path must stay within, with no link on the
  // way; the parent of the records directory when not given.
  root?: string;
  push?: PushBudget;
  // The paths the merge before this staging found expired, verified: their
  // files leave the tree.
  expired?: readonly string[];
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

export interface WorkingMemoryWrite {
  projectPath: string;
  projectKey: string | null;
  key: string;
  value: string;
  // Both in seconds since the epoch.
  expiresAt: number;
  updatedAt: number;
  machine: string | null;
}

// The rows of one project: the ones under this path, and the ones another
// machine wrote for the same repository under its own path. Two parameters,
// the key of the project and then its path.
export const SAME_PROJECT_SQL = '((project_key IS NOT NULL AND project_key = ?) OR project_path = ?)';

// One row per key for a repository, whatever the folder: a write lands on
// the row the repository has here already, under the folder it was first
// written under, or opens a new one. A write of this machine names the
// repository its path belongs to now. A record from another machine
// (remote) comes only when written later than the row (a row written before
// the write time existed, 0, yields) and leaves the key of the row when it
// carries none. False when the row was left as it was.
export async function upsertWorkingMemory(db: Database, entry: WorkingMemoryWrite, remote: boolean): Promise<boolean> {
  const local = await db.get<{ project_path: string; updated_at: number }>(
    `SELECT project_path, updated_at FROM working_memory WHERE key = ? AND ${SAME_PROJECT_SQL} ORDER BY updated_at DESC, expires_at DESC LIMIT 1`,
    [entry.key, entry.projectKey, entry.projectPath]
  );
  if (!local) {
    await db.run(
      'INSERT INTO working_memory (id, project_path, project_key, key, value, expires_at, machine_label, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), entry.projectPath, entry.projectKey, entry.key, entry.value, entry.expiresAt, entry.machine, entry.updatedAt]
    );
    return true;
  }
  if (remote && entry.updatedAt <= local.updated_at) return false;
  const projectKey = remote ? 'COALESCE(?, project_key)' : '?';
  await db.run(
    `UPDATE working_memory SET value = ?, expires_at = ?, project_key = ${projectKey}, machine_label = ?, updated_at = ? WHERE project_path = ? AND key = ?`,
    [entry.value, entry.expiresAt, entry.projectKey, entry.machine, entry.updatedAt, local.project_path, entry.key]
  );
  return true;
}

interface LessonRow { id: string; content: string; context: string; confidence: number; last_reinforced: string | null; last_recalled: string | null; created_at: string; tags: string | null; archived: number; project_path: string | null; project_key: string | null; author: string | null; machine_label: string | null }
interface DecisionRow { record_id: string; context: string | null; decision: string | null; timestamp: string; project_path: string | null; project_key: string | null; machine_label: string | null }
interface WorkingMemoryRow { project_path: string; project_key: string | null; key: string; value: string; expires_at: number; machine_label: string | null; updated_at: number }

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
  // The working memory keeps its expiry and its write time in seconds since
  // the epoch; the same key of one repository under two folders travels
  // once, by its latest write.
  const working = await db.all<WorkingMemoryRow[]>('SELECT project_path, project_key, key, value, expires_at, machine_label, updated_at FROM working_memory WHERE expires_at > ? ORDER BY updated_at DESC, expires_at DESC', [Math.floor(now / 1000)]);
  const seen = new Set<string>();
  for (const row of working) {
    const id = workingMemoryRecordId(row.project_key, row.project_path, row.key);
    if (seen.has(id)) continue;
    seen.add(id);
    records.push({ kind: 'working-memory', id, machine: row.machine_label ?? machine, body: { projectPath: row.project_path, projectKey: row.project_key, key: row.key, value: row.value, expiresAt: row.expires_at, updatedAt: row.updated_at } });
  }
  return records.filter(record => RECORD_ID_RE.test(record.id));
}

function recordPath(record: Pick<SyncRecord, 'kind' | 'id'>): string {
  return `${record.kind}/${record.id}.json`;
}

function isLink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

// The first link between `root` (exclusive) and `target` (inclusive), or
// the target itself when it does not sit under the root: a read or a write
// there would land elsewhere, so the sync never goes there.
function linkOnTheWay(target: string, root: string): string | null {
  const top = path.resolve(root);
  let probe = path.resolve(target);
  if (probe === top || !probe.startsWith(top + path.sep)) return probe;
  const components: string[] = [];
  while (probe !== top) {
    components.unshift(probe);
    probe = path.dirname(probe);
  }
  return components.find(isLink) ?? null;
}

// What the sync tree holds at the path of a record: nothing, the very same
// record, another text, an envelope that does not open with the team key
// (never written over), or something that is not a regular file.
type SealedState = 'absent' | 'same' | 'different' | 'unopened' | 'not-a-file';

function sealedState(target: string, plaintext: string, teamKey: Buffer, relativePath: string): SealedState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return 'absent';
  }
  if (!stat.isFile()) return 'not-a-file';
  // A file past the size a sealed record may have is not read: whatever it
  // is, it is not this record, and the record written over it is within the cap.
  if (stat.size > MAX_SEALED_RECORD_BYTES) return 'different';
  try {
    const opened = openEnvelope(fs.readFileSync(target, 'utf8'), teamKey, relativePath);
    if (opened === null) return 'unopened';
    return opened === plaintext ? 'same' : 'different';
  } catch {
    return 'unopened';
  }
}

interface StageContext { recordsDir: string; root: string; teamKey: Buffer; options: RecordsOptions }
type StageOutcome = { refusal: string } | { written: boolean };

// Why a record may not leave: a secret shape in it, a size above the cap of
// one record, or a link on its way in the tree. Null when it may.
function refusalBeforeSealing(plaintext: string, target: string, context: StageContext): string | null {
  const shape = context.options.secretShape?.(plaintext) ?? null;
  if (shape) return `holds what looks like ${shape}`;
  const bytes = Buffer.byteLength(plaintext, 'utf8');
  if (bytes > MAX_RECORD_BYTES) return `is ${bytes} bytes, above the ${MAX_RECORD_BYTES} bytes one record may carry`;
  const link = linkOnTheWay(target, context.root);
  if (link) return `sits behind a link (${path.basename(link)}), which the sync never follows`;
  return null;
}

// One record into the tree: left as it is when the file there holds it
// already, written when the file is absent or holds another text, refused
// when the file there does not open, is not a regular file, or would take
// the push past its cap.
function stageOne(record: SyncRecord, context: StageContext): StageOutcome {
  const relativePath = recordPath(record);
  const plaintext = JSON.stringify(record);
  const target = path.join(context.recordsDir, record.kind, `${record.id}.json`);
  const refusal = refusalBeforeSealing(plaintext, target, context);
  if (refusal) return { refusal };
  const state = sealedState(target, plaintext, context.teamKey, relativePath);
  if (state === 'same') return { written: false };
  if (state === 'unopened') return { refusal: 'has an envelope in the sync tree already that does not open with the team key, left as it is' };
  if (state === 'not-a-file') return { refusal: 'is not a regular file in the sync tree' };
  const bytes = Buffer.byteLength(plaintext, 'utf8');
  const push = context.options.push;
  if (push && push.ledger.stagedBytes + bytes > push.pushBytes) return { refusal: `would take this push past the ${push.pushBytes} bytes one push may carry` };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, sealEnvelope(plaintext, context.teamKey, relativePath), 'utf8');
  if (push) push.ledger.stagedBytes += bytes;
  return { written: true };
}

// The files of verified records the merge found expired: they leave the
// tree before the records of this machine are sealed, and never at a path a
// live record of this machine is about to take; the push carries the
// removal. A file that will not go now goes with the next sync.
function removeExpired(paths: readonly string[], live: ReadonlySet<string>, context: StageContext): number {
  let removed = 0;
  for (const relativePath of paths) {
    const target = path.join(context.recordsDir, relativePath);
    if (live.has(relativePath) || linkOnTheWay(target, context.root) || !isRegularFile(target)) continue;
    try {
      fs.unlinkSync(target);
      removed += 1;
    } catch {
      // Left in the tree for the next sync.
    }
  }
  return removed;
}

// The records sealed into the sync tree, one file each; a file already
// holding the same record is left as it is, so a sync with nothing new
// writes nothing.
export function stageRecords(records: readonly SyncRecord[], recordsDir: string, teamKey: Buffer, options: RecordsOptions = {}): RecordsStaging {
  const context: StageContext = { recordsDir, root: options.root ?? path.dirname(recordsDir), teamKey, options };
  const outcome: RecordsStaging = { staged: 0, written: 0, removed: 0, refused: [] };
  outcome.removed = removeExpired(options.expired ?? [], new Set(records.map(recordPath)), context);
  for (const record of records) {
    const staged = stageOne(record, context);
    if ('refusal' in staged) {
      outcome.refused.push({ path: recordPath(record), reason: staged.refusal });
      continue;
    }
    outcome.staged += 1;
    if (staged.written) outcome.written += 1;
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

// What became of one record: written, left as it was (here already, or no
// later than the row it met), expired on the way, or no record at all.
type MergeOutcome = 'merged' | 'unchanged' | 'expired' | 'rejected';

async function mergeDecision(db: Database, record: SyncRecord): Promise<MergeOutcome> {
  const body = record.body;
  const timestamp = text(body.timestamp);
  if (!timestamp || (!text(body.decision) && !text(body.context))) return 'rejected';
  const result = await db.run(
    'INSERT INTO decisions (record_id, context, decision, timestamp, project_path, project_key, machine_label) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(record_id) DO NOTHING',
    [record.id, text(body.context), text(body.decision), timestamp, text(body.projectPath), text(body.projectKey), record.machine]
  );
  return (result.changes ?? 0) > 0 ? 'merged' : 'unchanged';
}

async function mergeWorkingMemory(db: Database, record: SyncRecord, now: number): Promise<MergeOutcome> {
  const body = record.body;
  const projectPath = text(body.projectPath);
  const key = text(body.key);
  const value = text(body.value);
  const expiresAt = number(body.expiresAt);
  if (!projectPath || !key || value === null || expiresAt === null) return 'rejected';
  // Expired on the way: it never comes back (the expiry is in seconds).
  if (expiresAt <= Math.floor(now / 1000)) return 'expired';
  // Onto the row this repository has here, whatever its folder, and only
  // when written later than it.
  const written = await upsertWorkingMemory(db, { projectPath, projectKey: text(body.projectKey), key, value, expiresAt, updatedAt: number(body.updatedAt) ?? 0, machine: record.machine }, true);
  return written ? 'merged' : 'unchanged';
}

interface RecordEntry { kind: RecordKind; dir: string; name: string; relativePath: string }

// The files of the records tree, kind by kind; a directory behind a link,
// and anything that is not a regular file, is reported, never followed.
function listRecordEntries(recordsDir: string, root: string): { entries: RecordEntry[]; rejected: string[] } {
  const entries: RecordEntry[] = [];
  const rejected: string[] = [];
  for (const kind of RECORD_KINDS) {
    const dir = path.join(recordsDir, kind);
    if (linkOnTheWay(dir, root)) {
      rejected.push(`${kind}/`);
      continue;
    }
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
// The text of one file of the tree, opened with the team key; null when the
// file does not open. A file past the size a sealed record may have is not
// read at all, and a text past the cap of one record is no record.
function openSealedText(file: string, teamKey: Buffer, relativePath: string): string | null {
  try {
    if (fs.lstatSync(file).size > MAX_SEALED_RECORD_BYTES) return null;
    const opened = openEnvelope(fs.readFileSync(file, 'utf8'), teamKey, relativePath);
    return opened !== null && Buffer.byteLength(opened, 'utf8') <= MAX_RECORD_BYTES ? opened : null;
  } catch {
    return null;
  }
}

function openRecord(entry: RecordEntry, teamKey: Buffer): OpenedRecord {
  const id = entry.name.slice(0, -'.json'.length);
  if (!RECORD_ID_RE.test(id)) return { rejected: entry.relativePath };
  const plaintext = openSealedText(path.join(entry.dir, entry.name), teamKey, entry.relativePath);
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
  const listed = listRecordEntries(recordsDir, options.root ?? path.dirname(recordsDir));
  const outcome: RecordsMerge = { opened: 0, merged: 0, unchanged: 0, expired: [], rejected: [...listed.rejected], unopened: [] };
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
    const merged = await enqueue(() => mergeOne(db, opened.record, now));
    if (merged === 'merged') outcome.merged += 1;
    else if (merged === 'unchanged') outcome.unchanged += 1;
    else if (merged === 'expired') outcome.expired.push(recordPath(opened.record));
    else outcome.rejected.push(recordPath(opened.record));
  }));
  return outcome;
}

async function mergeOne(db: Database, record: SyncRecord, now: number): Promise<MergeOutcome> {
  if (record.kind === 'lesson') return (await mergeLesson(db, record)) ? 'merged' : 'rejected';
  if (record.kind === 'decision') return mergeDecision(db, record);
  return mergeWorkingMemory(db, record, now);
}
