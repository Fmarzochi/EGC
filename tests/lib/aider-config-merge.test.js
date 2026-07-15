/**
 * Tests for scripts/lib/aider-config-merge.js and its wiring into
 * install/apply.js (real file writes) -- covers the two scenarios required
 * by issue #736: creating .aider.conf.yml from scratch, and merging into an
 * existing one without touching unrelated keys.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const {
  MERGE_YAML_READ_LIST_KIND,
  REMOVE_SENTINEL,
  mergeAiderConfigReadList,
  removeAiderConfigReadEntry,
} = require('../../scripts/lib/aider-config-merge');
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
  console.log('\n=== Testing aider-config-merge ===\n');
  let passed = 0;
  let failed = 0;

  // --- Pure function: mergeAiderConfigReadList ---

  if (test('creates a fresh config with the correct read: list when no existing content', () => {
    const result = mergeAiderConfigReadList(null, '.aider/skills/tdd-workflow.md');
    const parsed = yaml.load(result);
    assert.deepStrictEqual(parsed, { read: ['.aider/skills/tdd-workflow.md'] });
  })) passed++; else failed++;

  if (test('preserves unrelated existing keys and only adds read:', () => {
    const existing = yaml.dump({ model: 'gpt-4o', 'auto-commits': false });
    const result = mergeAiderConfigReadList(existing, '.aider/skills/tdd-workflow.md');
    const parsed = yaml.load(result);
    assert.deepStrictEqual(parsed, {
      model: 'gpt-4o',
      'auto-commits': false,
      read: ['.aider/skills/tdd-workflow.md'],
    });
  })) passed++; else failed++;

  if (test('appends to an existing read: list without duplicating or dropping entries', () => {
    const existing = yaml.dump({ read: ['docs/CONVENTIONS.md'] });
    const result = mergeAiderConfigReadList(existing, '.aider/skills/tdd-workflow.md');
    const parsed = yaml.load(result);
    assert.deepStrictEqual(parsed.read, ['docs/CONVENTIONS.md', '.aider/skills/tdd-workflow.md']);
  })) passed++; else failed++;

  if (test('is idempotent: re-adding the same entry does not duplicate it', () => {
    const once = mergeAiderConfigReadList(null, '.aider/skills/tdd-workflow.md');
    const twice = mergeAiderConfigReadList(once, '.aider/skills/tdd-workflow.md');
    const parsed = yaml.load(twice);
    assert.deepStrictEqual(parsed.read, ['.aider/skills/tdd-workflow.md']);
  })) passed++; else failed++;

  // --- Pure function: removeAiderConfigReadEntry ---

  if (test('removes only the given entry, keeping other read: entries and keys', () => {
    const existing = yaml.dump({ model: 'gpt-4o', read: ['docs/CONVENTIONS.md', '.aider/skills/tdd-workflow.md'] });
    const result = removeAiderConfigReadEntry(existing, '.aider/skills/tdd-workflow.md');
    const parsed = yaml.load(result);
    assert.deepStrictEqual(parsed, { model: 'gpt-4o', read: ['docs/CONVENTIONS.md'] });
  })) passed++; else failed++;

  if (test('signals file removal when EGC entry was the only content', () => {
    const existing = yaml.dump({ read: ['.aider/skills/tdd-workflow.md'] });
    const result = removeAiderConfigReadEntry(existing, '.aider/skills/tdd-workflow.md');
    assert.strictEqual(result, REMOVE_SENTINEL);
  })) passed++; else failed++;

  if (test('signals file removal when existing content is empty/falsy', () => {
    const result = removeAiderConfigReadEntry(null, '.aider/skills/tdd-workflow.md');
    assert.strictEqual(result, REMOVE_SENTINEL);
  })) passed++; else failed++;

  // --- Real install application via applyInstallPlan ---

  function buildMinimalPlan(destinationPath, readEntry, installStatePath) {
    return {
      operations: [
        {
          kind: MERGE_YAML_READ_LIST_KIND,
          moduleId: 'workflow',
          destinationPath,
          strategy: MERGE_YAML_READ_LIST_KIND,
          ownership: 'managed',
          scaffoldOnly: false,
          readEntry,
        },
      ],
      installStatePath,
      statePreview: {
        schemaVersion: 'egc.install.v1',
        installedAt: new Date().toISOString(),
        target: { id: 'aider-project', target: 'aider', kind: 'project', root: path.dirname(destinationPath), installStatePath },
        request: { profile: null, modules: [], includeComponents: [], excludeComponents: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: ['workflow'], skippedModules: [] },
        source: { repoVersion: null, repoCommit: null, manifestVersion: 1 },
        operations: [],
      },
    };
  }

  if (test('applyInstallPlan creates .aider.conf.yml from scratch with the correct read: list', () => {
    const projectRoot = createTempDir('aider-apply-fresh-');
    try {
      const destinationPath = path.join(projectRoot, '.aider.conf.yml');
      const installStatePath = path.join(projectRoot, '.aider', 'egc-install-state.json');
      const plan = buildMinimalPlan(destinationPath, '.aider/skills/tdd-workflow.md', installStatePath);

      applyInstallPlan(plan);

      assert.ok(fs.existsSync(destinationPath));
      const parsed = yaml.load(fs.readFileSync(destinationPath, 'utf8'));
      assert.deepStrictEqual(parsed, { read: ['.aider/skills/tdd-workflow.md'] });
    } finally {
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('applyInstallPlan merges into an existing .aider.conf.yml without touching unrelated keys', () => {
    const projectRoot = createTempDir('aider-apply-existing-');
    try {
      const destinationPath = path.join(projectRoot, '.aider.conf.yml');
      fs.writeFileSync(destinationPath, yaml.dump({
        model: 'gpt-4o',
        'auto-commits': false,
        read: ['docs/CONVENTIONS.md'],
      }));
      const installStatePath = path.join(projectRoot, '.aider', 'egc-install-state.json');
      const plan = buildMinimalPlan(destinationPath, '.aider/skills/tdd-workflow.md', installStatePath);

      applyInstallPlan(plan);

      const parsed = yaml.load(fs.readFileSync(destinationPath, 'utf8'));
      assert.deepStrictEqual(parsed, {
        model: 'gpt-4o',
        'auto-commits': false,
        read: ['docs/CONVENTIONS.md', '.aider/skills/tdd-workflow.md'],
      });
    } finally {
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
