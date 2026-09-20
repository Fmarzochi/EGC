/**
 * Regression coverage for supported manual Gemini hook installation guidance.
 */

const assert = require('assert');
const { maybeSkipBaselineAbsent } = require('../lib/baseline-absent');

const fs = require('fs');
const path = require('path');

const README = path.join(__dirname, '..', '..', 'README.md');
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

  const readme = fs.readFileSync(README, 'utf8');
  const hooksReadme = fs.readFileSync(HOOKS_README, 'utf8');

  if (test('README warns against raw hook file copying', () => {
    assert.ok(
      readme.includes('Do not copy the raw repo `hooks/hooks.json` into `~/.gemini/settings.json` or `~/.gemini/hooks/hooks.json`'),
      'README should warn against unsupported raw hook copying'
    );
    assert.ok(
      readme.includes('sh scripts/install.sh --target egc --modules hooks-runtime'),
      'README should document the supported Bash hook install path'
    );
    assert.ok(
      readme.includes('pwsh -File scripts/install.ps1 --target egc --modules hooks-runtime'),
      'README should document the supported PowerShell hook install path'
    );
    assert.ok(
      readme.includes('%USERPROFILE%\\\\.gemini'),
      'README should call out the correct Windows Gemini config root'
    );
  })) passed++; else failed++;

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
