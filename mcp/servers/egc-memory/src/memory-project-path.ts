import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { resolveHome } from './home';

// The shapes a project path may take: the home directory itself (the
// fallback when no working directory is known), any directory under home
// except the hidden ones directly under it (~/.ssh, ~/.config, ~/.claude
// and every other dot-directory a tool keeps its secrets and settings in),
// and any directory outside home that is neither a filesystem root nor a
// system directory. Everything else is refused, so a new tool's
// dot-directory is covered the day it appears instead of waiting for a
// list to name it.
const POSIX_SYSTEM_ROOTS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/proc', '/sys', '/dev', '/root', '/var/lib', '/var/log', '/var/run', '/run'];
const CASE_FOLDED_PATHS = process.platform === 'win32' || process.platform === 'darwin';

// The system directories of a Windows install, wherever it lives: the
// environment names them, the usual spellings stand in when it does not.
function windowsSystemRoots(): string[] {
  const env = process.env;
  return [
    env.SystemRoot || String.raw`C:\Windows`,
    env.ProgramFiles || String.raw`C:\Program Files`,
    env['ProgramFiles(x86)'] || String.raw`C:\Program Files (x86)`,
    env.ProgramData || String.raw`C:\ProgramData`,
  ];
}

// The form of a path used for comparison: links resolved through the
// nearest existing ancestor (so a missing child of a linked directory still
// lands under the real one, and /etc, /private/etc or a linked home compare
// equal) and case folded where the filesystem ignores case.
function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  let existing = resolved;
  let remainder = '';
  // Every step moves to the parent, and the walk ends when the parent is
  // the path itself (the root), so the loop always terminates.
  while (true) {
    try {
      const real = fs.realpathSync(existing);
      const joined = remainder === '' ? real : path.join(real, remainder);
      return CASE_FOLDED_PATHS ? joined.toLowerCase() : joined;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      remainder = remainder === '' ? path.basename(existing) : path.join(path.basename(existing), remainder);
      existing = parent;
    }
  }
  return CASE_FOLDED_PATHS ? resolved.toLowerCase() : resolved;
}

// The part of `target` below `root`: '' when they are the same path, null
// when `target` is not under `root`. A root that already ends with the
// separator (a filesystem or drive root) is not given a second one.
function below(target: string, root: string): string | null {
  if (target === root) return '';
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix) ? target.slice(prefix.length) : null;
}

// A filesystem root as the platform's own parser sees it: '/', a drive
// root, or a UNC share root.
function isFilesystemRoot(target: string): boolean {
  const root = path.parse(target).root;
  return root !== '' && (target === root || target === root.slice(0, -1));
}

// The reason a resolved project path is refused, or null when it has one of
// the accepted shapes.
// Anchored on os.homedir() rather than resolveHome(): this is the security
// check that keeps a project_path out of hidden directories under the
// home where tools keep secrets, and it must not be bypassable by a
// caller setting HOME or USERPROFILE, which resolveHome() honors by
// design for the state-location formula (cubic review, confidence 8).
function projectPathRefusal(resolved: string): string | null {
  const target = canonicalPath(resolved);
  const underHome = below(target, canonicalPath(os.homedir()));
  if (underHome !== null) {
    const first = underHome.split(path.sep)[0];
    return first.startsWith('.') ? `${first} is a hidden directory under the home directory, where tools keep settings and secrets` : null;
  }
  if (isFilesystemRoot(target)) return 'the filesystem root is not a project';
  const roots = process.platform === 'win32' ? windowsSystemRoots() : POSIX_SYSTEM_ROOTS;
  const root = roots.find(candidate => below(target, canonicalPath(candidate)) !== null);
  return root === undefined ? null : `${root} is a system directory`;
}

export function resolveProjectPath(provided?: string): string {
  // process.cwd() reflects this process's actual working directory and is
  // always accurate. process.env.PWD is a shell convention that is only
  // updated by `cd` in an interactive shell -- a process spawned
  // programmatically with a different cwd (e.g. a background agent running
  // in a git worktree) can inherit a stale PWD from its parent, silently
  // resolving to the wrong project/branch and colliding with another
  // process's state file. Prefer cwd(); keep PWD only as a last-resort
  // fallback for environments where cwd() itself is unavailable.
  let cwd: string | undefined;
  try { cwd = process.cwd(); } catch { /* cwd unavailable, e.g. a deleted directory */ }
  const raw = provided || process.env.EGC_PROJECT || cwd || process.env.PWD || resolveHome();
  if (provided?.split(/[/\\]/).includes('..')) {
    throw new Error(`project_path must not contain path traversal sequences: ${provided}`);
  }
  let resolved = path.resolve(raw);
  if (fs.existsSync(resolved)) {
    resolved = fs.realpathSync(resolved);
  }
  const refusal = projectPathRefusal(resolved);
  if (refusal !== null) {
    throw new Error(`project_path is not allowed (${refusal}): ${resolved}`);
  }
  return resolved;
}
