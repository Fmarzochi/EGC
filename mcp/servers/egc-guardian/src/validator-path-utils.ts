import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shared by both the incoming path and each DENIED_PATHS entry in
// isProtectedPath(): resolve through fs.realpathSync(), falling back to
// resolving the nearest existing ancestor directory (then rejoining the remaining
// path components) when the target doesn't exist yet. Walking ancestor directories
// ensures that symlinks at any parent level (such as macOS /etc -> /private/etc)
// resolve correctly even for deeply nested non-existent paths (e.g. /etc/wireguard/wg0.conf).
// Resolving both sides fresh on every isProtectedPath() call removes any staleness window entirely.
export function resolveRealOrLexical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    let curr = p;
    const pieces: string[] = [];
    while (curr && curr !== path.dirname(curr)) {
      pieces.unshift(path.basename(curr));
      curr = path.dirname(curr);
      try {
        const resolved = fs.realpathSync(curr);
        return path.join(resolved, ...pieces);
      } catch {
        // continue walking up
      }
    }
    return p;
  }
}

// macOS and Windows resolve paths case-insensitively; Linux does not. Every
// path comparison in this file folds through here so a case variant cannot
// name a protected file while dodging the check written for it.
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

export function foldCase(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

// `~`, `$HOME` and `${HOME}` at the start of a path name the home directory
// once the shell is done with them; every path check reads them the same
// way, so a file is recognized under each spelling of its location.
const HOME_PARAMETER_RE = /^\$(?:HOME|\{HOME\})(?=[\\/]|$)/;

export function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  const parameter = HOME_PARAMETER_RE.exec(p);
  return parameter ? path.join(os.homedir(), p.slice(parameter[0].length)) : p;
}

// A relative write target names a file under the directory the agent works
// in, which the caller passes as cwd; without it, this process's own
// working directory is the only one known.
export function writeBaseDir(cwd?: string | null): string {
  const trimmed = cwd?.trim();
  return trimmed ? path.resolve(expandHome(trimmed)) : process.cwd();
}
