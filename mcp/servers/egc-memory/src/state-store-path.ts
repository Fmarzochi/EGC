import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Read side of the CLI event store. The CLI writes it under the shared .egc
// directory only (scripts/lib/state-store/path.js); the harness copies below
// are what older versions left behind and are read only while the shared
// store does not exist, so an install that never consolidated keeps its
// history visible.
const LEGACY_HARNESS_DIRS = ['.claude', '.gemini', '.cursor', '.github', '.kiro', '.codebuddy'];

export function resolveStateStoreDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EGC_STATE_DB) return path.resolve(env.EGC_STATE_DB);

  const homeDir = env.HOME || env.USERPROFILE || os.homedir();
  const canonical = path.join(homeDir, '.egc', 'egc', 'state.db');
  if (fs.existsSync(canonical)) return canonical;

  const legacy = LEGACY_HARNESS_DIRS
    .map((dir) => path.join(homeDir, dir, 'egc', 'state.db'))
    .find((candidate) => fs.existsSync(candidate));
  return legacy ?? canonical;
}
