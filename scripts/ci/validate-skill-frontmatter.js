#!/usr/bin/env node
/**
 * Validate that every skill's SKILL.md has well-formed frontmatter.
 *
 * Mirrors the structural checks freeCodeCamp runs on its curriculum content
 * (per-item schema validation in CI) applied to the EGC skill catalog: a
 * `name` and `description` are required on every skill so the catalog
 * indexer (scripts/build-skill-index.js) and session-start hook can surface
 * it. A skill silently missing either field is invisible to both.
 */

const fs = require('node:fs');
const path = require('node:path');

const SKILLS_DIR = path.join(__dirname, '../../skills');
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function hasSkillMd(dir) {
  return fs.existsSync(path.join(dir, 'SKILL.md'));
}

function isCategoryRoot(dir) {
  if (hasSkillMd(dir)) return false;
  try {
    const children = fs.readdirSync(dir, { withFileTypes: true });
    return children.some(c => c.isDirectory() && hasSkillMd(path.join(dir, c.name)));
  } catch (_) { /* ignore: unreadable directory safely means it is not a category root */
    return false;
  }
}

// Mirrors scripts/ci/validate-skills.js: skills live either directly under
// skills/<name>/SKILL.md or nested one level under a category directory
// (skills/<category>/<name>/SKILL.md).
function listSkillLeaves(root) {
  const leaves = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(root, entry.name);

    if (hasSkillMd(entryPath)) {
      leaves.push({ relPath: entry.name, dirName: entry.name, fullPath: entryPath });
      continue;
    }

    if (isCategoryRoot(entryPath)) {
      const skillEntries = fs.readdirSync(entryPath, { withFileTypes: true });
      for (const skill of skillEntries) {
        if (!skill.isDirectory()) continue;
        const skillPath = path.join(entryPath, skill.name);
        leaves.push({
          relPath: path.join(entry.name, skill.name),
          dirName: skill.name,
          fullPath: skillPath,
          missing: !hasSkillMd(skillPath),
        });
      }
    }
  }

  return leaves;
}

// Adapted from the frontmatter extractor in scripts/ci/validate-agents.js.
// Distinguishes "no frontmatter block at all" from "frontmatter block opened
// but never closed" so the error message points at the actual problem.
function extractFrontmatter(content) {
  const cleanContent = content.replace(/^\uFEFF/, '');
  const opensFrontmatter = /^---\r?\n/.test(cleanContent);

  if (!opensFrontmatter) {
    return { error: 'missing' };
  }

  const match = cleanContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { error: 'unterminated' };
  }

  const frontmatter = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
      frontmatter[key] = value;
    }
  }
  return { frontmatter };
}

// The established convention (verified against all current skills) is that
// `name` equals the leaf directory name, or, for skills grouped under a
// shared topic prefix (e.g. skills/docs/scientific-db-pubmed-database with
// name "pubmed-database"), the directory name ends with `-${name}`. Anything
// else indicates the name field drifted from the directory it lives in.
function nameMatchesDirectory(name, dirName) {
  if (name === dirName) return true;
  return dirName.endsWith(`-${name}`);
}

// Returns { skip: true } on fatal parse error (caller skips validCount++),
// or { skip: false, hasError: boolean } when frontmatter was parsed.
function validateLeafFrontmatter(leaf) {
  const skillMdPath = path.join(leaf.fullPath, 'SKILL.md');
  let content;
  try {
    content = fs.readFileSync(skillMdPath, 'utf-8');
  } catch (err) {
    console.error(`ERROR: ${leaf.relPath}/SKILL.md - ${err.message}`);
    return { skip: true };
  }

  const { frontmatter, error } = extractFrontmatter(content);

  if (error === 'missing') {
    console.error(`ERROR: ${leaf.relPath}/SKILL.md - Missing frontmatter (no leading --- block)`);
    return { skip: true };
  }
  if (error === 'unterminated') {
    console.error(`ERROR: ${leaf.relPath}/SKILL.md - Malformed frontmatter (opening --- found but no closing ---)`);
    return { skip: true };
  }

  let hasError = false;

  if (!frontmatter.name?.trim()) {
    console.error(`ERROR: ${leaf.relPath}/SKILL.md - Missing required frontmatter field: name`);
    hasError = true;
  } else {
    if (!SLUG_PATTERN.test(frontmatter.name)) {
      console.error(`ERROR: ${leaf.relPath}/SKILL.md - name '${frontmatter.name}' is not lowercase kebab-case (expected pattern: ${SLUG_PATTERN})`);
      hasError = true;
    }
    if (!nameMatchesDirectory(frontmatter.name, leaf.dirName)) {
      console.error(`ERROR: ${leaf.relPath}/SKILL.md - name '${frontmatter.name}' does not match directory '${leaf.dirName}' (expected exact match, or the directory to end with '-${frontmatter.name}')`);
      hasError = true;
    }
  }

  if (!frontmatter.description?.trim()) {
    console.error(`ERROR: ${leaf.relPath}/SKILL.md - Missing required frontmatter field: description`);
    hasError = true;
  }

  return { skip: false, hasError };
}

function validateSkillFrontmatter() {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log('No skills directory found, skipping validation');
    process.exit(0);
  }

  const leaves = listSkillLeaves(SKILLS_DIR);
  let hasErrors = false;
  let validCount = 0;

  for (const leaf of leaves) {
    if (leaf.missing) {
      // Already reported by validate-skills.js; skip here to avoid duplicate noise.
      continue;
    }

    const { skip, hasError } = validateLeafFrontmatter(leaf);
    if (skip) {
      hasErrors = true;
      continue;
    }
    if (hasError) hasErrors = true;
    validCount++;
  }

  if (hasErrors) {
    process.exit(1);
  }

  console.log(`Validated frontmatter for ${validCount} skill files`);
}

if (require.main === module) {
  validateSkillFrontmatter();
}

module.exports = { listSkillLeaves, extractFrontmatter, nameMatchesDirectory };
