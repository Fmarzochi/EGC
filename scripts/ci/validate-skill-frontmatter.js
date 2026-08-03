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
const { listSkillLeaves } = require('#lib/skill-tree-walker');
const { extractFrontmatterBlock } = require('#lib/frontmatter-block');
const { skipIfMissing, finishValidation } = require('#lib/validator-cli');

const SKILLS_DIR = path.join(__dirname, '../../skills');
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function extractFrontmatter(content) {
  const block = extractFrontmatterBlock(content);
  if (block.error) return { error: block.error };

  const frontmatter = {};
  const lines = block.raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Indented lines belong to a block scalar consumed below.
    if (/^\s/.test(line)) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Fold a YAML block scalar (key: >- / |-) into its indented body so a
    // description written as a block is validated on its real text, not the
    // bare ">-" indicator that a plain split-on-colon parser would store.
    if (/^[>|][+-]?$/.test(value)) {
      const block = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === '')) {
        block.push(lines[j].trim());
        j++;
      }
      value = block.join(' ').replace(/\s+/g, ' ').trim();
      i = j - 1;
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    frontmatter[key] = value;
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
  skipIfMissing(SKILLS_DIR, 'No skills directory found, skipping validation');

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

  finishValidation(hasErrors, `Validated frontmatter for ${validCount} skill files`);
}

if (require.main === module) {
  validateSkillFrontmatter();
}

module.exports = { listSkillLeaves, extractFrontmatter, nameMatchesDirectory };
