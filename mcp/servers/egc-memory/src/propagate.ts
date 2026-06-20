import fs from 'node:fs';
import path from 'node:path';

export interface PropagateArgs {
  projectPath: string;
  context?: string;
  decisions?: { what: string; why?: string }[];
  next?: string[];
}

export interface PropagateResult {
  cursor: string | null;
  copilot: string | null;
  gemini: string | null;
  windsurf: string | null;
  trae: string | null;
  zed: string | null;
  cline: string | null;
  aider: string | null;
  cursorrules: string | null;
  agents: string | null;
  llms: string | null;
}

const EGC_START = '<!-- egc:start -->';
const EGC_END = '<!-- egc:end -->';
const MAX_ITEMS = 5;

function buildSummaryBlock(args: PropagateArgs): string {
  const lines: string[] = ['## EGC Project Memory'];

  if (args.context) {
    lines.push('', `**Context:** ${args.context}`);
  }

  const decisions = args.decisions?.slice(0, MAX_ITEMS) ?? [];
  if (decisions.length > 0) {
    lines.push('', '**Active decisions:**');
    for (const d of decisions) {
      lines.push(`- ${d.what}`);
    }
  }

  const next = args.next?.slice(0, MAX_ITEMS) ?? [];
  if (next.length > 0) {
    lines.push('', '**Next session:**');
    for (const n of next) {
      lines.push(`- ${n}`);
    }
  }

  return lines.join('\n');
}

function upsertEgcSection(existing: string, block: string): string {
  const section = `${EGC_START}\n${block}\n${EGC_END}`;
  const startIdx = existing.indexOf(EGC_START);
  const endIdx = existing.indexOf(EGC_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return existing.slice(0, startIdx) + section + existing.slice(endIdx + EGC_END.length);
  }

  return existing ? `${existing.trimEnd()}\n\n${section}\n` : `${section}\n`;
}

function writeCursorContext(projectPath: string, block: string): string | null {
  const cursorDir = path.join(projectPath, '.cursor');
  try {
    if (!fs.existsSync(cursorDir) || !fs.statSync(cursorDir).isDirectory()) return null;
  } catch {
    return null;
  }

  const rulesDir = path.join(cursorDir, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });

  const filePath = path.join(rulesDir, 'egc-context.mdc');
  const content = `---\ndescription: EGC project memory (auto-updated by update_state)\nalwaysApply: true\n---\n\n${block}\n`;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function writeCopilotContext(projectPath: string, block: string): string | null {
  const filePath = path.join(projectPath, '.github', 'copilot-instructions.md');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeGeminiContext(projectPath: string, block: string): string | null {
  const filePath = path.join(projectPath, 'GEMINI.md');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeWindsurfContext(projectPath: string, block: string): string | null {
  const windsurfDir = path.join(projectPath, '.windsurf');
  try {
    if (!fs.existsSync(windsurfDir) || !fs.statSync(windsurfDir).isDirectory()) return null;
  } catch {
    return null;
  }

  const rulesDir = path.join(windsurfDir, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });

  const filePath = path.join(rulesDir, 'egc-context.md');
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeTraeContext(projectPath: string, block: string): string | null {
  const traeDir = path.join(projectPath, '.trae');
  try {
    if (!fs.existsSync(traeDir) || !fs.statSync(traeDir).isDirectory()) return null;
  } catch {
    return null;
  }

  const rulesDir = path.join(traeDir, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });

  const filePath = path.join(rulesDir, 'egc-context.md');
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeZedContext(projectPath: string, block: string): string | null {
  const filePath = path.join(projectPath, '.rules');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeClineContext(projectPath: string, block: string): string | null {
  const filePath = path.join(projectPath, '.clinerules');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeAiderContext(projectPath: string, block: string): string | null {
  const filePath = path.join(projectPath, 'CONVENTIONS.md');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeLegacyCursorRules(projectPath: string, block: string): string | null {
  const filePath = path.join(projectPath, '.cursorrules');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeAgentsContext(projectPath: string, block: string): string | null {
  const filePath = path.join(projectPath, 'AGENTS.md');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeLlmsTxt(projectPath: string, args: PropagateArgs): string | null {
  const filePath = path.join(projectPath, 'llms.txt');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const lines: string[] = ['# EGC Project Memory'];
  if (args.context) lines.push('', args.context);
  const next = args.next?.slice(0, MAX_ITEMS) ?? [];
  if (next.length > 0) {
    lines.push('', '## Next session');
    for (const n of next) lines.push(`- ${n}`);
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  fs.writeFileSync(filePath, upsertEgcSection(existing, lines.join('\n')), 'utf-8');
  return filePath;
}

export function propagateStateToTools(args: PropagateArgs): PropagateResult {
  const block = buildSummaryBlock(args);
  return {
    cursor: writeCursorContext(args.projectPath, block),
    copilot: writeCopilotContext(args.projectPath, block),
    gemini: writeGeminiContext(args.projectPath, block),
    windsurf: writeWindsurfContext(args.projectPath, block),
    trae: writeTraeContext(args.projectPath, block),
    zed: writeZedContext(args.projectPath, block),
    cline: writeClineContext(args.projectPath, block),
    aider: writeAiderContext(args.projectPath, block),
    cursorrules: writeLegacyCursorRules(args.projectPath, block),
    agents: writeAgentsContext(args.projectPath, block),
    llms: writeLlmsTxt(args.projectPath, args),
  };
}
