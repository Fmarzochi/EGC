import { simpleGit, SimpleGit } from 'simple-git';
import type { RemoteWithRefs } from 'simple-git';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { InitOptions, SyncBackend, SyncConfig, SyncStatus } from './SyncBackend';
import { GIT_ENVIRONMENT_KEYS, gitEnvironment } from './git-env';

const SYNC_STATE_DIR = path.join(os.homedir(), '.egc', 'team-sync');

// The first line git gave for a failure, without the "fatal:" prefix.
function gitReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split('\n').map(part => part.trim()).find(part => part.length > 0) ?? 'unknown error';
  return line.replace(/^fatal:\s*/, '');
}

// The same remote with or without a trailing slash; on Windows, where a
// local path is spelled with either slash, with either slash too.
function sameRemoteUrl(a: string, b: string): boolean {
  const normalize = (url: string) => (process.platform === 'win32' ? url.replace(/\\/g, '/') : url).replace(/\/$/, '');
  return normalize(a) === normalize(b);
}

// The remote an existing checkout follows, as the refusal names it.
function describeFollowed(remotes: RemoteWithRefs[], origin: RemoteWithRefs | undefined): string {
  if (!origin) return remotes.length === 0 ? 'no remote' : `${remotes.map(r => r.name).join(', ')} with no origin`;
  if (sameRemoteUrl(origin.refs.fetch, origin.refs.push)) return origin.refs.fetch;
  return `${origin.refs.fetch} and pushes to ${origin.refs.push}`;
}

export class GitBackend extends SyncBackend {
  private git: SimpleGit;
  private config: SyncConfig | null = null;
  private readonly repoDir: string;

  constructor(repoDir?: string) {
    super();
    this.repoDir = repoDir || SYNC_STATE_DIR;
    if (!fs.existsSync(this.repoDir)) {
      fs.mkdirSync(this.repoDir, { recursive: true });
    }
    // simple-git drops every GIT_* variable from the child environment unless
    // it is named here, and treats an ssh command in that environment as a
    // way to run arbitrary commands unless allowed: the three the server
    // sets or forwards are named, and the ssh command is allowed because the
    // server composes it itself, from its own flag and the person's
    // core.sshCommand, never from a remote or from a tool argument.
    this.git = simpleGit({
      baseDir: this.repoDir,
      allowEnvironment: [...GIT_ENVIRONMENT_KEYS],
      unsafe: { allowUnsafeSshCommand: true },
    });
  }

  async init(config: SyncConfig, options: InitOptions = {}): Promise<void> {
    this.config = config;
    await this.useNonInteractiveGit();

    const isRepo = fs.existsSync(path.join(this.repoDir, '.git'));
    if (isRepo) {
      await this.assertCheckoutFollows(config);
    } else {
      await this.git.init();
      // Rename default branch (master) to match config branch (e.g. main).
      await this.git.raw(['branch', '-M', config.branch]);
    }
    await this.ensureOriginRemote(config.remote);
    // A status reads the local checkout only, so it answers while the
    // remote is down.
    if (options.readRemote === false) return;

    // The remote is read once here, so a URL that cannot be reached (a typo,
    // a host key not yet accepted, a missing credential) fails the init
    // instead of becoming a sync that reports nothing moved.
    if (await this.remoteHasBranch(config)) {
      await this.git.pull('origin', config.branch, ['--allow-unrelated-histories', '--no-rebase']);
    }
  }

  // An existing checkout was made for one remote and one branch. A config
  // that names another is refused, with what to do, instead of leaving the
  // checkout behind the config: the next sync would pull and push the
  // configured branch against a checkout on another one, or push the old
  // history to the new repository.
  private async assertCheckoutFollows(config: SyncConfig): Promise<void> {
    const remotes = await this.git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    const followedBranch = await this.currentBranch();
    // A checkout with no remote at all adopts the configured one; a checkout
    // with remotes but no origin, or whose origin fetches from or pushes to
    // another place, is somebody else's and is refused.
    const sameRemote = remotes.length === 0
      || (origin !== undefined && sameRemoteUrl(origin.refs.fetch, config.remote) && sameRemoteUrl(origin.refs.push, config.remote));
    if (sameRemote && followedBranch === config.branch) return;
    throw new Error(
      `The sync checkout at ${this.repoDir} follows ${describeFollowed(remotes, origin)} on branch ${followedBranch}, not ${config.remote} on branch ${config.branch}. ` +
      'Remove that directory (your state under ~/.egc/state is not in it) and run egc team init again.',
    );
  }

  // Every git command from here on runs without a terminal to wait for: a
  // remote that would ask a question fails at once with git's reason, which
  // the sync reports, instead of holding the server until the caller's
  // timeout. The person's own core.sshCommand, read here once, is kept.
  private async useNonInteractiveGit(): Promise<void> {
    // Before the checkout exists a plain lookup would walk up to whatever
    // repository holds the home directory; the person's global setting is
    // what applies then.
    const scope = fs.existsSync(path.join(this.repoDir, '.git')) ? [] : ['--global'];
    let configuredSshCommand: string | null = null;
    try {
      configuredSshCommand = (await this.git.raw(['config', ...scope, '--get', 'core.sshCommand'])).trim() || null;
    } catch {
      // not configured
    }
    this.git = this.git.env(gitEnvironment(process.env, configuredSshCommand));
  }

  private async currentBranch(): Promise<string> {
    try {
      return (await this.git.raw(['symbolic-ref', '--short', 'HEAD'])).trim();
    } catch {
      return 'no branch (detached HEAD)';
    }
  }

  // Whether the configured branch exists on the remote. Throws, naming the
  // remote and git's reason, when the remote cannot be read at all; a
  // repository without the branch yet is simply false.
  private async remoteHasBranch(config: SyncConfig): Promise<boolean> {
    let heads: string;
    try {
      heads = await this.git.listRemote(['--heads', 'origin', config.branch]);
    } catch (error) {
      throw new Error(`The remote ${config.remote} cannot be read: ${gitReason(error)}`, { cause: error });
    }
    return heads.trim().length > 0;
  }

  async pull(): Promise<string[]> {
    if (!this.config) throw new Error('GitBackend not initialized. Call init() first.');

    // Discard uncommitted sync-repo changes before pulling.
    try {
      await this.git.reset(['--hard']);
    } catch {
      // Empty repo on first sync.
    }

    // A remote that cannot be read is an error the caller reports; a remote
    // without the branch yet has nothing to pull.
    if (!(await this.remoteHasBranch(this.config))) return [];
    await this.git.pull('origin', this.config.branch, ['--allow-unrelated-histories', '--no-rebase']);

    // Get list of changed files from the pull.
    const log = await this.git.log({ maxCount: 1 });
    if (!log.latest) {
      return [];
    }

    const commitCount = await this.git.raw(['rev-list', '--count', 'HEAD']);
    if (Number.parseInt(commitCount.trim(), 10) <= 1) {
      const show = await this.git.show(['--name-only', '--pretty=format:', log.latest.hash]);
      return show.split('\n').filter(Boolean);
    }

    const diff = await this.git.diff(['--name-only', `${log.latest.hash}~1`, log.latest.hash]);
    return diff.split('\n').filter(Boolean);
  }

  async push(): Promise<boolean> {
    if (!this.config) throw new Error('GitBackend not initialized. Call init() first.');

    // State files are staged by TeamSync as sealed team envelopes before
    // push() runs; the raw (personally encrypted) files never enter the repo.
    // The memory database under ~/.egc/memory (lessons, decisions, the
    // session bus, working memory) never leaves the machine either: earlier
    // versions mirrored it here in the clear, so a memory/ tree in the
    // checkout is retired and the commit below removes it from the shared
    // repository. History already pushed is rewritten by hand, if at all.
    GitBackend.retireMirroredMemory(this.repoDir);

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
      } catch (error_) {
        throw new Error(`Push failed after setting upstream: ${String(error_)}`, { cause: error_ });
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

    let hasUncommittedChanges: boolean;
    try {
      const gitStatus = await this.git.status();
      hasUncommittedChanges = gitStatus.files.length > 0;
    } catch {
      hasUncommittedChanges = false;
    }

    let conflictCount: number;
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

  destroy(): Promise<void> {
    this.config = null;
    return Promise.resolve();
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

  // The checkout entries an earlier version filled with the raw memory
  // database: the mirrored tree, and the temporaries an interrupted mirror
  // left beside it (it copied into a sibling, then swapped by renames).
  private static retireMirroredMemory(repoDir: string): void {
    const leftovers = fs.readdirSync(repoDir).filter(entry => (
      entry === 'memory' || entry.startsWith('.tmp-sync-memory-') || entry.startsWith('.tmp-old-memory-')
    ));
    for (const entry of leftovers) {
      fs.rmSync(path.join(repoDir, entry), { recursive: true, force: true });
    }
  }
}
