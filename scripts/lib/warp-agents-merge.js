'use strict';

const MERGE_MARKDOWN_INDEX_KIND = 'merge-markdown-skill-index';

const BLOCK_START = '<!-- egc-skills-index:start -->';
const BLOCK_END = '<!-- egc-skills-index:end -->';
const BLOCK_HEADING = '## EGC Skills';
const BLOCK_INTRO = 'Skills installed by EGC for this project. Read the referenced file when a task matches its description.';
const ENTRY_LINE_PATTERN = /^- \*\*(.+?)\*\*: (.*)$/;

// Warp only discovers a single root-level AGENTS.md (or legacy WARP.md) as
// project rules -- there is no per-skill file discovery like Kiro/Trae/
// OpenHands. With 230+ skills (~2MB of raw content), concatenating everything
// into that one always-loaded file would blow the user's context budget on
// every session regardless of relevance. So EGC maintains a short index
// inside a marked block instead: one line per skill (name, one-line
// description, path to the full file under .warp/skills/), letting Warp's
// agent read the full content on demand. The block is delimited so
// reinstall/uninstall never touches the user's own AGENTS.md content outside
// it -- AGENTS.md is an increasingly common cross-tool convention file other
// tools may also write to.

function buildEntryLine(entry) {
  return `- **${entry.name}**: ${entry.description} (\`${entry.relativePath}\`)`;
}

function parseEntryLine(line) {
  const match = ENTRY_LINE_PATTERN.exec(line.trim());
  if (!match) {
    return null;
  }
  return { name: match[1], line: line.trim() };
}

function findBlockRange(lines) {
  const startIndex = lines.indexOf(BLOCK_START);
  if (startIndex === -1) {
    return null;
  }
  const endIndex = lines.indexOf(BLOCK_END, startIndex + 1);
  if (endIndex === -1) {
    return null;
  }
  return { startIndex, endIndex };
}

function extractEntries(lines, range) {
  const entries = new Map();
  for (let i = range.startIndex + 1; i < range.endIndex; i++) {
    const parsed = parseEntryLine(lines[i]);
    if (parsed) {
      entries.set(parsed.name, parsed.line);
    }
  }
  return entries;
}

function renderBlock(entries) {
  return [BLOCK_START, BLOCK_HEADING, '', BLOCK_INTRO, '', ...entries.values(), BLOCK_END];
}

function mergeSkillIndexEntry(existingContent, entry) {
  const original = existingContent || '';
  const lines = original.length > 0 ? original.split('\n') : [];
  const range = findBlockRange(lines);

  const entries = range ? extractEntries(lines, range) : new Map();
  entries.set(entry.name, buildEntryLine(entry));

  const blockLines = renderBlock(entries);

  if (range) {
    const nextLines = [
      ...lines.slice(0, range.startIndex),
      ...blockLines,
      ...lines.slice(range.endIndex + 1),
    ];
    return nextLines.join('\n');
  }

  const trimmedOriginal = original.replace(/\n+$/, ''); // NOSONAR: superlinear risk accepted: input is repo-owned or local state content, never network-controlled
  const prefix = trimmedOriginal.length > 0 ? `${trimmedOriginal}\n\n` : '';
  return `${prefix}${blockLines.join('\n')}\n`;
}

// Removes only the given skill's entry from the marked block. If that empties
// the block, the block itself is dropped -- but the rest of the file (and the
// file itself) is always preserved, even if EGC created it and it would now
// be empty. See module comment above for why.
function removeSkillIndexEntry(existingContent, name) {
  if (!existingContent) {
    return '';
  }

  const lines = existingContent.split('\n');
  const range = findBlockRange(lines);
  if (!range) {
    return existingContent;
  }

  const entries = extractEntries(lines, range);
  entries.delete(name);

  const before = lines.slice(0, range.startIndex);
  const after = lines.slice(range.endIndex + 1);

  if (entries.size === 0) {
    while (before.length > 0 && before[before.length - 1] === '') {
      before.pop();
    }
    const nextLines = after.length > 0 ? [...before, '', ...after] : before;
    return nextLines.length > 0 ? `${nextLines.join('\n')}\n` : '';
  }

  const blockLines = renderBlock(entries);
  return [...before, ...blockLines, ...after].join('\n');
}

module.exports = {
  MERGE_MARKDOWN_INDEX_KIND,
  mergeSkillIndexEntry,
  removeSkillIndexEntry,
};
