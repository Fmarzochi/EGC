/**
 * Regression checks for first-install guidance.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const INSTALL_APPLY = path.join(REPO_ROOT, 'scripts', 'install-apply.js');
const INSTALL_SH = path.join(REPO_ROOT, 'scripts', 'install.sh');
const INSTALL_PS1 = path.join(REPO_ROOT, 'scripts', 'install.ps1');
const INSTALLATION_GUIDE = path.join(REPO_ROOT, 'docs', 'installation.md');

const UV_MESSAGES = [
  'Optional dependency not found: uv',
  'Required only for Jira and omega-memory MCP servers.',
  'Core EGC installation is unaffected.',
];
const DASHBOARD_MESSAGES = [
  'Dashboard was not started automatically.',
  "Run 'egc dashboard' to start it, or run 'egc init' inside a project for project setup.",
];

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

  const installApplySource = fs.readFileSync(INSTALL_APPLY, 'utf8');
  const bashSource = fs.readFileSync(INSTALL_SH, 'utf8');
  const powerShellSource = fs.readFileSync(INSTALL_PS1, 'utf8');
  const guide = fs.readFileSync(INSTALLATION_GUIDE, 'utf8');

  if (test('bash and PowerShell label uv as optional and scoped', () => {
    for (const message of UV_MESSAGES) {
      assert.ok(bashSource.includes(message), `install.sh missing: ${message}`);
      assert.ok(powerShellSource.includes(message), `install.ps1 missing: ${message}`);
    }
  })) passed++; else failed++;

  if (test('bash and PowerShell explain dashboard startup after bare installs only', () => {
    for (const message of DASHBOARD_MESSAGES) {
      assert.ok(bashSource.includes(message), `install.sh missing: ${message}`);
      assert.ok(powerShellSource.includes(message), `install.ps1 missing: ${message}`);
    }
    assert.ok(bashSource.includes('if [ "$_has_install_args" = false ]; then'));
    assert.ok(powerShellSource.includes('if (-not $hasInstallArgs)'));
  })) passed++; else failed++;

  if (test('delegating installer does not duplicate wrapper guidance', () => {
    for (const message of [...UV_MESSAGES, ...DASHBOARD_MESSAGES]) {
      assert.ok(!installApplySource.includes(message), `install-apply.js should not repeat: ${message}`);
    }
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
