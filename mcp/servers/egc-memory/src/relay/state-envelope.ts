import fs from 'node:fs';
import path from 'node:path';

import { resolveHeadState, resolveStateRead } from '../branch-state';
import { configuredKeyPath, loadOrCreateEncKey, readStateFile } from '../encryption';
import { resolveHome } from '../home';
import { loadOrCreateKey } from '../integrity';
import type { MemoryChangeNotice } from '../memory-notify';
import { openEnvelope, sealEnvelope } from '../sync/envelope';
import { hasLinkedAncestor, isLink, linkedDirectoryTowards, mergeTeamStateFrom, secretShapeIn, sharedRelativePath } from '../sync/TeamSync';
import type { TeamMergeOutcome } from '../sync/TeamSync';
import { writePrivateFile } from './private-file';

// The state document itself, through the mesh: when a machine writes its
// state, the bridge seals the document the way the git sync would (the same
// envelope, under the same path in the team's tree, with the same refusals)
// and hands it to the other machines, which merge it section by section
// into their own state with the same code the git sync uses. A machine
// without a git remote keeps up this way; one with a remote has the document
// before its next pull. A document too large for a box is left to the git
// sync.
export const MAX_ENVELOPE_PLAINTEXT_BYTES = 192 * 1024;
const MAX_SEALED_CHARS = 384 * 1024;
const MAX_RELATIVE_PATH_CHARS = 300;
const RELATIVE_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md$/;

export type StateTree = 'state' | 'global';

export interface StateEnvelope {
  tree: StateTree;
  relativePath: string;
  sealed: string;
}

// The keys of this machine: the personal key that encrypts the state on
// disk, taken from where the state reads take it (EGC_ENCRYPTION_KEY_FILE
// when it is set, the key file of the home otherwise), and the integrity
// key of the state files (only the machine's own home has one; a test home
// gets none and the merge writes no sidecar).
export interface MachineKeys {
  personal: Buffer;
  integrity: Buffer | null;
}

export function machineKeys(home: string): MachineKeys {
  const own = path.resolve(home) === path.resolve(resolveHome());
  const keyPath = (own ? configuredKeyPath() : null) ?? path.join(home, '.egc', 'encryption.key');
  return {
    personal: loadOrCreateEncKey(keyPath),
    integrity: own ? loadOrCreateKey() : null,
  };
}

function localTreeDir(home: string, tree: StateTree): string {
  return path.join(home, '.egc', tree);
}

// A relative path an envelope may name: the characters of the documents of
// the git sync, no component that is a dot or two (which would leave the
// tree on arrival), nothing longer than a path of a box.
function acceptableRelativePath(relativePath: string): boolean {
  if (relativePath.length > MAX_RELATIVE_PATH_CHARS || !RELATIVE_PATH_RE.test(relativePath)) return false;
  return relativePath.split('/').every(segment => segment !== '.' && segment !== '..');
}

// The file a notice of state speaks of: the global document, or the
// document of the project at the head the writer saw, the branch of the
// notice or the commit a detached HEAD points at.
function stateFileFor(localDir: string, notice: MemoryChangeNotice): string | null {
  if (notice.scope === 'global') return path.join(localDir, 'state.md');
  if (!notice.projectPath) return null;
  const detachedCommit = notice.branch ? null : resolveHeadState(notice.projectPath).detachedCommit;
  return resolveStateRead(localDir, notice.projectPath, notice.branch ?? null, detachedCommit).filePath;
}

// The document a notice of state speaks of, sealed for the team under the
// path the git sync shares it under. null when there is nothing to send:
// the notice is not about state, the document does not exist, or a keyed
// document supersedes it. A refusal is thrown with its reason, for the
// bridge to log: the document sits behind a link, holds what looks like a
// credential, or is too large for a box.
export function sealStateDocument(home: string, keys: MachineKeys, teamKey: Buffer, notice: MemoryChangeNotice): StateEnvelope | null {
  if (notice.kind !== 'state') return null;
  const tree: StateTree = notice.scope === 'global' ? 'global' : 'state';
  const localDir = localTreeDir(home, tree);
  const file = stateFileFor(localDir, notice);
  if (!file || !fs.existsSync(file)) return null;
  const linked = linkedDirectoryTowards(localDir);
  if (linked) throw new Error(`the local state tree is a link at ${linked} and is not sent`);
  const localPath = path.relative(localDir, file);
  if (isLink(file) || hasLinkedAncestor(file, localDir)) throw new Error(`the state document ${localPath} sits behind a link and is not sent`);
  const plaintext = readStateFile(file, keys.personal);
  const shared = sharedRelativePath(localDir, localPath, plaintext);
  if (shared === null) return null;
  const relativePath = shared.split(path.sep).join('/');
  if (!acceptableRelativePath(relativePath)) return null;
  const shape = secretShapeIn(plaintext);
  if (shape) throw new Error(`the state document ${relativePath} holds what looks like ${shape} and is not sent`);
  const bytes = Buffer.byteLength(plaintext, 'utf8');
  if (bytes > MAX_ENVELOPE_PLAINTEXT_BYTES) throw new Error(`the state document ${relativePath} is ${bytes} bytes, above the ${MAX_ENVELOPE_PLAINTEXT_BYTES} bytes a box may carry, and travels by the git sync alone`);
  return { tree, relativePath, sealed: sealEnvelope(plaintext, teamKey, relativePath) };
}

export function cleanStateEnvelope(value: unknown): StateEnvelope | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const tree = record.tree === 'state' || record.tree === 'global' ? record.tree : null;
  const relativePath = typeof record.relativePath === 'string' ? record.relativePath : '';
  const sealed = typeof record.sealed === 'string' ? record.sealed : '';
  if (!tree || !acceptableRelativePath(relativePath)) return null;
  if (!sealed || sealed.length > MAX_SEALED_CHARS) return null;
  return { tree, relativePath, sealed };
}

function refusal(reason: string): TeamMergeOutcome {
  return { opened: 0, merged: 0, rejected: [reason], unopened: [], unreadable: [] };
}

// A sealed document another machine sent: it is opened first, so a box that
// is not the team's goes nowhere and a text above the cap of a box is
// refused as it would be on sending; then it lands in an inbox tree of its
// own, reached through real directories only, the merge by section of the
// git sync takes it from there into the local state with the same checks
// (key, links, integrity), and the inbox copy is removed. null when the box
// carried no valid envelope; an outcome that names the refusal when the
// text or the inbox cannot be trusted.
export function receiveStateEnvelope(home: string, keys: MachineKeys, teamKey: Buffer, value: unknown): TeamMergeOutcome | null {
  const envelope = cleanStateEnvelope(value);
  if (!envelope) return null;
  const plaintext = openEnvelope(envelope.sealed, teamKey, envelope.relativePath);
  if (plaintext === null) return null;
  const bytes = Buffer.byteLength(plaintext, 'utf8');
  if (bytes > MAX_ENVELOPE_PLAINTEXT_BYTES) return refusal(`${envelope.relativePath} (is ${bytes} bytes, above the ${MAX_ENVELOPE_PLAINTEXT_BYTES} bytes a box may carry)`);
  const inboxTree = path.join(home, '.egc', 'mesh', 'inbox', envelope.tree);
  const file = path.join(inboxTree, ...envelope.relativePath.split('/'));
  if (!file.startsWith(inboxTree + path.sep)) return null;
  const linked = linkedDirectoryTowards(inboxTree);
  if (linked) return refusal(`${envelope.relativePath} (the inbox is a link at ${linked})`);
  fs.mkdirSync(inboxTree, { recursive: true, mode: 0o700 });
  if (isLink(file) || hasLinkedAncestor(file, inboxTree)) return refusal(`${envelope.relativePath} (a link sits at or above its place in the inbox)`);
  writePrivateFile(file, envelope.sealed);
  try {
    return mergeTeamStateFrom(inboxTree, localTreeDir(home, envelope.tree), teamKey, keys.personal, keys.integrity);
  } finally {
    fs.rmSync(file, { force: true });
  }
}
