/**
 * Validate that every SKILL.md in skills/ has strictly valid YAML frontmatter.
 * Ensures strict YAML parsers (js-yaml, PyYAML, Antigravity) parse them without dropping skills.
 * Resolves: #1653
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { extractFrontmatterBlock } = require('../../scripts/lib/frontmatter-block');
const { listSkillLeaves } = require('../../scripts/lib/skill-tree-walker');

const SKILLS_DIR = path.join(__dirname, '..', '..', 'skills');

function runTests() {
  console.log('\n=== Testing SKILL.md YAML Frontmatter (#1653) ===\n');

  let passed = 0;
  let failed = 0;

  const leaves = listSkillLeaves(SKILLS_DIR);
  assert.ok(leaves.length > 0, 'Must discover at least one skill directory');

  for (const leaf of leaves) {
    if (leaf.missing) continue;
    const skillPath = path.join(leaf.fullPath, 'SKILL.md');
    const relPath = path.relative(path.join(__dirname, '..', '..'), skillPath);

    try {
      const content = fs.readFileSync(skillPath, 'utf8');
      const block = extractFrontmatterBlock(content);
      assert.ok(!block.error, `Frontmatter block extraction error: ${block.error}`);
      assert.ok(block.raw && block.raw.trim().length > 0, 'Frontmatter block must not be empty');

      const parsed = yaml.load(block.raw);
      assert.ok(typeof parsed === 'object' && parsed !== null, 'Frontmatter must parse into an object');
      assert.ok(parsed.name, 'Frontmatter must define name');
      assert.ok(parsed.description, 'Frontmatter must define description');

      console.log(`  ✓ ${relPath}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${relPath}`);
      console.log(`    Error: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
