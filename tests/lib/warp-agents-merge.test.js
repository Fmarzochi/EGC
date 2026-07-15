/**
 * Tests for scripts/lib/warp-agents-merge.js and its wiring into
 * install/apply.js (real file writes) -- covers the scenarios required by
 * issue #739: creating AGENTS.md from scratch, merging into an existing one
 * without touching unrelated content, and never deleting the file on
 * uninstall even if the EGC block becomes empty.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MERGE_MARKDOWN_INDEX_KIND,
  mergeSkillIndexEntry,
  removeSkillIndexEntry,
} = require('../../scripts/lib/warp-agents-merge');
const { applyInstallPlan } = require('../../scripts/lib/install-executor');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing warp-agents-merge ===\n');
  let passed = 0;
  let failed = 0;

  const tddEntry = {
    name: 'tdd-workflow',
    description: 'TDD workflow guidance',
    relativePath: '.warp/skills/tdd-workflow.md',
  };

  // --- Pure function: mergeSkillIndexEntry ---

  if (test('creates a fresh block with a single entry when no existing content', () => {
    const result = mergeSkillIndexEntry(null, tddEntry);
    assert.ok(result.includes('<!-- egc-skills-index:start -->'));
    assert.ok(result.includes('<!-- egc-skills-index:end -->'));
    assert.ok(result.includes('- **tdd-workflow**: TDD workflow guidance (`.warp/skills/tdd-workflow.md`)'));
  })) passed++; else failed++;

  if (test('preserves unrelated existing content and appends the block', () => {
    const existing = '# My Project\n\nSome custom rules the user wrote.\n';
    const result = mergeSkillIndexEntry(existing, tddEntry);
    assert.ok(result.startsWith('# My Project\n\nSome custom rules the user wrote.'));
    assert.ok(result.includes('<!-- egc-skills-index:start -->'));
  })) passed++; else failed++;

  if (test('appends a second entry into the existing block without duplicating the first', () => {
    const once = mergeSkillIndexEntry(null, tddEntry);
    const twice = mergeSkillIndexEntry(once, {
      name: 'kotlin-patterns',
      description: 'Idiomatic Kotlin patterns',
      relativePath: '.warp/skills/kotlin-patterns.md',
    });
    assert.ok(twice.includes('- **tdd-workflow**:'));
    assert.ok(twice.includes('- **kotlin-patterns**:'));
    assert.strictEqual((twice.match(/<!-- egc-skills-index:start -->/g) || []).length, 1);
  })) passed++; else failed++;

  if (test('is idempotent: re-adding the same entry does not duplicate it', () => {
    const once = mergeSkillIndexEntry(null, tddEntry);
    const twice = mergeSkillIndexEntry(once, tddEntry);
    assert.strictEqual((twice.match(/^- \*\*tdd-workflow\*\*:/gm) || []).length, 1);
  })) passed++; else failed++;

  if (test('upserts an entry when the description changes on reinstall', () => {
    const once = mergeSkillIndexEntry(null, tddEntry);
    const updated = mergeSkillIndexEntry(once, { ...tddEntry, description: 'Updated description' });
    assert.ok(updated.includes('- **tdd-workflow**: Updated description'));
    assert.ok(!updated.includes('TDD workflow guidance'));
  })) passed++; else failed++;

  // --- Pure function: removeSkillIndexEntry ---

  if (test('removes only the given entry, keeping other entries and the block', () => {
    const withTwo = mergeSkillIndexEntry(
      mergeSkillIndexEntry(null, tddEntry),
      { name: 'kotlin-patterns', description: 'Idiomatic Kotlin patterns', relativePath: '.warp/skills/kotlin-patterns.md' }
    );
    const result = removeSkillIndexEntry(withTwo, 'tdd-workflow');
    assert.ok(!result.includes('tdd-workflow'));
    assert.ok(result.includes('kotlin-patterns'));
    assert.ok(result.includes('<!-- egc-skills-index:start -->'));
  })) passed++; else failed++;

  if (test('drops the block but keeps the rest of the file when the last entry is removed', () => {
    const existing = mergeSkillIndexEntry('# My Project\n\nCustom rules.\n', tddEntry);
    const result = removeSkillIndexEntry(existing, 'tdd-workflow');
    assert.ok(!result.includes('egc-skills-index'));
    assert.ok(result.includes('# My Project'));
    assert.ok(result.includes('Custom rules.'));
  })) passed++; else failed++;

  if (test('never deletes the file even when EGC was the only content', () => {
    const existing = mergeSkillIndexEntry(null, tddEntry);
    const result = removeSkillIndexEntry(existing, 'tdd-workflow');
    assert.strictEqual(typeof result, 'string');
    assert.ok(!result.includes('egc-skills-index'));
  })) passed++; else failed++;

  if (test('returns existing content unchanged when there is no block to remove from', () => {
    const existing = '# My Project\n';
    const result = removeSkillIndexEntry(existing, 'tdd-workflow');
    assert.strictEqual(result, existing);
  })) passed++; else failed++;

  // --- Real install application via applyInstallPlan ---

  function buildMinimalPlan(destinationPath, entry, installStatePath) {
    return {
      operations: [
        {
          kind: MERGE_MARKDOWN_INDEX_KIND,
          moduleId: 'workflow',
          destinationPath,
          strategy: MERGE_MARKDOWN_INDEX_KIND,
          ownership: 'managed',
          scaffoldOnly: false,
          skillName: entry.name,
          skillDescription: entry.description,
          relativePath: entry.relativePath,
        },
      ],
      installStatePath,
      statePreview: {
        schemaVersion: 'egc.install.v1',
        installedAt: new Date().toISOString(),
        target: { id: 'warp-project', target: 'warp', kind: 'project', root: path.dirname(destinationPath), installStatePath },
        request: { profile: null, modules: [], includeComponents: [], excludeComponents: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: ['workflow'], skippedModules: [] },
        source: { repoVersion: null, repoCommit: null, manifestVersion: 1 },
        operations: [],
      },
    };
  }

  if (test('applyInstallPlan creates AGENTS.md from scratch with the correct index entry', () => {
    const projectRoot = createTempDir('warp-apply-fresh-');
    try {
      const destinationPath = path.join(projectRoot, 'AGENTS.md');
      const installStatePath = path.join(projectRoot, '.warp', 'egc-install-state.json');
      const plan = buildMinimalPlan(destinationPath, tddEntry, installStatePath);

      applyInstallPlan(plan);

      assert.ok(fs.existsSync(destinationPath));
      const content = fs.readFileSync(destinationPath, 'utf8');
      assert.ok(content.includes('- **tdd-workflow**: TDD workflow guidance (`.warp/skills/tdd-workflow.md`)'));
    } finally {
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('applyInstallPlan merges into an existing AGENTS.md without touching unrelated content', () => {
    const projectRoot = createTempDir('warp-apply-existing-');
    try {
      const destinationPath = path.join(projectRoot, 'AGENTS.md');
      fs.writeFileSync(destinationPath, '# My Project\n\nCustom rules the user wrote.\n');
      const installStatePath = path.join(projectRoot, '.warp', 'egc-install-state.json');
      const plan = buildMinimalPlan(destinationPath, tddEntry, installStatePath);

      applyInstallPlan(plan);

      const content = fs.readFileSync(destinationPath, 'utf8');
      assert.ok(content.includes('# My Project'));
      assert.ok(content.includes('Custom rules the user wrote.'));
      assert.ok(content.includes('- **tdd-workflow**:'));
    } finally {
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
