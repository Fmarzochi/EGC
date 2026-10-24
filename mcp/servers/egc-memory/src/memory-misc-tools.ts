import { Database } from 'sqlite';
import fs from 'node:fs';
import { z } from 'zod';
import { log } from './memory-logging';
import { writeArbitrator, isSearchIndexReady } from './memory-db';
import { resolveProjectPath } from './memory-project-path';
import { openCompatDatabase, selectedEngine, enableWalBestEffort } from './sqlite-compat';
import { searchDecisions } from './search.js';
import { detectPatternsFromEvents, patternToStoreEntry } from './patterns.js';
import { llmCompress, loadRawObservations, pairCompressedWithId, replaceObservation } from './compress.js';
import { sanitize, sanitizeStrings } from './sanitize.js';
import { teamInit, teamSync, teamStatus } from './sync/TeamSync.js';
import { resolveStateStoreDbPath } from './state-store-path.js';
import { setWorkingMemory, getWorkingMemory, listWorkingMemory } from './working-memory';

export const WORKING_MEMORY_MAX_TTL_SECONDS = 604800; // 7 days: longer-lived data belongs in update_state, not working memory.

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
  limit: z.number().min(1).max(100).optional().default(20),
  offset: z.number().min(0).optional().default(0)
});

const WorkingMemorySetSchema = z.object({
  project_path: z.string().optional(),
  key: z.string().min(1).max(200),
  value: z.string().min(1).max(50000),
  ttl_seconds: z.number().int().min(1).max(WORKING_MEMORY_MAX_TTL_SECONDS).optional()
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

const CompressObservationsSchema = z.object({
  project_path: z.string().optional(),
  since: z.string().datetime().optional(),
  limit: z.number().min(1).max(500).optional().default(50)
});

const TeamInitSchema = z.object({
  backend: z.string().min(1).default('git'),
  remote: z.string().min(1),
  branch: z.string().min(1).default('main'),
  team_key: z.string().regex(/^[0-9a-f]{64}$/i, 'team_key must be 64 hexadecimal characters').optional()
});

// Substring search over decisions for SQLite builds without FTS5: every
// whitespace-separated term must appear in the context or the decision.
// FTS5 when the index is usable; otherwise the same substring matching
// lesson_recall already falls back to, so the tool keeps answering.
async function handleSearchHistory(db: Database, query: string, limit: number, minScore: number | undefined) {
  if (!isSearchIndexReady()) {
    const results = (await searchDecisionsBySubstring(db, query, limit)).filter(r => r.score >= (minScore ?? 0));
    log('INFO', 'Decision history searched by substring (no FTS5)', { results: results.length });
    return { content: [{ type: "text", text: JSON.stringify({ results, meta: { query, limit, min_score: minScore, count: results.length, mode: 'substring' } }, null, 2) }] };
  }
  const results = await searchDecisions(db, query, { limit, minScore });
  log('INFO', 'Decision history searched', { results: results.length });
  return { content: [{ type: "text", text: JSON.stringify({ results, meta: { query, limit, min_score: minScore, count: results.length } }, null, 2) }] };
}

// Same row shape as searchDecisions (id, content, context, date, score) so
// callers cannot tell the engines apart; every match scores 1.
async function searchDecisionsBySubstring(db: Database, query: string, limit: number): Promise<Array<{ id: number; content: string; context: string; date: string; score: number }>> {
  const terms = query.split(/\s+/).map(t => t.trim().toLowerCase()).filter(Boolean);
  if (terms.length === 0) return [];
  // The term is data, never a pattern: escape LIKE's wildcards.
  const escaped = terms.map(t => t.replace(/[\\%_]/g, m => `\\${m}`));
  const where = escaped.map(() => String.raw`(LOWER(context) LIKE ? ESCAPE '\' OR LOWER(decision) LIKE ? ESCAPE '\')`).join(' AND ');
  const params = escaped.flatMap(t => [`%${t}%`, `%${t}%`]);
  const rows: Array<{ id: number; context: string; decision: string; timestamp: string }> = await db.all(
    `SELECT id, context, decision, timestamp FROM decisions WHERE ${where} ORDER BY timestamp DESC LIMIT ?`,
    [...params, limit]
  );
  return rows.map(r => ({ id: r.id, content: r.decision, context: r.context, date: r.timestamp, score: 1 }));
}

export async function handleStoreDecision(db: Database, toolArgs: unknown) {
  const { context, decision } = StoreDecisionSchema.parse(toolArgs);
  const cleaned = sanitizeStrings({ context, decision });
  if (cleaned.flagged) {
    log('WARN', 'store_decision: suspicious content blocked', { reasons: cleaned.reasons });
    return { content: [{ type: "text", text: `Blocked: ${cleaned.reasons.join('; ')}` }] };
  }

  const decisionProjPath = resolveProjectPath();
  await writeArbitrator.enqueue(async () => {
    await db.run('INSERT INTO decisions (context, decision, project_path) VALUES (?, ?, ?)', [cleaned.sanitized.context, cleaned.sanitized.decision, decisionProjPath]);
  });

  log('INFO', 'Decision stored securely via Queue Arbitration');
  return { content: [{ type: "text", text: "Decision stored securely." }] };
}

export async function handleQueryHistory(db: Database, toolArgs: unknown) {
  const { limit, offset } = QueryHistorySchema.parse(toolArgs || {});
  const rows = await db.all('SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ? OFFSET ?', [limit, offset]);
  return { content: [{ type: "text", text: JSON.stringify({ data: rows, meta: { limit, offset } }, null, 2) }] };
}

export async function handleSearchHistoryTool(db: Database, toolArgs: unknown) {
  const { query, limit, min_score } = SearchHistorySchema.parse(toolArgs);
  return handleSearchHistory(db, query, limit, min_score);
}

export function handleGetProjectState() {
  return Promise.resolve({ content: [{ type: "text", text: JSON.stringify({ status: "active", engine: selectedEngine() === 'wasm' ? 'sqlite-wasm' : 'sqlite-wal', arbitration: "MessageQueue" }) }] });
}

export async function handleWorkingMemorySet(db: Database, toolArgs: unknown) {
  const args = WorkingMemorySetSchema.parse(toolArgs || {});
  const valueCheck = sanitize(args.value);
  if (valueCheck.flagged) {
    log('WARN', 'working_memory_set: suspicious content blocked', { key: args.key, reason: valueCheck.reason });
    return { content: [{ type: "text", text: `Blocked: ${valueCheck.reason}` }] };
  }
  const projPath = resolveProjectPath(args.project_path);
  await writeArbitrator.enqueue(async () => {
    await setWorkingMemory(db, projPath, args.key, args.value, args.ttl_seconds);
  });
  const ttl = args.ttl_seconds ?? 86400;
  log('INFO', 'Working memory entry stored', { project: projPath, key: args.key, ttl });
  return { content: [{ type: "text", text: `Working memory entry stored: key="${args.key}", ttl=${ttl}s` }] };
}

export async function handleWorkingMemoryGet(db: Database, toolArgs: unknown) {
  const args = WorkingMemoryGetSchema.parse(toolArgs || {});
  const projPath = resolveProjectPath(args.project_path);
  const entry = await getWorkingMemory(db, projPath, args.key);
  if (!entry) {
    return { content: [{ type: "text", text: `null` }] };
  }
  return { content: [{ type: "text", text: JSON.stringify({ key: entry.key, value: entry.value, expires_at: entry.expires_at }, null, 2) }] };
}

export async function handleWorkingMemoryList(db: Database, toolArgs: unknown) {
  const args = WorkingMemoryListSchema.parse(toolArgs || {});
  const projPath = resolveProjectPath(args.project_path);
  const entries = await listWorkingMemory(db, projPath);
  return { content: [{ type: "text", text: JSON.stringify(entries.map(e => ({ key: e.key, value: e.value, expires_at: e.expires_at })), null, 2) }] };
}

export async function handleTeamInit(_db: Database, toolArgs: unknown) {
  const { backend, remote, branch, team_key } = TeamInitSchema.parse(toolArgs || {});
  const config = await teamInit(backend, remote, branch, team_key);
  log('INFO', 'Team sync initialized', { backend, remote, branch, joined: team_key !== undefined });
  const { teamKey, ...shown } = config;
  return { content: [{ type: "text", text: JSON.stringify({ success: true, config: shown, teamKey, note: 'State travels sealed with this team key (AES-256-GCM plus HMAC). Share it out of band; teammates join with team_init and the same team_key.' }, null, 2) }] };
}

export async function handleTeamSync() {
  const result = await teamSync();
  const count = result.errors.length;
  log('INFO', 'Team sync completed', { pulled: result.pulledCount, pushed: result.pushedCount, conflicts: result.conflictCount, errors: count });
  return { content: [{ type: "text", text: JSON.stringify({ success: count === 0, result }, null, 2) }] };
}

export async function handleTeamStatus() {
  const status = await teamStatus();
  return { content: [{ type: "text", text: JSON.stringify({ success: true, status }, null, 2) }] };
}

export async function handleDetectPatterns(db: Database, toolArgs: unknown) {
  const { window_days, min_occurrences } = DetectPatternsSchema.parse(toolArgs || {});
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

    const ssDb = await openCompatDatabase(stateDbPath, 'egc-memory');
    try {
      await ssDb.exec('PRAGMA busy_timeout = 5000;');
      await enableWalBestEffort(ssDb);
      await ssDb.exec(`
        CREATE TABLE IF NOT EXISTS patterns (
    id TEXT PRIMARY KEY,
    pattern_type TEXT NOT NULL,
    key TEXT NOT NULL,
    description TEXT NOT NULL,
    occurrences INTEGER NOT NULL DEFAULT 1,
    frequency REAL NOT NULL DEFAULT 0,
    last_seen TEXT NOT NULL,
    suggested_automation TEXT,
    first_seen TEXT NOT NULL,
    window_days INTEGER NOT NULL DEFAULT 7
        );
      `);

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
    first_seen = MIN(patterns.first_seen, excluded.first_seen),
    window_days = excluded.window_days
      `;

      await ssDb.exec('BEGIN');
      try {
        for (const p of detected) {
    const entry = patternToStoreEntry(p, window_days);
    await ssDb.run(upsertSql, [ // NOSONAR: sequential by design, every insert belongs to the same BEGIN/COMMIT transaction on one db handle
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
      text: JSON.stringify({ success: true, data: { patterns: output }, meta: { window_days, min_occurrences, events_analyzed: events.length } }, null, 2)
    }]
  };
}

export async function handleCompressObservations(db: Database, toolArgs: unknown) {
  const args = CompressObservationsSchema.parse(toolArgs || {});
  const projPath = resolveProjectPath(args.project_path);

  const rawObservations = await loadRawObservations(projPath, args.limit, args.since);

  if (rawObservations.length === 0) {
    return {
      content: [{ type: "text", text: "No raw observations found to compress." }],
    };
  }

  // Use llmCompress (with ruleBasedCompress as its internal fallback) as the primary path.
  // Each observation compresses independently, so the calls run in parallel; the array keeps
  // rawObservations' index (null on failure) so a mid-list failure cannot shift ids onto the
  // wrong compressed entry below.
  const compressResults = await Promise.all(rawObservations.map(async raw => {
    // llmCompress falls back to ruleBasedCompress automatically when no LLM client is wired.
    // A real llmCall goes here once the EGC dispatcher is connected to this server.
    try {
      return await llmCompress(raw, () => Promise.reject(new Error('LLM not configured')));
    } catch (e) {
      log('ERROR', 'LLM compression failed, skipping', { error: String(e) });
      return null;
    }
  }));

  const pairs = pairCompressedWithId(rawObservations, compressResults);
  // Write replacements sequentially to prevent JSONL file corruption from concurrent writes
  for (const { id, result } of pairs) {
    await replaceObservation(projPath, id, result); // NOSONAR: sequential by design, replaceObservation rewrites the whole JSONL file, so concurrent calls would corrupt it
  }

  const compressed = pairs.map(p => p.result);
  const summary = compressed.map((c) => ({
    title:      c.title,
    type:       c.type,
    importance: c.importance,
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
    { compressed_count: compressed.length, summary },
    null,
    2
        ),
      },
    ],
  };
}
