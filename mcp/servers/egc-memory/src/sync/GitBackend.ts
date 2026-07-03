import simpleGit, { SimpleGit } from 'simple-git';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SyncBackend, SyncConfig, SyncStatus } from './SyncBackend';

const SYNC_STATE_DIR = path.join(os.homedir(), '.egc', 'team-sync');

export class GitBackend extends SyncBackend {
  private git: SimpleGit;
  private config: SyncConfig | null = null;
  private repoDir: string;

  constructor() {
    super();
    this.repoDir = SYNC_STATE_DIR;
    this.git = simpleGit(this.repoDir);
  }

  async init(config: SyncConfig): Promise<void> {
    this.config = config;
    if (!fs.existsSync(this.repoDir)) {
      fs.mkdirSync(this.repoDir, { recursive: true });
    }

    const isRepo = fs.existsSync(path.join(this.repoDir, '.git'));
    if (!isRepo) {
      await this.git.init();
      try {
        await this.git.addRemote('origin', config.remote);
      } catch {
        // remote may already exist
        const remotes = await this.git.getRemotes(true);
        if (!remotes.find(r => r.name === 'origin')) {
          await this.git.addRemote('origin', config.remote);
        }
      }
    } else {
      const remotes = await this.git.getRemotes(true);
      if (!remotes.find(r => r.name === 'origin')) {
        await this.git.addRemote('origin', config.remote);
      }
    }

    // Try to pull once to establish the branch tracking.
    try {
      await this.git.pull('origin', config.branch, ['--allow-unrelated-histories', '--no-rebase']);
    } catch {
      // First-time init: no upstream yet, that's fine.
    }
  }

  async pull(): Promise<string[]> {
    if (!this.config) throw new Error('GitBackend not initialized. Call init() first.');

    // Stash any local changes before pulling.
    try {
      await this.git.add('.');
      const stash = await this.git.stash();
      if (stash) {
        // Changes were stashed
      }
    } catch {
      // Nothing to stash
    }

    try {
      await this.git.pull('origin', this.config.branch, ['--allow-unrelated-histories', '--no-rebase']);
    } catch {
      // Pull failed, maybe no upstream yet.
      return [];
    }

    // Get list of changed files from the pull.
    const log = await this.git.log({ maxCount: 1 });
    if (log.latest) {
      const diff = await this.git.diff(['--name-only', `${log.latest.hash}~1`, log.latest.hash]);
      return diff.split('\n').filter(Boolean);
    }

    return [];
  }

  async push(): Promise<void> {
    if (!this.config) throw new Error('GitBackend not initialized. Call init() first.');

    // Copy the current state files into the sync repo.
    const stateDir = path.join(os.homedir(), '.egc', 'state');
    const syncStateDir = path.join(this.repoDir, 'state');
    if (!fs.existsSync(syncStateDir)) {
      fs.mkdirSync(syncStateDir, { recursive: true });
    }

    if (fs.existsSync(stateDir)) {
      this.copyRecursive(stateDir, syncStateDir);
    }

    // Also copy lessons/decisions from the memory DB as JSON.
    const memoryDir = path.join(os.homedir(), '.egc', 'memory');
    const syncMemoryDir = path.join(this.repoDir, 'memory');
    if (!fs.existsSync(syncMemoryDir)) {
      fs.mkdirSync(syncMemoryDir, { recursive: true });
    }
    if (fs.existsSync(memoryDir)) {
      this.copyRecursive(memoryDir, syncMemoryDir);
    }

    // Add, commit, and push.
    await this.git.add('.');
    const status = await this.git.status();
    if (status.staged.length === 0 && status.modified.length === 0 && status.not_added.length === 0) {
      return; // Nothing to commit.
    }

    const author = process.env.USER || process.env.USERNAME || 'unknown';
    await this.git.commit(`sync: team memory update from ${author}`);
    try {
      await this.git.push('origin', this.config.branch);
    } catch {
      // Push failed, maybe no upstream. Try setting upstream.
      await this.git.push(['--set-upstream', 'origin', this.config.branch]);
    }
  }

  async status(): Promise<SyncStatus> {
    if (!this.config) throw new Error('GitBackend not initialized. Call init() first.');

    const isRepo = fs.existsSync(path.join(this.repoDir, '.git'));
    if (!isRepo) {
      return {
        lastSyncTime: null,
        hasUncommittedChanges: false,
        conflictCount: 0,
        remoteUrl: this.config.remote,
      };
    }

    let lastSyncTime: string | null = null;
    try {
      const log = await this.git.log({ maxCount: 1 });
      if (log.latest) {
        lastSyncTime = log.latest.date;
      }
    } catch {
      // No commits yet.
    }

    let hasUncommittedChanges = false;
    try {
      const status = await this.git.status();
      hasUncommittedChanges = status.files.length > 0;
    } catch {
      hasUncommittedChanges = false;
    }

    let conflictCount = 0;
    try {
      const status = await this.git.status();
      conflictCount = status.conflicted.length;
    } catch {
      conflictCount = 0;
    }

    return {
      lastSyncTime,
      hasUncommittedChanges,
      conflictCount,
      remoteUrl: this.config.remote,
    };
  }

  async destroy(): Promise<void> {
    this.config = null;
  }

  private copyRecursive(src: string, dest: string): void {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(destPath, { recursive: true });
        }
        this.copyRecursive(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}
