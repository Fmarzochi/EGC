import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SyncBackend } from './SyncBackend';
import { GitBackend } from './GitBackend';
import type { SyncConfig, SyncStatus, SyncResult } from './SyncBackend';
import { loadOrCreateEncKey, readStateFile, writeStateFile } from '../encryption';
import { generateTeamKey, openEnvelope, parseTeamKey, sealEnvelope } from './envelope';
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

export function writeTeamConfig(config: SyncConfig): void {
  const egcDir = path.join(os.homedir(), '.egc');
  if (!fs.existsSync(egcDir)) {
    fs.mkdirSync(egcDir, { recursive: true });
  }
  fs.writeFileSync(TEAM_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
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
      result.errors.push(`Sync backend init failed (offline?): ${String(err)}`);
      return result;
    }

    // Step 1: Pull remote changes.
    try {
      const changedFiles = await instance.pull();
      result.pulledCount = changedFiles.length;
      result.conflictCount = 0; // Git handles merge tracking
    } catch (err) {
      result.errors.push(`Pull failed: ${String(err)}`);
    }

    // Step 2: Merge into local state; only verified team envelopes count.
    const merge = mergeTeamStateFrom(SYNC_STATE_DIR, LOCAL_STATE_DIR, teamKey, personalKey);
    result.rejectedCount = merge.rejected.length;
    for (const rejected of merge.rejected) {
      result.errors.push(`Rejected sync file (not a verified team envelope): ${rejected}`);
    }
    // Step 3: Stage local state as sealed envelopes and push.
    try {
      stageTeamState(LOCAL_STATE_DIR, SYNC_STATE_DIR, teamKey, personalKey);
      const pushed = await instance.push();
      if (pushed) {
        result.pushedCount = 1;
      }
    } catch (err) {
      result.errors.push(`Push failed: ${String(err)}`);
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
    await instance.init(config);
    return await instance.status();
  } finally {
    await instance.destroy();
  }
}

const SYNC_STATE_DIR = path.join(os.homedir(), '.egc', 'team-sync', 'state');
const LOCAL_STATE_DIR = path.join(os.homedir(), '.egc', 'state');

export interface TeamMergeOutcome {
  merged: number;
  rejected: string[];
}

// Every sync file must open as a team envelope (right key, intact signature)
// before it can touch local state; anything else is reported and skipped.
// Local files are read and written through the personal key, so the merge
// compares plaintext timestamps and the result stays encrypted at rest.
export function mergeTeamStateFrom(syncStateDir: string, localStateDir: string, teamKey: Buffer, personalKey: Buffer): TeamMergeOutcome {
  const outcome: TeamMergeOutcome = { merged: 0, rejected: [] };
  if (!fs.existsSync(syncStateDir)) return outcome;
  if (!fs.existsSync(localStateDir)) {
    fs.mkdirSync(localStateDir, { recursive: true });
  }
  for (const syncFile of getAllFiles(syncStateDir)) {
    const relativePath = path.relative(syncStateDir, syncFile);
    const remoteContent = openEnvelope(fs.readFileSync(syncFile, 'utf-8'), teamKey);
    if (remoteContent === null) {
      outcome.rejected.push(relativePath);
      continue;
    }
    const localFile = path.join(localStateDir, relativePath);
    let localContent = '';
    if (fs.existsSync(localFile)) {
      try {
        localContent = readStateFile(localFile, personalKey);
      } catch {
        localContent = '';
      }
    }
    const merged = localContent ? mergeStateDocs(localContent, remoteContent) : remoteContent;
    if (merged === localContent) continue;
    fs.mkdirSync(path.dirname(localFile), { recursive: true });
    writeStateFile(localFile, merged, personalKey);
    outcome.merged += 1;
  }
  // A team sync never removes local state files: a file absent from the sync
  // repo may be one this machine created and has not pushed yet, and deleting
  // it would be silent, unrecoverable memory loss. Remote deletions therefore
  // do not propagate automatically.
  return outcome;
}

// Local state leaves the machine only as sealed envelopes; a local file that
// cannot be decrypted is left out rather than shipped opaque.
export function stageTeamState(localStateDir: string, syncStateDir: string, teamKey: Buffer, personalKey: Buffer): number {
  if (!fs.existsSync(localStateDir)) return 0;
  let staged = 0;
  for (const localFile of getAllFiles(localStateDir)) {
    let plaintext: string;
    try {
      plaintext = readStateFile(localFile, personalKey);
    } catch {
      continue;
    }
    const target = path.join(syncStateDir, path.relative(localStateDir, localFile));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, sealEnvelope(plaintext, teamKey), 'utf-8');
    staged += 1;
  }
  return staged;
}

function getAllFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function mergeStateDocs(localContent: string, remoteContent: string): string {
  const localUpdated = extractTimestamp(localContent);
  const remoteUpdated = extractTimestamp(remoteContent);

  if (remoteUpdated > localUpdated) {
    return remoteContent;
  }
  return localContent;
}

function extractTimestamp(content: string): number {
  const match = /^updated:\s*(.+)/m.exec(content);
  if (match) {
    return new Date(match[1].trim()).getTime();
  }
  return 0;
}
