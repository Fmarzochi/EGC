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
import { extractFile, type ExtractedImport } from './graph-extract.js';
import { makeIgnore, readFileWithin, resolveSpecifier, TEXT_EXT, walkFiles } from './graph-build.js';
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

// One document per file, with the imports found by the single extraction of a
// JS/TS file. null when the file is protected or is not a regular file.
async function indexFile(
  root: string,
  rel: string,
  opts: FileIndexOptions
): Promise<{ doc: FileDoc; imports: ExtractedImport[] } | null> {
  const abs = path.join(root, rel);
  if (opts.isProtectedPath?.(abs)) return null;
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const pathTokens = tokenize(rel);
  // A large, unreadable or binary file is indexed by its path alone.
  const raw = st.size > MAX_FILE_BYTES ? null : await readFileWithin(root, rel, MAX_FILE_BYTES);
  const text = raw?.includes(String.fromCharCode(0)) ? null : raw;
  if (text === null) return { doc: { path: rel, fields: { path: pathTokens, symbols: [], keywords: [], summary: [] } }, imports: [] };

  const summary = tokenize(summaryOf(text));
  if (!JS_TS.test(rel)) return { doc: { path: rel, fields: { path: pathTokens, symbols: [], keywords: [], summary } }, imports: [] };
  const ex = extractFile(text);
  return {
    doc: { path: rel, fields: { path: pathTokens, symbols: ex.symbols.flatMap(s => tokenize(s.name)), keywords: [], summary } },
    imports: ex.imports
  };
}

async function loadIgnore(root: string): Promise<(rel: string, isDir: boolean) => boolean> {
  try {
    return makeIgnore(await fs.promises.readFile(path.join(root, '.gitignore'), 'utf8'));
  } catch {
    return () => false; // no .gitignore
  }
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export async function buildFileIndex(
  projectRoot: string,
  opts: FileIndexOptions = {}
): Promise<{ docs: FileDoc[]; edges: ImportEdge[]; skipped: number }> {
  const root = await fs.promises.realpath(projectRoot);
  const ignore = await loadIgnore(root);
  const deadline = Date.now() + DEADLINE_MS;
  const walked = await walkFiles(root, ignore, name => TEXT_EXT.test(name), MAX_FILES, deadline);
  const fileSet = new Set<string>(walked.files);
  const docs: FileDoc[] = [];
  const importsByFile: Array<[string, ExtractedImport[]]> = [];
  let skipped = 0;

  for (let k = 0; k < walked.files.length; k++) {
    // The deadline bounds the whole index, not only the directory walk.
    if (Date.now() > deadline) {
      skipped += walked.files.length - k;
      break;
    }
    const rel = walked.files[k];
    const indexed = await indexFile(root, rel, opts); // NOSONAR: one file at a time keeps memory and open handles bounded
    if (!indexed) {
      skipped++;
      continue;
    }
    docs.push(indexed.doc);
    if (indexed.imports.length > 0) importsByFile.push([rel, indexed.imports]);
  }

  const edges: ImportEdge[] = [];
  for (const [rel, imports] of importsByFile) {
    for (const im of imports) {
      const target = resolveSpecifier(rel, im.specifier, fileSet);
      if (target && target !== rel) edges.push({ from: rel, to: target, rel: 'imports' });
    }
  }
  edges.sort((a, b) => compareText(a.from + '\0' + a.to, b.from + '\0' + b.to));
  docs.sort((a, b) => compareText(a.path, b.path));
  return { docs, edges, skipped };
}
