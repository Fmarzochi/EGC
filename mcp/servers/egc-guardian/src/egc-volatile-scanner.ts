export type VolatileLabel = 'uuid' | 'iso8601' | 'jwt' | 'hex_hash';

export interface VolatileFinding {
  label: VolatileLabel;
  sample: string;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_HASH_LENGTHS = new Set([32, 40, 64]);
const HEX_ALPHABET_RE = /^[0-9a-f]+$/i;
const ISO_DATE_MIN_LEN = 8;

const ISO_RE = /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?/g;

function isJwtShape(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  return parts.every(p => p.length >= 4);
}

function isHexHash(token: string): boolean {
  return HEX_HASH_LENGTHS.has(token.length) && HEX_ALPHABET_RE.test(token);
}

export function scanVolatile(text: string): VolatileFinding[] {
  const findings: VolatileFinding[] = [];
  const seen = new Set<string>();

  const uuidMatches = text.match(UUID_RE) ?? [];
  for (const m of uuidMatches) {
    const key = `uuid:${m.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ label: 'uuid', sample: m.slice(0, 36) });
    }
  }

  const isoMatches = text.match(ISO_RE) ?? [];
  for (const m of isoMatches) {
    if (m.length >= ISO_DATE_MIN_LEN) {
      const key = `iso:${m}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({ label: 'iso8601', sample: m.slice(0, 24) });
      }
    }
  }

  const tokens = text.split(/[\s,;'"()\[\]{}]+/).filter(Boolean);
  for (const token of tokens) {
    if (isJwtShape(token)) {
      const key = `jwt:${token.slice(0, 16)}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({ label: 'jwt', sample: token.slice(0, 20) + '...' });
      }
      continue;
    }
    if (isHexHash(token)) {
      const key = `hex:${token}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({ label: 'hex_hash', sample: token.slice(0, 16) + '...' });
      }
    }
  }

  return findings;
}
