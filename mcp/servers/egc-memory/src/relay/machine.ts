import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveHome } from '../home';
import { privateJson, publishPrivateFile, writePrivateFile } from './private-file';
import { isHexId } from './protocol';

// Who this machine is on the mesh: a random id, made once and kept in
// ~/.egc/machine.json, and a label the person may edit (the host name by
// default), which is what the other machines show next to a session, a
// decision or a lesson that came from here.
export interface MachineIdentity {
  id: string;
  label: string;
  createdAt: string;
}

const MAX_LABEL_LENGTH = 64;

export function machineFilePath(home: string = resolveHome()): string {
  return path.join(home, '.egc', 'machine.json');
}

function defaultLabel(): string {
  const host = os.hostname().split('.')[0].trim();
  return (host || 'machine').slice(0, MAX_LABEL_LENGTH);
}

function sanitizeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.replaceAll(/[\r\n\t]/g, ' ').trim().slice(0, MAX_LABEL_LENGTH);
  return label.length > 0 ? label : null;
}

function readMachineFile(file: string): MachineIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const label = sanitizeLabel(record.label);
  if (!isHexId(record.id) || label === null) return null;
  return { id: record.id, label, createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString() };
}

// The identity of this machine, created on the first call and the same for
// every server of the machine from then on: the first one is published only
// if the name is free, so of two servers creating it at once exactly one
// wins and the other reads the winner back. A file that exists and is not
// an identity (damaged, or truncated by a crash) is replaced, once.
export function loadOrCreateMachine(home: string = resolveHome()): MachineIdentity {
  const file = machineFilePath(home);
  const existing = readMachineFile(file);
  if (existing) return existing;
  const fresh: MachineIdentity = { id: crypto.randomBytes(16).toString('hex'), label: defaultLabel(), createdAt: new Date().toISOString() };
  if (publishPrivateFile(file, privateJson(fresh))) return readMachineFile(file) ?? fresh;
  const winner = readMachineFile(file);
  if (winner) return winner;
  writePrivateFile(file, privateJson(fresh));
  return readMachineFile(file) ?? fresh;
}

// Renames this machine; the id never changes.
export function setMachineLabel(label: string, home: string = resolveHome()): MachineIdentity {
  const clean = sanitizeLabel(label);
  if (clean === null) throw new Error('The label of the machine cannot be empty.');
  const current = loadOrCreateMachine(home);
  const renamed = { ...current, label: clean };
  writePrivateFile(machineFilePath(home), privateJson(renamed));
  return renamed;
}
