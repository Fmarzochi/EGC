import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SyncBackend } from './SyncBackend';
import { GitBackend } from './GitBackend';
import type { SyncConfig, SyncStatus, SyncResult } from './SyncBackend';

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

export async function teamInit(backend: string, remote: string, branch: string = 'main'): Promise<SyncConfig> {
  const BackendClass = BACKEND_REGISTRY[backend];
  if (!BackendClass) {
    throw new Error(`Unknown sync backend: "${backend}". Supported backends: ${Object.keys(BACKEND_REGISTRY).join(', ')}`);
  }

  const config: SyncConfig = { backend, remote, branch };
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
    errors: [],
  };

  const instance = new BackendClass();
  try {
    await instance.init(config);

    // Step 1: Pull remote changes.
    try {
      const changedFiles = await instance.pull();
      result.pulledCount = changedFiles.length;
      result.conflictCount = 0; // Git handles merge tracking
    } catch (err) {
      result.errors.push(`Pull failed: ${String(err)}`);
    }

    // Step 2: Merge into local state.
    await mergeTeamState();

    // Step 3: Push local changes.
    try {
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

async function mergeTeamState(): Promise<void> {
  const syncStateDir = path.join(os.homedir(), '.egc', 'team-sync', 'state');
  const localStateDir = path.join(os.homedir(), '.egc', 'state');

  if (!fs.existsSync(syncStateDir)) return;
  if (!fs.existsSync(localStateDir)) {
    fs.mkdirSync(localStateDir, { recursive: true });
  }

  const syncFiles = getAllFiles(syncStateDir);
  if (syncFiles.length === 0) {
    return; // No remote state yet; preserve local files.
  }
  const syncedRelativePaths = new Set<string>();

  for (const syncFile of syncFiles) {
    const relativePath = path.relative(syncStateDir, syncFile);
    syncedRelativePaths.add(relativePath);
    const localFile = path.join(localStateDir, relativePath);

    const syncContent = fs.readFileSync(syncFile, 'utf-8');
    const localContent = fs.existsSync(localFile) ? fs.readFileSync(localFile, 'utf-8') : '';

    if (!localContent) {
      // New file from team: copy it over.
      const localDir = path.dirname(localFile);
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }
      fs.writeFileSync(localFile, syncContent, 'utf-8');
    } else {
      // Both exist: merge with last-write-wins per section.
      const merged = mergeStateDocs(localContent, syncContent);
      fs.writeFileSync(localFile, merged, 'utf-8');
    }
  }

  // Propagate remote deletions: remove local files absent from sync repo.
  const localFiles = getAllFiles(localStateDir);
  for (const localFile of localFiles) {
    const relativePath = path.relative(localStateDir, localFile);
    if (!syncedRelativePaths.has(relativePath)) {
      fs.unlinkSync(localFile);
    }
  }
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
