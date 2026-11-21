import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { RawData } from 'ws';

import { resolveHome } from '../home';
import { listLiveSessions, recordRemotePresence, forgetRemoteMachine, sweepRemoteMachines } from '../session-bus';
import type { BusDb, RemoteSession } from '../session-bus';
import { parseTeamKey } from '../sync/envelope';
import { getTeamConfig } from '../sync/TeamSync';
import { CLOSE_REPLACED } from './hub';
import { loadOrCreateMachine } from './machine';
import type { MachineIdentity } from './machine';
import { readMeshConfig } from './mesh-config';
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
  reconnectMaxMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  onMessage?: (from: string, message: MeshMessage) => void;
}

export interface BridgeStatus {
  pid: number;
  machine: MachineIdentity;
  central: string;
  connected: boolean;
  online: string[];
  updatedAt: string;
}

interface PresenceBody { label: string; sessions: RemoteSession[]; at: string }

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
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
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
    const current = readLock(this.file);
    if (current && current.token !== this.token) {
      const fresh = this.now() - Date.parse(current.heartbeatAt) < LOCK_STALE_MS;
      if (fresh && (current.pid === process.pid || processAlive(current.pid))) return false;
    }
    writePrivateJson(this.file, { pid: process.pid, token: this.token, heartbeatAt: new Date(this.now()).toISOString() });
    return readLock(this.file)?.token === this.token;
  }

  renew(): boolean {
    const current = readLock(this.file);
    if (!current || current.token !== this.token) return false;
    writePrivateJson(this.file, { ...current, heartbeatAt: new Date(this.now()).toISOString() });
    return true;
  }

  release(): void {
    if (readLock(this.file)?.token === this.token) fs.rmSync(this.file, { force: true });
  }
}

export class MeshBridge {
  readonly online = new Set<string>();
  connected = false;
  private socket: WebSocket | null = null;
  private presenceTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = RECONNECT_MIN_MS;
  private stopped = false;
  private readonly replay: ReplayGuard;
  private readonly authKey: Buffer;
  private readonly sealKey: Buffer;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: BridgeOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.replay = new ReplayGuard(this.now);
    this.authKey = meshAuthKey(options.teamKey);
    this.sealKey = meshSealKey(options.teamKey);
  }

  get machine(): MachineIdentity {
    return this.options.machine;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>(resolve => {
        socket.once('close', () => resolve());
        socket.close();
        setTimeout(resolve, 1000).unref();
      });
    } else if (socket) {
      socket.terminate();
    }
    this.connected = false;
    this.writeStatus();
  }

  status(): BridgeStatus {
    return {
      pid: process.pid,
      machine: this.options.machine,
      central: this.options.central,
      connected: this.connected,
      online: [...this.online].sort(),
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  // Sends the presence of this machine now: the sessions alive on the local
  // bus, under the machine's label, sealed for everyone.
  async announce(): Promise<boolean> {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const sessions = (await listLiveSessions(this.options.db, this.now())).slice(0, MAX_SESSIONS_IN_PRESENCE);
    const body: PresenceBody = { label: this.options.machine.label, sessions, at: new Date(this.now()).toISOString() };
    this.send(BROADCAST, { type: 'presence', body });
    return true;
  }

  // Seals a message for one machine or for all of them and hands it to the
  // central; false when there is no connection to hand it to.
  send(to: string, message: MeshMessage): boolean {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const id = newHexId();
    const box = sealBox(this.sealKey, { from: this.options.machine.id, to, id }, message, this.now());
    this.socket.send(JSON.stringify({ t: 'send', v: MESH_PROTOCOL_VERSION, to, id, box }));
    return true;
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
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) this.onFrame(data.toString()).catch(error => this.log(`mesh: a frame was not handled: ${error instanceof Error ? error.message : String(error)}`));
    });
    socket.on('close', code => this.onClose(socket, code));
    socket.on('error', error => this.log(`mesh: connection error: ${error.message}`));
  }

  private async onFrame(raw: string): Promise<void> {
    const frame = parseHubFrame(raw);
    if (!frame || !this.socket) return;
    switch (frame.t) {
      case 'challenge':
        this.socket.send(JSON.stringify({ t: 'hello', v: MESH_PROTOCOL_VERSION, machine: this.options.machine.id, proof: helloProof(this.authKey, frame.challenge, this.options.machine.id) }));
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

  private async onDeliver(from: string, to: string, id: string, box: string): Promise<void> {
    if (to !== BROADCAST && to !== this.options.machine.id) return;
    if (from === this.options.machine.id) return;
    const opened = openBox(this.sealKey, { from, to, id }, box);
    if (!opened || !this.replay.accept(id, opened.ts)) return;
    if (opened.message.type === 'presence') {
      const body = opened.message.body as Partial<PresenceBody> | undefined;
      const label = typeof body?.label === 'string' ? body.label : from.slice(0, 8);
      const sessions = Array.isArray(body?.sessions) ? body.sessions : [];
      await recordRemotePresence(this.options.db, from, label, sessions, this.now());
      this.online.add(from);
      this.writeStatus();
    }
    this.options.onMessage?.(from, opened.message);
  }

  private startPresence(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    const tick = (): void => {
      this.announce().catch(error => this.log(`mesh: presence was not sent: ${error instanceof Error ? error.message : String(error)}`));
      sweepRemoteMachines(this.options.db, this.now()).catch(() => undefined);
    };
    tick();
    this.presenceTimer = setInterval(tick, this.options.presenceMs ?? PRESENCE_INTERVAL_MS);
    this.presenceTimer.unref();
  }

  private onClose(socket: WebSocket, code: number): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.connected = false;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.presenceTimer = null;
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
}

// The bridge of this server, when the machine has a central configured, a
// team key, and the election went to this process; null in every other
// case, and the server runs as it always did. The lock is renewed with each
// presence tick, so a holder that froze is replaced within LOCK_STALE_MS.
export function startBridgeIfElected(options: StartBridgeOptions): MeshBridge | null {
  const home = options.home ?? resolveHome();
  const config = readMeshConfig(home);
  if (!config) return null;
  const teamKey = parseTeamKey(getTeamConfig()?.teamKey);
  if (!teamKey) {
    options.log?.('mesh: a central is configured but this machine has no team key; the bridge stays down');
    return null;
  }
  const lock = new BridgeLock(home);
  if (!lock.claim()) return null;
  const bridge = new MeshBridge({ home, db: options.db, teamKey, central: config.central, machine: loadOrCreateMachine(home), log: options.log });
  const renew = setInterval(() => {
    if (!lock.renew()) {
      clearInterval(renew);
      bridge.stop().catch(() => undefined);
    }
  }, PRESENCE_INTERVAL_MS);
  renew.unref();
  const release = (): void => {
    clearInterval(renew);
    lock.release();
  };
  process.once('exit', release);
  bridge.start();
  return bridge;
}
