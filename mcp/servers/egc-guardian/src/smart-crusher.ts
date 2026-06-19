export interface CrushResult {
  crushed: string;
  rows_before: number;
  rows_after: number;
  savings_pct: number;
}

const MIN_ROWS_TO_ANALYZE = 5;
const MAX_ROWS_AFTER_CRUSH = 10;
const VARIANCE_THRESHOLD = 0.15;

function columnCardinality(rows: Record<string, unknown>[], key: string): number {
  const values = new Set<string>();
  for (const row of rows) {
    const v = row[key];
    values.add(v === null || v === undefined ? '__null__' : String(v));
  }
  return values.size / rows.length;
}

function rowSignature(row: Record<string, unknown>, keys: string[]): string {
  return keys.map(k => {
    const v = row[k];
    return v === null || v === undefined ? '' : String(v).slice(0, 32);
  }).join('|');
}

export function crushJsonArray(text: string): CrushResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  const rows = parsed.filter(r => r !== null && typeof r === 'object') as Record<string, unknown>[];
  if (rows.length < MIN_ROWS_TO_ANALYZE) return null;

  const allKeys = [...new Set(rows.flatMap(r => Object.keys(r)))];

  // Keep columns with meaningful variance (high cardinality = important)
  const importantKeys = allKeys.filter(k => columnCardinality(rows, k) >= VARIANCE_THRESHOLD);
  const scoreKeys = importantKeys.length > 0 ? importantKeys : allKeys;

  // Deduplicate by signature on important keys
  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];
  for (const row of rows) {
    const sig = rowSignature(row, scoreKeys);
    if (!seen.has(sig)) {
      seen.add(sig);
      unique.push(row);
    }
  }

  // Cap at MAX_ROWS_AFTER_CRUSH, keeping first and last items for context
  let final = unique;
  if (unique.length > MAX_ROWS_AFTER_CRUSH) {
    const head = unique.slice(0, Math.floor(MAX_ROWS_AFTER_CRUSH / 2));
    const tail = unique.slice(-(MAX_ROWS_AFTER_CRUSH - head.length));
    final = [...head, ...tail];
  }

  if (final.length >= rows.length) return null;

  const crushed = JSON.stringify(final, null, 2);
  const savingsPct = Math.round((1 - final.length / rows.length) * 100);

  return {
    crushed,
    rows_before: rows.length,
    rows_after: final.length,
    savings_pct: savingsPct,
  };
}
