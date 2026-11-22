import os from 'node:os';
import { Bonjour } from 'bonjour-service';
import type { Service } from 'bonjour-service';

import { teamKeyMarker } from '../sync/envelope';

// The central announces itself on the home network by mDNS, as
// _egc-mesh._tcp, with a short tag of the team's marker in its TXT record:
// a machine of the team finds it without typing an address, and a central
// of another team on the same network is left alone. The tag is twelve
// characters of an HMAC under a key derived for the marker alone; nothing
// in it leads to the team key, and it opens nothing: the central still
// challenges every machine that connects.
export const MESH_SERVICE_TYPE = 'egc-mesh';
export const DISCOVERY_TIMEOUT_MS = 3000;
const TAG_LENGTH = 12;
const MAX_SERVICE_NAME = 63;

export function teamTag(teamKey: Buffer): string {
  return teamKeyMarker(teamKey).slice(0, TAG_LENGTH);
}

export interface Announcement {
  name: string;
  stop(): Promise<void>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// The announcement is optional for the central: an error of the mDNS
// socket or of the record, which arrives later, goes to `onError` and the
// central keeps serving.
export function announceCentral(options: { port: number; teamKey: Buffer; name?: string; onError?: (error: Error) => void }): Announcement {
  const onError = options.onError ?? ((): void => undefined);
  const bonjour = new Bonjour({}, (error: unknown) => onError(asError(error)));
  const name = (options.name ?? `EGC mesh on ${os.hostname().split('.')[0] || 'machine'}`).slice(0, MAX_SERVICE_NAME);
  const service = bonjour.publish({ name, type: MESH_SERVICE_TYPE, protocol: 'tcp', port: options.port, txt: { team: teamTag(options.teamKey), v: '1' } });
  service.on('error', (error: unknown) => onError(asError(error)));
  return {
    name,
    stop: () => new Promise<void>(resolve => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        bonjour.destroy();
        resolve();
      };
      // The goodbye packets go out first, so the other machines forget the
      // central at once instead of at the end of its record's life.
      bonjour.unpublishAll(finish);
      setTimeout(finish, 1000).unref();
    }),
  };
}

export interface FoundCentral {
  name: string;
  host: string;
  port: number;
  // What `egc mesh connect` takes: an IPv4 host:port, or an IPv6 one in brackets.
  address: string;
}

// An IPv4 address first, since it is the plain host:port the configuration
// reads; an IPv6 one in brackets otherwise; nothing when the record came
// without an address.
function pickAddress(service: Service): string | null {
  const addresses = service.addresses ?? [];
  const v4 = addresses.find(address => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address));
  if (v4) return v4;
  const v6 = addresses.find(address => address.includes(':'));
  return v6 ? `[${v6}]` : null;
}

// A port a central can listen on: a TCP port, never 0.
function usablePort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535;
}

// The centrals of this team that answered on the local network within the
// timeout, by address; a central of another team, or one that gave no
// address or no usable port, is not listed. A failure of the search itself
// is thrown when nothing was found, so the person learns why.
export async function discoverCentrals(options: { teamKey: Buffer; timeoutMs?: number }): Promise<FoundCentral[]> {
  const tag = teamTag(options.teamKey);
  let failure: Error | null = null;
  const bonjour = new Bonjour({}, (error: unknown) => { failure ??= asError(error); });
  const found = new Map<string, FoundCentral>();
  const browser = bonjour.find({ type: MESH_SERVICE_TYPE, protocol: 'tcp' }, (service: Service) => {
    const txt = (service.txt ?? {}) as Record<string, unknown>;
    if (txt.team !== tag) return;
    const host = pickAddress(service);
    if (!host || !usablePort(service.port)) return;
    const address = `${host}:${service.port}`;
    found.set(address, { name: service.name, host: service.host, port: service.port, address });
  });
  await new Promise(resolve => setTimeout(resolve, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS));
  browser.stop();
  bonjour.destroy();
  if (found.size === 0 && failure) throw failure;
  return [...found.values()].sort((left, right) => left.address.localeCompare(right.address));
}
