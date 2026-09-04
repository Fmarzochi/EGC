import crypto from 'node:crypto';
import { decryptState, encryptState } from '../encryption';

// State that leaves the machine travels sealed with the team key: the
// plaintext is encrypted (AES-256-GCM, the same primitive as the state at
// rest) and the ciphertext carries an HMAC-SHA256 signature made with the
// same team key, so a sync file that was not produced by a holder of the
// key, or was altered in the shared repository, opens as nothing.
export const TEAM_ENVELOPE_VERSION = 1;
export const TEAM_KEY_HEX_RE = /^[0-9a-f]{64}$/i;

export function parseTeamKey(value: unknown): Buffer | null {
  return typeof value === 'string' && TEAM_KEY_HEX_RE.test(value) ? Buffer.from(value, 'hex') : null;
}

export function generateTeamKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

function signature(teamKey: Buffer, data: Buffer): Buffer {
  return crypto.createHmac('sha256', teamKey).update(data).digest();
}

export function sealEnvelope(plaintext: string, teamKey: Buffer): string {
  const data = encryptState(plaintext, teamKey);
  const envelope = {
    egcTeamEnvelope: TEAM_ENVELOPE_VERSION,
    data: data.toString('base64'),
    mac: signature(teamKey, data).toString('hex'),
  };
  return `${JSON.stringify(envelope)}\n`;
}

export function openEnvelope(text: string, teamKey: Buffer): string | null {
  let parsed: { egcTeamEnvelope?: unknown; data?: unknown; mac?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed?.egcTeamEnvelope !== TEAM_ENVELOPE_VERSION) return null;
  if (typeof parsed.data !== 'string' || typeof parsed.mac !== 'string' || !TEAM_KEY_HEX_RE.test(parsed.mac)) return null;
  const data = Buffer.from(parsed.data, 'base64');
  const expected = signature(teamKey, data);
  const given = Buffer.from(parsed.mac, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    return decryptState(data, teamKey);
  } catch {
    return null;
  }
}
