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
