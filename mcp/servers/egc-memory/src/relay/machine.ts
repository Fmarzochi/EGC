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

// A file that exists at the name of the identity and is not one (damaged,
// or truncated by a crash) is moved aside, under a name of its own, so the
// name is free again; the rename is atomic, so of two servers that find the
// damage exactly one moves it and the other finds the name free or taken.
function setDamagedAside(file: string): void {
  try {
    fs.renameSync(file, `${file}.damaged.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  } catch {
    // another server moved it, or it is gone already
  }
}

const CREATE_ATTEMPTS = 3;

// The identity of this machine, created on the first call and the same for
// every server of the machine from then on: it is published only if the
// name is free, so of two servers creating it at once exactly one wins and
// the other reads the winner back, whatever the state the name was in.
export function loadOrCreateMachine(home: string = resolveHome()): MachineIdentity {
  const file = machineFilePath(home);
  const fresh: MachineIdentity = { id: crypto.randomBytes(16).toString('hex'), label: defaultLabel(), createdAt: new Date().toISOString() };
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    const existing = readMachineFile(file);
    if (existing) return existing;
    if (fs.existsSync(file)) setDamagedAside(file);
    if (publishPrivateFile(file, privateJson(fresh))) return readMachineFile(file) ?? fresh;
  }
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
