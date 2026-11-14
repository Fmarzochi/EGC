import crypto from 'node:crypto';
import path from 'node:path';

import { decryptState, encryptState } from '../encryption';

// State that leaves the machine travels sealed with the team key: the
// plaintext is encrypted (AES-256-GCM, the same primitive as the state at
// rest) under a key derived for encryption, and the ciphertext together with
// the file's path in the shared repository is signed (HMAC-SHA256) under a
// key derived for signing, so a sync file that was not produced by a holder
// of the team key, was altered in the repository, or was copied to another
// path opens as nothing.
export const TEAM_ENVELOPE_VERSION = 2;
export const TEAM_KEY_HEX_RE = /^[0-9a-f]{64}$/i;

export function parseTeamKey(value: unknown): Buffer | null {
  return typeof value === 'string' && TEAM_KEY_HEX_RE.test(value) ? Buffer.from(value, 'hex') : null;
}

export function generateTeamKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

// The repository path of a state file: the host's separator becomes the
// repository's, and nothing else is rewritten, so two distinct local names
// never share one authenticated path.
export function envelopePath(relativePath: string): string {
  return path.sep === '/' ? relativePath : relativePath.replaceAll(path.sep, '/');
}

function derivedKey(teamKey: Buffer, purpose: 'encrypt' | 'sign' | 'marker'): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', teamKey, '', `egc-team-envelope-${purpose}`, 32));
}

// The file at the root of the shared repository that names its team: the
// HMAC-SHA256 of a fixed text under a key derived from the team key for this
// purpose alone (#2080). It proves a key is the team's before any state file
// is read, and nothing in it lets anyone recover the key.
export const TEAM_MARKER_FILE = 'TEAM';
const TEAM_MARKER_SUBJECT = 'egc-team-key-marker';

export function teamKeyMarker(teamKey: Buffer): string {
  return crypto.createHmac('sha256', derivedKey(teamKey, 'marker')).update(TEAM_MARKER_SUBJECT, 'utf8').digest('hex');
}

// Whether a marker file's text is the marker of this key: a comparison in
// constant time of the 64 hex characters, anything else is no match.
export function markerMatches(text: string, teamKey: Buffer): boolean {
  const given = text.trim();
  if (!TEAM_KEY_HEX_RE.test(given)) return false;
  return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(teamKeyMarker(teamKey), 'hex'));
}

function signature(teamKey: Buffer, envelopeRelativePath: string, data: Buffer): Buffer {
  return crypto.createHmac('sha256', derivedKey(teamKey, 'sign'))
    .update(envelopeRelativePath, 'utf8')
    .update(Buffer.from([0]))
    .update(data)
    .digest();
}

export function sealEnvelope(plaintext: string, teamKey: Buffer, relativePath: string): string {
  const boundPath = envelopePath(relativePath);
  const data = encryptState(plaintext, derivedKey(teamKey, 'encrypt'));
  const envelope = {
    egcTeamEnvelope: TEAM_ENVELOPE_VERSION,
    path: boundPath,
    data: data.toString('base64'),
    mac: signature(teamKey, boundPath, data).toString('hex'),
  };
  return `${JSON.stringify(envelope)}\n`;
}

export function openEnvelope(text: string, teamKey: Buffer, relativePath: string): string | null {
  let parsed: { egcTeamEnvelope?: unknown; path?: unknown; data?: unknown; mac?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed?.egcTeamEnvelope !== TEAM_ENVELOPE_VERSION || parsed.path !== envelopePath(relativePath)) return null;
  if (typeof parsed.data !== 'string' || typeof parsed.mac !== 'string' || !TEAM_KEY_HEX_RE.test(parsed.mac)) return null;
  const data = Buffer.from(parsed.data, 'base64');
  const expected = signature(teamKey, parsed.path, data);
  const given = Buffer.from(parsed.mac, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    return decryptState(data, derivedKey(teamKey, 'encrypt'));
  } catch {
    return null;
  }
}
