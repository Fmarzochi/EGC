import WebSocket from 'ws';
import type { RawData } from 'ws';

import { CLOSE_REPLACED } from './hub';
import { openNatsLink } from './link-nats';
import { centralKind } from './mesh-config';
import { MESH_PROTOCOL_VERSION, helloProof, parseHubFrame } from './protocol';
import type { HubFrame } from './protocol';

// The link between the bridge of a machine and what relays for its team: the
// central of `egc mesh serve`, over a WebSocket, or a NATS server the person
// runs. The bridge speaks the frames of the central over either; a link turns
// what its transport carries into those frames, in the order they came, and
// says once when it is gone and why.
export type LinkClose =
  | { kind: 'replaced' }
  | { kind: 'lost'; reason: string };

export interface LinkEvents {
  frame(frame: HubFrame): void;
  closed(cause: LinkClose): void;
}

export interface LinkOptions {
  central: string;
  machineId: string;
  authKey: Buffer;
  teamKey: Buffer;
  // The credentials file of this machine on a NATS server; the central of
  // egc mesh serve takes none, the team key answers its challenge.
  authFile: string | null;
  log: (line: string) => void;
}

export interface CentralLink {
  // Whether what relays tells who comes and goes: the central does; a NATS
  // server does not, so over it the bridges tell each other.
  readonly tellsPresence: boolean;
  // Hands a sealed box to the relay; false when there is no connection to
  // hand it to.
  send(to: string, id: string, box: string): boolean;
  // Closes the link and waits, briefly, for the close to go through.
  close(): Promise<void>;
}

export type LinkOpener = (options: LinkOptions, events: LinkEvents) => CentralLink;

const CLOSE_WAIT_MS = 1000;

// The link to the central of egc mesh serve: it answers the challenge with
// the key derived from the team key and passes every other frame on.
export function openWebSocketLink(options: LinkOptions, events: LinkEvents): CentralLink {
  const socket = new WebSocket(options.central);
  let told = false;
  const tellClosed = (cause: LinkClose): void => {
    if (told) return;
    told = true;
    events.closed(cause);
  };
  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const frame = parseHubFrame(data.toString());
    if (!frame) return;
    if (frame.t === 'challenge') {
      socket.send(JSON.stringify({ t: 'hello', v: MESH_PROTOCOL_VERSION, machine: options.machineId, proof: helloProof(options.authKey, frame.challenge, options.machineId) }));
      return;
    }
    events.frame(frame);
  });
  socket.on('close', code => tellClosed(code === CLOSE_REPLACED ? { kind: 'replaced' } : { kind: 'lost', reason: `the connection closed (${code})` }));
  socket.on('error', error => options.log(`mesh: connection error: ${error.message}`));
  return {
    tellsPresence: true,
    send(to, id, box) {
      if (socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ t: 'send', v: MESH_PROTOCOL_VERSION, to, id, box }));
      return true;
    },
    close() {
      if (socket.readyState !== WebSocket.OPEN) {
        socket.terminate();
        return Promise.resolve();
      }
      return new Promise<void>(resolve => {
        socket.once('close', () => resolve());
        socket.close();
        setTimeout(resolve, CLOSE_WAIT_MS).unref();
      });
    },
  };
}

// The link an address calls for: a NATS server for nats:// and tls://, the
// central for ws:// and wss://.
export function openLinkFor(options: LinkOptions, events: LinkEvents): CentralLink {
  return centralKind(options.central) === 'nats' ? openNatsLink(options, events) : openWebSocketLink(options, events);
}
