'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_BRANCH_FILE, getStateDir } = require('./branch-state');

const HEADER_FIELD_REGEX = /^(project|branch|updated):\s*(.+)$/;
const SECTION_HEADING_REGEX = /^##\s+(.+)$/;

/**
 * Parses one project-state Markdown file produced by the egc-memory
 * server. Returns header fields plus section bodies keyed by heading.
 */
function parseStateFile(content) {
  const lines = String(content).split(/\r?\n/);
  const header = { project: null, branch: null, updated: null };
  const sections = {};
  let currentSection = null;

  for (const line of lines) {
    const headingMatch = line.match(SECTION_HEADING_REGEX);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
      sections[currentSection] = [];
      continue;
    }

    if (!currentSection) {
      const fieldMatch = line.match(HEADER_FIELD_REGEX);
      if (fieldMatch) {
        header[fieldMatch[1]] = fieldMatch[2].trim();
      }
      continue;
    }

    sections[currentSection].push(line);
  }

  const sectionText = {};
  for (const [name, body] of Object.entries(sections)) {
    sectionText[name] = body.join('\n').trim();
  }

  return { header, sections: sectionText };
}

function extractBullets(sectionBody) {
  if (!sectionBody) {
    return [];
  }

  return sectionBody
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(Boolean);
}

function firstParagraph(sectionBody) {
  if (!sectionBody) {
    return null;
  }

  const paragraph = sectionBody.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  return paragraph || null;
}

function readStateEntry(filePath, slug, branchInfo) {
  let stat;
  let parsed;
  try {
    stat = fs.statSync(filePath);
    parsed = parseStateFile(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return {
      slug,
      filePath,
      error: error.message,
    };
  }

  return {
    slug,
    filePath,
    project: parsed.header.project || slug,
    branch: parsed.header.branch || branchInfo.branch || null,
    updated: parsed.header.updated || stat.mtime.toISOString(),
    modifiedAt: stat.mtime.toISOString(),
    context: firstParagraph(parsed.sections.Context),
    next: extractBullets(parsed.sections['Next Session']),
    decisionCount: extractBullets(parsed.sections['Active Decisions']).length,
    avoidCount: extractBullets(parsed.sections['Do Not Repeat']).length,
    preferenceCount: extractBullets(parsed.sections.Preferences).length,
    branchStateCount: branchInfo.branchStateCount,
    layout: branchInfo.layout,
    error: null,
  };
}

function listMarkdownFiles(dirPath) {
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => entry.name);
}

/**
 * Picks the file that represents a branch-per-file project directory:
 * main.md when present, otherwise the most recently modified branch file.
 */
function pickPrimaryBranchFile(dirPath, fileNames) {
  if (fileNames.includes(DEFAULT_BRANCH_FILE)) {
    return DEFAULT_BRANCH_FILE;
  }

  let newest = null;
  let newestMtime = -1;
  for (const name of fileNames) {
    const mtime = fs.statSync(path.join(dirPath, name)).mtimeMs;
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newest = name;
    }
  }
  return newest;
}

/**
 * Collects every per-project state under the state root. Projects using
 * the branch-per-file directory layout take precedence over a legacy
 * flat file with the same slug, matching the read resolution order in
 * branch-state.js.
 */
function collectProjectStates(options = {}) {
  const stateDir = options.stateDir || getStateDir(options.homeDir);
  if (!fs.existsSync(stateDir)) {
    return { stateDir, entries: [] };
  }

  const dirents = fs.readdirSync(stateDir, { withFileTypes: true });
  const directorySlugs = new Set(
    dirents.filter(entry => entry.isDirectory()).map(entry => entry.name)
  );
  const entries = [];

  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      const dirPath = path.join(stateDir, dirent.name);
      const fileNames = listMarkdownFiles(dirPath);
      if (fileNames.length === 0) {
        continue;
      }
      const primary = pickPrimaryBranchFile(dirPath, fileNames);
      entries.push(readStateEntry(path.join(dirPath, primary), dirent.name, {
        branch: primary === DEFAULT_BRANCH_FILE ? 'main' : path.basename(primary, '.md'),
        branchStateCount: fileNames.length,
        layout: 'branch',
      }));
      continue;
    }

    if (!dirent.isFile() || !dirent.name.endsWith('.md')) {
      continue;
    }

    const slug = path.basename(dirent.name, '.md');
    if (directorySlugs.has(slug)) {
      continue;
    }

    entries.push(readStateEntry(path.join(stateDir, dirent.name), slug, {
      branch: null,
      branchStateCount: 1,
      layout: 'flat',
    }));
  }

  entries.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));

  return { stateDir, entries };
}

function renderOverviewMarkdown(overview) {
  const lines = [];
  const readable = overview.entries.filter(entry => !entry.error);
  const failed = overview.entries.filter(entry => entry.error);

  lines.push('# EGC State Overview');
  lines.push('');
  lines.push(`State root: ${overview.stateDir}`);
  lines.push(`Projects: ${readable.length}`);
  lines.push('');

  for (const entry of readable) {
    lines.push(`## ${entry.project}`);
    lines.push(`- Branch: ${entry.branch || 'n/a'} (${entry.branchStateCount} state file${entry.branchStateCount === 1 ? '' : 's'}, ${entry.layout} layout)`);
    lines.push(`- Updated: ${entry.updated}`);
    if (entry.context) {
      lines.push(`- Context: ${entry.context}`);
    }
    lines.push(`- Memory: ${entry.decisionCount} decisions, ${entry.avoidCount} avoid rules, ${entry.preferenceCount} preferences`);
    if (entry.next.length > 0) {
      lines.push('- Next:');
      for (const item of entry.next) {
        lines.push(`  - ${item}`);
      }
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push('## Unreadable state files');
    for (const entry of failed) {
      lines.push(`- ${entry.filePath}: ${entry.error}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

module.exports = {
  collectProjectStates,
  parseStateFile,
  renderOverviewMarkdown,
};
