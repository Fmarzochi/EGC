/*
 * Copyright 2024 The Link Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * TypeScript port of thelink/gitsignals.py at commit 4f607a4 (github.com/UnforGBeast/thelink).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { signal, type FileDoc, type GitContextLike, type ScoreContext } from './file-ranker.js';

const LOG_LIMIT = 50;
const MAX_FILES_PER_COMMIT = 100;
const DEFAULT_BRANCHES = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
const W_CHANGED = 1.0;
const W_BRANCH = 0.7;
const W_RECENT = 0.6;
const W_COCHANGE = 0.5;
const GIT_TIMEOUT_MS = 5000;

// S4036: prefer fixed git locations over a PATH lookup, as the hooks and the
// leak checks do; the bare name is the last resort for layouts like nix or
// portable Git.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`
].find(candidate => fs.existsSync(candidate)) ?? 'git';

// The project is not trusted: its .git/config can name commands that git runs
// on its own (core.fsmonitor is run by `git status`). Settings given on the
// command line win over the repository's, so the ones that run commands are
// switched off here, and git is told not to take locks or write to the repository.
const SAFE_GIT_ARGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];

// Asynchronous, so a slow repository never blocks the MCP event loop; null on
// any failure (no git, not a repository, a call that ran out of time).
function runGit(projectPath: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile(
      GIT_BIN,
      [...SAFE_GIT_ARGS, '-C', projectPath, ...args],
      { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout)
    );
  });
}

// Keys of the repository's own config that make git run something while it
// looks at files: a filter (git status runs `clean` whenever it has to compare
// a file's content), a hooks directory, a diff or merge driver, or an include
// that could bring any of them in. The user's own and the system config are
// trusted; this one belongs to the project being ranked.
const RISKY_LOCAL_CONFIG = /^(filter\..+\.(clean|smudge|process|required)|core\.(fsmonitor|hookspath)|include\.path|includeif\..+\.path|diff\..+\.(command|textconv)|merge\..+\.driver)$/i;

// `git config --list` only prints; it runs nothing. When it cannot be read the
// answer is no, so the working tree is not looked at.
async function localConfigIsPlain(projectPath: string): Promise<boolean> {
  const out = await runGit(projectPath, ['config', '--local', '--list', '-z']);
  if (out === null) return false;
  return !out.split('\0').some(entry => RISKY_LOCAL_CONFIG.test(entry.split('\n')[0]));
}

const norm = (p: string): string => p.replaceAll('\\', '/').trim().replace(/^\.\/+/, '');

// -uall lists the files inside an untracked directory, not just the directory.
// With -z a rename or copy record is followed by one more, bare record that
// holds the original path; it has no status prefix and is skipped.
async function changedPaths(projectPath: string): Promise<Set<string>> {
  const paths = new Set<string>();
  // git status is the one call that reads the working tree, so it is the one a
  // repository's own filters could reach. Without them it is skipped, and the
  // branch, recency and co-change signals still come from the commits.
  if (!(await localConfigIsPlain(projectPath))) return paths;
  const out = await runGit(projectPath, ['status', '--porcelain', '-z', '-uall']);
  if (!out) return paths;
  const entries = out.split('\0');
  for (let k = 0; k < entries.length; k++) {
    const entry = entries[k];
    if (entry.length <= 3) continue;
    paths.add(norm(entry.slice(3)));
    if (/[RC]/.test(entry.slice(0, 2))) k++;
  }
  return paths;
}

async function branchPaths(projectPath: string): Promise<Set<string>> {
  let base: string | null = null;
  for (const ref of DEFAULT_BRANCHES) {
    const mb = await runGit(projectPath, ['merge-base', 'HEAD', ref]); // NOSONAR: the first ref that resolves wins, so the probes are ordered by design
    if (mb?.trim()) {
      base = mb.trim();
      break;
    }
  }
  if (!base) return new Set();
  const head = await runGit(projectPath, ['rev-parse', 'HEAD']);
  if (head && head.trim() === base) return new Set();
  // -z: names come NUL-separated and unquoted, whatever characters they hold.
  const diff = await runGit(projectPath, ['diff', '-z', '--no-ext-diff', '--no-textconv', '--name-only', `${base}...HEAD`]);
  return new Set((diff ?? '').split('\0').filter(l => l.trim()).map(norm));
}

async function recentAndCochange(
  projectPath: string
): Promise<{ recent: Map<string, number>; cochange: Map<string, Map<string, number>> }> {
  const recent = new Map<string, number>();
  const cochange = new Map<string, Map<string, number>>();
  const raw = await runGit(projectPath, ['log', `-${LOG_LIMIT}`, '-z', '--name-only', '--pretty=format:%x01%H', '--no-merges']);
  if (!raw) return { recent, cochange };

  // With -z each commit is "\x01<hash>\n" followed by its paths, NUL-separated and unquoted.
  const commits: string[][] = [];
  for (const chunk of raw.split('\x01')) {
    const newline = chunk.indexOf('\n');
    if (newline === -1) continue;
    const files = chunk.slice(newline + 1).split('\0').filter(f => f.trim()).map(norm);
    if (files.length) commits.push(files);
  }

  const n = Math.max(commits.length, 1);
  commits.forEach((files, i) => {
    if (files.length > MAX_FILES_PER_COMMIT) return;
    const w = (n - i) / n;
    for (const f of files) {
      if (w > (recent.get(f) ?? 0)) recent.set(f, w);
    }
    for (const a of files) {
      let bucket = cochange.get(a);
      if (!bucket) {
        bucket = new Map();
        cochange.set(a, bucket);
      }
      for (const b of files) {
        if (a !== b) bucket.set(b, (bucket.get(b) ?? 0) + 1);
      }
    }
  });
  return { recent, cochange };
}

export async function collectGitContext(projectPath: string): Promise<GitContextLike | null> {
  if ((await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'])) === null) return null;
  const [changed, branch, { recent, cochange }] = await Promise.all([
    changedPaths(projectPath),
    branchPaths(projectPath),
    recentAndCochange(projectPath)
  ]);
  if (changed.size === 0 && branch.size === 0 && recent.size === 0) return null;
  return { changed, branch, recent, cochange };
}

interface GitKeys { changed: string[]; branch: string[]; recent: string[]; cochange: string[] }
const KEYS = new WeakMap<GitContextLike, GitKeys>();

// The key lists are copied once per git context, not once per document scored.
function keysOf(git: GitContextLike): GitKeys {
  let keys = KEYS.get(git);
  if (!keys) {
    keys = { changed: [...git.changed], branch: [...git.branch], recent: [...git.recent.keys()], cochange: [...git.cochange.keys()] };
    KEYS.set(git, keys);
  }
  return keys;
}

export function matchPath(docPath: string, keys: Iterable<string>): string | undefined {
  const d = norm(docPath);
  const list = Array.isArray(keys) ? (keys as string[]) : [...keys];
  if (list.includes(d)) return d;
  return list.find(k => k.endsWith('/' + d) || d.endsWith('/' + k));
}

signal('git', 1.0, (doc: FileDoc, ctx: ScoreContext) => {
  const git = ctx.extras.gitSignal;
  if (!git) return 0;
  let score = 0;
  const keys = keysOf(git);
  if (matchPath(doc.path, keys.changed)) score += W_CHANGED;
  if (matchPath(doc.path, keys.branch)) score += W_BRANCH;
  const rk = matchPath(doc.path, keys.recent);
  if (rk) score += W_RECENT * (git.recent.get(rk) ?? 0);
  const ck = matchPath(doc.path, keys.cochange);
  if (ck && git.changed.size > 0) {
    const bucket = git.cochange.get(ck) ?? new Map<string, number>();
    let hits = 0;
    for (const c of git.changed) hits += bucket.get(c) ?? 0;
    if (hits) score += W_COCHANGE * Math.min(hits / 3, 1);
  }
  return score;
});
