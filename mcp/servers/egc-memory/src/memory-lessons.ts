import { Database } from 'sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { log } from './memory-logging';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { writeArbitrator, isLessonsSearchIndexReady } from './memory-db';
import { resolveProjectPath } from './memory-project-path';
import { searchLessons } from './search.js';
import { sanitize, sanitizeStrings } from './sanitize.js';

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
  author?: string | null;
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
    author: row.author ?? null,
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

export async function runLessonDecaySweep(db: Database): Promise<number> {
  const now = Date.now();
  const rows = await db.all<LessonRow[]>('SELECT * FROM lessons WHERE archived = 0');
  let affected = 0;
  for (const row of rows) {
    const decayed = computeLessonDecay(row.confidence, row.last_recalled, row.created_at, now);
    if (decayed === row.confidence) {
      continue;
    }
    const archived = decayed < LESSON_ARCHIVE_THRESHOLD ? 1 : 0;
    await db.run('UPDATE lessons SET confidence = ?, archived = ? WHERE id = ?', [decayed, archived, row.id]); // NOSONAR: sequential by design, one shared db handle, writes serialized to avoid lock contention
    affected++;
  }
  return affected;
}

const LessonSaveSchema = z.object({
  content: z.string().min(1).max(5000),
  context: z.string().min(1).max(2000),
  // Accepts either a comma-separated string (legacy) or an array of tags
  // (preferred). Both are normalized to the same comma-joined TEXT column
  // on write via normalizeTags() -- the stored format never changes, so
  // existing rows and existing readers are unaffected either way.
  tags: z.union([z.string(), z.array(z.string())]).optional(),
  initial_confidence: z.number().min(0).max(1).optional().default(0.7),
  author: z.string().max(100).optional()
});

function normalizeTags(tags: string | string[] | undefined): string | null {
  if (tags === undefined) return null;
  if (Array.isArray(tags)) {
    const cleaned = tags.map(t => t.trim()).filter(Boolean);
    return cleaned.length > 0 ? cleaned.join(',') : null;
  }
  return tags;
}

const LessonRecallSchema = z.object({
  query: z.string().min(1).max(1000),
  min_confidence: z.number().min(0).max(1).optional().default(0.2),
  limit: z.number().min(1).max(100).optional().default(10)
});

const LessonReinforceSchema = z.object({
  id: z.string().min(1)
});

export async function handleLessonSave(db: Database, args: unknown) {
  const { content, context, tags, initial_confidence, author } = LessonSaveSchema.parse(args);
  const authorName = author || process.env.USER || process.env.USERNAME || 'unknown';
  const normalizedTags = normalizeTags(tags);
  const checked = checkLessonText({ content, context, tags: normalizedTags ?? undefined, author: authorName });
  if (checked.reasons.length > 0) {
    log('WARN', 'lesson_save: suspicious content blocked', { reasons: checked.reasons });
    return { content: [{ type: "text", text: `Blocked: ${checked.reasons.join('; ')}` }] };
  }

  // Exact-match deduplication: reinforce an identical lesson instead of duplicating.
  const duplicate = await db.get<{id: string}>(
    'SELECT id FROM lessons WHERE content = ? AND context = ? AND archived = 0',
    [content, context]
  );
  if (duplicate) {
    log('INFO', 'Lesson deduplicated via exact match, reinforcing', { id: duplicate.id });
    return await handleLessonReinforce(db, { id: duplicate.id });
  }

  const id = generateLessonId();
  const now = new Date().toISOString();
  const projPath = resolveProjectPath();
  await writeArbitrator.enqueue(async () => {
    await db.run(
      `INSERT INTO lessons (id, content, context, confidence, last_reinforced, last_recalled, created_at, tags, archived, project_path, author)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?, ?)`,
      [id, content, context, initial_confidence, now, normalizedTags, projPath, authorName]
    );
  });
  log('INFO', 'Lesson saved', { id, context, author: authorName });
  return { content: [{ type: "text", text: JSON.stringify({ id, content, context, confidence: initial_confidence, tags: normalizedTags, createdAt: now, author: authorName }, null, 2) }] };
}

type LessonText = { content: string; context: string; tags?: string; author?: string };

// Each field is checked on its own and then read together, in the order a
// recalled lesson presents them, so a directive split across fields is
// caught as a whole and every field then comes back as the blocked marker.
function checkLessonText(fields: LessonText): { sanitized: Record<string, string>; reasons: string[] } {
  const cleaned = sanitizeStrings(fields);
  if (cleaned.flagged) return { sanitized: cleaned.sanitized, reasons: cleaned.reasons };
  const present = Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined);
  const together = sanitize(present.map(([, value]) => value).join('\n'));
  if (!together.flagged) return { sanitized: cleaned.sanitized, reasons: [] };
  return {
    sanitized: Object.fromEntries(present.map(([key]) => [key, together.value])),
    reasons: [`fields read together: ${together.reason}`],
  };
}

// A stored field that reads as an instruction is handed back as the blocked
// marker, never as its text: rows written before lesson_save checked its
// input, or put in the store by anything else, are read the way new ones are
// checked, and the row itself stays visible so it can be found and fixed.
function presentLesson(lesson: ReturnType<typeof mapLessonRow>): ReturnType<typeof mapLessonRow> {
  const { sanitized } = checkLessonText({
    content: lesson.content,
    context: lesson.context,
    tags: lesson.tags ?? undefined,
    author: lesson.author ?? undefined,
  });
  return { ...lesson, ...sanitized };
}

export async function handleLessonRecall(db: Database, args: unknown) {
  const { query, min_confidence, limit } = LessonRecallSchema.parse(args);

  let matched: ReturnType<typeof mapLessonRow>[];

  if (isLessonsSearchIndexReady()) {
    const results = await searchLessons(db, query, min_confidence, limit);
    matched = results.map(r => mapLessonRow({
      id: r.id, content: r.content, context: r.context, confidence: r.confidence,
      tags: r.tags ?? null, author: r.author ?? null, archived: 0, created_at: r.created_at,
      last_reinforced: r.last_reinforced ?? null, last_recalled: r.last_recalled ?? null
    } as LessonRow)).map(presentLesson);
  } else {
    const lowerQuery = query.toLowerCase();
    const rows = await db.all<LessonRow[]>(
      `SELECT * FROM lessons
       WHERE archived = 0 AND confidence >= ?
       ORDER BY confidence DESC, created_at DESC
       LIMIT ?`,
      [min_confidence, limit * 3]
    );
    matched = rows
      .filter(r => r.content.toLowerCase().includes(lowerQuery) || r.context.toLowerCase().includes(lowerQuery) || (r.tags?.toLowerCase().includes(lowerQuery) ?? false))
      .slice(0, limit)
      .map(mapLessonRow)
      .map(presentLesson);
  }

  const now = new Date().toISOString();
  if (matched.length > 0) {
    await writeArbitrator.enqueue(async () => {
      for (const lesson of matched) {
        await db.run('UPDATE lessons SET last_recalled = ? WHERE id = ?', [now, lesson.id]); // NOSONAR: sequential by design, one shared db handle, writes serialized to avoid lock contention
      }
    });
  }

  log('INFO', 'Lessons recalled', { query, fts: isLessonsSearchIndexReady(), count: matched.length });
  return { content: [{ type: "text", text: JSON.stringify({ lessons: matched, meta: { query, min_confidence, limit, count: matched.length } }, null, 2) }] };
}

export async function handleLessonReinforce(db: Database, args: unknown) {
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
  return { content: [{ type: "text", text: JSON.stringify(updated ? presentLesson(mapLessonRow(updated)) : { id, confidence: newConfidence }, null, 2) }] };
}
