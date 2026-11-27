import fs from 'node:fs';

import type { ConnectionOptions } from 'nats';

import { teamTag } from './discovery';
import type { CentralLink, LinkClose, LinkEvents, LinkOptions } from './link';
import { BROADCAST, MESH_PROTOCOL_VERSION, isAddress, isBox, isHexId } from './protocol';
import type { HubFrame } from './protocol';

// The bridge over a NATS server the person runs (nats:// or tls://), in
// place of the central of `egc mesh serve`. The server sees subjects and
// sealed boxes: a box for one machine goes to `egc.mesh.<tag>.to.<machine>`,
// a box for everyone to `egc.mesh.<tag>.all`, where the tag is twelve
// characters of the team's marker (the one the discovery announces), so two
// teams on one server stay apart and nothing in a subject leads to the key.
// A NATS server keeps nothing for a machine that is off: what is said
// reaches the machines connected at that moment, and the git sync remains
// the record. Who comes and goes is not told by the server either: the
// bridges tell each other, with their sealed presence and a sealed goodbye.
// The library is loaded only when a machine points at a NATS server.
export const NATS_CONNECT_TIMEOUT_MS = 10_000;
const CLOSE_WAIT_MS = 1000;
const CREDS_MARK = '-----BEGIN NATS USER JWT-----';

// What the NATS library gives of a connection and the link uses, so a test
// can stand in for the library.
export interface NatsClient {
  info?: { max_payload?: number };
  subscribe(subject: string, options: { callback: (error: Error | null, message: { subject: string; data: Uint8Array }) => void }): unknown;
  publish(subject: string, payload: Uint8Array): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  closed(): Promise<void | Error>;
}

export type NatsConnect = (options: ConnectionOptions) => Promise<NatsClient>;

export type NatsAuth = Pick<ConnectionOptions, 'user' | 'pass' | 'token' | 'authenticator'>;
export type NatsAuthKind = 'none' | 'creds' | 'token' | 'password';

export interface NatsLinkOptions extends LinkOptions {
  connect?: NatsConnect;
}

export function meshSubjects(tag: string): { all: string; to: (machine: string) => string } {
  const root = `egc.mesh.${tag}`;
  return { all: `${root}.all`, to: machine => `${root}.to.${machine}` };
}

// The credentials of this machine on the NATS server, from the file `egc
// mesh connect --auth` named: a `.creds` file (the user JWT and its seed, as
// the NATS tools write it), or JSON with a `token`, or with a `user` and a
// `pass`. The file is the person's own: one that is not a regular file, or
// that other users can read, is refused. No file, no credentials.
export async function readNatsAuth(file: string | null | undefined): Promise<{ kind: NatsAuthKind; options: NatsAuth }> {
  if (!file) return { kind: 'none', options: {} };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`the NATS credentials file ${file} does not exist`);
  }
  if (!stat.isFile()) throw new Error(`the NATS credentials file ${file} is not a regular file`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error(`the NATS credentials file ${file} is readable by other users: chmod 600 ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(CREDS_MARK)) {
    const { credsAuthenticator } = await import('nats');
    return { kind: 'creds', options: { authenticator: credsAuthenticator(new TextEncoder().encode(text)) } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  if (record && typeof record.token === 'string' && record.token.length > 0) return { kind: 'token', options: { token: record.token } };
  if (record && typeof record.user === 'string' && record.user.length > 0 && typeof record.pass === 'string') return { kind: 'password', options: { user: record.user, pass: record.pass } };
  throw new Error(`the NATS credentials file ${file} is neither a .creds file nor JSON with a "token", or a "user" and a "pass"`);
}

// A box another machine published, as the central would deliver it, or null
// for anything that is not one: another version, a bad id or address, a box
// that is not a box. The sender named here is checked by the seal, which
// binds the box to its sender, its addressee and its id.
export function parseDelivery(raw: string): HubFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== MESH_PROTOCOL_VERSION || !isHexId(record.from) || !isAddress(record.to) || !isHexId(record.id) || !isBox(record.box)) return null;
  return { t: 'deliver', v: MESH_PROTOCOL_VERSION, from: record.from, to: record.to, id: record.id, box: record.box };
}

async function connectWithLibrary(options: ConnectionOptions): Promise<NatsClient> {
  const nats = await import('nats');
  return nats.connect(options) as unknown as Promise<NatsClient>;
}

export function openNatsLink(options: NatsLinkOptions, events: LinkEvents): CentralLink {
  const subjects = meshSubjects(teamTag(options.teamKey));
  let client: NatsClient | null = null;
  let closing = false;
  let told = false;
  const tellClosed = (cause: LinkClose): void => {
    if (told) return;
    told = true;
    events.closed(cause);
  };
  const onMessage = (error: Error | null, message: { subject: string; data: Uint8Array }): void => {
    if (error) {
      options.log(`mesh: the NATS server reported an error on a subscription: ${error.message}`);
      return;
    }
    const frame = parseDelivery(Buffer.from(message.data).toString('utf8'));
    if (frame) events.frame(frame);
  };
  // The library reconnects on its own by default; here it does not, so that
  // one loss of the connection is one close of the link and the bridge
  // reconnects with the backoff it has for the central. The server does not
  // echo this machine's own boxes back; the bridge would drop them anyway.
  const open = async (): Promise<void> => {
    const auth = await readNatsAuth(options.authFile);
    const connect = options.connect ?? connectWithLibrary;
    const connected = await connect({ servers: options.central, name: `egc-mesh ${options.machineId.slice(0, 8)}`, reconnect: false, timeout: NATS_CONNECT_TIMEOUT_MS, noEcho: true, ...auth.options });
    if (closing) {
      await connected.close().catch(() => undefined);
      throw new Error('closed before it opened');
    }
    client = connected;
    connected.subscribe(subjects.all, { callback: onMessage });
    connected.subscribe(subjects.to(options.machineId), { callback: onMessage });
    connected.closed()
      .then(error => {
        if (client === connected) client = null;
        tellClosed({ kind: 'lost', reason: error ? error.message : 'the connection closed' });
      })
      .catch(() => undefined);
    // A NATS server has no welcome: the link is up, and who is online comes
    // with the sealed presence of each machine.
    events.frame({ t: 'welcome', v: MESH_PROTOCOL_VERSION, online: [] });
  };
  open().catch((error: unknown) => tellClosed({ kind: 'lost', reason: error instanceof Error ? error.message : String(error) }));
  return {
    tellsPresence: false,
    send(to, id, box) {
      const connected = client;
      if (!connected) return false;
      const payload = Buffer.from(JSON.stringify({ v: MESH_PROTOCOL_VERSION, from: options.machineId, to, id, box }), 'utf8');
      const max = connected.info?.max_payload;
      if (typeof max === 'number' && payload.length > max) {
        // Behind us: a box the server would refuse waits for nothing.
        options.log(`mesh: a box of ${payload.length} bytes is above the max_payload of the NATS server (${max}) and stays on this machine`);
        return true;
      }
      try {
        connected.publish(to === BROADCAST ? subjects.all : subjects.to(to), payload);
        return true;
      } catch (error) {
        options.log(`mesh: the box was not published: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
    async close() {
      closing = true;
      const connected = client;
      client = null;
      if (connected) {
        // What was published last (a goodbye) goes out before the close.
        await Promise.race([
          connected.flush().catch(() => undefined).then(() => connected.close()),
          new Promise<void>(resolve => setTimeout(resolve, CLOSE_WAIT_MS).unref()),
        ]).catch(() => undefined);
      }
      tellClosed({ kind: 'lost', reason: 'closed' });
    },
  };
}
