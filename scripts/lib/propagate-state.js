'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EGC_START = '<!-- egc:start -->';
const EGC_END = '<!-- egc:end -->';
const MAX_ITEMS = 5;

function parseStateContent(content) {
  const result = { context: '', decisions: [], next: [] };
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
  const lines = ['## EGC Project Memory'];

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

function writeCursorContext(projectPath, block) {
  const cursorDir = path.join(projectPath, '.cursor');
  try {
    if (!fs.existsSync(cursorDir) || !fs.statSync(cursorDir).isDirectory()) return null;
  } catch {
    return null;
  }

  const rulesDir = path.join(cursorDir, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });

  const filePath = path.join(rulesDir, 'egc-context.mdc');
  const content = `---\ndescription: EGC project memory (auto-updated)\nalwaysApply: true\n---\n\n${block}\n`;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function writeCopilotContext(projectPath, block) {
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

function writeGeminiContext(projectPath, block) {
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

function writeWindsurfContext(projectPath, block) {
  const filePath = path.join(projectPath, '.windsurfrules');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function writeAgentsContext(projectPath, block) {
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

function writeLlmsTxt(projectPath, parsed) {
  const filePath = path.join(projectPath, 'llms.txt');
  try {
    if (!fs.existsSync(filePath)) return null;
  } catch {
    return null;
  }

  const lines = ['# EGC Project Memory'];
  if (parsed.context) lines.push('', parsed.context);
  if (parsed.next.length > 0) {
    lines.push('', '## Next session');
    for (const n of parsed.next.slice(0, MAX_ITEMS)) lines.push(`- ${n}`);
  }
  const block = lines.join('\n');

  const existing = fs.readFileSync(filePath, 'utf-8');
  fs.writeFileSync(filePath, upsertEgcSection(existing, block), 'utf-8');
  return filePath;
}

function propagateStateContent(projectPath, stateContent) {
  const parsed = parseStateContent(stateContent);
  const block = buildSummaryBlock(parsed);

  return {
    cursor: writeCursorContext(projectPath, block),
    copilot: writeCopilotContext(projectPath, block),
    gemini: writeGeminiContext(projectPath, block),
    windsurf: writeWindsurfContext(projectPath, block),
    agents: writeAgentsContext(projectPath, block),
    llms: writeLlmsTxt(projectPath, parsed),
  };
}

module.exports = { propagateStateContent };
