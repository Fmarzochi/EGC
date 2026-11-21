import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveHome } from '../home';

// Where this machine's bridge finds the central: ~/.egc/mesh.json, written
// by `egc mesh connect <address>` and read by the memory server when it
// starts. No file, no central: the machine works alone, as it always did.
export interface MeshConfig {
  central: string;
  connectedAt: string;
}

export function meshConfigPath(home: string = resolveHome()): string {
  return path.join(home, '.egc', 'mesh.json');
}

// A WebSocket address with a host; a bare host:port is read as ws://, and an
// address that names another scheme (http://, for one) is refused rather
// than read as a host called "http".
export function normalizeCentralAddress(value: string): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme && !/^wss?$/i.test(scheme[1])) return null;
  const candidate = scheme ? text : `ws://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!/^wss?:$/.test(url.protocol) || !url.hostname) return null;
  return url.toString().replace(/\/$/, '');
}

export function readMeshConfig(home: string = resolveHome()): MeshConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(meshConfigPath(home), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const central = typeof record.central === 'string' ? normalizeCentralAddress(record.central) : null;
  if (!central) return null;
  return { central, connectedAt: typeof record.connectedAt === 'string' ? record.connectedAt : new Date(0).toISOString() };
}

export function writeMeshConfig(central: string, home: string = resolveHome()): MeshConfig {
  const normalized = normalizeCentralAddress(central);
  if (!normalized) throw new Error(`Not an address of a mesh central: ${central}. Give a host and a port, such as 192.168.1.50:47470, or a ws:// or wss:// URL.`);
  const config: MeshConfig = { central: normalized, connectedAt: new Date().toISOString() };
  const file = meshConfigPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
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
