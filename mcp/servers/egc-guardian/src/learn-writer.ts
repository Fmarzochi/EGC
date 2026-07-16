import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const MARKER_START = '<!-- egc:learn:start -->';
const MARKER_END   = '<!-- egc:learn:end -->';

const PROPAGATION_TARGETS = [
  'GEMINI.md',
  'AGENTS.md',
  '.cursor/rules/egc-context.mdc',
  '.github/copilot-instructions.md',
  '.windsurf/rules/egc-context.md',
  '.trae/rules/egc-context.md',
  '.rules',
  '.clinerules',
  'CONVENTIONS.md',
  '.cursorrules',
  'llms.txt',
];

export interface FailurePattern {
  tool: string;
  count: number;
  sample_error: string;
}

export interface LearnResult {
  patterns_found: number;
  recommendations_written: number;
  target_file: string;
  skipped: boolean;
  reason?: string;
  propagated_to: string[];
}

function resolveStateDb(): string {
  const env = process.env.EGC_STATE_DB;
  if (env) return path.resolve(env);
  return path.join(os.homedir(), '.gemini', 'egc', 'state.db');
}

async function loadRecentFailures(projectRoot: string, limit: number): Promise<FailurePattern[]> {
  const dbPath = resolveStateDb();
  if (!fs.existsSync(dbPath)) return [];

  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  try {
    const rows: { tool: string; payload: string }[] = await db.all(`
      SELECT e.payload
      FROM events e
      INNER JOIN sessions s ON e.session_id = s.id
      WHERE s.repo_root = ?
      ORDER BY e.timestamp DESC
      LIMIT ?
    `, [projectRoot, limit * 10]);

    const tally = new Map<string, { count: number; sample: string }>();

    for (const row of rows) {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(row.payload); } catch { continue; }

      const out = String(payload.output ?? payload.result ?? '');
      const tool = String(payload.tool ?? 'unknown');

      if (/error|failed|exception|cannot|unexpected/i.test(out)) {
        const existing = tally.get(tool);
        const errorLine = out.split('\n').find(l => /error|failed|exception/i.test(l))?.trim() ?? out.slice(0, 120);
        if (existing) {
          existing.count++;
        } else {
          tally.set(tool, { count: 1, sample: errorLine });
        }
      }
    }

    return [...tally.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit)
      .map(([tool, { count, sample }]) => ({ tool, count, sample_error: sample }));
  } finally {
    await db.close();
  }
}

function buildRecommendations(patterns: FailurePattern[]): string {
  const lines: string[] = [
    '## Auto-generated from EGC session analysis',
    '',
    '### Recurring tool failures detected',
    '',
  ];

  for (const p of patterns) {
    lines.push(`- **${p.tool}** failed ${p.count} time(s). Last error: \`${p.sample_error.slice(0, 100)}\``);
  }

  lines.push('');
  lines.push(`_Updated: ${new Date().toISOString()}_`);

  return lines.join('\n');
}

function writeToFile(filePath: string, content: string): void {
  let existing = '';
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf8');
  }

  const block = `${MARKER_START}\n${content}\n${MARKER_END}`;

  if (existing.includes(MARKER_START) && existing.includes(MARKER_END)) {
    const before = existing.slice(0, existing.indexOf(MARKER_START));
    const after  = existing.slice(existing.indexOf(MARKER_END) + MARKER_END.length);
    fs.writeFileSync(filePath, before + block + after, 'utf8');
  } else {
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n';
    fs.writeFileSync(filePath, existing + separator + block + '\n', 'utf8');
  }
}

function propagateLearnBlock(projectRoot: string, content: string): string[] {
  const written: string[] = [];
  for (const rel of PROPAGATION_TARGETS) {
    const targetPath = path.join(projectRoot, rel);
    if (fs.existsSync(targetPath)) {
      writeToFile(targetPath, content);
      written.push(rel);
    }
  }
  return written;
}

export async function autoLearn(opts: {
  project_path: string;
  target_file?: string;
  limit?: number;
}): Promise<LearnResult> {
  const projectRoot = opts.project_path;
  const primaryFile = opts.target_file ?? path.join(projectRoot, 'CLAUDE.md');
  const limit       = opts.limit ?? 10;

  const patterns = await loadRecentFailures(projectRoot, limit);

  if (patterns.length === 0) {
    return { patterns_found: 0, recommendations_written: 0, target_file: primaryFile, skipped: true, reason: 'no failures found in session history', propagated_to: [] };
  }

  const content = buildRecommendations(patterns);
  writeToFile(primaryFile, content);
  const propagated = propagateLearnBlock(projectRoot, content);

  return {
    patterns_found: patterns.length,
    recommendations_written: patterns.length,
    target_file: primaryFile,
    skipped: false,
    propagated_to: propagated,
  };
}
