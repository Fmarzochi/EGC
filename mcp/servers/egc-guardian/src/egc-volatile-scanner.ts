export type VolatileLabel = 'uuid' | 'iso8601' | 'jwt' | 'hex_hash';

export interface VolatileFinding {
  label: VolatileLabel;
  sample: string;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_HASH_LENGTHS = new Set([32, 40, 64]);
const HEX_ALPHABET_RE = /^[0-9a-f]+$/i;
const ISO_DATE_MIN_LEN = 8;

const ISO_RE = /\d{4}-\d{2}-\d{2}(?:T[\d:+\-.Z]+)?/g;

function isJwtShape(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  return parts.every(p => p.length >= 4);
}

function isHexHash(token: string): boolean {
  return HEX_HASH_LENGTHS.has(token.length) && HEX_ALPHABET_RE.test(token);
}

function addFinding(findings: VolatileFinding[], seen: Set<string>, key: string, label: VolatileLabel, sample: string): void {
  if (!seen.has(key)) {
    seen.add(key);
    findings.push({ label, sample });
  }
}

export function scanVolatile(text: string): VolatileFinding[] {
  const findings: VolatileFinding[] = [];
  const seen = new Set<string>();

  for (const m of text.match(UUID_RE) ?? []) {
    addFinding(findings, seen, `uuid:${m.toLowerCase()}`, 'uuid', m.slice(0, 36));
  }

  for (const m of text.match(ISO_RE) ?? []) {
    if (m.length >= ISO_DATE_MIN_LEN) {
      addFinding(findings, seen, `iso:${m}`, 'iso8601', m.slice(0, 24));
    }
  }

  const tokens = text.split(/[\s,;'"()[\]{}]+/).filter(Boolean);
  for (const token of tokens) {
    if (isJwtShape(token)) {
      addFinding(findings, seen, `jwt:${token.slice(0, 16)}`, 'jwt', `${token.slice(0, 20)}...`);
      continue;
    }
    if (isHexHash(token)) {
      addFinding(findings, seen, `hex:${token}`, 'hex_hash', `${token.slice(0, 16)}...`);
    }
  }

  return findings;
}
