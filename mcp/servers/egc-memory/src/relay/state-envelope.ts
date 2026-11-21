import fs from 'node:fs';
import path from 'node:path';

import { resolveStateRead } from '../branch-state';
import { loadOrCreateEncKey, readStateFile } from '../encryption';
import { resolveHome } from '../home';
import { loadOrCreateKey } from '../integrity';
import type { MemoryChangeNotice } from '../memory-notify';
import { openEnvelope, sealEnvelope } from '../sync/envelope';
import { mergeTeamStateFrom } from '../sync/TeamSync';
import type { TeamMergeOutcome } from '../sync/TeamSync';
import { writePrivateFile } from './private-file';

// The state document itself, through the mesh: when a machine writes its
// state, the bridge seals the document the way the git sync would (the same
// envelope, under the same path in the team's tree) and hands it to the
// other machines, which merge it section by section into their own state
// with the same code the git sync uses. A machine without a git remote
// keeps up this way; one with a remote has the document before its next
// pull. A document too large for a box is left to the git sync.
export const MAX_ENVELOPE_PLAINTEXT_BYTES = 192 * 1024;
const MAX_SEALED_CHARS = 384 * 1024;
const RELATIVE_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md$/;

export type StateTree = 'state' | 'global';

export interface StateEnvelope {
  tree: StateTree;
  relativePath: string;
  sealed: string;
}

// The keys of this machine: the personal key that encrypts the state on
// disk, and the integrity key of the state files (only the machine's own
// home has one; a test home gets none and the merge writes no sidecar).
export interface MachineKeys {
  personal: Buffer;
  integrity: Buffer | null;
}

export function machineKeys(home: string): MachineKeys {
  const own = path.resolve(home) === path.resolve(resolveHome());
  return {
    personal: loadOrCreateEncKey(path.join(home, '.egc', 'encryption.key')),
    integrity: own ? loadOrCreateKey() : null,
  };
}

function localTreeDir(home: string, tree: StateTree): string {
  return path.join(home, '.egc', tree);
}

// The document a notice of state speaks of, sealed for the team under the
// path the git sync gives it; null when there is no such document, when the
// notice is not about state, or when the document is too large for a box.
export function sealStateDocument(home: string, keys: MachineKeys, teamKey: Buffer, notice: MemoryChangeNotice): StateEnvelope | null {
  if (notice.kind !== 'state') return null;
  const tree: StateTree = notice.scope === 'global' ? 'global' : 'state';
  const localDir = localTreeDir(home, tree);
  let file: string;
  if (tree === 'global') {
    file = path.join(localDir, 'state.md');
  } else {
    if (!notice.projectPath) return null;
    file = resolveStateRead(localDir, notice.projectPath, notice.branch ?? null, null).filePath;
  }
  if (!fs.existsSync(file)) return null;
  const relativePath = path.relative(localDir, file).split(path.sep).join('/');
  if (!RELATIVE_PATH_RE.test(relativePath)) return null;
  const plaintext = readStateFile(file, keys.personal);
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_ENVELOPE_PLAINTEXT_BYTES) return null;
  return { tree, relativePath, sealed: sealEnvelope(plaintext, teamKey, relativePath) };
}

export function cleanStateEnvelope(value: unknown): StateEnvelope | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const tree = record.tree === 'state' || record.tree === 'global' ? record.tree : null;
  const relativePath = typeof record.relativePath === 'string' ? record.relativePath : '';
  const sealed = typeof record.sealed === 'string' ? record.sealed : '';
  if (!tree || !RELATIVE_PATH_RE.test(relativePath) || relativePath.length > 300) return null;
  if (!sealed || sealed.length > MAX_SEALED_CHARS) return null;
  return { tree, relativePath, sealed };
}

// A sealed document another machine sent: it is opened first, so a box that
// is not the team's goes nowhere; then it lands in an inbox tree of its own,
// the merge by section of the git sync takes it from there into the local
// state with the same checks (key, links, integrity), and the inbox copy is
// removed. null when the box carried no valid envelope.
export function receiveStateEnvelope(home: string, keys: MachineKeys, teamKey: Buffer, value: unknown): TeamMergeOutcome | null {
  const envelope = cleanStateEnvelope(value);
  if (!envelope) return null;
  if (openEnvelope(envelope.sealed, teamKey, envelope.relativePath) === null) return null;
  const inboxTree = path.join(home, '.egc', 'mesh', 'inbox', envelope.tree);
  const file = path.join(inboxTree, ...envelope.relativePath.split('/'));
  writePrivateFile(file, envelope.sealed);
  try {
    return mergeTeamStateFrom(inboxTree, localTreeDir(home, envelope.tree), teamKey, keys.personal, keys.integrity);
  } finally {
    fs.rmSync(file, { force: true });
  }
}
