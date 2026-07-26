'use strict';
/**
 * Integrity of the generated catalog (scripts/build-skill-index.js output).
 *
 * Regression for the catalog indexer (EGC-438):
 *  - it used to walk every .md under skills/, so reference docs and sub-agents
 *    were counted as top-level skills, inflating the catalog past the real
 *    SKILL.md count.
 *  - its line-splitting frontmatter parser collapsed a YAML block scalar
 *    (description: >- / |-) to the bare ">-" indicator, corrupting those
 *    descriptions.
 *
 * Run with: node tests/ci/skill-index-integrity.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const index = require(path.join(ROOT, 'scripts', 'lib', 'skill-index.json'));

function countSkillMd(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countSkillMd(path.join(dir, entry.name));
    else if (entry.name === 'SKILL.md') total += 1;
  }
  return total;
}

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('\n=== Testing generated skill-index.json integrity ===\n');

run('skill count equals the real SKILL.md files (no sub-.md inflation)', () => {
  const realSkills = countSkillMd(path.join(ROOT, 'skills'));
  const catalogSkills = index.entries.filter(e => e.kind === 'skill').length;
  assert.strictEqual(
    catalogSkills,
    realSkills,
    `catalog skills (${catalogSkills}) should equal SKILL.md files (${realSkills}); ` +
    'run "node scripts/build-skill-index.js" to regenerate'
  );
});

run('no description collapsed to a bare YAML block-scalar indicator', () => {
  const indicators = ['>', '>-', '>+', '|', '|-', '|+'];
  const corrupted = index.entries.filter(e => indicators.includes((e.description || '').trim()));
  assert.strictEqual(
    corrupted.length,
    0,
    `descriptions corrupted to a block-scalar indicator: ${corrupted.map(e => e.name).join(', ')}`
  );
});

run('every entry has a non-empty name and description', () => {
  const empty = index.entries.filter(e => !e.name || !(e.description || '').trim());
  assert.strictEqual(empty.length, 0, `entries missing name/description: ${empty.length}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
