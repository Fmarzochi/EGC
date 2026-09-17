#!/usr/bin/env node
'use strict';

// The Codex-facing skill surface lives in .agents/skills: a real directory per
// skill with the SKILL.md Codex reads and an agents/openai.yaml Codex needs and
// the catalog does not carry. Codex accepts only a few frontmatter keys, so the
// SKILL.md there is the catalog file with the other keys removed. This script
// derives those files from the catalog instead of leaving them to hand copies
// (which drifted for months): --check lists the ones that differ or are
// missing, --write creates or regenerates them. Directories without a catalog
// counterpart (the egc skill) and the symlinked entries are left alone.

const fs = require('node:fs');
const path = require('node:path');

const CODEX_FRONTMATTER_KEYS = Object.freeze(['allowed-tools', 'description', 'license', 'metadata', 'name']);
const BYTE_ORDER_MARK = /^\uFEFF/;

function splitFrontmatter(content) {
  const text = content.replace(BYTE_ORDER_MARK, '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) {
    return null;
  }
  return { frontmatter: match[1], body: text.slice(match[0].length), newline: match[2] || '\n' };
}

// Keeps the top-level keys Codex accepts, with the indented lines that belong
// to them; drops the others with their continuation lines.
function filterFrontmatter(frontmatter) {
  const kept = [];
  let keeping = false;
  for (const line of frontmatter.split(/\r?\n/)) {
    const topLevel = line.match(/^([A-Za-z0-9_-]+):/);
    if (topLevel) {
      keeping = CODEX_FRONTMATTER_KEYS.includes(topLevel[1]);
    }
    if (keeping) {
      kept.push(line);
    }
  }
  return kept;
}

// The line ending of the source file is kept, so a checkout that converts
// line endings compares equal to what it would write.
function toCodexSkill(content) {
  const parts = splitFrontmatter(content);
  if (!parts) {
    return content.replace(BYTE_ORDER_MARK, '');
  }
  const newline = parts.frontmatter.includes('\r\n') || parts.newline === '\r\n' ? '\r\n' : '\n';
  return `---${newline}${filterFrontmatter(parts.frontmatter).join(newline)}${newline}---${parts.newline}${parts.body}`;
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

function catalogSkillDir(repoRoot, skillName) {
  const skillsRoot = path.join(repoRoot, 'skills');
  for (const category of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const candidate = path.join(skillsRoot, category.name, skillName);
    if (fs.existsSync(path.join(candidate, 'SKILL.md'))) {
      return candidate;
    }
  }
  return null;
}

function listFilesRecursive(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(full).map(child => path.join(entry.name, child)));
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

// The mirror entries the catalog governs: real directories whose skill exists
// in the catalog. Each carries SKILL.md plus the files it already has that the
// catalog also has, so a contributor who adds one decides what the Codex
// surface shows; the catalog decides content.
function listMirrorSkills(repoRoot) {
  const mirrorRoot = path.join(repoRoot, '.agents', 'skills');
  const skills = [];
  for (const entry of fs.readdirSync(mirrorRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const catalogDir = catalogSkillDir(repoRoot, entry.name);
    if (!catalogDir) continue;
    const mirrorDir = path.join(mirrorRoot, entry.name);
    const present = listFilesRecursive(mirrorDir)
      .filter(relative => relative.split(path.sep)[0] !== 'agents')
      .filter(relative => fs.existsSync(path.join(catalogDir, relative)));
    const files = [...new Set(['SKILL.md', ...present])].sort((a, b) => a.localeCompare(b));
    skills.push({ name: entry.name, mirrorDir, catalogDir, files });
  }
  return skills;
}

function expectedContent(catalogDir, relative) {
  const content = fs.readFileSync(path.join(catalogDir, relative), 'utf8');
  return relative === 'SKILL.md' ? toCodexSkill(content) : content;
}

function mirrorPath(skillName, relative) {
  return path.posix.join('.agents', 'skills', skillName, relative.split(path.sep).join('/'));
}

function isCurrent(target, expected) {
  if (!fs.existsSync(target)) return false;
  return normalizeNewlines(fs.readFileSync(target, 'utf8')) === normalizeNewlines(expected);
}

function checkCodexMirror(repoRoot) {
  const drifted = [];
  for (const skill of listMirrorSkills(repoRoot)) {
    for (const relative of skill.files) {
      if (!isCurrent(path.join(skill.mirrorDir, relative), expectedContent(skill.catalogDir, relative))) {
        drifted.push(mirrorPath(skill.name, relative));
      }
    }
  }
  return { drifted };
}

function writeCodexMirror(repoRoot) {
  const written = [];
  for (const skill of listMirrorSkills(repoRoot)) {
    for (const relative of skill.files) {
      const target = path.join(skill.mirrorDir, relative);
      const expected = expectedContent(skill.catalogDir, relative);
      if (isCurrent(target, expected)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, expected);
      written.push(mirrorPath(skill.name, relative));
    }
  }
  return { written };
}

function main(argv) {
  const repoRoot = path.join(__dirname, '..', '..');
  if (argv.includes('--write')) {
    const { written } = writeCodexMirror(repoRoot);
    console.log(written.length === 0 ? 'codex mirror: up to date' : `codex mirror: ${written.length} file(s) written\n  ${written.join('\n  ')}`);
    return 0;
  }
  const { drifted } = checkCodexMirror(repoRoot);
  if (drifted.length === 0) {
    console.log('codex mirror: up to date');
    return 0;
  }
  console.error(`codex mirror: ${drifted.length} file(s) differ from the catalog or are missing; run 'node scripts/ci/codex-mirror.js --write'\n  ${drifted.join('\n  ')}`);
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { CODEX_FRONTMATTER_KEYS, checkCodexMirror, filterFrontmatter, listMirrorSkills, toCodexSkill, writeCodexMirror };
