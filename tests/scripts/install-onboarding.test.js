/**
 * Regression checks for first-install guidance.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const INSTALL_APPLY = path.join(REPO_ROOT, 'scripts', 'install-apply.js');
const INSTALLATION_GUIDE = path.join(REPO_ROOT, 'docs', 'installation.md');

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing install onboarding guidance ===\n');

  let passed = 0;
  let failed = 0;

  const installSource = fs.readFileSync(INSTALL_APPLY, 'utf8');
  const guide = fs.readFileSync(INSTALLATION_GUIDE, 'utf8');

  if (test('bare install labels uv as optional and scoped', () => {
    assert.ok(installSource.includes('Optional dependency not found: uv'));
    assert.ok(installSource.includes('Required only for Jira and omega-memory MCP servers.'));
    assert.ok(installSource.includes('Core EGC installation is unaffected.'));
  })) passed++; else failed++;

  if (test('bare install states that the dashboard was not started', () => {
    assert.ok(installSource.includes('Dashboard was not started automatically.'));
    assert.ok(installSource.includes("Run 'egc dashboard' to start it"));
  })) passed++; else failed++;

  if (test('installation guide explains the three setup stages', () => {
    assert.ok(guide.includes('## Installation lifecycle'));
    assert.ok(guide.includes('### 1. Bare install'));
    assert.ok(guide.includes('### 2. Project setup'));
    assert.ok(guide.includes('### 3. Full profile'));
    assert.ok(guide.includes('egc install --target <target> --profile full'));
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
