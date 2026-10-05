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
 * TypeScript port of thelink/scoring.py at commit 4f607a4 (github.com/UnforGBeast/thelink).
 */

const TOKEN_RE = /[a-zA-Z0-9]+/g;
const CAMEL_RE = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g;

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are',
  'be', 'this', 'that', 'it', 'with', 'as', 'at', 'by', 'from',
  'py', 'js', 'ts', 'tsx', 'jsx', 'go', 'rs', 'java', 'rb', 'md', 'txt',
  'src', 'lib', 'test', 'tests', 'spec'
]);

const MIN_STEM_LEN = 4;
const STEM_TAIL = 3;

export function stem(tok: string): string {
  if (tok.length < MIN_STEM_LEN) return tok;
  let t = tok;
  if (t.endsWith('ies') && t.length > 4) t = t.slice(0, -3) + 'y';
  else if (/(sses|shes|ches|xes|zes|ses)$/.test(t)) t = t.slice(0, -2);
  else if (t.endsWith('s') && !/(ss|us|is|as)$/.test(t)) t = t.slice(0, -1);
  if (t.endsWith('ing') && t.length - 3 >= STEM_TAIL) t = t.slice(0, -3);
  else if (t.endsWith('ed') && t.length - 2 >= STEM_TAIL) t = t.slice(0, -2);
  return t;
}

export function tokenize(text: string | undefined, opts: { stem?: boolean } = {}): string[] {
  const useStem = opts.stem ?? true;
  const out: string[] = [];
  for (const chunk of (text ?? '').match(TOKEN_RE) ?? []) {
    const parts = chunk.match(CAMEL_RE) ?? [chunk];
    for (const raw of parts) {
      const p = raw.toLowerCase();
      if (p.length < 2 || STOP.has(p)) continue;
      out.push(useStem ? stem(p) : p);
    }
  }
  return out;
}

export interface FileDoc {
  path: string;
  fields: { path: string[]; symbols: string[]; keywords: string[]; summary: string[] };
}

export const FIELD_WEIGHTS: Record<string, number> = { path: 3.0, symbols: 2.5, keywords: 1.5, summary: 1.0 };
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;
export const HISTORY_TERM_WEIGHT = 0.4;

function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

export class Bm25Index {
  private constructor(
    private readonly docTf: Array<Map<string, number>>,
    private readonly docLen: number[],
    private readonly avgdl: number,
    private readonly idf: Map<string, number>,
    private readonly vocab: string[]
  ) {}

  static build(docs: FileDoc[]): Bm25Index {
    const docTf: Array<Map<string, number>> = [];
    const docLen: number[] = [];
    const df = new Map<string, number>();
    for (const d of docs) {
      const tf = new Map<string, number>();
      for (const [field, toks] of Object.entries(d.fields)) {
        const fw = FIELD_WEIGHTS[field] ?? 1.0;
        for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + fw);
      }
      docTf.push(tf);
      docLen.push([...tf.values()].reduce((a, b) => a + b, 0));
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = docs.length;
    const avgdl = n ? docLen.reduce((a, b) => a + b, 0) / n : 0;
    const idf = new Map<string, number>();
    for (const [t, c] of df) idf.set(t, Math.log(1 + (n - c + 0.5) / (c + 0.5)));
    return new Bm25Index(docTf, docLen, avgdl, idf, [...df.keys()].sort());
  }

  expand(terms: string[]): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    for (const t of terms) {
      if (this.idf.has(t)) {
        out.push([t, 1.0]);
        continue;
      }
      if (t.length < 4) continue;
      for (const v of this.vocab) {
        if (v.length > t.length && v.startsWith(t)) {
          out.push([v, 0.5]);
          continue;
        }
        const cpl = commonPrefixLen(t, v);
        if (cpl >= 5 && t.length - cpl <= 3 && v.length - cpl <= 3) out.push([v, 0.5]);
      }
    }
    return out;
  }

  score(docIndex: number, weighted: Array<[string, number]>): number {
    const tf = this.docTf[docIndex];
    const dl = this.docLen[docIndex];
    if (!tf || tf.size === 0) return 0;
    const denom = BM25_K1 * (1 - BM25_B + BM25_B * (this.avgdl ? dl / this.avgdl : 0));
    let total = 0;
    for (const [term, qw] of weighted) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      total += qw * (this.idf.get(term) ?? 0) * (f * (BM25_K1 + 1)) / (f + denom);
    }
    return total;
  }
}
