import type { Database } from 'sqlite';

export interface RankedDecision {
  id: number;
  content: string;
  context: string;
  date: string;
  score: number;
}

interface RawSearchRow {
  id: number;
  content: string;
  context: string;
  date: string;
  rawScore: number;
}

export interface SearchOptions {
  limit?: number;
  minScore?: number;
}

export const DEFAULT_SEARCH_LIMIT = 10;

// FTS5 MATCH has its own query grammar (AND, OR, NEAR, *, quotes). Raw user
// input would be parsed as that grammar and could fail or change semantics,
// so every token is double-quoted to force literal term matching.
export function sanitizeFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) || [];
  return tokens.map(token => `"${token}"`).join(' OR ');
}

export async function createSearchIndex(db: Database): Promise<void> {
  await db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
      context,
      decision,
      content='decisions',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS decisions_fts_after_insert AFTER INSERT ON decisions BEGIN
      INSERT INTO decisions_fts(rowid, context, decision) VALUES (new.id, new.context, new.decision);
    END;
    CREATE TRIGGER IF NOT EXISTS decisions_fts_after_delete AFTER DELETE ON decisions BEGIN
      INSERT INTO decisions_fts(decisions_fts, rowid, context, decision) VALUES ('delete', old.id, old.context, old.decision);
    END;
    CREATE TRIGGER IF NOT EXISTS decisions_fts_after_update AFTER UPDATE ON decisions BEGIN
      INSERT INTO decisions_fts(decisions_fts, rowid, context, decision) VALUES ('delete', old.id, old.context, old.decision);
      INSERT INTO decisions_fts(rowid, context, decision) VALUES (new.id, new.context, new.decision);
    END;
  `);
}

export async function rebuildSearchIndex(db: Database): Promise<void> {
  await db.exec(`INSERT INTO decisions_fts(decisions_fts) VALUES ('rebuild')`);
}

// bm25() returns negative numbers where lower means more relevant. Scores are
// normalized against the best match so callers get values in [0, 1], where a
// near-zero score means the matched terms carry almost no IDF weight.
export function rankResults(rows: RawSearchRow[]): RankedDecision[] {
  if (rows.length === 0) return [];
  const best = Math.max(...rows.map(row => -row.rawScore));
  return rows.map(row => ({
    id: row.id,
    content: row.content,
    context: row.context,
    date: row.date,
    score: best > 0 ? Math.round((-row.rawScore / best) * 100) / 100 : 0
  }));
}

export interface RankedLesson {
  id: string;
  content: string;
  context: string;
  confidence: number;
  tags: string | null;
  created_at: string;
  last_reinforced: string | null;
  last_recalled: string | null;
  score: number;
}

interface RawLessonRow {
  id: string;
  content: string;
  context: string;
  confidence: number;
  tags: string | null;
  created_at: string;
  last_reinforced: string | null;
  last_recalled: string | null;
  rawScore: number;
}

export async function createLessonsSearchIndex(db: Database): Promise<void> {
  await db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
      content,
      context,
      tags,
      content='lessons',
      content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS lessons_fts_after_insert AFTER INSERT ON lessons BEGIN
      INSERT INTO lessons_fts(rowid, content, context, tags)
        VALUES (new.rowid, new.content, new.context, COALESCE(new.tags, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS lessons_fts_after_delete AFTER DELETE ON lessons BEGIN
      INSERT INTO lessons_fts(lessons_fts, rowid, content, context, tags)
        VALUES ('delete', old.rowid, old.content, old.context, COALESCE(old.tags, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS lessons_fts_after_update AFTER UPDATE ON lessons BEGIN
      INSERT INTO lessons_fts(lessons_fts, rowid, content, context, tags)
        VALUES ('delete', old.rowid, old.content, old.context, COALESCE(old.tags, ''));
      INSERT INTO lessons_fts(rowid, content, context, tags)
        VALUES (new.rowid, new.content, new.context, COALESCE(new.tags, ''));
    END;
  `);
}

export async function rebuildLessonsSearchIndex(db: Database): Promise<void> {
  await db.exec(`INSERT INTO lessons_fts(lessons_fts) VALUES ('rebuild')`);
}

export async function searchLessons(
  db: Database,
  query: string,
  minConfidence: number,
  limit: number
): Promise<RankedLesson[]> {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];

  const rows: RawLessonRow[] = await db.all(
    `SELECT l.id, l.content, l.context, l.confidence, l.tags,
            l.created_at, l.last_reinforced, l.last_recalled,
            bm25(lessons_fts) AS rawScore
     FROM lessons_fts
     JOIN lessons l ON l.rowid = lessons_fts.rowid
     WHERE lessons_fts MATCH ?
       AND l.archived = 0
       AND l.confidence >= ?
     ORDER BY rawScore
     LIMIT ?`,
    [match, minConfidence, limit]
  );

  if (rows.length === 0) return [];
  const best = Math.max(...rows.map(r => -r.rawScore));
  return rows.map(r => ({
    id: r.id,
    content: r.content,
    context: r.context,
    confidence: r.confidence,
    tags: r.tags ?? null,
    created_at: r.created_at,
    last_reinforced: r.last_reinforced ?? null,
    last_recalled: r.last_recalled ?? null,
    score: best > 0 ? Math.round((-r.rawScore / best) * 100) / 100 : 0
  }));
}

export async function searchDecisions(
  db: Database,
  query: string,
  options: SearchOptions = {}
): Promise<RankedDecision[]> {
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const minScore = options.minScore ?? 0;

  const match = sanitizeFtsQuery(query);
  if (!match) return [];

  const rows: RawSearchRow[] = await db.all(
    `SELECT d.id AS id,
            d.decision AS content,
            d.context AS context,
            d.timestamp AS date,
            bm25(decisions_fts) AS rawScore
     FROM decisions_fts
     JOIN decisions d ON d.id = decisions_fts.rowid
     WHERE decisions_fts MATCH ?
     ORDER BY rawScore
     LIMIT ?`,
    [match, limit]
  );

  return rankResults(rows).filter(result => result.score >= minScore);
}
