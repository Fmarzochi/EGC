import fs from 'node:fs';
import path from 'node:path';

import { resolveHome } from '../home';
import { privateJson, writePrivateFile } from './private-file';

// Where this machine's bridge finds what relays for its team: ~/.egc/mesh.json,
// written by `egc mesh connect <address>` and read by the memory server when
// it starts. The address is the central of egc mesh serve (ws:// or wss://)
// or a NATS server the person runs (nats:// or tls://), with the credentials
// file of this machine on that server when it asks for one. No file, no
// central: the machine works alone, as it always did.
export interface MeshConfig {
  central: string;
  connectedAt: string;
  authFile: string | null;
}

export type CentralKind = 'relay' | 'nats';

export function meshConfigPath(home: string = resolveHome()): string {
  return path.join(home, '.egc', 'mesh.json');
}

export const DEFAULT_CENTRAL_PORT = 47470;

const RELAY_SCHEME = /^wss?$/i;
const NATS_SCHEME = /^(?:nats|tls)$/i;

// What an address of the mesh points at: the central of egc mesh serve, or a
// NATS server.
export function centralKind(central: string): CentralKind {
  return /^(?:nats|tls):\/\//i.test(central) ? 'nats' : 'relay';
}

// An address with a host. A bare host, or host:port, is read as ws:// and a
// host alone gets the port of the central (47470); a ws:// or wss:// URL is
// taken as written, so a central behind a proxy keeps the port of its scheme;
// a nats:// or tls:// URL names a NATS server, as written (the library gives
// it the port of NATS, 4222, when none is given). An address that names
// another scheme (http://, for one) is refused rather than read as a host
// called "http", and so is one that carries a user name or a password, which
// would end up in every status line.
export function normalizeCentralAddress(value: string): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme && !RELAY_SCHEME.test(scheme[1]) && !NATS_SCHEME.test(scheme[1])) return null;
  const candidate = scheme ? text : `ws://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!/^(?:wss?|nats|tls):$/.test(url.protocol) || !url.hostname) return null;
  if (url.username || url.password) return null;
  if (!scheme && !url.port) url.port = String(DEFAULT_CENTRAL_PORT);
  return url.toString().replace(/\/$/, '');
}

function isRegularFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

export function readMeshConfig(home: string = resolveHome()): MeshConfig | null {
  const file = meshConfigPath(home);
  let parsed: unknown;
  try {
    // Only a regular file is read: a link or a pipe in its place is not a
    // configuration, and a read of it would follow or block.
    if (!fs.lstatSync(file).isFile()) return null;
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const central = typeof record.central === 'string' ? normalizeCentralAddress(record.central) : null;
  if (!central) return null;
  // A credentials file means nothing to the central of egc mesh serve.
  const authFile = centralKind(central) === 'nats' && typeof record.authFile === 'string' && record.authFile.length > 0 ? record.authFile : null;
  return { central, connectedAt: typeof record.connectedAt === 'string' ? record.connectedAt : new Date(0).toISOString(), authFile };
}

export interface WriteMeshConfigOptions {
  // The credentials file of this machine on a NATS server, kept by its
  // absolute path; the file itself stays where the person put it.
  authFile?: string | null;
}

export function writeMeshConfig(central: string, home: string = resolveHome(), options: WriteMeshConfigOptions = {}): MeshConfig {
  const normalized = normalizeCentralAddress(central);
  if (!normalized) throw new Error(`Not an address of a mesh central: ${central}. Give a host and a port, such as 192.168.1.50:47470, a ws:// or wss:// URL of the central, or a nats:// or tls:// URL of your NATS server, without a user name or a password in it.`);
  const authFile = options.authFile ? path.resolve(options.authFile) : null;
  if (authFile && centralKind(normalized) !== 'nats') throw new Error('A credentials file (--auth) goes with the address of a NATS server (nats:// or tls://); the central of egc mesh serve takes the team key alone.');
  if (authFile && !isRegularFile(authFile)) throw new Error(`The credentials file ${authFile} does not exist or is not a regular file.`);
  const config: MeshConfig = { central: normalized, connectedAt: new Date().toISOString(), authFile };
  writePrivateFile(meshConfigPath(home), privateJson(config));
  return config;
}

// True when a central was forgotten, false when none was configured; a file
// that exists and cannot be removed is an error, so the caller never reports
// a machine as alone while it still has its central.
export function clearMeshConfig(home: string = resolveHome()): boolean {
  try {
    fs.rmSync(meshConfigPath(home));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
