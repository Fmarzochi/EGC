export interface ReduceResult {
  crushed: string;
  rows_before: number;
  rows_after: number;
  savings_pct: number;
}

const MIN_ROWS_TO_ANALYZE = 5;
const MAX_ROWS_AFTER_CRUSH = 10;
const VARIANCE_THRESHOLD = 0.15;

function toKey(v: unknown): string {
  if (v === null || v === undefined) return '__null__';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v); // NOSONAR: object values are stringified as JSON on the previous line
}

function columnCardinality(rows: Record<string, unknown>[], key: string): number {
  const values = new Set<string>();
  for (const row of rows) values.add(toKey(row[key]));
  return values.size / rows.length;
}

function rowSignature(row: Record<string, unknown>, keys: string[]): string {
  return keys.map(k => toKey(row[k]).slice(0, 32)).join('|');
}

function reduceRows(rows: Record<string, unknown>[]): Record<string, unknown>[] | null {
  if (rows.length < MIN_ROWS_TO_ANALYZE) return null;

  const allKeys = [...new Set(rows.flatMap(r => Object.keys(r)))];

  const importantKeys = allKeys.filter(k => columnCardinality(rows, k) >= VARIANCE_THRESHOLD);
  const scoreKeys = importantKeys.length > 0 ? importantKeys : allKeys;

  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];
  for (const row of rows) {
    const sig = rowSignature(row, scoreKeys);
    if (!seen.has(sig)) {
      seen.add(sig);
      unique.push(row);
    }
  }

  let final = unique;
  if (unique.length > MAX_ROWS_AFTER_CRUSH) {
    const head = unique.slice(0, Math.floor(MAX_ROWS_AFTER_CRUSH / 2));
    const tail = unique.slice(-(MAX_ROWS_AFTER_CRUSH - head.length));
    final = [...head, ...tail];
  }

  return final.length >= rows.length ? null : final;
}

function objectRows(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.filter(r => r !== null && typeof r === 'object' && !Array.isArray(r)) as Record<string, unknown>[];
  return rows.length >= MIN_ROWS_TO_ANALYZE ? rows : null;
}

// The bulk of a REST or CLI payload is almost never the top-level value: it
// is a list nested one key down, beside a handful of small scalars
// (`{"items": [...], "totalCount": 812}`, `{"workflow_runs": [...]}`,
// `{"jobs": [...]}`). Requiring an array at the very top meant every one of
// those passed through at full size. The largest such list is reduced and
// everything around it is preserved, so counts and pagination cursors still
// read correctly.
function largestNestedList(parsed: Record<string, unknown>): { key: string; rows: Record<string, unknown>[] } | null {
  let best: { key: string; rows: Record<string, unknown>[] } | null = null;
  for (const [key, value] of Object.entries(parsed)) {
    const rows = objectRows(value);
    if (rows && (!best || rows.length > best.rows.length)) best = { key, rows };
  }
  return best;
}

export function reduceJsonArray(text: string): ReduceResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    const rows = objectRows(parsed);
    if (!rows) return null;
    const final = reduceRows(rows);
    if (!final) return null;
    return {
      crushed: JSON.stringify(final, null, 2),
      rows_before: rows.length,
      rows_after: final.length,
      savings_pct: Math.round((1 - final.length / rows.length) * 100),
    };
  }

  if (parsed === null || typeof parsed !== 'object') return null;

  const target = largestNestedList(parsed as Record<string, unknown>);
  if (!target) return null;
  const final = reduceRows(target.rows);
  if (!final) return null;

  return {
    crushed: JSON.stringify({ ...(parsed as Record<string, unknown>), [target.key]: final }, null, 2),
    rows_before: target.rows.length,
    rows_after: final.length,
    savings_pct: Math.round((1 - final.length / target.rows.length) * 100),
  };
}
