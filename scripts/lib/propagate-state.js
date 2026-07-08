'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EGC_START = '<!-- egc:start -->';
const EGC_END = '<!-- egc:end -->';
const MAX_ITEMS = 5;

const EGC_TRIGGERS = `## EGC Natural Language Interface

Detect user intent in any language and call the matching EGC tool — no keywords required:

**Session**
- User resumes work (any language) → \`get_state\`
- User ends session (any language) → \`update_state\`

**Diagnosis — when AI seems confused or hallucinating**
- User questions whether things are working → \`get_project_state\`
- User asks what mistakes keep repeating → \`detect_patterns\`
- User asks what was learned in past sessions → \`lesson_recall\`

**Memory — user forces a save**
- User asks to record a decision → \`store_decision\`
- User asks AI not to repeat a mistake → \`lesson_save\`
- User confirms a past lesson happened again → \`lesson_reinforce\`
- User wants to store something temporarily → \`working_memory_set\`
- User asks what is in temporary memory → \`working_memory_get\` / \`working_memory_list\`

**Search — when AI forgot something**
- User asks about past decisions on a topic → \`search_history\`
- User asks for recent decisions chronologically → \`query_history\`

**Context — when heavy**
- User says context is full or heavy → \`reduce_context\`
- User asks to compress session observations → \`compress_observations\`

**Safety — when user is suspicious**
- User asks if a shell command is safe → \`validate_command\`
- User asks if a file path is safe to write → \`validate_write\`
- User asks to organize a complex task → \`orchestrate_task\`
- User asks AI to learn from session errors → \`auto_learn\``;

function parseStateContent(content) {
  const result = { context: '', decisions: [], next: [], updated: '' };
  const updatedMatch = content.match(/^updated:\s*(\S+)\s*$/m);
  if (updatedMatch) result.updated = updatedMatch[1];
  let section = '';

  for (const line of content.split('\n')) {
    const h2 = line.match(/^## (.+)/);
    if (h2) { section = h2[1].trim(); continue; }

    const item = line.replace(/^- /, '').trim();
    if (!item) continue;

    if (section === 'Context') result.context = item;
    if (section === 'Active Decisions') result.decisions.push(item);
    if (section === 'Next Session') result.next.push(item);
  }

  return result;
}

function buildSummaryBlock(parsed) {
  const lines = [];
  if (parsed.updated) lines.push(`<!-- egc:state-updated:${parsed.updated} -->`);
  lines.push('## EGC Project Memory');

  if (parsed.context) {
    lines.push('', `**Context:** ${parsed.context}`);
  }

  const decisions = parsed.decisions.slice(0, MAX_ITEMS);
  if (decisions.length > 0) {
    lines.push('', '**Active decisions:**');
    for (const d of decisions) lines.push(`- ${d}`);
  }

  const next = parsed.next.slice(0, MAX_ITEMS);
  if (next.length > 0) {
    lines.push('', '**Next session:**');
    for (const n of next) lines.push(`- ${n}`);
  }

  lines.push('', EGC_TRIGGERS);

  return lines.join('\n');
}

function upsertEgcSection(existing, block) {
  const section = `${EGC_START}\n${block}\n${EGC_END}`;
  const startIdx = existing.indexOf(EGC_START);
  const endIdx = existing.indexOf(EGC_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return existing.slice(0, startIdx) + section + existing.slice(endIdx + EGC_END.length);
  }

  return existing ? `${existing.trimEnd()}\n\n${section}\n` : `${section}\n`;
}

const STATE_UPDATED_RE = /<!-- egc:state-updated:(\S+) -->/;

function extractStateUpdated(content) {
  const match = typeof content === 'string' ? content.match(STATE_UPDATED_RE) : null;
  return match ? match[1] : '';
}

// A mirror stamped by an equally new or newer state must not be overwritten:
// stale sources (older update stamp, or no stamp at all) would silently roll
// project memory back, as a leftover flat state file once did to AGENTS.md.
function isStaleWrite(existingContent, stateUpdated) {
  const existingUpdated = extractStateUpdated(existingContent || '');
  if (!existingUpdated) return false;
  if (!stateUpdated) return true;
  const existingMs = Date.parse(existingUpdated);
  const stateMs = Date.parse(stateUpdated);
  if (Number.isNaN(existingMs) || Number.isNaN(stateMs)) return false;
  return stateMs <= existingMs;
}

function writeCursorContext(projectPath, block, stateUpdated) {
  const cursorDir = path.join(projectPath, '.cursor');
  try {
    if (!fs.existsSync(cursorDir) || !fs.statSync(cursorDir).isDirectory()) return null;
  } catch {
    return null;
  }

  const rulesDir = path.join(cursorDir, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });

  const filePath = path.join(rulesDir, 'egc-context.mdc');
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  if (isStaleWrite(existing, stateUpdated)) return filePath;
  const content = `---\ndescription: EGC project memory (auto-updated)\nalwaysApply: true\n---\n\n${block}\n`;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function writeCopilotContext(projectPath, block, stateUpdated) {
  const filePath = path.join(projectPath, '.github', 'copilot-instructions.md');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  if (isStaleWrite(existing, stateUpdated)) return filePath;
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeGeminiContext(projectPath, block, stateUpdated) {
  const filePath = path.join(projectPath, 'GEMINI.md');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  if (isStaleWrite(existing, stateUpdated)) return filePath;
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeWindsurfContext(projectPath, block, stateUpdated) {
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
  if (isStaleWrite(existing, stateUpdated)) return filePath;
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeTraeContext(projectPath, block, stateUpdated) {
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
  if (isStaleWrite(existing, stateUpdated)) return filePath;
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeZedContext(projectPath, block, stateUpdated) {
  const filePath = path.join(projectPath, '.rules');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  if (isStaleWrite(existing, stateUpdated)) return filePath;
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeClineContext(projectPath, block, stateUpdated) {
  const filePath = path.join(projectPath, '.clinerules');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  if (isStaleWrite(existing, stateUpdated)) return filePath;
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeAiderContext(projectPath, block, stateUpdated) {
  const filePath = path.join(projectPath, 'CONVENTIONS.md');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  if (isStaleWrite(existing, stateUpdated)) return filePath;
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeLegacyCursorRules(projectPath, block, stateUpdated) {
  const filePath = path.join(projectPath, '.cursorrules');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  if (isStaleWrite(existing, stateUpdated)) return filePath;
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeAgentsContext(projectPath, block, stateUpdated) {
  const filePath = path.join(projectPath, 'AGENTS.md');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  if (isStaleWrite(existing, stateUpdated)) return filePath;
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeLlmsTxt(projectPath, parsed) {
  const filePath = path.join(projectPath, 'llms.txt');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const stateUpdated = parsed.updated;
  const lines = [];
  if (stateUpdated) lines.push(`<!-- egc:state-updated:${stateUpdated} -->`);
  lines.push('# EGC Project Memory');
  if (parsed.context) lines.push('', parsed.context);
  if (parsed.next.length > 0) {
    lines.push('', '## Next session');
    for (const n of parsed.next.slice(0, MAX_ITEMS)) lines.push(`- ${n}`);
  }
  lines.push('', EGC_TRIGGERS);
  const block = lines.join('\n');

  const existing = fs.readFileSync(filePath, 'utf-8');
  if (isStaleWrite(existing, stateUpdated)) return filePath;
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function propagateStateContent(projectPath, stateContent) {
  const parsed = parseStateContent(stateContent);
  const block = buildSummaryBlock(parsed);

  const stateUpdated = parsed.updated;

  return {
    cursor: writeCursorContext(projectPath, block, stateUpdated),
    copilot: writeCopilotContext(projectPath, block, stateUpdated),
    gemini: writeGeminiContext(projectPath, block, stateUpdated),
    windsurf: writeWindsurfContext(projectPath, block, stateUpdated),
    trae: writeTraeContext(projectPath, block, stateUpdated),
    zed: writeZedContext(projectPath, block, stateUpdated),
    cline: writeClineContext(projectPath, block, stateUpdated),
    aider: writeAiderContext(projectPath, block, stateUpdated),
    cursorrules: writeLegacyCursorRules(projectPath, block, stateUpdated),
    agents: writeAgentsContext(projectPath, block, stateUpdated),
    llms: writeLlmsTxt(projectPath, parsed),
  };
}

module.exports = { propagateStateContent };
