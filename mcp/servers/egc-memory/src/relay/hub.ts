import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

import {
  BROADCAST,
  DEFAULT_MESH_PORT,
  MAX_FRAME_BYTES,
  MESH_PROTOCOL_VERSION,
  MESSAGE_TTL_MS,
  newChallenge,
  parseMachineFrame,
  proofMatches,
} from './protocol';
import type { HubFrame } from './protocol';

// The central of a team's machines (`egc mesh serve`): it lets in a machine
// that answers its challenge with the key derived from the team key for
// that purpose, passes each sealed box to the machine it is addressed to (or
// to every machine of the team), and keeps a box for a machine that is off
// for up to a day. It never holds the key that opens a box.
export const HELLO_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MS = 30_000;
export const PENDING_PER_SENDER = 200;

// Close codes a machine can tell apart.
export const CLOSE_NO_HELLO = 4001;
export const CLOSE_BINARY = 4002;
export const CLOSE_NOT_MEMBER = 4003;
export const CLOSE_REPLACED = 4004;

export interface HubOptions {
  authKey: Buffer;
  port?: number;
  host?: string;
  now?: () => number;
  helloTimeoutMs?: number;
  heartbeatMs?: number;
}

export interface Hub {
  port: number;
  host: string;
  close(): Promise<void>;
}

interface Pending { from: string; to: string; id: string; box: string; storedAt: number }

function send(socket: WebSocket, frame: HubFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

class Central {
  private readonly online = new Map<string, WebSocket>();
  private readonly lastSeen = new Map<string, number>();
  private readonly pending = new Map<string, Pending[]>();
  private readonly alive = new WeakSet<WebSocket>();

  constructor(private readonly authKey: Buffer, private readonly now: () => number, private readonly helloTimeoutMs: number) {}

  accept(socket: WebSocket): void {
    const challenge = newChallenge();
    let machine: string | null = null;
    const timer = setTimeout(() => {
      if (machine === null) socket.close(CLOSE_NO_HELLO, 'no hello');
    }, this.helloTimeoutMs);
    this.alive.add(socket);
    socket.on('pong', () => this.alive.add(socket));
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        socket.close(CLOSE_BINARY, 'text frames only');
        return;
      }
      const frame = parseMachineFrame(data.toString());
      if (machine === null) {
        if (frame?.t !== 'hello' || !proofMatches(this.authKey, challenge, frame.machine, frame.proof)) {
          socket.close(CLOSE_NOT_MEMBER, 'not a member of this team');
          return;
        }
        clearTimeout(timer);
        machine = frame.machine;
        this.join(machine, socket);
        return;
      }
      if (frame?.t !== 'send') {
        send(socket, { t: 'error', v: MESH_PROTOCOL_VERSION, reason: 'not a frame of this protocol' });
        return;
      }
      this.route(machine, socket, frame.to, frame.id, frame.box);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (machine !== null) this.leave(machine, socket);
    });
    // A socket error is followed by its close, which does the cleanup.
    socket.on('error', () => undefined);
    send(socket, { t: 'challenge', v: MESH_PROTOCOL_VERSION, challenge });
  }

  // Pings every machine and drops one that did not answer the last ping, so
  // a machine that slept or lost its network leaves the presence on time;
  // boxes kept past their day are forgotten.
  heartbeat(): void {
    for (const socket of this.online.values()) {
      if (!this.alive.has(socket)) {
        socket.terminate();
        continue;
      }
      this.alive.delete(socket);
      socket.ping();
    }
    this.sweep();
  }

  closeAll(): void {
    for (const socket of this.online.values()) socket.terminate();
  }

  private join(machine: string, socket: WebSocket): void {
    const previous = this.online.get(machine);
    this.online.set(machine, socket);
    this.lastSeen.set(machine, this.now());
    if (previous && previous !== socket) previous.close(CLOSE_REPLACED, 'replaced by a newer connection of this machine');
    send(socket, { t: 'welcome', v: MESH_PROTOCOL_VERSION, online: [...this.online.keys()].filter(id => id !== machine) });
    if (!previous) this.announce(machine, true);
    this.flush(machine, socket);
  }

  private leave(machine: string, socket: WebSocket): void {
    if (this.online.get(machine) !== socket) return;
    this.online.delete(machine);
    this.lastSeen.set(machine, this.now());
    this.announce(machine, false);
  }

  private announce(machine: string, online: boolean): void {
    for (const [id, socket] of this.online) {
      if (id !== machine) send(socket, { t: 'presence', v: MESH_PROTOCOL_VERSION, machine, online });
    }
  }

  // A machine the central saw in the last day: the ones a box can wait for.
  private isKnown(machine: string): boolean {
    return this.online.has(machine) || (this.lastSeen.get(machine) ?? Number.NEGATIVE_INFINITY) >= this.now() - MESSAGE_TTL_MS;
  }

  private route(from: string, sender: WebSocket, to: string, id: string, box: string): void {
    if (to !== BROADCAST && !this.isKnown(to)) {
      send(sender, { t: 'error', v: MESH_PROTOCOL_VERSION, reason: `no machine ${to} was seen in the last day` });
      return;
    }
    const targets = to === BROADCAST ? [...this.lastSeen.keys()].filter(machine => machine !== from && this.isKnown(machine)) : [to];
    for (const target of targets) {
      const socket = this.online.get(target);
      if (socket) send(socket, { t: 'deliver', v: MESH_PROTOCOL_VERSION, from, to, id, box });
      else this.store(target, { from, to, id, box, storedAt: this.now() });
    }
  }

  private fresh(item: Pending): boolean {
    return item.storedAt >= this.now() - MESSAGE_TTL_MS;
  }

  // Keeps a box for a machine that is off: at most PENDING_PER_SENDER from
  // one sender, the oldest of that sender giving way to the newest.
  private store(target: string, item: Pending): void {
    const kept = (this.pending.get(target) ?? []).filter(pending => this.fresh(pending));
    const fromSender = kept.filter(pending => pending.from === item.from);
    const dropped = fromSender.length >= PENDING_PER_SENDER ? fromSender[0] : null;
    this.pending.set(target, [...kept.filter(pending => pending !== dropped), item]);
  }

  private flush(target: string, socket: WebSocket): void {
    const kept = this.pending.get(target) ?? [];
    this.pending.delete(target);
    for (const item of kept.filter(pending => this.fresh(pending))) {
      send(socket, { t: 'deliver', v: MESH_PROTOCOL_VERSION, from: item.from, to: item.to, id: item.id, box: item.box });
    }
  }

  private sweep(): void {
    for (const [target, kept] of this.pending) {
      const fresh = kept.filter(pending => this.fresh(pending));
      if (fresh.length === 0) this.pending.delete(target);
      else this.pending.set(target, fresh);
    }
    for (const machine of [...this.lastSeen.keys()]) {
      if (!this.isKnown(machine)) this.lastSeen.delete(machine);
    }
  }
}

// Stops the heartbeat, drops every machine and closes the listening socket.
function closeHub(server: WebSocketServer, central: Central, heartbeat: NodeJS.Timeout): Promise<void> {
  clearInterval(heartbeat);
  central.closeAll();
  for (const client of server.clients) client.terminate();
  return new Promise<void>(done => server.close(() => done()));
}

export function startHub(options: HubOptions): Promise<Hub> {
  const central = new Central(options.authKey, options.now ?? Date.now, options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
  const server = new WebSocketServer({ port: options.port ?? DEFAULT_MESH_PORT, host: options.host ?? '0.0.0.0', maxPayload: MAX_FRAME_BYTES });
  server.on('connection', socket => central.accept(socket));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      // Once listening, an error of the server is an error of one connection.
      server.on('error', () => undefined);
      const heartbeat = setInterval(() => central.heartbeat(), options.heartbeatMs ?? HEARTBEAT_MS);
      heartbeat.unref();
      const address = server.address() as AddressInfo;
      resolve({ port: address.port, host: address.address, close: () => closeHub(server, central, heartbeat) });
    });
  });
}
