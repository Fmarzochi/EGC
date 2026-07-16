'use strict';

const fs = require('fs');
const path = require('path');
const { ensurePrivateDir } = require('./utils');

const DEFAULT_THRESHOLD = 40;
const WORKING_WINDOW_DAYS = 7;
const EPISODIC_WINDOW_DAYS = 30;
const SEMANTIC_FACTS_PER_LINE = 3;

// Sections that hold the active queue or freeform context. They are never
// layered by age: rewriting them would erase actionable short-term memory.
const VERBATIM_SECTIONS = new Set(['Context', 'Next Session']);

const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const BR_DATE_RE = /\b(\d{2})\/(\d{2})\/(\d{4})\b/;

function projectSlug(projectPath) {
  const parts = projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
}

function stateDir(homeDir) {
  return path.join(homeDir, '.egc', 'state');
}

function stateFilePath(homeDir, projectPath) {
  return path.join(stateDir(homeDir), `${projectSlug(projectPath)}.md`);
}

function archiveDir(homeDir) {
  return path.join(stateDir(homeDir), 'archive');
}

function buildDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function extractEntryDate(text) {
  const iso = text.match(ISO_DATE_RE);
  if (iso) {
    const date = buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (date) return date;
  }

  const br = text.match(BR_DATE_RE);
  if (br) {
    const date = buildDate(Number(br[3]), Number(br[2]), Number(br[1]));
    if (date) return date;
  }

  return null;
}

function ageInDays(date, now) {
  const diff = now.getTime() - date.getTime();
  if (diff < 0) return 0;
  return diff / (24 * 60 * 60 * 1000);
}

function classifyEntry(text, now) {
  const date = extractEntryDate(text);
  if (!date) return { layer: 'semantic', date: null };

  const age = ageInDays(date, now);
  if (age <= WORKING_WINDOW_DAYS) return { layer: 'working', date };
  if (age <= EPISODIC_WINDOW_DAYS) return { layer: 'episodic', date };
  return { layer: 'semantic', date };
}

function weekStart(date) {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const mondayOffset = (result.getUTCDay() + 6) % 7;
  result.setUTCDate(result.getUTCDate() - mondayOffset);
  return result;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);
const EDGE_FILLER = new Set([' ', '\t', ':', ',', '-']);

// Trimming scans characters instead of using anchored +$ regexes,
// which backtrack super-linearly on crafted input.
function trimTrailingChars(text, chars) {
  let end = text.length;
  while (end > 0 && chars.has(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

function trimEdgeChars(text, chars) {
  let start = 0;
  let end = text.length;
  while (start < end && chars.has(text[start])) start += 1;
  while (end > start && chars.has(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

function normalizeKey(text) {
  const collapsed = text.toLowerCase().replace(/\s+/g, ' ');
  return trimTrailingChars(collapsed, TRAILING_PUNCTUATION).trim();
}

function stripDateTokens(text) {
  const withoutDates = text
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/\d{2}\/\d{2}\/\d{4}/g, ' ')
    .replace(/[([] *[)\]]/g, ' ')
    .replace(/\s+/g, ' ');
  return trimEdgeChars(withoutDates, EDGE_FILLER).trim();
}

// Entries follow the "what: why" shape produced by update_state. The rationale
// is dropped only when the "what" part is long enough to stand alone, so short
// prefixes like "fix: lint" are kept whole.
function coreFact(text) {
  const cleaned = stripDateTokens(text);
  const separator = cleaned.indexOf(': ');
  if (separator >= 12) return cleaned.slice(0, separator).trim();
  return cleaned;
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

function parseStateDocument(content) {
  const lines = content.split('\n');
  const header = [];
  const sections = [];
  let current = null;

  for (const line of lines) {
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      current = { title: heading[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      header.push(line);
      continue;
    }
    current.lines.push(line);
  }

  while (header.length > 0 && header[header.length - 1].trim() === '') {
    header.pop();
  }

  return { header, sections };
}

function deduplicateLines(bodyLines, stats) {
  const seen = new Set();
  const kept = [];
  for (const line of bodyLines) {
    const key = normalizeKey(line.replace(/^- /, ''));
    if (seen.has(key)) {
      stats.duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);
    kept.push(line);
  }
  return kept;
}

function bucketLines(bodyLines, now, seen, stats) {
  const working = [];
  const episodicByWeek = new Map();
  const semantic = [];

  for (const line of bodyLines) {
    const text = line.replace(/^- /, '').trim();
    const key = normalizeKey(text);
    if (seen.has(key)) {
      stats.duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);

    const { layer, date } = classifyEntry(text, now);
    if (layer === 'working') {
      working.push(line);
      stats.workingKept += 1;
    } else if (layer === 'episodic') {
      const week = formatDate(weekStart(date));
      if (!episodicByWeek.has(week)) episodicByWeek.set(week, []);
      episodicByWeek.get(week).push(coreFact(text));
    } else {
      semantic.push(coreFact(text));
    }
  }
  return { working, episodicByWeek, semantic };
}

function buildSemanticOutput(semantic, stats) {
  const out = [];
  const seen = new Set();
  const deduped = [];
  for (const fact of semantic) {
    const key = normalizeKey(fact);
    if (!fact || seen.has(key)) {
      if (fact) stats.duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);
    deduped.push(fact);
  }
  for (const group of chunk(deduped, SEMANTIC_FACTS_PER_LINE)) {
    out.push(`- ${group.join('; ')}`);
  }
  stats.semanticFacts += deduped.length;
  return out;
}

function consolidateSection(section, now, stats) {
  const bodyLines = section.lines.filter(line => line.trim() !== '');

  if (VERBATIM_SECTIONS.has(section.title) || bodyLines.some(line => !line.startsWith('- '))) {
    return deduplicateLines(bodyLines, stats);
  }

  const seen = new Set();
  const { working, episodicByWeek, semantic } = bucketLines(bodyLines, now, seen, stats);

  const output = [...working];

  const weeks = [...episodicByWeek.keys()].sort((a, b) => a.localeCompare(b)).reverse();
  for (const week of weeks) {
    output.push(`- Week of ${week}: ${episodicByWeek.get(week).join('; ')}`);
    stats.episodicWeeks += 1;
  }

  output.push(...buildSemanticOutput(semantic, stats));

  return output;
}

function renderDocument(header, sectionOutputs) {
  const lines = [...header, ''];
  for (const section of sectionOutputs) {
    lines.push(`## ${section.title}`);
    lines.push(...section.lines);
    lines.push('');
  }
  return lines.join('\n');
}

function countLines(content) {
  return content.split('\n').length;
}

function consolidateState(content, options = {}) {
  const now = options.now || new Date();
  const threshold = options.threshold || DEFAULT_THRESHOLD;

  const stats = {
    workingKept: 0,
    episodicWeeks: 0,
    semanticFacts: 0,
    duplicatesRemoved: 0,
  };

  const linesBefore = countLines(content);
  const needed = linesBefore > threshold;

  const { header, sections } = parseStateDocument(content);
  const sectionOutputs = sections.map(section => ({
    title: section.title,
    lines: consolidateSection(section, now, stats),
  }));

  const output = renderDocument(header, sectionOutputs);

  return {
    needed,
    threshold,
    linesBefore,
    linesAfter: countLines(output),
    output,
    stats,
  };
}

function backupStateFile(homeDir, filePath, now = new Date()) {
  const dir = archiveDir(homeDir);
  ensurePrivateDir(dir);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const base = path.basename(filePath, '.md');
  const backupPath = path.join(dir, `${base}.${stamp}.md`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

module.exports = {
  DEFAULT_THRESHOLD,
  WORKING_WINDOW_DAYS,
  EPISODIC_WINDOW_DAYS,
  projectSlug,
  stateFilePath,
  archiveDir,
  extractEntryDate,
  classifyEntry,
  weekStart,
  coreFact,
  parseStateDocument,
  consolidateState,
  backupStateFile,
};
