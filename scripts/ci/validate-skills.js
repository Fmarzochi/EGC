#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const SKILLS_DIR = path.join(__dirname, '../../skills');

function hasSkillMd(dir) {
  return fs.existsSync(path.join(dir, 'SKILL.md'));
}

function isCategoryRoot(dir) {
  if (hasSkillMd(dir)) return false;
  try {
    const children = fs.readdirSync(dir, { withFileTypes: true });
    return children.some(c => c.isDirectory() && hasSkillMd(path.join(dir, c.name)));
  } catch (_err) {
    return false;
  }
}

function collectSkillEntriesFromCategory(entryPath, entryName) {
  const leaves = [];
  const skillEntries = fs.readdirSync(entryPath, { withFileTypes: true });
  for (const skill of skillEntries) {
    if (!skill.isDirectory()) continue;
    const skillPath = path.join(entryPath, skill.name);
    const relPath = path.join(entryName, skill.name);
    if (hasSkillMd(skillPath)) {
      leaves.push({ relPath, fullPath: skillPath });
    } else {
      leaves.push({ relPath, fullPath: skillPath, missing: true });
    }
  }
  return leaves;
}

function listSkillLeaves(root) {
  const leaves = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(root, entry.name);

    if (hasSkillMd(entryPath)) {
      leaves.push({ relPath: entry.name, fullPath: entryPath });
      continue;
    }

    if (isCategoryRoot(entryPath)) {
      leaves.push(...collectSkillEntriesFromCategory(entryPath, entry.name));
      continue;
    }

    leaves.push({ relPath: entry.name, fullPath: entryPath, missing: true });
  }

  return leaves;
}

function validateSkills() {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log('No curated skills directory (skills/), skipping');
    process.exit(0);
  }

  const leaves = listSkillLeaves(SKILLS_DIR);
  let hasErrors = false;
  let validCount = 0;

  for (const leaf of leaves) {
    if (leaf.missing) {
      console.error(`ERROR: ${leaf.relPath}/ - Missing SKILL.md`);
      hasErrors = true;
      continue;
    }

    const skillMd = path.join(leaf.fullPath, 'SKILL.md');
    let content;
    try {
      content = fs.readFileSync(skillMd, 'utf-8');
    } catch (err) {
      console.error(`ERROR: ${leaf.relPath}/SKILL.md - ${err.message}`);
      hasErrors = true;
      continue;
    }
    if (content.trim().length === 0) {
      console.error(`ERROR: ${leaf.relPath}/SKILL.md - Empty file`);
      hasErrors = true;
      continue;
    }

    validCount++;
  }

  if (hasErrors) {
    process.exit(1);
  }

  console.log(`Validated ${validCount} skill directories`);
}

if (require.main === module) {
  validateSkills();
}

module.exports = { listSkillLeaves, hasSkillMd, isCategoryRoot };
