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
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractFile } from './graph-extract.js';
import { makeIgnore, resolveSpecifier, TEXT_EXT, walkFiles } from './graph-build.js';
import { tokenize, type FileDoc, type ImportEdge } from './file-ranker.js';

export const MAX_FILE_BYTES = 256 * 1024;
const JS_TS = /\.(?:[cm]?[jt]sx?)$/i;
const MAX_FILES = 5000;
const DEADLINE_MS = 20000;

function summaryOf(text: string): string {
  const line = text.split('\n').map(l => l.replace(/^[\s#*>/-]+/, '').trim()).find(l => l.length > 0);
  return line ?? '';
}

export interface FileIndexOptions {
  isProtectedPath?: (absPath: string) => boolean;
}

export async function buildFileIndex(
  projectRoot: string,
  opts: FileIndexOptions = {}
): Promise<{ docs: FileDoc[]; edges: ImportEdge[]; skipped: number }> {
  const root = fs.realpathSync(projectRoot);
  let ignore = (_rel: string, _isDir: boolean): boolean => false;
  try {
    ignore = makeIgnore(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'));
  } catch {
    // no .gitignore
  }
  const walked = await walkFiles(root, ignore, name => TEXT_EXT.test(name), MAX_FILES, Date.now() + DEADLINE_MS);
  const fileSet = new Set<string>(walked.files);
  const docs: FileDoc[] = [];
  const jsTs = new Map<string, string>();
  let skipped = 0;

  for (const rel of walked.files) {
    const abs = path.join(root, rel);
    if (opts.isProtectedPath?.(abs)) {
      skipped++;
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      skipped++;
      continue;
    }
    if (!st.isFile()) {
      skipped++;
      continue;
    }
    let text: string | null = null;
    if (st.size <= MAX_FILE_BYTES) {
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        text = null;
      }
    }
    if (text !== null && text.includes('\u0000')) text = null;
    const pathTokens = tokenize(rel);
    if (text === null) {
      docs.push({ path: rel, fields: { path: pathTokens, symbols: [], keywords: [], summary: [] } });
      continue;
    }
    if (JS_TS.test(rel)) {
      jsTs.set(rel, text);
      const ex = extractFile(text);
      docs.push({
        path: rel,
        fields: {
          path: pathTokens,
          symbols: ex.symbols.flatMap(s => tokenize(s.name)),
          keywords: [],
          summary: tokenize(summaryOf(text))
        }
      });
    } else {
      docs.push({ path: rel, fields: { path: pathTokens, symbols: [], keywords: [], summary: tokenize(summaryOf(text)) } });
    }
  }

  const edges: ImportEdge[] = [];
  for (const [rel, text] of jsTs) {
    for (const im of extractFile(text).imports) {
      const target = resolveSpecifier(rel, im.specifier, fileSet);
      if (target && target !== rel) edges.push({ from: rel, to: target, rel: 'imports' });
    }
  }
  edges.sort((a, b) => (a.from + '\0' + a.to < b.from + '\0' + b.to ? -1 : a.from + '\0' + a.to > b.from + '\0' + b.to ? 1 : 0));
  docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { docs, edges, skipped };
}
