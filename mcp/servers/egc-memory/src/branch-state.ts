import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

export const DEFAULT_BRANCH_FILE = 'main.md';

export type StateSource = 'branch' | 'default-branch' | 'flat' | 'none';

export interface ResolvedState {
  filePath: string;
  source: StateSource;
  branch: string | null;
}

export function projectSlug(projectPath: string): string {
  const parts = projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
}

export function sanitizeBranchName(branch: string): string {
  return branch.replace(/\//g, '-').replace(/[^a-zA-Z0-9-_]/g, '_');
}

export function detectBranch(projectPath: string): string | null {
  try {
    const output = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    // Detached HEAD reports the literal string "HEAD"; treat it as no branch
    if (!output || output === 'HEAD') return null;
    return output;
  } catch (_) {
    return null;
  }
}

export function flatStateFile(stateDir: string, projectPath: string): string {
  return path.join(stateDir, `${projectSlug(projectPath)}.md`);
}

export function branchStateFile(stateDir: string, projectPath: string, branch: string): string {
  return path.join(stateDir, projectSlug(projectPath), `${sanitizeBranchName(branch)}.md`);
}

export function resolveStateRead(stateDir: string, projectPath: string, branch: string | null): ResolvedState {
  if (branch) {
    const branchFile = branchStateFile(stateDir, projectPath, branch);
    if (fs.existsSync(branchFile)) {
      return { filePath: branchFile, source: 'branch', branch };
    }
    const defaultFile = path.join(stateDir, projectSlug(projectPath), DEFAULT_BRANCH_FILE);
    if (fs.existsSync(defaultFile)) {
      return { filePath: defaultFile, source: 'default-branch', branch };
    }
  }

  const flatFile = flatStateFile(stateDir, projectPath);
  if (fs.existsSync(flatFile)) {
    return { filePath: flatFile, source: 'flat', branch: branch || null };
  }

  return {
    filePath: branch ? branchStateFile(stateDir, projectPath, branch) : flatFile,
    source: 'none',
    branch: branch || null,
  };
}

export function resolveStateWrite(stateDir: string, projectPath: string, branch: string | null): string {
  if (branch) return branchStateFile(stateDir, projectPath, branch);
  return flatStateFile(stateDir, projectPath);
}
