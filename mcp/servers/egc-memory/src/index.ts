#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createSearchIndex, rebuildSearchIndex, searchDecisions } from './search.js';
import { detectBranch, resolveStateRead, resolveStateWrite } from './branch-state';
import {
  createWorkingMemoryTable,
  sweepExpired,
  setWorkingMemory,
  getWorkingMemory,
  listWorkingMemory,
} from './working-memory';
import { detectPatternsFromEvents, patternToStoreEntry } from './patterns.js';

// Mirrors DEFAULT_STATE_STORE_RELATIVE_PATH from scripts/lib/state-store/index.js
const STATE_STORE_RELATIVE_PATH = path.join('.gemini', 'egc', 'state.db');

function resolveStateStoreDbPath(): string {
  const envOverride = process.env.EGC_STATE_DB;
  if (envOverride) {
    return path.resolve(envOverride);
  }
  const homeDir = process.env.HOME || os.homedir();
  return path.join(homeDir, STATE_STORE_RELATIVE_PATH);
}

function hideEgcRootOnWindows(): void {
  if (process.platform !== 'win32') return;
  const egcRoot = path.join(os.homedir(), '.egc');
  try {
    execSync(`attrib +h "${egcRoot}"`, { stdio: 'ignore' });
  } catch (_) {
    // non-critical: folder works even if attribute fails
  }
}

class PersistentLogger {
  private logPath: string;
  private maxSizeBytes = 5 * 1024 * 1024; // 5MB

  constructor(serviceName: string) {
    const logDir = path.join(os.homedir(), '.egc', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    hideEgcRootOnWindows();
    this.logPath = path.join(logDir, `${serviceName}.log`);
  }

  log(level: 'INFO'|'WARN'|'ERROR'|'AUDIT'|'DEBUG', msg: string, meta: Record<string, unknown> = {}) {
    const payload = JSON.stringify({ timestamp: new Date().toISOString(), level, msg, ...meta });
    // STDERR used to prevent JSON-RPC corruption on STDOUT
    console.error(payload);
    
    try {
      if (fs.existsSync(this.logPath)) {
        const stats = fs.statSync(this.logPath);
        if (stats.size > this.maxSizeBytes) {
           fs.renameSync(this.logPath, `${this.logPath}.${Date.now()}.bak`);
        }
      }
      fs.appendFileSync(this.logPath, payload + '\n', 'utf-8');
    } catch(e) {
      // Safe fail to avoid runtime crash if disk full
    }
  }
}

const sysLogger = new PersistentLogger('egc-memory-orchestrator');

function log(level: 'INFO'|'WARN'|'ERROR'|'AUDIT'|'DEBUG', msg: string, meta: Record<string, unknown> = {}) {
  sysLogger.log(level, msg, meta);
}

let dbInstance: Database | null = null;
let searchIndexReady = false;

// ============================================================================
// SQLite Arbitration & Message Queue (Cross-Runtime Synchronization)
// Orchestrates shared memory writes with exponential backoff to prevent IDE crashes
// ============================================================================
interface QueueTask<T> {
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  retries: number;
}

class SQLiteArbitrationQueue {
  private queue: QueueTask<unknown>[] = [];
  private isProcessing = false;
  private readonly MAX_RETRIES = 5;
  private readonly BASE_BACKOFF_MS = 50;
  private readonly MAX_BACKOFF_MS = 5000;

  async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, resolve, reject, retries: 0 });
      this.processNext();
    });
  }

  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const task = this.queue.shift();
    if (!task) {
      this.isProcessing = false;
      return;
    }

    try {
      const result = await task.operation();
      task.resolve(result);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.message && (error.message.includes('SQLITE_BUSY') || error.message.includes('database is locked'))) {
        if (task.retries < this.MAX_RETRIES) {
          task.retries++;
          let backoff = Math.pow(2, task.retries) * this.BASE_BACKOFF_MS;
          if (backoff > this.MAX_BACKOFF_MS) backoff = this.MAX_BACKOFF_MS;
          log('WARN', `Write Collision Detected (SQLITE_BUSY). Arbitration retrying...`, {
            queue_depth: this.queue.length,
            retry_count: task.retries,
            backoff_ms: backoff
          });

          setTimeout(() => {
            this.queue.push(task); // Requeue at the end instead of unshift to prevent queue poisoning
            this.processNext();
          }, backoff);

          this.isProcessing = false;
          return;
        } else {
          log('ERROR', `Arbitration Failed. Write lock unrecoverable. Dead-lettering task.`, { retries: task.retries });
          task.reject(new Error(`Arbitration Failed after ${this.MAX_RETRIES} retries: ` + error.message));
        }
      } else {
        task.reject(err);
      }
    }

    this.isProcessing = false;
    this.processNext();
  }
}

const writeArbitrator = new SQLiteArbitrationQueue();

// ============================================================================
// Boot & Migrations
// ============================================================================
async function runMigrations(db: Database, dbDir: string) {
  const lockFile = path.join(dbDir, 'migration.lock');

  // Remove stale lock from a previous crashed process
  if (fs.existsSync(lockFile)) {
    try {
      const storedPid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
      if (!isNaN(storedPid) && storedPid !== process.pid) {
        // Check if the PID is still alive (POSIX: signal 0 = probe only)
        let alive = false;
        try { process.kill(storedPid, 0); alive = true; } catch (_) {}
        if (!alive) fs.unlinkSync(lockFile);
      }
    } catch (_) {}
  }

  let locked = false;
  let retries = 50;
  while (!locked && retries > 0) {
    try {
      fs.writeFileSync(lockFile, process.pid.toString(), { flag: 'wx' });
      locked = true;
    } catch (e) {
      retries--;
      await new Promise(r => setTimeout(r, 100));
    }
  }

  if (!locked) throw new Error('Timeout acquiring migration lock');

  try {
    log('INFO', 'Running SQLite migrations');
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
      CREATE TABLE IF NOT EXISTS operational_state (id TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context TEXT, decision TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
    `);

    // Migration 2: FTS5 index over decisions for BM25 keyword search.
    // Triggers keep the index in sync incrementally on every write; the
    // one-time rebuild backfills rows stored before this migration existed.
    const hasV2 = await db.get('SELECT version FROM schema_migrations WHERE version = 2');
    try {
      if (!hasV2) {
        await createSearchIndex(db);
        await rebuildSearchIndex(db);
        await db.run('INSERT INTO schema_migrations (version) VALUES (2)');
      }
      searchIndexReady = true;
    } catch (e) {
      // SQLite builds without FTS5 keep working; only search_history is disabled.
      searchIndexReady = false;
      log('WARN', 'FTS5 unavailable, search_history disabled', { error: String(e) });
    }

    // Migration 3: working_memory table for transient, TTL-bounded entries.
    const hasV3 = await db.get('SELECT version FROM schema_migrations WHERE version = 3');
    if (!hasV3) {
      await createWorkingMemoryTable(db);
      await db.run('INSERT INTO schema_migrations (version) VALUES (3)');
    }

    // Migration 4: lessons table with confidence decay support.
    const hasV4 = await db.get('SELECT version FROM schema_migrations WHERE version = 4');
    if (!hasV4) {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS lessons (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          context TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.7,
          last_reinforced TEXT,
          last_recalled TEXT,
          created_at TEXT NOT NULL,
          tags TEXT,
          archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_lessons_confidence_created_at
          ON lessons (confidence DESC, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_lessons_archived_confidence
          ON lessons (archived, confidence DESC);
      `);
      await db.run('INSERT INTO schema_migrations (version) VALUES (4)');
    }
  } finally {
    try { fs.unlinkSync(lockFile); } catch(e) {}
  }
}

async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;
  const dbDir = path.join(os.homedir(), '.egc', 'memory');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  hideEgcRootOnWindows();
  
  const dbPath = path.join(dbDir, 'state.db');
  dbInstance = await open({ filename: dbPath, driver: sqlite3.Database });
  
  await dbInstance.exec('PRAGMA journal_mode = WAL;');
  await dbInstance.exec('PRAGMA synchronous = NORMAL;');
  await dbInstance.exec('PRAGMA foreign_keys = ON;');
  await dbInstance.exec('PRAGMA busy_timeout = 5000;'); // Native fallback
  
  await runMigrations(dbInstance, dbDir);
  return dbInstance;
}

const server = new Server({ name: "egc-memory-orchestrator", version: "3.0.0" }, { capabilities: { tools: {} } });

function getStateDir(): string {
  const dir = path.join(os.homedir(), '.egc', 'state');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  hideEgcRootOnWindows();
  return dir;
}

function resolveProjectPath(provided?: string): string {
  return provided || process.env.EGC_PROJECT || process.env.PWD || os.homedir();
}

function readStateDoc(filePath: string): Record<string, string[]|string> {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf-8');
  const result: Record<string, string[]|string> = {};
  let currentSection = '';
  for (const line of content.split('\n')) {
    const h2 = line.match(/^## (.+)/);
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

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

const LESSON_REINFORCE_DELTA = 0.15;
const LESSON_DECAY_DELTA_PER_WEEK = 0.05;
const LESSON_DECAY_GRACE_DAYS = 30;
const LESSON_ARCHIVE_THRESHOLD = 0.2;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface LessonRow {
  id: string;
  content: string;
  context: string;
  confidence: number;
  last_reinforced: string | null;
  last_recalled: string | null;
  created_at: string;
  tags: string | null;
  archived: number;
}

function mapLessonRow(row: LessonRow) {
  return {
    id: row.id,
    content: row.content,
    context: row.context,
    confidence: row.confidence,
    lastReinforced: row.last_reinforced ?? null,
    lastRecalled: row.last_recalled ?? null,
    createdAt: row.created_at,
    tags: row.tags ?? null,
    archived: row.archived === 1,
  };
}

function computeLessonDecay(confidence: number, lastRecalledIso: string | null, createdAtIso: string, nowMs: number): number {
  const referenceMs = lastRecalledIso
    ? new Date(lastRecalledIso).getTime()
    : new Date(createdAtIso).getTime();
  const elapsedMs = nowMs - referenceMs;
  const gracePeriodMs = LESSON_DECAY_GRACE_DAYS * MS_PER_DAY;
  if (elapsedMs <= gracePeriodMs) {
    return confidence;
  }
  const weeksOverGrace = Math.floor((elapsedMs - gracePeriodMs) / MS_PER_WEEK);
  return Math.max(0, confidence - weeksOverGrace * LESSON_DECAY_DELTA_PER_WEEK);
}

function generateLessonId(): string {
  return `lesson-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

async function runLessonDecaySweep(db: Database): Promise<number> {
  const now = Date.now();
  const rows = await db.all<LessonRow[]>('SELECT * FROM lessons WHERE archived = 0');
  let affected = 0;
  for (const row of rows) {
    const decayed = computeLessonDecay(row.confidence, row.last_reinforced, row.created_at, now);
    if (decayed === row.confidence) {
      continue;
    }
    const archived = decayed < LESSON_ARCHIVE_THRESHOLD ? 1 : 0;
    await db.run('UPDATE lessons SET confidence = ?, archived = ? WHERE id = ?', [decayed, archived, row.id]);
    affected++;
  }
  return affected;
}

const StoreDecisionSchema = z.object({
  context: z.string().min(1).max(5000),
  decision: z.string().min(1).max(10000)
});

const SearchHistorySchema = z.object({
  query: z.string().min(1).max(1000),
  limit: z.number().min(1).max(100).optional().default(10),
  min_score: z.number().min(0).max(1).optional().default(0)
});

const QueryHistorySchema = z.object({
  limit: z.number().min(1).max(100).optional().default(10),
  offset: z.number().min(0).optional().default(0)
});

const LessonSaveSchema = z.object({
  content: z.string().min(1).max(5000),
  context: z.string().min(1).max(2000),
  tags: z.string().max(500).optional(),
  initial_confidence: z.number().min(0).max(1).optional().default(0.7)
});

const LessonRecallSchema = z.object({
  query: z.string().min(1).max(1000),
  min_confidence: z.number().min(0).max(1).optional().default(0.2),
  limit: z.number().min(1).max(100).optional().default(10)
});

const LessonReinforceSchema = z.object({
  id: z.string().min(1)
});

const GetStateSchema = z.object({
  project_path: z.string().optional()
});

const UpdateStateSchema = z.object({
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
  next: z.array(z.string().max(500)).max(10).optional()
});

const WorkingMemorySetSchema = z.object({
  project_path: z.string().optional(),
  key: z.string().min(1).max(200),
  value: z.string().min(1).max(50000),
  ttl_seconds: z.number().int().min(1).optional()
});

const WorkingMemoryGetSchema = z.object({
  project_path: z.string().optional(),
  key: z.string().min(1).max(200)
});

const WorkingMemoryListSchema = z.object({
  project_path: z.string().optional()
});

const DetectPatternsSchema = z.object({
  window_days: z.number().min(1).max(365).optional().default(7),
  min_occurrences: z.number().min(2).max(1000).optional().default(3)
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      { name: "get_project_state", description: "Returns server health metadata for the active project: storage engine (sqlite-wal) and write arbitration mode (MessageQueue). Use this to verify the egc-memory server is running and responsive before calling get_state or update_state.", inputSchema: { type: "object", properties: {} } },
      { name: "store_decision", description: "Persist a single decision to the SQLite store with write-lock arbitration to prevent concurrent conflicts. Provide a short context label and the decision text. Decisions stored here are queryable via query_history and surfaced in get_state.", inputSchema: { type: "object", properties: { context: { type: "string", description: "Short label for the decision context, e.g. 'architecture' or 'dependencies'." }, decision: { type: "string", description: "The decision text to persist." } }, required: ["context", "decision"] } },
      { name: "query_history", description: "Return a paginated list of past decisions stored in the SQLite state. Each entry includes the decision text, context label, and timestamp. Use limit and offset for pagination. Useful for auditing what was decided without loading the full project state.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "Maximum number of decisions to return. Defaults to 20." }, offset: { type: "number", description: "Number of decisions to skip for pagination. Defaults to 0." } } } },
      { name: "search_history", description: "Keyword search over the decision history with BM25 relevance ranking (SQLite FTS5). Each result includes the decision content, context label, timestamp, and a score normalized to [0, 1] where 1 is the best match in the result set. Use this to find past decisions by topic instead of paging through query_history.", inputSchema: { type: "object", properties: { query: { type: "string", description: "Keywords to search for, e.g. 'authentication jwt'." }, limit: { type: "number", description: "Maximum number of results to return. Defaults to 10." }, min_score: { type: "number", description: "Minimum normalized relevance score between 0 and 1. Defaults to 0." } }, required: ["query"] } },
      {
        name: "get_state",
        description: "Returns the current project memory: decisions made, preferences established, things to avoid, and what to pick up next. State is scoped to the current git branch when the project is a git repository, falling back to the default branch state and then to the legacy flat state file. Call this at the START of every session to restore context.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute path to the project root. Defaults to current working directory." }
          }
        }
      },
      {
        name: "update_state",
        description: "Updates the project memory with decisions made this session. Writes to the state file of the current git branch when the project is a git repository. Call this at the END of every session. Merges with existing state and does not erase previous memory.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            context: { type: "string", description: "What this project is and its current phase." },
            decisions: { type: "array", items: { type: "object", properties: { what: { type: "string" }, why: { type: "string" } }, required: ["what"] }, description: "Decisions made this session." },
            avoid: { type: "array", items: { type: "object", properties: { what: { type: "string" }, why: { type: "string" } }, required: ["what"] }, description: "What failed and should not be repeated." },
            preferences: { type: "array", items: { type: "string" }, description: "Coding style, workflow, or communication preferences discovered." },
            next: { type: "array", items: { type: "string" }, description: "What to pick up in the next session." }
          }
        }
      },
      {
        name: "working_memory_set",
        description: "Store a transient key-value entry scoped to the current project. The entry expires automatically after ttl_seconds (default: end-of-session). Use this for debug flags, temporary task context, or any value that should not pollute long-term project state.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute path to the project root. Defaults to current working directory." },
            key: { type: "string", description: "Unique name for this transient entry, e.g. 'debug_flag' or 'active_config'." },
            value: { type: "string", description: "Value to store. Any string including JSON." },
            ttl_seconds: { type: "number", description: "How long the entry lives in seconds. Omit to use the session default (86400s)." }
          },
          required: ["key", "value"]
        }
      },
      {
        name: "working_memory_get",
        description: "Retrieve a single transient entry by key for the current project. Returns null if the entry does not exist or has expired.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute path to the project root. Defaults to current working directory." },
            key: { type: "string", description: "Key of the entry to retrieve." }
          },
          required: ["key"]
        }
      },
      {
        name: "working_memory_list",
        description: "List all live transient entries for the current project, ordered by key. Expired entries are excluded.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute path to the project root. Defaults to current working directory." }
          }
        }
      },
      {
        name: "lesson_save",
        description: "Persist a new lesson learned during this session. Lessons are stored with a confidence score and decay over time when not reinforced. Use this to record patterns, rules, or observations the AI should remember across sessions.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "The lesson text to store." },
            context: { type: "string", description: "Where this lesson applies, e.g. 'code review' or 'git workflow'." },
            tags: { type: "string", description: "Optional comma-separated tags for categorization." },
            initial_confidence: { type: "number", description: "Starting confidence score between 0 and 1. Defaults to 0.7." }
          },
          required: ["content", "context"]
        }
      },
      {
        name: "lesson_recall",
        description: "Search active lessons above a confidence threshold. Lessons below 0.2 confidence are archived and not returned by default. Returns lessons ranked by confidence score.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keyword or topic to filter lessons by content or context." },
            min_confidence: { type: "number", description: "Minimum confidence threshold, 0 to 1. Defaults to 0.2." },
            limit: { type: "number", description: "Maximum number of lessons to return. Defaults to 10." }
          },
          required: ["query"]
        }
      },
      {
        name: "lesson_reinforce",
        description: "Reinforce an existing lesson when the same pattern is observed again. Increases confidence by 0.15, capped at 1.0. Call this when a previously stored lesson proves relevant or a mistake is repeated.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "The lesson ID returned by lesson_save or lesson_recall." }
          },
          required: ["id"]
        }
      },
      {
        name: "detect_patterns",
        description: "Analyzes captured runtime events and surfaces recurring behaviors across sessions. Detects repeated commands and recurring errors using frequency analysis. Patterns are persisted to SQLite with frequency, last_seen, and suggested_automation fields. Returns patterns with type, description, occurrence count, and an actionable suggestion.",
        inputSchema: {
          type: "object",
          properties: {
            window_days: { type: "number", description: "Number of past days to analyze. Defaults to 7." },
            min_occurrences: { type: "number", description: "Minimum times a pattern must appear to be reported. Defaults to 3." }
          }
        }
      }
    ]
  };
});

async function handleLessonSave(db: Database, args: unknown) {
  const { content, context, tags, initial_confidence } = LessonSaveSchema.parse(args);
  const id = generateLessonId();
  const now = new Date().toISOString();
  await writeArbitrator.enqueue(async () => {
    await db.run(
      `INSERT INTO lessons (id, content, context, confidence, last_reinforced, last_recalled, created_at, tags, archived)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 0)`,
      [id, content, context, initial_confidence, now, tags ?? null]
    );
  });
  log('INFO', 'Lesson saved', { id, context });
  return { content: [{ type: "text", text: JSON.stringify({ id, content, context, confidence: initial_confidence, tags: tags ?? null, createdAt: now }, null, 2) }] };
}

async function handleLessonRecall(db: Database, args: unknown) {
  const { query, min_confidence, limit } = LessonRecallSchema.parse(args);
  const lowerQuery = query.toLowerCase();
  const rows = await db.all<LessonRow[]>(
    `SELECT * FROM lessons
     WHERE archived = 0 AND confidence >= ?
     ORDER BY confidence DESC, created_at DESC
     LIMIT ?`,
    [min_confidence, limit * 3]
  );
  const matched = rows
    .filter(r => r.content.toLowerCase().includes(lowerQuery) || r.context.toLowerCase().includes(lowerQuery) || (r.tags?.toLowerCase().includes(lowerQuery) ?? false))
    .slice(0, limit)
    .map(mapLessonRow);

  const now = new Date().toISOString();
  if (matched.length > 0) {
    await writeArbitrator.enqueue(async () => {
      for (const lesson of matched) {
        await db.run('UPDATE lessons SET last_recalled = ? WHERE id = ?', [now, lesson.id]);
      }
    });
  }

  log('INFO', 'Lessons recalled', { query, count: matched.length });
  return { content: [{ type: "text", text: JSON.stringify({ lessons: matched, meta: { query, min_confidence, limit, count: matched.length } }, null, 2) }] };
}

async function handleLessonReinforce(db: Database, args: unknown) {
  const { id } = LessonReinforceSchema.parse(args);
  const row = await db.get<LessonRow>('SELECT * FROM lessons WHERE id = ?', [id]);
  if (!row) {
    throw new McpError(ErrorCode.InvalidRequest, `Lesson not found: ${id}`);
  }
  const newConfidence = Math.min(1, row.confidence + LESSON_REINFORCE_DELTA);
  const now = new Date().toISOString();
  await writeArbitrator.enqueue(async () => {
    await db.run(
      'UPDATE lessons SET confidence = ?, last_reinforced = ?, archived = 0 WHERE id = ?',
      [newConfidence, now, id]
    );
  });
  const updated = await db.get<LessonRow>('SELECT * FROM lessons WHERE id = ?', [id]);
  log('INFO', 'Lesson reinforced', { id, confidence: newConfidence });
  return { content: [{ type: "text", text: JSON.stringify(updated ? mapLessonRow(updated) : { id, confidence: newConfidence }, null, 2) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const db = await getDb();
  try {
    switch (request.params.name) {
      case "store_decision": {
        const { context, decision } = StoreDecisionSchema.parse(request.params.arguments);
        
        // Execute write through the Queue Arbitrator to prevent IDE crash on SQLITE_BUSY
        await writeArbitrator.enqueue(async () => {
          await db.run('INSERT INTO decisions (context, decision) VALUES (?, ?)', [context, decision]);
        });
        
        log('INFO', 'Decision stored securely via Queue Arbitration');
        return { content: [{ type: "text", text: "Decision stored securely." }] };
      }
      case "query_history": {
        const { limit, offset } = QueryHistorySchema.parse(request.params.arguments || {});
        const rows = await db.all('SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ? OFFSET ?', [limit, offset]);
        return { content: [{ type: "text", text: JSON.stringify({ data: rows, meta: { limit, offset } }, null, 2) }] };
      }
      case "search_history": {
        const { query, limit, min_score } = SearchHistorySchema.parse(request.params.arguments);
        if (!searchIndexReady) {
          throw new McpError(ErrorCode.InvalidRequest, 'search_history is unavailable: this SQLite build has no FTS5 support.');
        }
        const results = await searchDecisions(db, query, { limit, minScore: min_score });
        log('INFO', 'Decision history searched', { results: results.length });
        return { content: [{ type: "text", text: JSON.stringify({ results, meta: { query, limit, min_score, count: results.length } }, null, 2) }] };
      }
      case "get_project_state": {
        return { content: [{ type: "text", text: JSON.stringify({ status: "active", engine: "sqlite-wal", arbitration: "MessageQueue" }) }] };
      }
      case "get_state": {
        const { project_path } = GetStateSchema.parse(request.params.arguments || {});
        const projPath = resolveProjectPath(project_path);
        const branch = detectBranch(projPath);
        const resolved = resolveStateRead(getStateDir(), projPath, branch);

        // Sweep expired working memory entries on every session start.
        const swept = await sweepExpired(db);
        if (swept > 0) {
          log('INFO', 'Swept expired working memory entries', { count: swept });
        }

        // Run confidence decay sweep on every get_state call.
        try {
          const affected = await runLessonDecaySweep(db);
          if (affected > 0) {
            log('INFO', 'Lesson decay sweep ran', { affected });
          }
        } catch (e) {
          log('WARN', 'Lesson decay sweep failed, continuing', { error: String(e) });
        }

        if (resolved.source === 'none') {
          const branchLine = branch ? `Branch: ${branch}\n` : '';
          return { content: [{ type: "text", text: `No state found for this project yet.\n${branchLine}Path: ${resolved.filePath}\n\nCall update_state at the end of this session to start building project memory.` }] };
        }

        const content = fs.readFileSync(resolved.filePath, 'utf-8');
        log('INFO', 'Project state retrieved', { project: projPath, branch: branch || 'none', source: resolved.source });
        return { content: [{ type: "text", text: content }] };
      }

      case "update_state": {
        const args = UpdateStateSchema.parse(request.params.arguments || {});
        const projPath = resolveProjectPath(args.project_path);
        const branch = detectBranch(projPath);
        // Merge from the same file get_state would read, so the first
        // branch-scoped write inherits the pre-existing flat state
        const resolved = resolveStateRead(getStateDir(), projPath, branch);
        const existing = readStateDoc(resolved.filePath);
        const filePath = resolveStateWrite(getStateDir(), projPath, branch);

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        writeStateDoc(filePath, projPath, args, existing, branch);

        log('INFO', 'Project state updated', { project: projPath, branch: branch || 'none', decisions: args.decisions?.length || 0 });
        const branchLine = branch ? `Branch: ${branch}\n` : '';
        return { content: [{ type: "text", text: `Project memory updated.\n${branchLine}File: ${filePath}\nDecisions saved: ${args.decisions?.length || 0}\nNext session items: ${args.next?.length || 0}` }] };
      }

      case "working_memory_set": {
        const args = WorkingMemorySetSchema.parse(request.params.arguments || {});
        const projPath = resolveProjectPath(args.project_path);
        await writeArbitrator.enqueue(async () => {
          await setWorkingMemory(db, projPath, args.key, args.value, args.ttl_seconds);
        });
        const ttl = args.ttl_seconds ?? 86400;
        log('INFO', 'Working memory entry stored', { project: projPath, key: args.key, ttl });
        return { content: [{ type: "text", text: `Working memory entry stored: key="${args.key}", ttl=${ttl}s` }] };
      }

      case "working_memory_get": {
        const args = WorkingMemoryGetSchema.parse(request.params.arguments || {});
        const projPath = resolveProjectPath(args.project_path);
        const entry = await getWorkingMemory(db, projPath, args.key);
        if (!entry) {
          return { content: [{ type: "text", text: `null` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ key: entry.key, value: entry.value, expires_at: entry.expires_at }, null, 2) }] };
      }

      case "working_memory_list": {
        const args = WorkingMemoryListSchema.parse(request.params.arguments || {});
        const projPath = resolveProjectPath(args.project_path);
        const entries = await listWorkingMemory(db, projPath);
        return { content: [{ type: "text", text: JSON.stringify(entries.map(e => ({ key: e.key, value: e.value, expires_at: e.expires_at })), null, 2) }] };
      }

      case "lesson_save":
        return await handleLessonSave(db, request.params.arguments);

      case "lesson_recall":
        return await handleLessonRecall(db, request.params.arguments);

      case "lesson_reinforce":
        return await handleLessonReinforce(db, request.params.arguments);

      case "detect_patterns": {
        const { window_days, min_occurrences } = DetectPatternsSchema.parse(request.params.arguments || {});
        const cutoff = new Date(Date.now() - window_days * 24 * 60 * 60 * 1000).toISOString();

        // Read events and persist patterns in the state-store DB where hooks write events.
        // Uses the server's own sqlite3/sqlite driver so the build carries no extra dependency.
        const stateDbPath = resolveStateStoreDbPath();

        let events: Array<{
          id: string;
          sessionId: string | null;
          eventType: string;
          payload: Record<string, unknown> | null;
          timestamp: string;
        }> = [];

        const patterns = await writeArbitrator.enqueue(async () => {
          if (!fs.existsSync(stateDbPath)) {
            log('INFO', 'State-store DB not found; no events to analyze', { path: stateDbPath });
            return [];
          }

          const ssDb = await open({ filename: stateDbPath, driver: sqlite3.Database });
          try {
            await ssDb.exec('PRAGMA journal_mode = WAL;');
            await ssDb.exec('PRAGMA busy_timeout = 5000;');

            const rawEvents = await ssDb.all<Array<{ id: string; session_id: string | null; event_type: string; payload: string; timestamp: string }>>(
              'SELECT id, session_id, event_type, payload, timestamp FROM events WHERE timestamp >= ? ORDER BY timestamp ASC',
              [cutoff]
            );

            events = rawEvents.map(row => ({
              id: row.id,
              sessionId: row.session_id ?? null,
              eventType: row.event_type,
              payload: (() => { try { return JSON.parse(row.payload); } catch { return null; } })(),
              timestamp: row.timestamp,
            }));

            const detected = detectPatternsFromEvents(events, window_days, min_occurrences);

            const upsertSql = `
              INSERT INTO patterns (id, pattern_type, key, description, occurrences, frequency, last_seen, suggested_automation, first_seen, window_days)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                pattern_type = excluded.pattern_type,
                key = excluded.key,
                description = excluded.description,
                occurrences = excluded.occurrences,
                frequency = excluded.frequency,
                last_seen = excluded.last_seen,
                suggested_automation = excluded.suggested_automation,
                window_days = excluded.window_days
            `;

            await ssDb.exec('BEGIN');
            try {
              for (const p of detected) {
                const entry = patternToStoreEntry(p, window_days);
                await ssDb.run(upsertSql, [
                  entry.id,
                  entry.patternType,
                  entry.key,
                  entry.description,
                  entry.occurrences,
                  entry.frequency,
                  entry.lastSeen,
                  entry.suggestedAutomation,
                  entry.firstSeen,
                  entry.windowDays,
                ]);
              }
              await ssDb.exec('COMMIT');
            } catch (txError) {
              await ssDb.exec('ROLLBACK');
              throw txError;
            }

            return detected;
          } finally {
            await ssDb.close();
          }
        });

        const output = patterns.map(p => ({
          type: p.type,
          description: p.description,
          occurrences: p.occurrences,
          suggestion: p.suggestion,
        }));

        log('INFO', 'Pattern detection complete', {
          window_days,
          min_occurrences,
          events_analyzed: events.length,
          patterns_found: patterns.length,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ patterns: output, meta: { window_days, min_occurrences, events_analyzed: events.length } }, null, 2)
          }]
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${request.params.name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${error.message}`);
    }
    log('ERROR', 'Tool execution failed', { tool: request.params.name, error: String(error) });
    throw error;
  }
});

let transport: StdioServerTransport | null = null;

async function run() {
  // Pre-warm: open DB and run migrations before accepting MCP requests.
  // Eliminates first-call latency that caused first-run failures in AGY.
  await getDb();
  transport = new StdioServerTransport();
  await server.connect(transport);
  log('INFO', 'egc-memory-orchestrator initialized with Write Arbitration');
}

async function shutdown() {
  log('INFO', 'Shutting down gracefully');
  if (dbInstance) {
    await dbInstance.close();
    log('INFO', 'SQLite handle closed');
  }
  if (transport) {
    await server.close();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run().catch((e) => {
  log('ERROR', 'Fatal startup error', { error: String(e) });
  process.exit(1);
});
