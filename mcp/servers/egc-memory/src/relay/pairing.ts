import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { Bonjour } from 'bonjour-service';
import type { Service } from 'bonjour-service';

import type { SyncConfig } from '../sync/SyncBackend';
import { TEAM_CONFIG_PATH, writeTeamConfig } from '../sync/TeamSync';
import { pickAddress } from './discovery';
import { clearMeshConfig, writeMeshConfig } from './mesh-config';
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
// Frames kept for a side that has not asked for the next one yet (the
// person is reading the code); a peer that sends more is cut off.
const MAX_QUEUED_FRAMES = 8;
// How long a connection has to say hello before the invitation is free again.
const HELLO_TIMEOUT_MS = 10_000;
// Connections kept open while they have not said hello yet; one more is
// turned away at once, so a peer holding sockets cannot fill the listener.
const MAX_PENDING_WIRES = 8;

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

// Null for 32 bytes that are not a key of the curve: the exchange is
// refused, nothing derived from it.
function sharedSecretOrNull(mine: PairingKeys, theirs: Buffer): Buffer | null {
  try {
    return sharedSecret(mine, theirs);
  } catch {
    return null;
  }
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
  private readonly closeWatchers: Array<() => void> = [];
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly socket: net.Socket, timeoutMs: number) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('close', () => this.end());
    socket.on('error', () => this.end());
    this.timer = setTimeout(() => this.end(), timeoutMs);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onData(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.end();
      return;
    }
    let at = this.buffer.indexOf('\n');
    while (at !== -1 && !this.closed) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line) this.deliver(parseFrame(line));
      at = this.buffer.indexOf('\n');
    }
  }

  // A frame to whoever waits for one, or kept for the next call; a peer
  // that sends more than a reading person can take is cut off.
  private deliver(frame: Frame | null): void {
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter(frame);
      return;
    }
    if (!frame) return;
    if (this.queue.length >= MAX_QUEUED_FRAMES) {
      this.end();
      return;
    }
    this.queue.push(frame);
  }

  // The next frame, or null once the wire closed or the budget ran out: a
  // frame that arrived before the close is not read after it.
  next(): Promise<Frame | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() ?? null);
    return new Promise(resolve => this.waiting.push(resolve));
  }

  // Settles when the wire closes, for a wait on the person to stop with it.
  whenClosed(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise(resolve => this.closeWatchers.push(resolve));
  }

  send(frame: Frame): void {
    if (!this.closed && !this.socket.destroyed) this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.queue.splice(0);
    for (const waiter of this.waiting.splice(0)) waiter(null);
    for (const watcher of this.closeWatchers.splice(0)) watcher();
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
}

// The answer of the person, or false once the wire closed (the other
// machine left, or the budget ran out): nobody waits on a question whose
// answer no longer matters. isClosed tells the two apart.
function confirmWhileOpen(wire: Wire, confirm: (code: string) => Promise<boolean>, code: string): Promise<boolean> {
  return Promise.race([confirm(code), wire.whenClosed().then(() => false)]);
}

// The public key of a connection that says hello in time, or null for one
// that does not: a connection alone takes no invitation.
async function awaitHello(wire: Wire, timeoutMs: number): Promise<Buffer | null> {
  const hello = await Promise.race([wire.next(), new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs).unref())]);
  return hello?.t === 'hello' ? publicKeyOf(hello) : null;
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
      if (address.internal) continue;
      // IPv4 as it is; IPv6 only when routable (a link-local address needs a
      // zone the other machine cannot type).
      if (address.family === 'IPv4' || (address.family === 'IPv6' && !address.address.toLowerCase().startsWith('fe80'))) found.push(address.address);
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
  // The addresses as the person types them before the port: an IPv6 one in brackets.
  const shown = wildcard ? lanAddresses() : [host.includes(':') ? `[${host}]` : host];
  options.onReady?.({ port, addresses: shown, announced: announcement !== null });

  const wires = new Set<Wire>();
  let closing = false;
  const outcome = await new Promise<PairOutcome>(resolve => {
    let taken = false;
    // Why a new connection is turned away at once: the invitation is taken
    // or closing, or as many connections as allowed still have to say hello.
    const turnAway = (): string | null => {
      if (closing || taken) return 'another machine is pairing';
      if (wires.size >= MAX_PENDING_WIRES) return 'the invitation is busy';
      return null;
    };
    const deadline = setTimeout(() => resolve(refused('no machine joined in time')), timeoutMs);
    const failed = (error: unknown): void => resolve(refused(error instanceof Error ? error.message : String(error)));
    // The invitation goes to the first connection that says hello in time;
    // one that only holds the socket is dropped, and the next may come.
    const admit = async (wire: Wire): Promise<void> => {
      const theirs = await awaitHello(wire, HELLO_TIMEOUT_MS);
      if (!theirs || taken) {
        if (theirs) wire.send({ t: 'abort', reason: 'another machine is pairing' });
        wire.end();
        return;
      }
      taken = true;
      clearTimeout(deadline);
      resolve(await hostExchange(wire, theirs, keys, options));
    };
    server.on('connection', socket => {
      const reason = turnAway();
      if (reason) {
        socket.end(`${JSON.stringify({ t: 'abort', reason })}\n`);
        return;
      }
      const wire = new Wire(socket, timeoutMs);
      wires.add(wire);
      wire.whenClosed().then(() => { wires.delete(wire); }, () => undefined);
      admit(wire).catch(failed);
    });
  });
  // No connection is let in from here on: the listener closes before the
  // announcement goes, and the wires still open are ended, so the close
  // does not wait on a late connection.
  closing = true;
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  for (const wire of wires) wire.end();
  await announcement?.stop();
  await closed;
  return outcome;
}

async function hostExchange(wire: Wire, theirs: Buffer, keys: PairingKeys, options: InviteOptions): Promise<PairOutcome> {
  try {
    wire.send({ t: 'hello', v: PAIR_PROTOCOL_VERSION, pub: keys.publicKey.toString('base64') });
    const shared = sharedSecretOrNull(keys, theirs);
    if (!shared) return refused('the key the other machine sent is not a valid key: nothing was shared');
    const code = pairingCode(shared, keys.publicKey, theirs);
    // The person reads the code here while the other side answers; the wait
    // ends with the wire, and the team crosses only with a yes from both.
    const mine = await confirmWhileOpen(wire, options.confirm, code);
    if (!mine) {
      if (wire.isClosed) return refused('the other machine left before you answered: nothing was shared');
      wire.send({ t: 'abort', reason: 'refused on the inviting machine' });
      return refused('you said the codes differ: nothing was shared');
    }
    const answer = await wire.next();
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
    // Only an invitation of this protocol version: a stale announcement of
    // another version is not an invitation this machine can take.
    const version = (service.txt as Record<string, unknown> | undefined)?.v;
    if (String(version) !== String(PAIR_PROTOCOL_VERSION)) return;
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

// The team and its central land together: the team first, the central
// next, and a central that will not be written puts the team file back as it
// was, so a failure never leaves half a join. A team without a central clears
// the central a previous team left, so the bridge does not go back to it.
function writeTeam(team: TeamConfig, central: string | null): void {
  // Only a regular file is read and kept for the rollback: a pipe or a
  // link in its place is refused before anything is read or written.
  let stat: fs.Stats | null;
  try {
    stat = fs.lstatSync(TEAM_CONFIG_PATH);
  } catch {
    stat = null;
  }
  if (stat && !stat.isFile()) throw new Error(`${TEAM_CONFIG_PATH} is not a regular file`);
  const previous = stat ? fs.readFileSync(TEAM_CONFIG_PATH) : null;
  writeTeamConfig(team);
  try {
    if (central) writeMeshConfig(central);
    else clearMeshConfig();
  } catch (error) {
    if (previous === null) fs.rmSync(TEAM_CONFIG_PATH, { force: true });
    else fs.writeFileSync(TEAM_CONFIG_PATH, previous);
    throw error;
  }
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
  const keys = newPairingKeys();
  const socket = net.connect({ host: target.host, port: target.port });
  const wire = new Wire(socket, options.timeoutMs ?? PAIR_TIMEOUT_MS);
  try {
    const connected = await new Promise<boolean>(resolve => {
      socket.once('connect', () => resolve(true));
      socket.once('error', () => resolve(false));
    });
    if (!connected) return joinRefused(`${target.host}:${target.port} did not answer`);
    return await joinExchange(wire, keys, options);
  } finally {
    wire.end();
  }
}

// The exchange from the joining side: hello, the code, a yes from the
// person while the wire is open, then the team sealed by the exchange.
async function joinExchange(wire: Wire, keys: PairingKeys, options: JoinOptions): Promise<JoinOutcome> {
  wire.send({ t: 'hello', v: PAIR_PROTOCOL_VERSION, pub: keys.publicKey.toString('base64') });
  const hello = await wire.next();
  if (hello?.t === 'abort') return joinRefused(hello.reason ?? 'the invitation refused');
  const theirs = hello?.t === 'hello' ? publicKeyOf(hello) : null;
  if (!theirs) return joinRefused('the inviting machine did not answer the exchange');
  const shared = sharedSecretOrNull(keys, theirs);
  if (!shared) return joinRefused('the key the inviting machine sent is not a valid key: nothing was written');
  const code = pairingCode(shared, keys.publicKey, theirs);
  const yes = await confirmWhileOpen(wire, options.confirm, code);
  if (!yes) {
    if (wire.isClosed) return joinRefused('the inviting machine left before you answered: nothing was written');
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
  return writeHanded(wire, handed, options);
}

// The team written where the caller keeps it; a write that fails leaves the
// machine as it was and is told as a refusal, not thrown at the person.
function writeHanded(wire: Wire, handed: { team: TeamConfig; central: string | null }, options: JoinOptions): JoinOutcome {
  try {
    (options.write ?? writeTeam)(handed.team, handed.central);
  } catch (error) {
    return joinRefused(`the team could not be written (${error instanceof Error ? error.message : String(error)}): this machine is as it was`);
  }
  wire.send({ t: 'done' });
  return { paired: true, reason: null, team: { backend: handed.team.backend, remote: handed.team.remote, branch: handed.team.branch }, central: handed.central };
}
