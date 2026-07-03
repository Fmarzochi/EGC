import simpleGit, { SimpleGit } from 'simple-git';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SyncBackend, SyncConfig, SyncStatus } from './SyncBackend';

const SYNC_STATE_DIR = path.join(os.homedir(), '.egc', 'team-sync');

export class GitBackend extends SyncBackend {
  private git: SimpleGit;
  private config: SyncConfig | null = null;
  private readonly repoDir: string;

  constructor() {
    super();
    this.repoDir = SYNC_STATE_DIR;
    if (!fs.existsSync(this.repoDir)) {
      fs.mkdirSync(this.repoDir, { recursive: true });
    }
    this.git = simpleGit(this.repoDir);
  }

  async init(config: SyncConfig): Promise<void> {
    this.config = config;

    const isRepo = fs.existsSync(path.join(this.repoDir, '.git'));
    if (!isRepo) {
      await this.git.init();
      // Rename default branch (master) to match config branch (e.g. main).
      await this.git.raw(['branch', '-M', config.branch]);
      await this.ensureOriginRemote(config.remote);
    } else {
      await this.ensureOriginRemote(config.remote);
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

    // Discard uncommitted sync-repo changes before pulling.
    try {
      await this.git.reset(['--hard']);
    } catch {
      // Empty repo on first sync.
    }

    try {
      await this.git.pull('origin', this.config.branch, ['--allow-unrelated-histories', '--no-rebase']);
    } catch {
      // Pull failed, maybe no upstream yet.
      return [];
    }

    // Get list of changed files from the pull.
    const log = await this.git.log({ maxCount: 1 });
    if (!log.latest) {
      return [];
    }

    const commitCount = await this.git.raw(['rev-list', '--count', 'HEAD']);
    if (parseInt(commitCount.trim(), 10) <= 1) {
      const show = await this.git.show(['--name-only', '--pretty=format:', log.latest.hash]);
      return show.split('\n').filter(Boolean);
    }

    const diff = await this.git.diff(['--name-only', `${log.latest.hash}~1`, log.latest.hash]);
    return diff.split('\n').filter(Boolean);
  }

  async push(): Promise<boolean> {
    if (!this.config) throw new Error('GitBackend not initialized. Call init() first.');

    // Copy the current state files into the sync repo.
    const stateDir = path.join(os.homedir(), '.egc', 'state');
    const syncStateDir = path.join(this.repoDir, 'state');

    if (fs.existsSync(stateDir)) {
      this.mirrorCopy(stateDir, syncStateDir);
    }

    // Also copy lessons/decisions from the memory DB as JSON.
    const memoryDir = path.join(os.homedir(), '.egc', 'memory');
    const syncMemoryDir = path.join(this.repoDir, 'memory');
    if (fs.existsSync(memoryDir)) {
      this.mirrorCopy(memoryDir, syncMemoryDir);
    }

    // Add, commit, and push.
    await this.git.add('-A');
    const staged = await this.git.diff(['--cached', '--name-only']);
    if (!staged.trim()) {
      return false;
    }

    await this.ensureGitIdentity();

    const author = process.env.USER || process.env.USERNAME || 'unknown';
    await this.git.commit(`sync: team memory update from ${author}`);
    try {
      await this.git.push('origin', this.config.branch);
    } catch {
      // Push failed, maybe no upstream. Try setting upstream.
      try {
        await this.git.push(['--set-upstream', 'origin', this.config.branch]);
      } catch (err2) {
        throw new Error(`Push failed after setting upstream: ${String(err2)}`);
      }
    }
    return true;
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
      const gitStatus = await this.git.status();
      hasUncommittedChanges = gitStatus.files.length > 0;
    } catch {
      hasUncommittedChanges = false;
    }

    let conflictCount = 0;
    try {
      const gitStatus = await this.git.status();
      conflictCount = gitStatus.conflicted.length;
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

  private async ensureGitIdentity(): Promise<void> {
    const name = process.env.USER || process.env.USERNAME || 'egc';
    await this.git.addConfig('user.email', `${name}@egc.local`, false, 'local');
    await this.git.addConfig('user.name', name, false, 'local');
  }

  private async ensureOriginRemote(remoteUrl: string): Promise<void> {
    const remotes = await this.git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    if (!origin) {
      try {
        await this.git.addRemote('origin', remoteUrl);
      } catch {
        // remote may already exist from a concurrent init
        if (!remotes.some(r => r.name === 'origin')) {
          await this.git.addRemote('origin', remoteUrl);
        }
      }
    } else if (origin.refs.fetch !== remoteUrl) {
      await this.git.remote(['set-url', 'origin', remoteUrl]);
    }
  }

  private mirrorCopy(src: string, dest: string): void {
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
}
