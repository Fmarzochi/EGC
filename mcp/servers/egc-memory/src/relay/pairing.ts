import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { Bonjour } from 'bonjour-service';
import type { Service } from 'bonjour-service';

import type { SyncConfig } from '../sync/SyncBackend';
import { writeTeamConfig } from '../sync/TeamSync';
import { pickAddress } from './discovery';
import { writeMeshConfig } from './mesh-config';
import { newHexId, openBox, sealBox } from './protocol';

// A new machine joins the team by a short code. The machine that is in the
// team invites (it listens on the local network and says so by mDNS); the
// new one joins (it finds the invitation, or is given its address). The two
// exchange X25519 public keys, and each shows six digits taken from the
// shared secret and the two keys: the same six digits on both screens, or
// someone stands in the middle and the person says no on either side. Only
// after both said yes does the team configuration (the team key with it,
// and the address of the central when there is one) cross, sealed with a key
// of the exchange. Nothing of this needs the central or a library: X25519
// and AES-GCM are in Node.
export const PAIR_SERVICE_TYPE = 'egc-pair';
export const PAIR_PROTOCOL_VERSION = 1;
export const PAIR_TIMEOUT_MS = 5 * 60 * 1000;
export const PAIR_DISCOVERY_MS = 3000;
const CODE_MODULUS = 1_000_000;
const MAX_LINE_BYTES = 64 * 1024;
const PUBLIC_KEY_BYTES = 32;
const DONE_GRACE_MS = 10_000;
const MAX_SERVICE_NAME = 63;

export interface PairingKeys {
  publicKey: Buffer;
  privateKey: crypto.KeyObject;
}

export function newPairingKeys(): PairingKeys {
  const pair = crypto.generateKeyPairSync('x25519');
  return { publicKey: rawPublicKey(pair.publicKey), privateKey: pair.privateKey };
}

// The 32 raw bytes of an X25519 public key: the tail of its SPKI encoding.
function rawPublicKey(key: crypto.KeyObject): Buffer {
  const der = key.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - PUBLIC_KEY_BYTES));
}

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function publicKeyFromRaw(raw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), type: 'spki', format: 'der' });
}

export function sharedSecret(mine: PairingKeys, theirs: Buffer): Buffer {
  return crypto.diffieHellman({ privateKey: mine.privateKey, publicKey: publicKeyFromRaw(theirs) });
}

// The two public keys in one order, whichever side derives: the code and
// the seal key are the same on both screens.
function exchangeSalt(one: Buffer, other: Buffer): Buffer {
  return Buffer.compare(one, other) <= 0 ? Buffer.concat([one, other]) : Buffer.concat([other, one]);
}

// Six digits of the exchange, shown on both screens; a key in the middle
// gives each screen a different exchange, so different digits.
export function pairingCode(shared: Buffer, one: Buffer, other: Buffer): string {
  const digest = Buffer.from(crypto.hkdfSync('sha256', shared, exchangeSalt(one, other), 'egc-pair-code', 4));
  return String(digest.readUInt32BE(0) % CODE_MODULUS).padStart(6, '0');
}

export function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function pairingSealKey(shared: Buffer, one: Buffer, other: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', shared, exchangeSalt(one, other), 'egc-pair-seal', 32));
}

type Frame =
  | { t: 'hello'; v: number; pub: string }
  | { t: 'confirm' }
  | { t: 'abort'; reason?: string }
  | { t: 'team'; id: string; box: string }
  | { t: 'done' };

function parseFrame(line: string): Frame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const frame = parsed as Record<string, unknown>;
  switch (frame.t) {
    case 'hello':
      return frame.v === PAIR_PROTOCOL_VERSION && typeof frame.pub === 'string' ? { t: 'hello', v: frame.v, pub: frame.pub } : null;
    case 'confirm':
    case 'done':
      return { t: frame.t };
    case 'abort':
      return { t: 'abort', reason: typeof frame.reason === 'string' ? frame.reason.slice(0, 200) : undefined };
    case 'team':
      return typeof frame.id === 'string' && typeof frame.box === 'string' ? { t: 'team', id: frame.id, box: frame.box } : null;
    default:
      return null;
  }
}

function publicKeyOf(frame: { pub: string }): Buffer | null {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(frame.pub)) return null;
  const raw = Buffer.from(frame.pub, 'base64');
  return raw.length === PUBLIC_KEY_BYTES ? raw : null;
}

// One side of the exchange over a socket: frames in and out as JSON lines,
// with a budget for the whole conversation.
class Wire {
  private buffer = '';
  private readonly queue: Frame[] = [];
  private readonly waiting: Array<(frame: Frame | null) => void> = [];
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly socket: net.Socket, timeoutMs: number) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('close', () => this.end());
    socket.on('error', () => this.end());
    this.timer = setTimeout(() => this.end(), timeoutMs);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.end();
      return;
    }
    let at = this.buffer.indexOf('\n');
    while (at !== -1) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line) this.deliver(parseFrame(line));
      at = this.buffer.indexOf('\n');
    }
  }

  private deliver(frame: Frame | null): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter(frame);
    else if (frame) this.queue.push(frame);
  }

  // The next frame, or null when the wire closed or the budget ran out.
  next(): Promise<Frame | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() ?? null);
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => this.waiting.push(resolve));
  }

  send(frame: Frame): void {
    if (!this.closed && !this.socket.destroyed) this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    for (const waiter of this.waiting.splice(0)) waiter(null);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
}

export interface PairOutcome {
  paired: boolean;
  // Why not, in words for the person; null when paired.
  reason: string | null;
}

// The configuration of the team as the CLI keeps it: the sync settings and
// the switch of the sync around the session.
export type TeamConfig = SyncConfig & { autosync?: boolean };

export interface InviteOptions {
  team: TeamConfig;
  central: string | null;
  host?: string;
  port?: number;
  announce?: boolean;
  name?: string;
  timeoutMs?: number;
  // The person, asked whether the other screen shows the same code.
  confirm: (code: string) => Promise<boolean>;
  onReady?: (info: { port: number; addresses: string[]; announced: boolean }) => void;
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

// The addresses of this machine on its networks, for the person to type on
// the other machine when the invitation is not found.
export function lanAddresses(): string[] {
  const found: string[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal && address.family === 'IPv4') found.push(address.address);
    }
  }
  return found;
}

function refused(reason: string): PairOutcome {
  return { paired: false, reason };
}

// The machine in the team waits for one new machine, shows the code, and
// hands the team over once both sides said yes.
export async function invite(options: InviteOptions): Promise<PairOutcome> {
  const timeoutMs = options.timeoutMs ?? PAIR_TIMEOUT_MS;
  const keys = newPairingKeys();
  const server = net.createServer();
  const host = options.host ?? '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  const wildcard = WILDCARD_HOSTS.has(host);
  const announcement = options.announce !== false && wildcard ? announceInvitation(port, options.name) : null;
  options.onReady?.({ port, addresses: wildcard ? lanAddresses() : [host], announced: announcement !== null });

  const outcome = await new Promise<PairOutcome>(resolve => {
    let taken = false;
    const deadline = setTimeout(() => resolve(refused('no machine joined in time')), timeoutMs);
    server.on('connection', socket => {
      if (taken) {
        socket.end(`${JSON.stringify({ t: 'abort', reason: 'another machine is pairing' })}\n`);
        return;
      }
      taken = true;
      clearTimeout(deadline);
      hostExchange(new Wire(socket, timeoutMs), keys, options).then(resolve, error => resolve(refused(error instanceof Error ? error.message : String(error))));
    });
  });
  await announcement?.stop();
  await new Promise<void>(resolve => server.close(() => resolve()));
  return outcome;
}

async function hostExchange(wire: Wire, keys: PairingKeys, options: InviteOptions): Promise<PairOutcome> {
  try {
    const hello = await wire.next();
    const theirs = hello?.t === 'hello' ? publicKeyOf(hello) : null;
    if (!theirs) return refused('the other machine did not start the exchange');
    wire.send({ t: 'hello', v: PAIR_PROTOCOL_VERSION, pub: keys.publicKey.toString('base64') });
    const shared = sharedSecret(keys, theirs);
    const code = pairingCode(shared, keys.publicKey, theirs);
    // The other side answers while the person reads the code here; the
    // team crosses only with a yes from both.
    const [mine, answer] = await Promise.all([options.confirm(code), wire.next()]);
    if (!mine) {
      wire.send({ t: 'abort', reason: 'refused on the inviting machine' });
      return refused('you said the codes differ: nothing was shared');
    }
    if (answer?.t !== 'confirm') {
      return refused(answer?.t === 'abort' ? 'the other machine said the codes differ: nothing was shared' : 'the other machine left before confirming');
    }
    const id = newHexId();
    const address = { from: keys.publicKey.toString('base64'), to: theirs.toString('base64'), id };
    wire.send({ t: 'team', id, box: sealBox(pairingSealKey(shared, keys.publicKey, theirs), address, { type: 'team', body: { team: options.team, central: options.central } }) });
    const done = await Promise.race([wire.next(), new Promise<null>(resolve => setTimeout(() => resolve(null), DONE_GRACE_MS).unref())]);
    return done?.t === 'done' ? { paired: true, reason: null } : refused('the team was sent, and the other machine did not say it was written');
  } finally {
    wire.end();
  }
}

export interface FoundInvitation {
  name: string;
  address: string;
}

function announceInvitation(port: number, name?: string): { stop(): Promise<void> } {
  const bonjour = new Bonjour({}, () => undefined);
  const label = (name ?? `EGC pairing on ${os.hostname().split('.')[0] || 'machine'}`).slice(0, MAX_SERVICE_NAME);
  bonjour.publish({ name: label, type: PAIR_SERVICE_TYPE, protocol: 'tcp', port, txt: { v: String(PAIR_PROTOCOL_VERSION) } });
  return {
    stop: () => new Promise<void>(resolve => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        bonjour.destroy();
        resolve();
      };
      bonjour.unpublishAll(finish);
      setTimeout(finish, 1000).unref();
    }),
  };
}

// The invitations on the local network, by address.
export async function discoverInvitations(timeoutMs: number = PAIR_DISCOVERY_MS): Promise<FoundInvitation[]> {
  const bonjour = new Bonjour({}, () => undefined);
  const found = new Map<string, FoundInvitation>();
  const browser = bonjour.find({ type: PAIR_SERVICE_TYPE, protocol: 'tcp' }, (service: Service) => {
    const host = pickAddress(service);
    if (!host || !Number.isInteger(service.port) || service.port < 1) return;
    found.set(`${host}:${service.port}`, { name: service.name, address: `${host}:${service.port}` });
  });
  await new Promise(resolve => setTimeout(resolve, timeoutMs));
  browser.stop();
  bonjour.destroy();
  return [...found.values()].sort((left, right) => left.address.localeCompare(right.address));
}

export interface JoinOptions {
  address?: string;
  timeoutMs?: number;
  discoveryMs?: number;
  confirm: (code: string) => Promise<boolean>;
  onFound?: (invitations: FoundInvitation[]) => void;
  // Where the team lands; the files of the home by default.
  write?: (team: TeamConfig, central: string | null) => void;
}

export interface JoinOutcome extends PairOutcome {
  team: { backend: string; remote: string; branch: string } | null;
  central: string | null;
}

function joinRefused(reason: string): JoinOutcome {
  return { paired: false, reason, team: null, central: null };
}

const HEX_KEY_RE = /^[0-9a-f]{64}$/i;

// What an invitation hands over, checked before anything is written.
function cleanTeam(value: unknown): { team: TeamConfig; central: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const team = body.team as Record<string, unknown> | undefined;
  if (!team || typeof team !== 'object') return null;
  const { backend, remote, branch, teamKey } = team;
  if (typeof backend !== 'string' || typeof remote !== 'string' || typeof branch !== 'string' || typeof teamKey !== 'string' || !HEX_KEY_RE.test(teamKey)) return null;
  const central = typeof body.central === 'string' && body.central ? body.central : null;
  // The sync around the session is on for a machine that joins, as it is
  // for one that runs init.
  const handed: TeamConfig = { backend, remote, branch, teamKey, autosync: true };
  return { team: handed, central };
}

function writeTeam(team: TeamConfig, central: string | null): void {
  writeTeamConfig(team);
  if (central) writeMeshConfig(central);
}

function parseAddress(address: string): { host: string; port: number } | null {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(address.trim());
  if (!match) return null;
  const port = Number(match[3]);
  return port >= 1 && port <= 65535 ? { host: match[1] ?? match[2], port } : null;
}

async function resolveInvitation(options: JoinOptions): Promise<{ host: string; port: number } | JoinOutcome> {
  if (options.address) {
    return parseAddress(options.address) ?? joinRefused(`${options.address} is not a host:port`);
  }
  const invitations = await discoverInvitations(options.discoveryMs);
  options.onFound?.(invitations);
  if (invitations.length === 0) return joinRefused('no invitation answered on the local network: run egc team invite on a machine of the team, or give its address');
  if (invitations.length > 1) return joinRefused(`several invitations answered (${invitations.map(found => found.address).join(', ')}): give the address of the one you mean`);
  return parseAddress(invitations[0].address) ?? joinRefused('the invitation gave no usable address');
}

// The new machine: finds the invitation, shows the code, and writes the
// team it receives once both sides said yes.
export async function join(options: JoinOptions): Promise<JoinOutcome> {
  const target = await resolveInvitation(options);
  if ('paired' in target) return target;
  const timeoutMs = options.timeoutMs ?? PAIR_TIMEOUT_MS;
  const keys = newPairingKeys();
  const socket = net.connect({ host: target.host, port: target.port });
  const wire = new Wire(socket, timeoutMs);
  try {
    const connected = await new Promise<boolean>(resolve => {
      socket.once('connect', () => resolve(true));
      socket.once('error', () => resolve(false));
    });
    if (!connected) return joinRefused(`${target.host}:${target.port} did not answer`);
    wire.send({ t: 'hello', v: PAIR_PROTOCOL_VERSION, pub: keys.publicKey.toString('base64') });
    const hello = await wire.next();
    if (hello?.t === 'abort') return joinRefused(hello.reason ?? 'the invitation refused');
    const theirs = hello?.t === 'hello' ? publicKeyOf(hello) : null;
    if (!theirs) return joinRefused('the inviting machine did not answer the exchange');
    const shared = sharedSecret(keys, theirs);
    const code = pairingCode(shared, keys.publicKey, theirs);
    if (!(await options.confirm(code))) {
      wire.send({ t: 'abort', reason: 'refused on the joining machine' });
      return joinRefused('you said the codes differ: nothing was written');
    }
    wire.send({ t: 'confirm' });
    const frame = await wire.next();
    if (frame?.t !== 'team') {
      return joinRefused(frame?.t === 'abort' ? 'the inviting machine said the codes differ: nothing was written' : 'the inviting machine left before sharing the team');
    }
    const opened = openBox(pairingSealKey(shared, keys.publicKey, theirs), { from: theirs.toString('base64'), to: keys.publicKey.toString('base64'), id: frame.id }, frame.box);
    const handed = opened?.message.type === 'team' ? cleanTeam(opened.message.body) : null;
    if (!handed) return joinRefused('what the inviting machine sent did not open as a team: nothing was written');
    (options.write ?? writeTeam)(handed.team, handed.central);
    wire.send({ t: 'done' });
    return { paired: true, reason: null, team: { backend: handed.team.backend, remote: handed.team.remote, branch: handed.team.branch }, central: handed.central };
  } finally {
    wire.end();
  }
}
