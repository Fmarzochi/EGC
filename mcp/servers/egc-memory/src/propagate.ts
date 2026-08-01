import fs from 'node:fs';
import path from 'node:path';

// scripts/lib/memory-filters.js lives outside this package's src/ tree (tsconfig
// rootDir is "src"), so a static import would break the build -- required at
// runtime instead, mirroring the tryRequire pattern already used by
// scripts/hooks/pre-bash-crusher-rewrite.js for the same kind of cross-package
// reach. The npm package's "files" list ships scripts/ and
// mcp/servers/egc-memory/build/ at the same relative depth as this repo, so the
// path below resolves identically in a real `npm install -g` layout.
function tryRequireMemoryFilters(): typeof import('../../../../scripts/lib/memory-filters') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../../../scripts/lib/memory-filters');
  } catch {
    return null;
  }
}

// Ensures populated memory can never reach a commit for this project, before
// the first byte of real content is written to any propagation file.
// Previously this only happened via the separate, manual `egc init` command
// (scripts/init.js) -- a project that only ever ran `egc install` (the exact
// command the README documents) never got this protection unless the user
// also ran `egc init` by hand. Best-effort and silent: this is a privacy
// convenience, not a correctness gate, so any failure here (no git binary, a
// read-only filesystem, projectPath not a repo) must never block the actual
// memory write that the caller is waiting on.
function ensureCommitPrivacy(projectPath: string): void {
  try {
    const memoryFilters = tryRequireMemoryFilters();
    if (!memoryFilters) return;
    const scriptPath = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'check-state-leak.js');
    memoryFilters.configureMemoryFilters({ projectDir: projectPath, scriptPath, dryRun: false });
  } catch (err) {
    // Best-effort: never let commit-privacy setup block the memory write the
    // caller is waiting on. But silent failure here means a real git-config
    // error (permission denied, git binary crashed) leaves the user with no
    // signal that populated memory can still reach a commit -- a single
    // stderr line costs nothing (MCP servers speak MCP over stdout, stderr
    // is free for diagnostics) and this is the one place that can ever know
    // (cubic review, audit EGC-547).
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[egc-memory] commit-privacy filter setup failed for ${projectPath}: ${message}\n`);
  }
}

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
  claude: string | null;
  roo: string | null;
  continue: string | null;
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
  const startCount = (existing.match(/<!-- egc:start -->/g) ?? []).length;
  const endCount = (existing.match(/<!-- egc:end -->/g) ?? []).length;
  const startIdx = existing.indexOf(EGC_START);
  const endIdx = existing.indexOf(EGC_END);

  if (startCount === 1 && endCount === 1 && startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return existing.slice(0, startIdx) + section + existing.slice(endIdx + EGC_END.length);
  }

  // Anything other than exactly one correctly paired marker set (missing,
  // orphaned, duplicated, or inverted) is not safe to slice in place -- an
  // orphaned <!-- egc:start --> left over from a stray edit previously made
  // the NEXT call delete everything between it and a fresh end marker.
  // Strip only the bare marker tags and append one fresh, paired block.
  const stripped = existing.replace(/<!-- egc:(start|end) -->/g, '').trim();
  return stripped ? `${stripped}\n\n${section}\n` : `${section}\n`;
}

// Shared by the harness writers below: upsert the EGC block into filePath,
// using defaultContent as the starting point when the file doesn't exist yet.
function upsertFileSection(filePath: string, block: string, defaultContent = ''): string {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : defaultContent;
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

// Before this fix, writeCursorContext always overwrote the whole file with
// just this frontmatter + block, no markers. On the first run after the
// fix, that old unmarked content would otherwise be preserved as "user
// content" by upsertEgcSection and get a second, marked block appended
// below it -- permanent duplication. Recognize and strip it down to just
// the frontmatter so only the new marked block survives.
const LEGACY_CURSOR_FRONTMATTER = `---\ndescription: EGC project memory (auto-updated by update_state)\nalwaysApply: true\n---\n\n`;
const LEGACY_BLOCK_HEADER = '## EGC Project Memory';
function stripLegacyCursorContent(existing: string): string {
  if (existing.includes(EGC_START)) return existing;
  // Normalize CRLF for the comparison only -- a file saved with Windows line
  // endings must still be recognized as the legacy auto-generated shape.
  const normalized = existing.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(LEGACY_CURSOR_FRONTMATTER)) return existing;
  // Only the pre-marker writer's own auto-generated block is safe to drop here.
  // Anything else after the frontmatter (a note a human added) must be kept.
  const rest = normalized.slice(LEGACY_CURSOR_FRONTMATTER.length);
  return rest.trimStart().startsWith(LEGACY_BLOCK_HEADER) ? LEGACY_CURSOR_FRONTMATTER : existing;
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
  const existing = fs.existsSync(filePath)
    ? stripLegacyCursorContent(fs.readFileSync(filePath, 'utf-8'))
    : LEGACY_CURSOR_FRONTMATTER;
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeClaudeContext(projectPath: string, block: string): string | null {
  const filePath = path.join(projectPath, 'CLAUDE.md');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  return upsertFileSection(filePath, block);
}

function writeRooCodeContext(projectPath: string, block: string): string | null {
  const rooDir = path.join(projectPath, '.roo');
  const rulesDir = path.join(rooDir, 'rules');
  let rulesDirHasContent = false;
  try {
    rulesDirHasContent = fs.existsSync(rulesDir) && fs.statSync(rulesDir).isDirectory() && fs.readdirSync(rulesDir).length > 0;
  } catch {
    rulesDirHasContent = false;
  }

  let rooRulesExists = false;
  const rooRulesPath = path.join(projectPath, '.roorules');
  try {
    rooRulesExists = fs.existsSync(rooRulesPath);
  } catch {
    rooRulesExists = false;
  }

  // Roo Code discovers .roo/rules/ over the legacy flat .roorules file when
  // both exist -- .roorules is the documented fallback, not the default.
  if (!rulesDirHasContent && rooRulesExists) {
    try {
      return upsertFileSection(rooRulesPath, block);
    } catch {
      return null;
    }
  }

  try {
    if (!fs.existsSync(rooDir) || !fs.statSync(rooDir).isDirectory()) return null;
  } catch {
    return null;
  }

  fs.mkdirSync(rulesDir, { recursive: true });
  const filePath = path.join(rulesDir, 'egc-context.md');
  return upsertFileSection(filePath, block);
}

function writeContinueContext(projectPath: string, block: string): string | null {
  const continueDir = path.join(projectPath, '.continue');
  try {
    if (!fs.existsSync(continueDir) || !fs.statSync(continueDir).isDirectory()) return null;
  } catch {
    return null;
  }

  const rulesDir = path.join(continueDir, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  const filePath = path.join(rulesDir, 'egc-context.md');
  return upsertFileSection(filePath, block);
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
  ensureCommitPrivacy(args.projectPath);
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
    claude: writeClaudeContext(args.projectPath, block),
    roo: writeRooCodeContext(args.projectPath, block),
    continue: writeContinueContext(args.projectPath, block),
  };
}
