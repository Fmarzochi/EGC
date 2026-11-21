import crypto from 'node:crypto';

// The wire protocol between the machines of a team and the central that
// relays for them (`egc mesh serve`). The central reads only whom a frame is
// for: what a machine says travels in a box sealed with a key derived from
// the team key for the mesh alone, so a central on a rented server forwards
// what it can neither read nor forge. A machine proves it holds the team key
// by answering the central's challenge with another derived key, the only
// key the central holds. Frames are JSON text frames over a WebSocket.
export const MESH_PROTOCOL_VERSION = 1;
export const DEFAULT_MESH_PORT = 47470;
// A box carries at most a sealed state document (256 KiB, the cap of one
// document in the git sync) once encoded; a frame is a box and its address.
export const MAX_BOX_BYTES = 384 * 1024;
export const MAX_FRAME_BYTES = 512 * 1024;
// A sealed message is accepted for a day, the time the central keeps one for
// a machine that is off, and from a clock up to five minutes ahead.
export const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const BROADCAST = '*';

const HEX_ID_RE = /^[0-9a-f]{32}$/;
const PROOF_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const TS_BYTES = 8;

function meshKey(teamKey: Buffer, purpose: 'auth' | 'seal'): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', teamKey, '', `egc-mesh-${purpose}`, 32));
}

// The key the central checks a machine's answer with: knowing it opens no box.
export function meshAuthKey(teamKey: Buffer): Buffer {
  return meshKey(teamKey, 'auth');
}

// The key the machines seal their boxes with, never given to the central.
export function meshSealKey(teamKey: Buffer): Buffer {
  return meshKey(teamKey, 'seal');
}

export function newHexId(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function isHexId(value: unknown): value is string {
  return typeof value === 'string' && HEX_ID_RE.test(value);
}

export function newChallenge(): string {
  return crypto.randomBytes(32).toString('base64');
}

export function helloProof(authKey: Buffer, challenge: string, machine: string): string {
  return crypto.createHmac('sha256', authKey).update(`egc-mesh-hello\0${challenge}\0${machine}`, 'utf8').digest('hex');
}

export function proofMatches(authKey: Buffer, challenge: string, machine: string, proof: unknown): boolean {
  if (typeof proof !== 'string' || !PROOF_RE.test(proof)) return false;
  return crypto.timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(helloProof(authKey, challenge, machine), 'hex'));
}

export type MachineFrame =
  | { t: 'hello'; v: number; machine: string; proof: string }
  | { t: 'send'; v: number; to: string; id: string; box: string };

export type HubFrame =
  | { t: 'challenge'; v: number; challenge: string }
  | { t: 'welcome'; v: number; online: string[] }
  | { t: 'presence'; v: number; machine: string; online: boolean }
  | { t: 'deliver'; v: number; from: string; to: string; id: string; box: string }
  | { t: 'error'; v: number; reason: string };

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function isBox(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_BOX_BYTES && value.length % 4 === 0 && BASE64_RE.test(value);
}

function isAddress(value: unknown): value is string {
  return value === BROADCAST || isHexId(value);
}

// A frame from a machine, or null for anything the protocol does not define:
// another version, an unknown type, a field of the wrong shape.
export function parseMachineFrame(raw: string): MachineFrame | null {
  const frame = parseObject(raw);
  if (!frame || frame.v !== MESH_PROTOCOL_VERSION) return null;
  if (frame.t === 'hello' && isHexId(frame.machine) && typeof frame.proof === 'string' && PROOF_RE.test(frame.proof)) {
    return { t: 'hello', v: MESH_PROTOCOL_VERSION, machine: frame.machine, proof: frame.proof };
  }
  if (frame.t === 'send' && isAddress(frame.to) && isHexId(frame.id) && isBox(frame.box)) {
    return { t: 'send', v: MESH_PROTOCOL_VERSION, to: frame.to, id: frame.id, box: frame.box };
  }
  return null;
}

function isHexIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isHexId);
}

// A frame from the central, or null for anything the protocol does not define.
export function parseHubFrame(raw: string): HubFrame | null {
  const frame = parseObject(raw);
  if (!frame || frame.v !== MESH_PROTOCOL_VERSION) return null;
  const v = MESH_PROTOCOL_VERSION;
  switch (frame.t) {
    case 'challenge':
      return typeof frame.challenge === 'string' && frame.challenge.length > 0 ? { t: 'challenge', v, challenge: frame.challenge } : null;
    case 'welcome':
      return isHexIdList(frame.online) ? { t: 'welcome', v, online: frame.online } : null;
    case 'presence':
      return isHexId(frame.machine) && typeof frame.online === 'boolean' ? { t: 'presence', v, machine: frame.machine, online: frame.online } : null;
    case 'deliver':
      return isHexId(frame.from) && isAddress(frame.to) && isHexId(frame.id) && isBox(frame.box)
        ? { t: 'deliver', v, from: frame.from, to: frame.to, id: frame.id, box: frame.box }
        : null;
    case 'error':
      return typeof frame.reason === 'string' ? { t: 'error', v, reason: frame.reason } : null;
    default:
      return null;
  }
}

export interface MeshMessage { type: string; body: unknown }
export interface BoxAddress { from: string; to: string; id: string }

function additionalData(address: BoxAddress, ts: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`egc-mesh-box\0${MESH_PROTOCOL_VERSION}\0${address.from}\0${address.to}\0${address.id}\0`, 'utf8'), ts]);
}

// Seals a message for its address: the sender, the addressee (a machine or
// everyone) and the message id are authenticated with the moment it was
// sealed, so a box moved to another address, replayed under another id or
// altered opens as nothing.
export function sealBox(sealKey: Buffer, address: BoxAddress, message: MeshMessage, now: number = Date.now()): string {
  const ts = Buffer.alloc(TS_BYTES);
  ts.writeBigUInt64BE(BigInt(Math.trunc(now)));
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey, iv);
  cipher.setAAD(additionalData(address, ts));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ type: message.type, body: message.body }), 'utf8'), cipher.final()]);
  return Buffer.concat([ts, iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

// The message a box holds and when it was sealed, or null when the box does
// not open with this key for this address.
export function openBox(sealKey: Buffer, address: BoxAddress, box: string): { ts: number; message: MeshMessage } | null {
  if (!isBox(box)) return null;
  const bytes = Buffer.from(box, 'base64');
  if (bytes.length <= TS_BYTES + IV_BYTES + TAG_BYTES) return null;
  const ts = bytes.subarray(0, TS_BYTES);
  const iv = bytes.subarray(TS_BYTES, TS_BYTES + IV_BYTES);
  const tag = bytes.subarray(TS_BYTES + IV_BYTES, TS_BYTES + IV_BYTES + TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey, iv);
    decipher.setAAD(additionalData(address, ts));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(TS_BYTES + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    const parsed = parseObject(plaintext);
    if (!parsed || typeof parsed.type !== 'string') return null;
    return { ts: Number(ts.readBigUInt64BE()), message: { type: parsed.type, body: parsed.body } };
  } catch {
    return null;
  }
}

// What a machine accepts once a box opened: a message sealed within the last
// day and not ahead of this clock by more than the tolerated skew, and each
// message id once. Ids are forgotten when their message would be refused
// for its age anyway, so the memory of a long session stays bounded. The
// guard lives in the process that opens the boxes and knows nothing of an
// earlier one: a machine that restarts within the day takes a box it had
// already opened as new, and what that costs is one repeated notice, since
// what the boxes carry (events, locks, records merged by id) is idempotent
// on the receiving side.
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  accept(id: string, ts: number): boolean {
    const now = this.now();
    if (!Number.isFinite(ts) || ts > now + CLOCK_SKEW_MS || ts < now - MESSAGE_TTL_MS) return false;
    for (const [seenId, seenTs] of this.seen) {
      if (seenTs < now - MESSAGE_TTL_MS) this.seen.delete(seenId);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, ts);
    return true;
  }
}
