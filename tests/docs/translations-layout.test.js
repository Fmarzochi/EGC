'use strict';

// The translations tree carries one file per language, the README that
// crowdin.yml syncs. A translated docs tree next to it drifts the moment
// the English docs move on (translations/pt/docs stalled in August 2026 and
// still listed retired tools two months later), so nothing else lives there.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const translationsRoot = path.join(repoRoot, 'translations');

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

console.log('\n=== Testing the translations layout ===\n');

let passed = 0;
let failed = 0;

if (test('every language under translations/ carries only the README that crowdin.yml syncs', () => {
  const languages = fs.readdirSync(translationsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
  assert.ok(languages.length > 0, 'translations/ lists at least one language');
  for (const language of languages) {
    const entries = fs.readdirSync(path.join(translationsRoot, language.name));
    assert.deepStrictEqual(entries, ['README.md'], `translations/${language.name} carries only README.md, found: ${entries.join(', ')}`);
  }
})) passed++; else failed++;

console.log(`\nPassed: ${passed}, Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
