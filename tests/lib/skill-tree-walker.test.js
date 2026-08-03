/**
 * Tests for scripts/lib/skill-tree-walker.js -- the shared skill-directory
 * tree walker extracted from scripts/ci/validate-skills.js and
 * scripts/ci/validate-skill-frontmatter.js (EGC-539 audit, Finding 4).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { hasSkillMd, isCategoryRoot, listSkillLeaves } = require('../../scripts/lib/skill-tree-walker');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function makeSkill(root, ...segments) {
  const dir = path.join(root, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: x\n---\n');
  return dir;
}

function runTests() {
  console.log('\n=== Testing scripts/lib/skill-tree-walker.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('hasSkillMd is true for a directory with SKILL.md, false otherwise', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-walker-'));
    try {
      const withSkill = makeSkill(root, 'has-one');
      const without = path.join(root, 'no-skill');
      fs.mkdirSync(without);
      assert.strictEqual(hasSkillMd(withSkill), true);
      assert.strictEqual(hasSkillMd(without), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('isCategoryRoot is true only for a directory whose children (not itself) have SKILL.md', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-walker-'));
    try {
      const category = path.join(root, 'category');
      fs.mkdirSync(category);
      makeSkill(category, 'child-skill');
      assert.strictEqual(isCategoryRoot(category), true);

      const leafSkill = makeSkill(root, 'leaf-skill');
      assert.strictEqual(isCategoryRoot(leafSkill), false, 'a directory with its own SKILL.md is a leaf, not a category root');

      const empty = path.join(root, 'empty');
      fs.mkdirSync(empty);
      assert.strictEqual(isCategoryRoot(empty), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('isCategoryRoot does not throw on an unreadable directory', () => {
    assert.strictEqual(isCategoryRoot(path.join(os.tmpdir(), 'skill-walker-does-not-exist')), false);
  })) passed++; else failed++;

  if (test('listSkillLeaves finds top-level skills directly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-walker-'));
    try {
      makeSkill(root, 'top-level-skill');
      const leaves = listSkillLeaves(root);
      assert.strictEqual(leaves.length, 1);
      assert.strictEqual(leaves[0].relPath, 'top-level-skill');
      assert.strictEqual(leaves[0].dirName, 'top-level-skill');
      assert.strictEqual(leaves[0].missing, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('listSkillLeaves finds skills nested one level under a category directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-walker-'));
    try {
      makeSkill(root, 'docs', 'nested-skill');
      const leaves = listSkillLeaves(root);
      assert.strictEqual(leaves.length, 1);
      assert.strictEqual(leaves[0].relPath, path.join('docs', 'nested-skill'));
      assert.strictEqual(leaves[0].dirName, 'nested-skill');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('listSkillLeaves flags a directory with no SKILL.md and no valid children as missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-walker-'));
    try {
      fs.mkdirSync(path.join(root, 'broken-skill'));
      const leaves = listSkillLeaves(root);
      assert.strictEqual(leaves.length, 1);
      assert.strictEqual(leaves[0].missing, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('listSkillLeaves flags a skill missing under an otherwise-valid category', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-walker-'));
    try {
      const category = path.join(root, 'category');
      makeSkill(category, 'real-skill');
      fs.mkdirSync(path.join(category, 'broken-skill'));
      const leaves = listSkillLeaves(root);
      assert.strictEqual(leaves.length, 2);
      const broken = leaves.find(l => l.dirName === 'broken-skill');
      assert.strictEqual(broken.missing, true);
      const real = leaves.find(l => l.dirName === 'real-skill');
      // A found nested skill explicitly gets missing: false (from
      // !hasSkillMd(...)); a found top-level skill never sets the key at
      // all (undefined). Both are falsy for every real consumer's `if
      // (leaf.missing)` check -- pre-existing, harmless asymmetry inherited
      // from the two original implementations, not introduced here.
      assert.ok(!real.missing);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('listSkillLeaves ignores non-directory entries at the root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-walker-'));
    try {
      fs.writeFileSync(path.join(root, 'README.md'), 'not a skill');
      makeSkill(root, 'real-skill');
      const leaves = listSkillLeaves(root);
      assert.strictEqual(leaves.length, 1);
      assert.strictEqual(leaves[0].dirName, 'real-skill');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
