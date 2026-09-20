/**
 * Regression coverage for supported manual Gemini hook installation guidance.
 */

const assert = require('assert');
const { maybeSkipBaselineAbsent } = require('../lib/baseline-absent');

const fs = require('fs');
const path = require('path');

const HOOKS_README = path.join(__dirname, '..', '..', 'hooks', 'README.md');

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    if (maybeSkipBaselineAbsent(error, name)) return true;
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing manual hook install docs ===\n');

  let passed = 0;
  let failed = 0;

  const hooksReadme = fs.readFileSync(HOOKS_README, 'utf8');

  // The root README no longer documents the manual hook install: that guidance lives in
  // hooks/README.md, which the case below guards. A case for a document that stopped
  // carrying the text asserts nothing, so it was removed rather than left skipping.
  if (test('hooks/README mirrors supported manual install guidance', () => {
    assert.ok(
      hooksReadme.includes('do not paste the raw repo `hooks.json` into `~/.gemini/settings.json` or copy it directly into `~/.gemini/hooks/hooks.json`'),
      'hooks/README should warn against unsupported raw hook copying'
    );
    assert.ok(
      hooksReadme.includes('sh scripts/install.sh --target egc --modules hooks-runtime'),
      'hooks/README should document the supported Bash hook install path'
    );
    assert.ok(
      hooksReadme.includes('pwsh -File scripts/install.ps1 --target egc --modules hooks-runtime'),
      'hooks/README should document the supported PowerShell hook install path'
    );
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
