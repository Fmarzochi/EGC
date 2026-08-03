#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { listSkillLeaves } = require('#lib/skill-tree-walker');

const SKILLS_DIR = path.join(__dirname, '../../skills');

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

module.exports = { listSkillLeaves };
