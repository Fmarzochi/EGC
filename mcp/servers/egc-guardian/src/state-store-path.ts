import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Read side of the CLI event store. The CLI writes it under the shared .egc
// directory only (scripts/lib/state-store/path.js), with EGC_DIR as the
// explicit override, so both are honored here first. The harness roots below
// mirror getKnownHarnessDirs() in scripts/lib/utils.js (plus .codebuddy, which
// the env routing used) and are read only while the shared store does not
// exist, so an install that never consolidated keeps its history visible.
// The copy of the tool that launched this process is preferred, the same
// choice the CLI used to make when it wrote there.
const LEGACY_HARNESS_DIRS = [
  '.claude', '.gemini', '.cursor', '.github', '.kiro', '.codebuddy',
  path.join('.codeium', 'windsurf'), path.join('.config', 'opencode'), path.join('.config', 'zed'),
  '.agents', '.amp', '.continue', '.trae', '.trae-cn',
];

function activeHarnessDir(env: NodeJS.ProcessEnv): string | null {
  if (env.GEMINI_PROJECT_DIR || env.GEMINI_PLUGIN_ROOT) return '.gemini';
  if (env.CLAUDE_PROJECT_DIR || env.CLAUDE_PLUGIN_ROOT) return '.claude';
  if (env.CODEBUDDY_PROJECT_DIR || env.CODEBUDDY_PLUGIN_ROOT) return '.codebuddy';
  if (env.VSCODE_AGENT || env.GITHUB_COPILOT_API_TOKEN) return '.github';
  if (env.KIRO_HOOK_FILE || env.KIRO_FILE_PATH) return '.kiro';
  if (env.TRAE_ENV) return env.TRAE_ENV === 'cn' ? '.trae-cn' : '.trae';
  return null;
}

export function resolveStateStoreDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EGC_STATE_DB) return path.resolve(env.EGC_STATE_DB);
  if (env.EGC_DIR) return path.join(env.EGC_DIR, 'egc', 'state.db');

  const homeDir = env.HOME || env.USERPROFILE || os.homedir();
  const canonical = path.join(homeDir, '.egc', 'egc', 'state.db');
  if (fs.existsSync(canonical)) return canonical;

  const active = activeHarnessDir(env);
  const roots = active ? [active, ...LEGACY_HARNESS_DIRS.filter((dir) => dir !== active)] : LEGACY_HARNESS_DIRS;
  const legacy = roots
    .map((dir) => path.join(homeDir, dir, 'egc', 'state.db'))
    .find((candidate) => fs.existsSync(candidate));
  return legacy ?? canonical;
}
