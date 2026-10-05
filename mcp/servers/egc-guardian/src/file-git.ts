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
import { spawnSync } from 'node:child_process';
import { signal, type FileDoc, type GitContextLike, type ScoreContext } from './file-ranker.js';

const LOG_LIMIT = 50;
const MAX_FILES_PER_COMMIT = 100;
const DEFAULT_BRANCHES = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
const W_CHANGED = 1.0;
const W_BRANCH = 0.7;
const W_RECENT = 0.6;
const W_COCHANGE = 0.5;

function runGit(projectPath: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', projectPath, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

const norm = (p: string): string => p.replace(/\\/g, '/').trim().replace(/^\.\/+/, '');

function changedPaths(projectPath: string): Set<string> {
  const out = runGit(projectPath, ['status', '--porcelain', '-z']);
  const paths = new Set<string>();
  if (!out) return paths;
  for (const entry of out.split('\0')) {
    if (entry.length > 3) paths.add(norm(entry.slice(3)));
  }
  return paths;
}

function branchPaths(projectPath: string): Set<string> {
  let base: string | null = null;
  for (const ref of DEFAULT_BRANCHES) {
    const mb = runGit(projectPath, ['merge-base', 'HEAD', ref]);
    if (mb && mb.trim()) {
      base = mb.trim();
      break;
    }
  }
  if (!base) return new Set();
  const head = runGit(projectPath, ['rev-parse', 'HEAD']);
  if (head && head.trim() === base) return new Set();
  const diff = runGit(projectPath, ['diff', '--name-only', `${base}...HEAD`]);
  return new Set((diff ?? '').split('\n').filter(l => l.trim()).map(norm));
}

function recentAndCochange(projectPath: string): { recent: Map<string, number>; cochange: Map<string, Map<string, number>> } {
  const recent = new Map<string, number>();
  const cochange = new Map<string, Map<string, number>>();
  const raw = runGit(projectPath, ['log', `-${LOG_LIMIT}`, '--name-only', '--pretty=format:%x01%H', '--no-merges']);
  if (!raw) return { recent, cochange };

  const commits: string[][] = [];
  let current: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('\x01')) {
      if (current.length) commits.push(current);
      current = [];
    } else if (line.trim()) {
      current.push(norm(line));
    }
  }
  if (current.length) commits.push(current);

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

export function collectGitContext(projectPath: string): GitContextLike | null {
  if (runGit(projectPath, ['rev-parse', '--is-inside-work-tree']) === null) return null;
  const changed = changedPaths(projectPath);
  const branch = branchPaths(projectPath);
  const { recent, cochange } = recentAndCochange(projectPath);
  if (changed.size === 0 && branch.size === 0 && recent.size === 0) return null;
  return { changed, branch, recent, cochange };
}

export function matchPath(docPath: string, keys: Iterable<string>): string | undefined {
  const d = norm(docPath);
  const list = [...keys];
  if (list.includes(d)) return d;
  for (const k of list) {
    if (k.endsWith('/' + d) || d.endsWith('/' + k)) return k;
  }
  const base = d.split('/').pop();
  return list.find(k => k.split('/').pop() === base);
}

signal('git', 1.0, (doc: FileDoc, ctx: ScoreContext) => {
  const git = ctx.extras.gitSignal;
  if (!git) return 0;
  let score = 0;
  if (matchPath(doc.path, git.changed)) score += W_CHANGED;
  if (matchPath(doc.path, git.branch)) score += W_BRANCH;
  const rk = matchPath(doc.path, git.recent.keys());
  if (rk) score += W_RECENT * (git.recent.get(rk) ?? 0);
  const ck = matchPath(doc.path, git.cochange.keys());
  if (ck && git.changed.size > 0) {
    const bucket = git.cochange.get(ck) ?? new Map<string, number>();
    let hits = 0;
    for (const c of git.changed) hits += bucket.get(c) ?? 0;
    if (hits) score += W_COCHANGE * Math.min(hits / 3, 1);
  }
  return score;
});
