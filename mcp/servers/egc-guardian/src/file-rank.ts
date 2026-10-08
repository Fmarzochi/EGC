/*
 * Copyright 2024 The Link Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Orchestration for The Link port: index, git state, scoring, explain and briefing.
 * Kept apart from file-ranker.ts so that the git signal module can import the
 * scoring registry without an import cycle.
 */
import { collectGitContext } from './file-git.js';
import { buildFileIndex } from './file-index.js';
import { scoreDocuments } from './file-ranker.js';
import { redactPayload } from './audit-log.js';
import { scanForInjection } from './prompt-injection-scanner.js';

export interface RankOptions {
  projectPath: string;
  query: string;
  history?: string;
  topN?: number;
  useGit?: boolean;
  weights?: Record<string, number>;
  graphHops?: number;
  isProtectedPath?: (absPath: string) => boolean;
}
export interface RankedFile { path: string; score: number; signals: Record<string, number> }

export async function rankProjectFiles(opts: RankOptions): Promise<{ ranked: RankedFile[]; explain: string[]; briefing: string }> {
  const index = await buildFileIndex(opts.projectPath, { isProtectedPath: opts.isProtectedPath });
  const gitSignal = opts.useGit === false ? null : await collectGitContext(opts.projectPath);
  const scored = scoreDocuments(index.docs, {
    query: opts.query,
    history: opts.history ?? '',
    edges: index.edges,
    extras: { gitSignal: gitSignal ?? undefined, graphHops: opts.graphHops }
  }, { weights: opts.weights, signals: gitSignal ? ['bm25', 'path_hit', 'git'] : undefined });

  const limit = Math.max(opts.topN ?? 10, 0);
  const ranked: RankedFile[] = scored
    .filter(sd => sd.total > 0)
    .slice(0, limit)
    .map(sd => ({
      path: sd.doc.path,
      score: Math.round(sd.total * 1000) / 1000,
      signals: Object.fromEntries(sd.signals.map(s => [s.name, Math.round(s.raw * s.weight * 1000) / 1000]))
    }));
  return {
    ranked,
    explain: renderExplain(ranked),
    briefing: renderBriefing(opts.query, opts.history ?? '', ranked)
  };
}

export function renderExplain(files: RankedFile[]): string[] {
  if (files.length === 0) return ['explain: no files ranked'];
  const names: string[] = [];
  for (const f of files) for (const n of Object.keys(f.signals)) if (!names.includes(n)) names.push(n);
  const header = ['#', 'score', ...names, 'path'];
  const rows: string[][] = [header, ...files.map((f, i) => [
    String(i + 1), f.score.toFixed(2), ...names.map(n => (f.signals[n] ?? 0).toFixed(2)), f.path
  ])];
  const widths = header.map((_, c) => Math.max(...rows.map(r => r[c].length)));
  const out = [`explain: ${files.length} file(s) ranked (signals: ${names.join(', ')})`];
  for (const r of rows) {
    const cells = r.slice(0, -1).map((cell, c) => cell.padStart(widths[c]));
    out.push('  ' + [...cells, r[r.length - 1]].join('  '));
  }
  return out;
}

function safeText(text: string): string {
  if (scanForInjection(text).length > 0) return '[omitted: flagged by prompt-injection scan]';
  return String(redactPayload({ text }).text);
}

export function renderBriefing(query: string, history: string, files: RankedFile[]): string {
  const historyBlock = history.trim() ? safeText(history.trim()) : '(no session history found)';
  const codeBlock = files.length === 0
    ? '(no relevant files found)'
    : files.map(f => `--- ${f.path} ---`).join('\n');
  return [
    '[PROJECT HISTORY]',
    historyBlock,
    '',
    '[RELEVANT CODEBASE CONTEXT]',
    codeBlock,
    '',
    '[USER REQUEST]',
    query
  ].join('\n');
}
