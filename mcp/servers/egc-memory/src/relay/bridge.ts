import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { RawData } from 'ws';

import { resolveHome } from '../home';
import {
  forgetRemoteMachine,
  listLiveSessions,
  listOutboundEvents,
  listRemoteSessions,
  listSharedLocks,
  recordInboundEvent,
  recordRemoteLocks,
  recordRemotePresence,
  rememberBox,
  sweepRemoteMachines,
  withBusTransaction,
} from '../session-bus';
import type { BusDb, RemoteSession, SharedEvent, SharedLock } from '../session-bus';
import { parseTeamKey } from '../sync/envelope';
import { getTeamConfig } from '../sync/TeamSync';
import { CLOSE_REPLACED } from './hub';
import { loadOrCreateMachine } from './machine';
import type { MachineIdentity } from './machine';
import { readMeshConfig } from './mesh-config';
import { privateJson, writePrivateFile } from './private-file';
import {
  BROADCAST,
  MESH_PROTOCOL_VERSION,
  ReplayGuard,
  meshAuthKey,
  meshSealKey,
  helloProof,
  newHexId,
  openBox,
  parseHubFrame,
  sealBox,
} from './protocol';
import type { MeshMessage } from './protocol';

// The bridge of this machine: the one connection to the central that every
// memory server of the machine shares. The servers elect one of them through
// a lock file; the elected one tells the central who is here (presence,
// every 30 s, sealed for the whole team) and writes what the other machines
// say about themselves into the local bus, where session_peers reads it.
// Without a central configured, or with the central down, the machine works
// alone as it always did; the bridge reconnects by itself, waiting up to 30 s
// between attempts.
export const PRESENCE_INTERVAL_MS = 30_000;
// Events and lock changes leave within a second of landing on the local bus.
export const FORWARD_INTERVAL_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const LOCK_STALE_MS = 90_000;
const RECONNECT_MIN_MS = 1_000;
const MAX_SESSIONS_IN_PRESENCE = 50;

export interface BridgeOptions {
  home: string;
  db: BusDb;
  teamKey: Buffer;
  central: string;
  machine: MachineIdentity;
  presenceMs?: number;
  forwardMs?: number;
  reconnectMaxMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  onMessage?: (from: string, message: MeshMessage) => void;
  // The write arbiter of the server, when the bridge runs inside one: what
  // the bridge writes to the bus then takes its turn with the other writers.
  enqueue?: <T>(work: () => Promise<T>) => Promise<T>;
}

export interface BridgeStatus {
  pid: number;
  machine: MachineIdentity;
  central: string;
  connected: boolean;
  online: string[];
  updatedAt: string;
}

interface PresenceBody { label: string; sessions: RemoteSession[]; locks: SharedLock[]; at: string }
interface LocksBody { locks: SharedLock[] }

function meshDir(home: string): string {
  return path.join(home, '.egc', 'mesh');
}

export function bridgeLockPath(home: string = resolveHome()): string {
  return path.join(meshDir(home), 'bridge.lock');
}

export function bridgeStatusPath(home: string = resolveHome()): string {
  return path.join(meshDir(home), 'bridge.json');
}

function writePrivateJson(file: string, value: unknown): void {
  writePrivateFile(file, privateJson(value));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface LockRecord { pid: number; token: string; heartbeatAt: string }

function readLock(file: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string' || typeof parsed.heartbeatAt !== 'string') return null;
    return parsed as LockRecord;
  } catch {
    return null;
  }
}

// The election: the lock is free when nobody holds it, when its holder's
// process is gone, or when its heartbeat is older than LOCK_STALE_MS (a
// holder that froze). The central backs this up: a second bridge of the
// same machine replaces the first, which then steps down.
export class BridgeLock {
  private readonly token = newHexId();

  constructor(private readonly home: string, private readonly now: () => number = Date.now) {}

  get file(): string {
    return bridgeLockPath(this.home);
  }

  claim(): boolean {
    try {
      const current = readLock(this.file);
      if (current && current.token !== this.token) {
        const fresh = this.now() - Date.parse(current.heartbeatAt) < LOCK_STALE_MS;
        if (fresh && (current.pid === process.pid || processAlive(current.pid))) return false;
      }
      writePrivateJson(this.file, { pid: process.pid, token: this.token, heartbeatAt: new Date(this.now()).toISOString() });
      return readLock(this.file)?.token === this.token;
    } catch {
      return false;
    }
  }

  // The heartbeat is written only while the file still carries this token
  // and read back afterwards, so a holder that lost the lock to a
  // replacement between the two steps learns it here and steps down. A
  // heartbeat that cannot be written counts as a lost lock, never as an
  // exception thrown from a timer.
  renew(): boolean {
    try {
      const current = readLock(this.file);
      if (!current || current.token !== this.token) return false;
      writePrivateJson(this.file, { ...current, heartbeatAt: new Date(this.now()).toISOString() });
      return readLock(this.file)?.token === this.token;
    } catch {
      return false;
    }
  }

  release(): void {
    try {
      if (readLock(this.file)?.token === this.token) fs.rmSync(this.file, { force: true });
    } catch {
      // a lock that cannot be removed expires by its heartbeat
    }
  }
}

export class MeshBridge {
  readonly online = new Set<string>();
  connected = false;
  private identity: MachineIdentity;
  private socket: WebSocket | null = null;
  private presenceTimer: NodeJS.Timeout | null = null;
  private forwardTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = RECONNECT_MIN_MS;
  private stopped = false;
  // What left already: the last bus event forwarded, and the locks last
  // told; the cursor starts at the top of the queue, so a bridge that
  // starts never replays what the machine said before it existed.
  private forwardCursor = 0;
  private startedAt: string | null = null;
  private lastLocksSent = '';
  private forwardRun: Promise<void> | null = null;
  private inboundChain: Promise<void> | null = null;
  private readonly replay: ReplayGuard;
  private readonly authKey: Buffer;
  private readonly sealKey: Buffer;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: BridgeOptions) {
    this.identity = options.machine;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.replay = new ReplayGuard(this.now);
    this.authKey = meshAuthKey(options.teamKey);
    this.sealKey = meshSealKey(options.teamKey);
  }

  get machine(): MachineIdentity {
    return this.identity;
  }

  get central(): string {
    return this.options.central;
  }

  // True once the bridge is down for good: after stop(), or when another
  // process of this machine took the connection over.
  get isStopped(): boolean {
    return this.stopped;
  }

  start(): void {
    this.stopped = false;
    // What the bus held before the bridge existed stays on this machine;
    // everything queued from this moment on leaves, whether the connection
    // is up yet or not. The boundary is the time of this start, taken here
    // and now, not a snapshot of the queue read later: an event written while
    // the bridge starts is after the boundary and leaves.
    if (this.startedAt === null) this.startedAt = new Date(this.now()).toISOString();
    this.connect();
  }

  // The status file says "not connected" from the first moment of the stop,
  // before the socket is closed, which can take up to a second. What the
  // bridge was writing to the bus when the stop came is finished first, so
  // the database is never closed under it.
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.writeStatus();
    if (socket && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>(resolve => {
        socket.once('close', () => resolve());
        socket.close();
        setTimeout(resolve, 1000).unref();
      });
    } else if (socket) {
      socket.terminate();
    }
    await this.settleInFlight();
    this.connected = false;
    this.writeStatus();
  }

  private async settleInFlight(): Promise<void> {
    const pending = [this.inboundChain, this.forwardRun].filter((work): work is Promise<void> => work !== null);
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>(resolve => setTimeout(resolve, 5000).unref()),
    ]);
  }

  status(): BridgeStatus {
    return {
      pid: process.pid,
      machine: this.identity,
      central: this.options.central,
      connected: this.connected,
      online: [...this.online].sort((left, right) => left.localeCompare(right)),
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  // Sends the presence of this machine now: the sessions alive on the local
  // bus, under the machine's label, sealed for everyone. The identity is
  // read again first, so a label changed with `egc mesh label` travels with
  // the next presence.
  async announce(): Promise<boolean> {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.refreshIdentity();
    const sessions = (await listLiveSessions(this.options.db, this.now())).slice(0, MAX_SESSIONS_IN_PRESENCE);
    const locks = await listSharedLocks(this.options.db, this.now());
    this.lastLocksSent = JSON.stringify(locks);
    const body: PresenceBody = { label: this.identity.label, sessions, locks, at: new Date(this.now()).toISOString() };
    this.send(BROADCAST, { type: 'presence', body });
    return true;
  }

  // What landed on the local bus for the other machines since the last
  // look: direct events for their sessions, broadcasts, and a change in the
  // locks this machine holds, told at once instead of with the next presence.
  async forward(): Promise<void> {
    if (this.forwardRun || !this.connected) return;
    this.forwardRun = this.forwardOnce().finally(() => {
      this.forwardRun = null;
    });
    await this.forwardRun;
  }

  // The cursor moves past an event only once the central has it: a
  // connection that closes mid-way leaves the cursor on the last event sent,
  // and the rest goes out after the reconnection.
  private async forwardOnce(): Promise<void> {
    const { lastId, events } = await listOutboundEvents(this.options.db, this.forwardCursor, this.startedAt);
    if (events.length > 0) {
      const remote = await listRemoteSessions(this.options.db, undefined, this.now());
      for (const event of events) {
        if (!this.forwardEvent(event, remote)) return;
        this.forwardCursor = event.event_id;
      }
    }
    this.forwardCursor = lastId;
    const locks = await listSharedLocks(this.options.db, this.now());
    const key = JSON.stringify(locks);
    if (key !== this.lastLocksSent) {
      const body: LocksBody = { locks };
      if (this.send(BROADCAST, { type: 'locks', body })) this.lastLocksSent = key;
    }
  }

  // True when the event is behind us: handed to the central, or addressed to
  // a session no machine online holds, which nobody could deliver.
  private forwardEvent(event: SharedEvent, remote: Record<string, unknown>[]): boolean {
    if (event.to_session === null) return this.send(BROADCAST, { type: 'event', body: event });
    const target = remote.find(row => row.id === event.to_session);
    if (!target || typeof target.machine_id !== 'string') return true;
    return this.send(target.machine_id, { type: 'event', body: event });
  }

  // Seals a message for one machine or for all of them and hands it to the
  // central; false when there is no connection to hand it to.
  send(to: string, message: MeshMessage): boolean {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const id = newHexId();
    const box = sealBox(this.sealKey, { from: this.identity.id, to, id }, message, this.now());
    this.socket.send(JSON.stringify({ t: 'send', v: MESH_PROTOCOL_VERSION, to, id, box }));
    return true;
  }

  private refreshIdentity(): void {
    try {
      const current = loadOrCreateMachine(this.options.home);
      if (current.id === this.identity.id) this.identity = current;
    } catch {
      // the file is unreadable right now; the identity in memory stands
    }
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.central);
    } catch (error) {
      this.log(`mesh: the central address is not usable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.socket = socket;
    // The status file is refreshed with every connection attempt, so a
    // bridge that is reconnecting through a long outage of the central is
    // still reported as alive, and as reconnecting.
    this.writeStatus();
    // The frames of a connection are handled one after the other, in the
    // order the central sent them: a presence that is being written to the
    // bus while the central says the same machine left would otherwise land
    // after the removal. The queue belongs to this connection: what a
    // connection that is no longer current still has queued is dropped, so
    // it neither delays the challenge of the next one nor touches its state.
    let inbound: Promise<void> = Promise.resolve();
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const raw = data.toString();
      inbound = inbound
        .then(() => (this.socket === socket ? this.onFrame(raw, socket) : undefined))
        .catch(error => this.log(`mesh: a frame was not handled: ${error instanceof Error ? error.message : String(error)}`));
      this.inboundChain = inbound;
    });
    socket.on('close', code => this.onClose(socket, code));
    socket.on('error', error => this.log(`mesh: connection error: ${error.message}`));
  }

  private async onFrame(raw: string, socket: WebSocket): Promise<void> {
    const frame = parseHubFrame(raw);
    if (!frame || this.socket !== socket) return;
    switch (frame.t) {
      case 'challenge':
        socket.send(JSON.stringify({ t: 'hello', v: MESH_PROTOCOL_VERSION, machine: this.identity.id, proof: helloProof(this.authKey, frame.challenge, this.identity.id) }));
        return;
      case 'welcome':
        this.connected = true;
        this.backoffMs = RECONNECT_MIN_MS;
        this.online.clear();
        for (const id of frame.online) this.online.add(id);
        this.log(`mesh: connected to ${this.options.central}, ${frame.online.length} other machine(s) online`);
        this.startPresence();
        this.writeStatus();
        return;
      case 'presence':
        if (frame.online) this.online.add(frame.machine);
        else {
          this.online.delete(frame.machine);
          await forgetRemoteMachine(this.options.db, frame.machine);
        }
        this.writeStatus();
        return;
      case 'deliver':
        await this.onDeliver(frame.from, frame.to, frame.id, frame.box);
        return;
      case 'error':
        this.log(`mesh: the central answered an error: ${frame.reason}`);
        return;
      default:
        return;
    }
  }

  // A box is taken once: the bus remembers the id for a day, so a bridge that
  // restarts or replaces this one refuses it too, and the guard in memory
  // keeps the window of the timestamps. The durable record comes first: a
  // box the database could not record is not marked as seen, so nothing is
  // lost to a write that failed.
  // A box is taken and applied as one: the id is recorded and what the box
  // said is written in one transaction, serialized with the other writers
  // of the server, so a write that fails leaves the box untaken (the guard
  // in memory forgets it too) and nothing is marked as seen and then lost.
  private async onDeliver(from: string, to: string, id: string, box: string): Promise<void> {
    if (to !== BROADCAST && to !== this.identity.id) return;
    if (from === this.identity.id) return;
    const opened = openBox(this.sealKey, { from, to, id }, box);
    if (!opened || !this.replay.accept(id, opened.ts)) return;
    const serialize = this.options.enqueue ?? (<T>(work: () => Promise<T>) => work());
    let taken: boolean;
    try {
      taken = await serialize(() => withBusTransaction(this.options.db, async () => {
        if (!(await rememberBox(this.options.db, id, this.now()))) return false;
        await this.applyMessage(from, opened.message);
        return true;
      }));
    } catch (error) {
      this.replay.forget(id);
      throw error;
    }
    if (taken) this.options.onMessage?.(from, opened.message);
  }

  // What another machine said, written into the local bus: its presence
  // (sessions and locks), a change in its locks, or an event for a session
  // here. Anything else is left to the listener.
  private async applyMessage(from: string, message: MeshMessage): Promise<void> {
    const { type, body } = message;
    if (type === 'presence') {
      const presence = body as Partial<PresenceBody> | undefined;
      const label = typeof presence?.label === 'string' ? presence.label : from.slice(0, 8);
      await recordRemotePresence(this.options.db, from, label, Array.isArray(presence?.sessions) ? presence.sessions : [], this.now());
      await recordRemoteLocks(this.options.db, from, Array.isArray(presence?.locks) ? presence.locks : []);
      this.online.add(from);
      this.writeStatus();
      return;
    }
    if (type === 'locks') {
      const locks = (body as Partial<LocksBody> | undefined)?.locks;
      await recordRemoteLocks(this.options.db, from, Array.isArray(locks) ? locks : []);
      return;
    }
    if (type === 'event') await recordInboundEvent(this.options.db, body, this.now());
  }

  // Each tick sends the presence, sweeps the machines that fell silent and
  // refreshes the status file, whose age tells `egc mesh status` whether this
  // bridge is alive.
  private startPresence(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    const tick = (): void => {
      this.announce().catch(error => this.log(`mesh: presence was not sent: ${error instanceof Error ? error.message : String(error)}`));
      sweepRemoteMachines(this.options.db, this.now()).catch(() => undefined);
      this.writeStatus();
    };
    tick();
    this.presenceTimer = setInterval(tick, this.options.presenceMs ?? PRESENCE_INTERVAL_MS);
    this.presenceTimer.unref();
    if (this.forwardTimer) clearInterval(this.forwardTimer);
    this.forwardTimer = setInterval(() => {
      this.forward().catch(error => this.log(`mesh: forwarding failed: ${error instanceof Error ? error.message : String(error)}`));
    }, this.options.forwardMs ?? FORWARD_INTERVAL_MS);
    this.forwardTimer.unref();
  }

  private onClose(socket: WebSocket, code: number): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.connected = false;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.forwardTimer) clearInterval(this.forwardTimer);
    this.presenceTimer = null;
    this.forwardTimer = null;
    this.writeStatus();
    if (this.stopped) return;
    if (code === CLOSE_REPLACED) {
      // Another bridge of this machine took over: this one steps down.
      this.log('mesh: another process of this machine holds the bridge now');
      this.stopped = true;
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.reconnectMaxMs ?? RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref();
  }

  private clearTimers(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.forwardTimer) clearInterval(this.forwardTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.presenceTimer = null;
    this.forwardTimer = null;
    this.reconnectTimer = null;
  }

  private writeStatus(): void {
    try {
      writePrivateJson(bridgeStatusPath(this.options.home), this.status());
    } catch {
      // a status that cannot be written is not worth a broken bridge
    }
  }
}

export interface StartBridgeOptions {
  db: BusDb;
  home?: string;
  log?: (line: string) => void;
  // The tests hand the key in and shorten the periods; a server reads the
  // key from team.json and runs the periods above.
  teamKey?: Buffer;
  electionMs?: number;
  presenceMs?: number;
  reconnectMaxMs?: number;
  now?: () => number;
  enqueue?: <T>(work: () => Promise<T>) => Promise<T>;
}

export interface BridgeHandle {
  // The bridge this process holds right now; null while another process of
  // the machine holds it, or while no central is configured.
  readonly bridge: MeshBridge | null;
  stop(): Promise<void>;
}

// The bridge of this server. Every period the server looks again: without a
// bridge it stands for the election, so a holder that froze is replaced by
// the next server within LOCK_STALE_MS and a central configured after the
// start is joined; with a bridge it renews the lock and checks that the
// central is still configured and the same, and steps down otherwise, which
// is how `egc mesh disconnect` reaches a running bridge. Without a team key
// the bridge stays down and the log says so once. Nothing here can keep the
// server from answering.
export function startBridgeIfElected(options: StartBridgeOptions): BridgeHandle {
  const home = options.home ?? resolveHome();
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  let bridge: MeshBridge | null = null;
  let lock: BridgeLock | null = null;
  let stopped = false;
  let warnedNoKey = false;

  const stepDown = (): Promise<void> => {
    const current = bridge;
    bridge = null;
    lock?.release();
    lock = null;
    return current ? current.stop() : Promise.resolve();
  };

  const stand = (): void => {
    const config = readMeshConfig(home);
    if (!config) return;
    const teamKey = options.teamKey ?? parseTeamKey(getTeamConfig()?.teamKey);
    if (!teamKey) {
      if (!warnedNoKey) log('mesh: a central is configured but this machine has no team key; the bridge stays down');
      warnedNoKey = true;
      return;
    }
    const candidate = new BridgeLock(home, now);
    if (!candidate.claim()) return;
    // A bridge that fails to start gives the lock back at once, so the next
    // tick (of this server or another) stands again instead of waiting for
    // the heartbeat to go stale.
    try {
      const started = new MeshBridge({ home, db: options.db, teamKey, central: config.central, machine: loadOrCreateMachine(home), log, now, presenceMs: options.presenceMs, reconnectMaxMs: options.reconnectMaxMs, enqueue: options.enqueue });
      started.start();
      lock = candidate;
      bridge = started;
    } catch (error) {
      candidate.release();
      throw error;
    }
  };

  const tick = (): void => {
    if (stopped) return;
    try {
      if (!bridge) {
        stand();
        return;
      }
      const config = readMeshConfig(home);
      const keeps = lock?.renew() === true && config !== null && config.central === bridge.central && !bridge.isStopped;
      if (!keeps) stepDown().catch(() => undefined);
    } catch (error) {
      log(`mesh: the bridge election failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const timer = setInterval(tick, options.electionMs ?? PRESENCE_INTERVAL_MS);
  timer.unref();
  process.once('exit', () => lock?.release());
  tick();
  return {
    get bridge() {
      return bridge;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await stepDown();
    },
  };
}
