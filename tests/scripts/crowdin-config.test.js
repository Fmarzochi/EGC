/**
 * Regression guard for crowdin.yml and the Crowdin Sync workflow.
 *
 * This repo's Crowdin project has languages registered with a region code
 * (Portuguese as pt-PT and pt-BR, Spanish as es-ES -- confirmed live via the
 * /mts API on 2026-08-02), while translations/ only has one pt/ and one es/
 * directory. %two_letters_code% collapses those region codes down to two
 * letters, which is why it must stay in crowdin.yml even though it is the
 * same placeholder that mismaps Chinese Simplified to "zh" instead of
 * "zh-CN". Switching to %locale% "fixes" zh-CN by breaking pt and es instead
 * (tested live via workflow_dispatch on 2026-08-02, reverted before merge --
 * see issue #483 and PRs #988, #991, #992, #998, #1000, #1039 for the six
 * prior fix attempts this same config has already been through).
 *
 * upload_translations must also stay false on both crowdin/github-action
 * steps: re-enabling it reintroduces the paragraph-duplication and
 * link-feedback-loop bugs fixed in #1039, because Crowdin cannot
 * sentence-split Chinese text.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CROWDIN_YML = path.join(__dirname, '..', '..', 'crowdin.yml');
const SYNC_WORKFLOW = path.join(__dirname, '..', '..', '.github', 'workflows', 'crowdin-sync.yml');
const TRANSLATIONS_DIR = path.join(__dirname, '..', '..', 'translations');

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

function runTests() {
  console.log('\n=== Testing crowdin.yml / crowdin-sync.yml config ===\n');

  let passed = 0;
  let failed = 0;

  const crowdinYml = fs.readFileSync(CROWDIN_YML, 'utf8');
  const syncWorkflow = fs.readFileSync(SYNC_WORKFLOW, 'utf8');
  const translationDirs = fs.readdirSync(TRANSLATIONS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  if (test('crowdin.yml keeps %two_letters_code%, not %locale%', () => {
    assert.ok(
      crowdinYml.includes('/translations/%two_letters_code%/README.md'),
      'translation path must use %two_letters_code% -- %locale% breaks pt/es (region-registered in this project) even though it fixes zh-CN'
    );
    assert.ok(
      !crowdinYml.includes('%locale%'),
      'crowdin.yml must not reference %locale% at all'
    );
  })) passed++; else failed++;

  if (test('crowdin.yml keeps the zh-CN languages_mapping entry', () => {
    assert.ok(
      /languages_mapping:\s*\n\s*two_letters_code:\s*\n\s*zh-CN:\s*zh-CN/.test(crowdinYml),
      'the zh-CN: zh-CN mapping under two_letters_code must stay in place'
    );
  })) passed++; else failed++;

  if (test('crowdin-sync.yml keeps upload_translations: false on every crowdin/github-action step', () => {
    const uploadTranslationsValues = [...syncWorkflow.matchAll(/upload_translations:\s*(\S+)/g)].map(m => m[1]);
    assert.ok(
      uploadTranslationsValues.length > 0,
      'expected at least one upload_translations setting in the workflow'
    );
    for (const value of uploadTranslationsValues) {
      assert.strictEqual(
        value,
        'false',
        'upload_translations must stay false everywhere -- re-enabling it reintroduces the #1039 paragraph-duplication/link-feedback-loop bugs'
      );
    }
  })) passed++; else failed++;

  if (test('crowdin-sync.yml keeps the post-download zh -> zh-CN normalization step', () => {
    // Exact substrings, not just "translations/zh" -- that's a prefix of
    // "translations/zh-CN" and would match even if the actual rename logic
    // below were deleted, since "translations/zh-CN" appears unconditionally
    // elsewhere in the file (e.g. mkdir -p translations/zh-CN).
    assert.ok(
      syncWorkflow.includes('if [ -d translations/zh ]'),
      'the directory check for the un-renamed zh/ download must stay'
    );
    assert.ok(
      syncWorkflow.includes('rm -rf translations/zh'),
      'the cleanup of the un-renamed zh/ directory must stay'
    );
  })) passed++; else failed++;

  if (test('translations/ has the expected two-letter directories for region-registered languages', () => {
    for (const expected of ['pt', 'es', 'zh-CN']) {
      assert.ok(
        translationDirs.includes(expected),
        `expected translations/${expected}/ to exist`
      );
    }
    for (const unexpected of ['pt-PT', 'pt-BR', 'es-ES', 'zh']) {
      assert.ok(
        !translationDirs.includes(unexpected),
        `translations/${unexpected}/ should not exist -- a region-coded directory here means the path placeholder regressed`
      );
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
