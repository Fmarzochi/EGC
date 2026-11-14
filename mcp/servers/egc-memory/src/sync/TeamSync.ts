import crypto from 'node:crypto';
import path from 'node:path';

import os from 'node:os';
import fs from 'node:fs';
import { SyncBackend } from './SyncBackend';
import { GitBackend } from './GitBackend';
import type { SyncConfig, SyncStatus, SyncResult } from './SyncBackend';
import { isEncrypted, loadOrCreateEncKey, readPrivateKeyFile, readStateFile, writeStateFile } from '../encryption';
import { loadOrCreateKey as loadOrCreateIntegrityKey, writeHmac } from '../integrity';
import { branchStateKey, projectIdentity, projectSlug } from '../branch-state';
import { TEAM_MARKER_FILE, generateTeamKey, markerMatches, openEnvelope, parseTeamKey, sealEnvelope, teamKeyMarker } from './envelope';
import { canonicalForm, mergeStateDocuments } from './merge-sections';

// The integrity sidecar next to a state document is a per-machine value,
// made with ~/.egc/integrity.key: it never travels, and a merged document
// gets one written anew here, as update_state writes it.
const SIDECAR_SUFFIX = '.hmac';
function isSidecar(filePath: string): boolean {
  return filePath.endsWith(SIDECAR_SUFFIX);
}

const TEAM_CONFIG_PATH = path.join(os.homedir(), '.egc', 'team.json');

const BACKEND_REGISTRY: Record<string, new () => SyncBackend> = {
  git: GitBackend,
};

export function getTeamConfig(): SyncConfig | null {
  if (!fs.existsSync(TEAM_CONFIG_PATH)) return null;
  try {
    const raw = fs.readFileSync(TEAM_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as SyncConfig;
  } catch {
    return null;
  }
}

// The config carries the team key, so it is private to the user.
export function writeTeamConfig(config: SyncConfig): void {
  const egcDir = path.join(os.homedir(), '.egc');
  fs.mkdirSync(egcDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(egcDir, 0o700);
  } catch {
    // modes are not supported on this filesystem
  }
  // Written next to its place and renamed over it, so an interrupted write
  // never leaves a truncated config that would look like a missing team.
  const temporary = `${TEAM_CONFIG_PATH}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    // modes are not supported on this filesystem
  }
  fs.renameSync(temporary, TEAM_CONFIG_PATH);
}

export async function teamInit(backend: string, remote: string, branch: string = 'main', teamKey?: string): Promise<SyncConfig> {
  const BackendClass = BACKEND_REGISTRY[backend];
  if (!BackendClass) {
    throw new Error(`Unknown sync backend: "${backend}". Supported backends: ${Object.keys(BACKEND_REGISTRY).join(', ')}`);
  }
  // The first member generates the team key; the others join with the same
  // key (64 hex characters) shared out of band.
  if (teamKey !== undefined && !parseTeamKey(teamKey)) {
    throw new Error('The team key must be 64 hexadecimal characters (32 bytes).');
  }
  const config: SyncConfig = { backend, remote, branch, teamKey: teamKey ?? generateTeamKey() };
  const instance = new BackendClass();
  try {
    await instance.init(config);
    // The init pulled the remote: a repository that already names its team
    // refuses a key that is not that team's before any configuration is
    // written, whether the key was given or made here for a new team, and a
    // repository from before the marker that already holds state asks the
    // key to open one of its files, as the sync would.
    const judged = judgeTeamKey(SYNC_CHECKOUT_DIR, SYNC_STATE_DIR, parseTeamKey(config.teamKey) as Buffer, remote, { requireProofWithoutMarker: true });
    if (judged.verdict === 'wrong') throw new Error(judged.message);
    writeTeamConfig(config);
    return config;
  } finally {
    await instance.destroy();
  }
}

export async function teamSync(): Promise<SyncResult> {
  const config = getTeamConfig();
  if (!config) {
    throw new Error('Team not initialized. Run `egc team init --backend git --remote <url>` first.');
  }

  const BackendClass = BACKEND_REGISTRY[config.backend];
  if (!BackendClass) {
    throw new Error(`Configured backend "${config.backend}" is not available.`);
  }

  const result: SyncResult = {
    pulledCount: 0,
    pushedCount: 0,
    conflictCount: 0,
    rejectedCount: 0,
    errors: [],
    warnings: [],
  };
  const teamKey = parseTeamKey(config.teamKey);
  if (!teamKey) {
    result.errors.push('Team key missing or invalid in team.json: run team init again (with the shared key to join an existing team). Nothing was synced.');
    return result;
  }
  const personalKey = loadOrCreateEncKey();
  const instance = new BackendClass();
  try {
    // A missing or unreachable remote must degrade to an offline no-op with
    // a reported error, never an exception that takes the MCP server down.
    try {
      await instance.init(config);
    } catch (err) {
      result.errors.push(`Sync backend init failed: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    // Step 1: Pull remote changes.
    try {
      const changedFiles = await instance.pull();
      result.pulledCount = changedFiles.length;
      result.conflictCount = 0; // Git handles merge tracking
    } catch (err) {
      // Nothing is merged or pushed over a pull that failed: the sync is an
      // offline no-op with the error reported.
      result.errors.push(`Pull failed: ${String(err)}`);
      return result;
    }

    // The marker of the team key, before anything is merged, written locally
    // or pushed: a key that is not the team's stops here, a damaged marker
    // (the key opens the state files the marker disowns) is said and
    // rewritten with the push below, a repository without one keeps the rule
    // of the opened files.
    const judged = judgeTeamKey(SYNC_CHECKOUT_DIR, SYNC_STATE_DIR, teamKey, config.remote);
    if (judged.verdict === 'wrong') {
      result.errors.push(judged.message);
      return result;
    }
    if (judged.verdict === 'damaged') result.warnings.push(judged.message);

    // Step 2: Merge into local state; only verified team envelopes count.
    const merge = mergeTeamStateFrom(SYNC_STATE_DIR, LOCAL_STATE_DIR, teamKey, personalKey, loadOrCreateIntegrityKey());
    const refused = [...merge.rejected, ...merge.unopened];
    result.rejectedCount = refused.length;
    for (const rejected of refused) {
      result.errors.push(`Rejected sync file (not a verified team envelope for its path): ${rejected}`);
    }
    for (const unreadable of merge.unreadable) {
      result.errors.push(`Local state file could not be decrypted and was left untouched: ${unreadable}`);
    }
    // Step 3: Stage local state as sealed envelopes and push. A key that
    // opened none of the files on the remote is not shown to be the team's
    // key, and a push with it would put envelopes the teammates cannot open
    // over theirs, so nothing leaves until the key is right.
    if (keyNotProven(merge)) {
      result.errors.push(keyNotProvenMessage(merge.unopened.length));
    } else {
      await pushSealedState(instance, teamKey, personalKey, merge.unopened, result);
    }

    // Step 4: Check for conflicts.
    try {
      const status = await instance.status();
      result.conflictCount = status.conflictCount;
    } catch {
      // Status check is best-effort.
    }
  } finally {
    await instance.destroy();
  }

  return result;
}

export async function teamStatus(): Promise<SyncStatus> {
  const config = getTeamConfig();
  if (!config) {
    throw new Error('Team not initialized. Run `egc team init --backend git --remote <url>` first.');
  }

  const BackendClass = BACKEND_REGISTRY[config.backend];
  if (!BackendClass) {
    throw new Error(`Configured backend "${config.backend}" is not available.`);
  }

  const instance = new BackendClass();
  try {
    // The status describes the local checkout, so it must answer while the
    // remote is down: the remote is not read here.
    await instance.init(config, { readRemote: false });
    return await instance.status();
  } finally {
    await instance.destroy();
  }
}

const SYNC_CHECKOUT_DIR = path.join(os.homedir(), '.egc', 'team-sync');
const SYNC_STATE_DIR = path.join(SYNC_CHECKOUT_DIR, 'state');
const LOCAL_STATE_DIR = path.join(os.homedir(), '.egc', 'state');

function keyNotProven(merge: TeamMergeOutcome): boolean {
  return merge.opened === 0 && merge.unopened.length > 0;
}

export type MarkerState = 'absent' | 'match' | 'mismatch';

// The remote as a message shows it: a credential a URL carries (user:token@
// after the scheme) never reaches the terminal or a log, by a scan that
// stays linear in the text.
export function redactRemote(remote: string): string {
  let shown = '';
  let rest = remote;
  for (;;) {
    const scheme = rest.indexOf('://');
    if (scheme === -1) return shown + rest;
    const start = scheme + 3;
    const authority = rest.slice(start);
    const end = authority.search(/[/\s]/);
    const host = end === -1 ? authority : authority.slice(0, end);
    const at = host.lastIndexOf('@');
    shown += rest.slice(0, start) + (at === -1 ? host : host.slice(at + 1));
    rest = authority.slice(host.length);
  }
}

// What the TEAM marker of the checkout says about a key: absent when there
// is no entry at all (a repository from before the marker, or still empty),
// a match for the key of its team, a mismatch for any other text and for
// anything that is not a regular file (a link, a pipe, a directory). The
// entry is opened without following a link and without blocking, and read
// only once it is known to be a regular file.
export function readMarkerState(checkoutDir: string, teamKey: Buffer): MarkerState {
  const file = path.join(checkoutDir, TEAM_MARKER_FILE);
  if (isLink(file)) return 'mismatch';
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'mismatch';
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) return 'mismatch';
    return markerMatches(fs.readFileSync(descriptor, 'utf-8'), teamKey) ? 'match' : 'mismatch';
  } catch {
    return 'mismatch';
  } finally {
    fs.closeSync(descriptor);
  }
}

// Writes the marker of this key at the root of the checkout, through a
// temporary created exclusively and renamed over the marker: a link planted
// or replaced at the marker is never written through, and the marker is
// never seen half written.
export function writeTeamMarker(checkoutDir: string, teamKey: Buffer): void {
  const file = path.join(checkoutDir, TEAM_MARKER_FILE);
  fs.mkdirSync(checkoutDir, { recursive: true });
  const temporary = path.join(checkoutDir, `.${TEAM_MARKER_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', 0o644);
  try {
    fs.writeSync(descriptor, `${teamKeyMarker(teamKey)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    if (isLink(file)) removeSyncFile(file);
    fs.renameSync(temporary, file);
  } catch (err) {
    removeSyncFile(temporary);
    throw err;
  }
}

// The state files of the sync tree a key could open: regular files that are
// neither sidecars nor hidden, none when the tree is missing or sits behind
// a link, the same guard the merge applies before it walks the tree.
function stateFilesOf(syncStateDir: string): string[] {
  if (linkedDirectoryTowards(syncStateDir) || !fs.existsSync(syncStateDir)) return [];
  return walkEntries(syncStateDir).files.filter(file => !isSidecar(file) && !isHiddenEntry(file, syncStateDir));
}

// Whether the key opens at least one envelope of the sync tree, reading
// only: the proof the marker rule falls back on when the marker disagrees,
// and the proof an init asks of a repository from before the marker.
export function keyOpensAny(syncStateDir: string, teamKey: Buffer): boolean {
  return stateFilesOf(syncStateDir).some(file => {
    try {
      return openEnvelope(fs.readFileSync(file, 'utf-8'), teamKey, path.relative(syncStateDir, file)) !== null;
    } catch {
      return false;
    }
  });
}

export interface TeamKeyJudgement {
  verdict: 'ok' | 'damaged' | 'wrong';
  message?: string;
}

export interface TeamKeyJudgementOptions {
  // An init has no merge to fall back on: a repository without a marker
  // that already holds state proves the key by opening one file, before
  // any configuration is written; an empty repository takes any key, since
  // it starts the team.
  requireProofWithoutMarker?: boolean;
}

// The verdict on a key once the checkout holds the remote: ok when the
// marker matches or is absent, damaged when it disagrees but the key opens
// the state files (the marker was not written by this key, the files were),
// wrong when it disagrees and the key opens none.
export function judgeTeamKey(checkoutDir: string, syncStateDir: string, teamKey: Buffer, remote: string, options: TeamKeyJudgementOptions = {}): TeamKeyJudgement {
  const shownRemote = redactRemote(remote);
  const marker = readMarkerState(checkoutDir, teamKey);
  if (marker === 'match') return { verdict: 'ok' };
  if (marker === 'absent') {
    if (options.requireProofWithoutMarker && stateFilesOf(syncStateDir).length > 0 && !keyOpensAny(syncStateDir, teamKey)) {
      return {
        verdict: 'wrong',
        message: `This key opens none of the state files of ${shownRemote}, a repository from before the ${TEAM_MARKER_FILE} marker: it is not the key of that team. Join with the key of the team, or use an empty repository for a new one.`,
      };
    }
    return { verdict: 'ok' };
  }
  if (keyOpensAny(syncStateDir, teamKey)) {
    return {
      verdict: 'damaged',
      message: `The ${TEAM_MARKER_FILE} marker of ${shownRemote} did not match this key, but the key opens the state files of the repository: the marker was damaged and is written again with this sync.`,
    };
  }
  return {
    verdict: 'wrong',
    message: `This key is not the key of the team that uses ${shownRemote}: the ${TEAM_MARKER_FILE} marker of the repository was written with another key, and this key opens none of its state files. Join with the key of that team, or use an empty repository for a new one.`,
  };
}

function keyNotProvenMessage(count: number): string {
  const files = count === 1 ? 'the one state file' : `any of the ${count} state files`;
  return `This team key opened none of the remote state (${files}), so nothing was pushed and the shared state was left as it was. If the key is wrong, run egc team init again with the key of the team; if the key is right, the files on the remote are damaged and have to be removed from the repository by hand.`;
}

async function pushSealedState(instance: SyncBackend, teamKey: Buffer, personalKey: Buffer, unopened: readonly string[], result: SyncResult): Promise<void> {
  try {
    stageTeamState(LOCAL_STATE_DIR, SYNC_STATE_DIR, teamKey, personalKey, new Set(unopened));
    // The key is the team's here (it opened a file, or the repository holds
    // no state yet): a repository without the marker, or with a damaged
    // one, gets the marker of this key in the same push.
    if (readMarkerState(SYNC_CHECKOUT_DIR, teamKey) !== 'match') writeTeamMarker(SYNC_CHECKOUT_DIR, teamKey);
    if (await instance.push()) result.pushedCount = 1;
  } catch (err) {
    result.errors.push(`Push failed: ${String(err)}`);
  }
}

export interface TeamMergeOutcome {
  // Envelopes that opened with the team key, written to local state or not.
  opened: number;
  merged: number;
  // Links and paths that go through a link: never state, removed from the checkout.
  rejected: string[];
  // Files that did not open with the team key: left where they are.
  unopened: string[];
  unreadable: string[];
}

// Regular files and links under a directory, links kept apart: a link in
// the shared repository or at a local state path is never followed.
function walkEntries(dir: string): { files: string[]; links: string[] } {
  const found: { files: string[]; links: string[] } = { files: [], links: [] };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      found.links.push(fullPath);
    } else if (entry.isDirectory()) {
      const nested = walkEntries(fullPath);
      found.files.push(...nested.files);
      found.links.push(...nested.links);
    } else if (entry.isFile()) {
      found.files.push(fullPath);
    }
  }
  return found;
}

function isLink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

// Whether any directory between `root` (exclusive) and `filePath`
// (exclusive) is a link: a write there would land elsewhere.
function hasLinkedAncestor(filePath: string, root: string): boolean {
  let probe = path.dirname(filePath);
  const top = path.resolve(root);
  while (probe !== top && probe.startsWith(top + path.sep)) {
    if (isLink(probe)) return true;
    probe = path.dirname(probe);
  }
  return false;
}

// The roots below which every directory of ours must be real: the home
// directory and the temporary directory (where tests place their trees).
// Above them the system's own layout (a linked /tmp, say) is not ours to judge.
function trustedRoots(): string[] {
  return [os.homedir(), os.tmpdir()].map(root => path.resolve(root));
}

// The prefix every descendant of `root` starts with; a root that is the
// filesystem root already ends with the separator.
function descendantPrefix(root: string): string {
  return root.endsWith(path.sep) ? root : root + path.sep;
}


// The first directory between a trusted root (exclusive) and `dir`
// (inclusive) that is a link, or null when the whole chain is real.
function linkedDirectoryTowards(dir: string): string | null {
  const resolved = path.resolve(dir);
  const root = trustedRoots().find(candidate => resolved.startsWith(descendantPrefix(candidate)));

  if (!root) return isLink(resolved) ? resolved : null;
  let probe = resolved;
  while (probe !== root) {
    if (isLink(probe)) return probe;
    probe = path.dirname(probe);
  }
  return null;
}

function removeSyncFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // a file that cannot be removed is still refused for local state
  }
}

// Every sync file must open as a team envelope (right key, intact signature)
// before it can touch local state; anything else is reported and skipped.
// Local files are read and written through the personal key, so the merge
// compares plaintext timestamps and the result stays encrypted at rest.
type LegacyDocument = { file: string; content: string };
type MergeContext = { syncStateDir: string; localStateDir: string; teamKey: Buffer; personalKey: Buffer; integrityKey: Buffer | null; outcome: TeamMergeOutcome; legacy: Map<string, LegacyDocument> };

// The local document as it stands, or null when it must not be touched
// (a link, or a file that does not open with the personal key).
function currentLocal(localFile: string, relativePath: string, context: MergeContext): { content: string; legacyPlaintext: boolean } | null {
  if (isLink(localFile) || hasLinkedAncestor(localFile, context.localStateDir)) {
    context.outcome.rejected.push(`${relativePath} (local path goes through a link)`);
    return null;
  }
  if (!fs.existsSync(localFile)) return { content: '', legacyPlaintext: false };
  try {
    const raw = fs.readFileSync(localFile);
    return { content: readStateFile(localFile, context.personalKey), legacyPlaintext: !isEncrypted(raw) };
  } catch {
    // A local file that does not open with the personal key (rotated key,
    // damaged bytes) is left exactly as it is.
    context.outcome.unreadable.push(relativePath);
    return null;
  }
}

// A local document the merge leaves as it is may carry a sidecar older
// versions left unusable: missing, or the encrypted bytes an earlier merge
// wrote in its place. Such a sidecar is written anew with the key of this
// machine. A well-formed sidecar that does not match is left alone, since
// that mismatch is the tamper signal get_state reports.
function repairSidecar(localFile: string, content: string, integrityKey: Buffer | null): void {
  if (!integrityKey || !content) return;
  // Read without following a link and without blocking on a FIFO, from a
  // regular private file only: anything else at the path is not a sidecar,
  // and the write below replaces it instead of reading or writing through it.
  let existing: string | null;
  try {
    existing = readPrivateKeyFile(`${localFile}${SIDECAR_SUFFIX}`).trim();
  } catch {
    existing = null;
  }
  if (existing !== null && /^[0-9a-f]{64}$/.test(existing)) return;
  writeHmac(localFile, content, integrityKey);
}

function mergeOneSyncFile(syncFile: string, context: MergeContext): void {
  const relativePath = path.relative(context.syncStateDir, syncFile);
  const remoteContent = openEnvelope(fs.readFileSync(syncFile, 'utf-8'), context.teamKey, relativePath);
  if (remoteContent === null) {
    // Refused for local state and left where it is: a file this key cannot
    // open was sealed by a team this machine may not belong to, or is
    // damaged, and neither is for this machine to remove from the shared
    // repository.
    context.outcome.unopened.push(relativePath);
    return;
  }
  context.outcome.opened += 1;
  const localFile = path.join(context.localStateDir, relativePath);
  const local = currentLocal(localFile, relativePath, context);
  if (local === null) return;
  // A keyed document that arrives before this machine wrote one merges with
  // the document an earlier version keyed by the path, which would otherwise
  // be shadowed unread; the result lands under the key, the legacy file stays.
  const legacy = local.content ? undefined : context.legacy.get(relativePath);
  const localContent = legacy ? legacy.content : local.content;
  const merged = localContent ? mergeStateDocuments(localContent, remoteContent) : remoteContent;
  // When the remote changes nothing in the document, the local file is left
  // as it is, whatever layout an earlier version gave it.
  const unchanged = local.content !== '' && (merged === local.content || merged === canonicalForm(local.content));
  if (unchanged && !local.legacyPlaintext) {
    repairSidecar(localFile, local.content, context.integrityKey);
    return;
  }
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  writeStateFile(localFile, merged, context.personalKey);
  if (context.integrityKey) writeHmac(localFile, merged, context.integrityKey);
  context.outcome.merged += 1;
}

export function mergeTeamStateFrom(syncStateDir: string, localStateDir: string, teamKey: Buffer, personalKey: Buffer, integrityKey: Buffer | null = null): TeamMergeOutcome {
  const outcome: TeamMergeOutcome = { opened: 0, merged: 0, rejected: [], unopened: [], unreadable: [] };
  // The state tree of the repository must be a real directory: a link there
  // (dangling or not) would make the merge read, reject and remove whatever
  // it points at.
  const linkedSync = linkedDirectoryTowards(syncStateDir);
  if (linkedSync) {
    outcome.rejected.push(`state (the sync tree is a link at ${linkedSync})`);
    if (linkedSync === path.resolve(syncStateDir)) removeSyncFile(syncStateDir);
    return outcome;
  }
  if (!fs.existsSync(syncStateDir)) return outcome;
  // The local tree and every directory above it must be real too, or the
  // merge would write wherever a link points.
  const linkedLocal = linkedDirectoryTowards(localStateDir);
  if (linkedLocal) {
    outcome.rejected.push(`local state (the local tree is a link at ${linkedLocal})`);
    return outcome;
  }
  fs.mkdirSync(localStateDir, { recursive: true });


  const entries = walkEntries(syncStateDir);
  // A link in the repository is refused and removed, so it is neither
  // followed here nor pushed back to the team.
  for (const link of entries.links) {
    outcome.rejected.push(path.relative(syncStateDir, link));
    removeSyncFile(link);
  }
  // A sidecar an earlier version pushed has no meaning on any other
  // machine, and neither has a hidden file (the markers the hooks keep
  // next to the state): both are retired from the shared tree and never
  // written locally.
  for (const stray of entries.files.filter(file => isSidecar(file) || isHiddenEntry(file, syncStateDir))) removeSyncFile(stray);
  const context: MergeContext = { syncStateDir, localStateDir, teamKey, personalKey, integrityKey, outcome, legacy: indexLegacyDocuments(localStateDir, personalKey) };
  for (const syncFile of entries.files.filter(file => !isSidecar(file) && !isHiddenEntry(file, syncStateDir))) mergeOneSyncFile(syncFile, context);
  // A team sync never removes local state files: a file absent from the sync
  // repo may be one this machine created and has not pushed yet, and deleting
  // it would be silent, unrecoverable memory loss. Remote deletions therefore
  // do not propagate automatically.
  return outcome;
}

type DocumentHeader = { project: string | null; branch: string | null };

// The project and the branch a state document was written for, from its
// header.
function documentHeader(plaintext: string): DocumentHeader {
  const header: DocumentHeader = { project: null, branch: null };
  for (const line of plaintext.split(/\r?\n/, 16)) {
    if (line.startsWith('## ')) break;
    if (line.startsWith('project:')) header.project = line.slice('project:'.length).trim() || null;
    if (line.startsWith('branch:')) header.branch = line.slice('branch:'.length).trim() || null;
  }
  return header;
}

const HASHED_DOCUMENT_NAME = /--[0-9a-f]{64}\.md$/;

// The name a legacy document takes under the key: the hashed name of the
// branch its header records, the only name the current version reads and
// writes for a branch, so the documents of both versions meet. Without a
// branch in the header, a name that is already hashed is kept and the
// `<branch>.md` of the versions before the hash is hashed from its stem. A
// detached document keeps its name, the commit.
function keyedDocumentName(fileName: string, branch: string | null): string {
  if (fileName.startsWith('detached--')) return fileName;
  if (branch) return `${branchStateKey(branch)}.md`;
  if (HASHED_DOCUMENT_NAME.test(fileName)) return fileName;
  const fromName = fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
  return `${branchStateKey(fromName)}.md`;
}

// The keyed path a document of the versions before the remote identity
// (under the slug of the project path, or the flat file of the project) is
// shared under, when this machine still has the repository; null for any
// other document. A flat document, which predates branches, becomes the
// document of the branch its header records or of the default branch. The
// header is trusted only as far as projectIdentity trusts a path: a
// repository under the home or the temp directory, read through the same
// checks as HEAD, and the key it yields is a sanitized name and a hash, so a
// header can name no path outside the state directories. A holder of the
// team key can still learn, by naming a path, the key of a repository this
// machine has there; the signature per member of #2056 is what closes that.
function legacySharedPath(relativePath: string, plaintext: string): string | null {
  const { project, branch } = documentHeader(plaintext);
  if (!project) return null;
  const segments = relativePath.split(path.sep);
  const slug = projectSlug(project);
  const isLegacyDir = segments.length === 2 && segments[0] === slug;
  const isLegacyFlat = segments.length === 1 && segments[0] === `${slug}.md`;
  if (!isLegacyDir && !isLegacyFlat) return null;
  const identity = projectIdentity(project);
  if (identity.kind !== 'remote') return null;
  const name = isLegacyDir ? keyedDocumentName(segments[1], branch) : `${branchStateKey(branch || 'main')}.md`;
  return path.join(identity.key, name);
}

// The path a local document is shared under: its own, or the keyed one for
// a document of the versions before the remote identity, so the other
// machines read it for their own checkouts; null when the keyed document
// that supersedes it exists locally, since that one carries the state.
export function sharedRelativePath(localStateDir: string, relativePath: string, plaintext: string): string | null {
  const shared = legacySharedPath(relativePath, plaintext);
  if (shared === null) return relativePath;
  return keyedDocumentExists(localStateDir, shared) ? null : shared;
}

// A keyed document counts as present only as a regular file reached through
// real directories: a link planted at that path, or above it, is not state
// and must not silence the legacy document.
function keyedDocumentExists(localStateDir: string, shared: string): boolean {
  const keyedFile = path.join(localStateDir, shared);
  if (isLink(keyedFile) || hasLinkedAncestor(keyedFile, localStateDir)) return false;
  try {
    return fs.lstatSync(keyedFile).isFile();
  } catch {
    return false;
  }
}

// The documents of the versions before the remote identity, by the path
// they are shared under, so a keyed document arriving from another machine
// merges with the local legacy one instead of shadowing it unread. Two
// legacy documents of one repository (two checkouts) are merged into one.
function indexLegacyDocuments(localStateDir: string, personalKey: Buffer): Map<string, LegacyDocument> {
  const index = new Map<string, LegacyDocument>();
  if (!fs.existsSync(localStateDir)) return index;
  for (const file of walkEntries(localStateDir).files) {
    if (isSidecar(file)) continue;
    let content: string;
    try {
      content = readStateFile(file, personalKey);
    } catch {
      continue;
    }
    const shared = legacySharedPath(path.relative(localStateDir, file), content);
    if (shared === null) continue;
    const previous = index.get(shared);
    index.set(shared, { file, content: previous ? mergeStateDocuments(previous.content, content) : content });
  }
  return index;
}

// Local state leaves the machine only as sealed envelopes; a local file that
// cannot be decrypted is left out rather than shipped opaque.
// `keep` holds the relative paths the merge could not open: this machine
// never writes its own state over an envelope it cannot read, so those
// paths are left as they are and not staged.
type StageContext = { localStateDir: string; syncStateDir: string; teamKey: Buffer; personalKey: Buffer; keep: ReadonlySet<string>; stagedByPath: Map<string, string> };

// Seals one local document into the sync tree at the path it is shared
// under. Two legacy documents of one repository (two checkouts of it on this
// machine) share one path: what leaves is their merge, section by section.
function stageOneDocument(localFile: string, context: StageContext): void {
  let plaintext: string;
  try {
    plaintext = readStateFile(localFile, context.personalKey);
  } catch {
    return;
  }
  const sharedPath = sharedRelativePath(context.localStateDir, path.relative(context.localStateDir, localFile), plaintext);
  if (sharedPath === null || context.keep.has(sharedPath)) return;
  const already = context.stagedByPath.get(sharedPath);
  const chosen = already === undefined ? plaintext : mergeStateDocuments(already, plaintext);
  if (chosen === already) return;
  const target = path.join(context.syncStateDir, sharedPath);
  if (isLink(target)) removeSyncFile(target);
  if (hasLinkedAncestor(target, context.syncStateDir)) throw new Error(`the sync state tree has a linked directory above ${sharedPath} and is not written`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, sealEnvelope(chosen, context.teamKey, sharedPath), 'utf-8');
  context.stagedByPath.set(sharedPath, chosen);
}

export function stageTeamState(localStateDir: string, syncStateDir: string, teamKey: Buffer, personalKey: Buffer, keep: ReadonlySet<string> = new Set()): number {
  const linkedLocal = linkedDirectoryTowards(localStateDir);
  if (linkedLocal) throw new Error(`the local state tree is a link at ${linkedLocal} and is not staged`);
  const linkedSync = linkedDirectoryTowards(syncStateDir);
  if (linkedSync) throw new Error(`the sync state tree is a link at ${linkedSync} and is not written`);
  if (!fs.existsSync(localStateDir)) return 0;

  const context: StageContext = { localStateDir, syncStateDir, teamKey, personalKey, keep, stagedByPath: new Map() };
  for (const localFile of walkEntries(localStateDir).files) {
    if (!isSidecar(localFile) && !isHiddenEntry(localFile, localStateDir)) stageOneDocument(localFile, context);
  }
  return context.stagedByPath.size;
}

// A hidden entry under the state tree is not a state document: the hooks
// keep their markers there (the save-prompt throttle of the Claude Code
// stop hook), and those belong to one machine. A hidden directory hides
// everything below it.
function isHiddenEntry(filePath: string, root: string): boolean {
  return path.relative(root, filePath).split(path.sep).some(segment => segment.startsWith('.'));
}
