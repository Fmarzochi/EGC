'use strict';

// Shared skill-directory tree walker for scripts/ci/validate-skills.js and
// scripts/ci/validate-skill-frontmatter.js. Both used to reimplement this
// identically (EGC-539 audit, Finding 4) -- the convention is that a skill
// lives either directly under skills/<name>/SKILL.md, or nested one level
// under a category directory (skills/<category>/<name>/SKILL.md).

const fs = require('node:fs');
const path = require('node:path');

function hasSkillMd(dir) {
  return fs.existsSync(path.join(dir, 'SKILL.md'));
}

function isCategoryRoot(dir) {
  if (hasSkillMd(dir)) return false;
  try {
    const children = fs.readdirSync(dir, { withFileTypes: true });
    return children.some(c => c.isDirectory() && hasSkillMd(path.join(dir, c.name)));
  } catch (_err) { // NOSONAR: unreadable dir cannot contain a skill
    return false;
  }
}

// Each leaf is { relPath, dirName, fullPath, missing? }. relPath is
// category/name for nested skills, or just name for top-level ones; dirName
// is always the leaf directory's own name, used by validate-skill-
// frontmatter.js to check the frontmatter `name` field against it.
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
      continue;
    }

    leaves.push({ relPath: entry.name, dirName: entry.name, fullPath: entryPath, missing: true });
  }

  return leaves;
}

module.exports = { hasSkillMd, isCategoryRoot, listSkillLeaves };
