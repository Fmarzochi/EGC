import * as os from 'node:os';
import * as path from 'node:path';

export const GLOBAL_APPENDIX_SECTIONS: Array<{ heading: string; cap: number }> = [
  { heading: 'Preferences', cap: 5 },
  { heading: 'Active Decisions', cap: 5 },
  { heading: 'Do Not Repeat', cap: 5 }
];

export function globalStateFilePath(): string {
  return path.join(os.homedir(), '.egc', 'global', 'state.md');
}

// Trust-domain isolation: global scope is only written via an explicit
// scope:"global" call, never derived from project data.
export function buildGlobalAppendix(
  globalDoc: Record<string, string[] | string>,
  projectContent: string
): string | null {
  const projectLines = new Set(
    projectContent.split('\n').map(l => l.replace(/^- /, '').trim()).filter(Boolean)
  );
  const parts: string[] = [];
  for (const { heading, cap } of GLOBAL_APPENDIX_SECTIONS) {
    const entries = globalDoc[heading];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter(e => e.trim() && !projectLines.has(e.trim())).slice(0, cap);
    if (kept.length === 0) continue;
    parts.push(`### ${heading}`, ...kept.map(e => `- ${e}`), '');
  }
  if (parts.length === 0) return null;
  return ['', '## Global Memory (all projects)', '', ...parts].join('\n').trimEnd();
}
