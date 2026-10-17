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
const GUARDIAN_SRC = path.join(ROOT, 'mcp', 'servers', 'egc-guardian', 'src');
const MAX_GENERATED_LINES = 800;
const PART_FILE_RE = /^catalog-(?:skills|agents|rules)-\d+\.ts$/;

function lineCount(file) {
  return fs.readFileSync(file, 'utf8').split('\n').length;
}

function entryCount(file) {
  return (fs.readFileSync(file, 'utf8').match(/"kind": "/g) || []).length;
}

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

run('every entry records the repository path it comes from, and that path exists', () => {
  const missing = index.entries.filter(e => typeof e.source !== 'string' || !fs.existsSync(path.join(ROOT, e.source)));
  assert.strictEqual(missing.length, 0, `entries without a valid source: ${missing.map(e => e.name).slice(0, 5).join(', ')}`);
  const skillsWithTriggers = index.entries.filter(e => e.kind === 'skill' && typeof e.triggers === 'string' && e.triggers.length > 0).length;
  assert.ok(skillsWithTriggers > 100, `expected the activation text of most skills to be indexed, got ${skillsWithTriggers}`);
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

run('the TypeScript catalog is parts under 800 lines, all imported by the aggregator, carrying every entry', () => {
  const parts = fs.readdirSync(GUARDIAN_SRC).filter(name => PART_FILE_RE.test(name)).sort();
  assert.ok(parts.length > 0, 'expected catalog-<kind>-<n>.ts part files next to catalog-index.ts');
  const oversized = ['catalog-index.ts', ...parts].filter(name => lineCount(path.join(GUARDIAN_SRC, name)) > MAX_GENERATED_LINES);
  assert.deepStrictEqual(oversized, [], `generated catalog files over ${MAX_GENERATED_LINES} lines: ${oversized.join(', ')}`);
  const aggregator = fs.readFileSync(path.join(GUARDIAN_SRC, 'catalog-index.ts'), 'utf8');
  const imported = [...aggregator.matchAll(/from '\.\/(catalog-[a-z]+-\d+)\.js'/g)].map(match => `${match[1]}.ts`).sort();
  assert.deepStrictEqual(imported, parts, 'the aggregator must import exactly the part files present');
  const carried = parts.reduce((sum, name) => sum + entryCount(path.join(GUARDIAN_SRC, name)), 0);
  assert.strictEqual(carried, index.entries.length, 'the parts must carry every entry of the JSON twin');
});

run('every entry has a non-empty name and description', () => {
  const empty = index.entries.filter(e => !e.name || !(e.description || '').trim());
  assert.strictEqual(empty.length, 0, `entries missing name/description: ${empty.length}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
