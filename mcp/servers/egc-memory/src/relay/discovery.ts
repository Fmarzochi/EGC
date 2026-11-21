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

export function announceCentral(options: { port: number; teamKey: Buffer; name?: string }): Announcement {
  const bonjour = new Bonjour();
  const name = (options.name ?? `EGC mesh on ${os.hostname().split('.')[0] || 'machine'}`).slice(0, MAX_SERVICE_NAME);
  bonjour.publish({ name, type: MESH_SERVICE_TYPE, protocol: 'tcp', port: options.port, txt: { team: teamTag(options.teamKey), v: '1' } });
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

// The centrals of this team that answered on the local network within the
// timeout, by address; a central of another team, or one that gave no
// address, is not listed.
export async function discoverCentrals(options: { teamKey: Buffer; timeoutMs?: number }): Promise<FoundCentral[]> {
  const tag = teamTag(options.teamKey);
  const bonjour = new Bonjour();
  const found = new Map<string, FoundCentral>();
  const browser = bonjour.find({ type: MESH_SERVICE_TYPE, protocol: 'tcp' }, (service: Service) => {
    const txt = (service.txt ?? {}) as Record<string, unknown>;
    if (txt.team !== tag) return;
    const host = pickAddress(service);
    if (!host || !Number.isInteger(service.port)) return;
    const address = `${host}:${service.port}`;
    found.set(address, { name: service.name, host: service.host, port: service.port, address });
  });
  await new Promise(resolve => setTimeout(resolve, options.timeoutMs ?? DISCOVERY_TIMEOUT_MS));
  browser.stop();
  bonjour.destroy();
  return [...found.values()].sort((left, right) => left.address.localeCompare(right.address));
}
