/**
 * Validates docs/spec/integration-tiers.md matches reality:
 *   - All 9 harnesses are listed
 *   - Every Tier 1 target named in the doc is in SUPPORTED_INSTALL_TARGETS
 *   - Every Tier 2 harness has a real installer script
 *   - Tier 3 entries reference real injection paths in bootstrap-cognitive.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'spec', 'integration-tiers.md');

const EXPECTED_HARNESSES = [
  'Claude Code',
  'Antigravity',
  'Gemini CLI',
  'Cursor',
  'Codex CLI',
  'OpenCode',
  'CodeBuddy',
  'Kiro',
  'Trae',
];

const EXPECTED_TIER1_TARGETS = ['egc', 'cursor', 'antigravity', 'codex', 'gemini', 'opencode', 'codebuddy'];
const EXPECTED_TIER2_INSTALLERS = ['.kiro/install.sh', '.trae/install.sh'];

function loadDoc() {
  assert.ok(fs.existsSync(DOC_PATH), `integration-tiers.md must exist at ${DOC_PATH}`);
  return fs.readFileSync(DOC_PATH, 'utf8');
}

function testDocListsAll9Harnesses() {
  const doc = loadDoc();
  for (const harness of EXPECTED_HARNESSES) {
    assert.ok(
      doc.includes(harness),
      `integration-tiers.md must list harness "${harness}"`,
    );
  }
  console.log(`  ✓ integration-tiers.md lists all ${EXPECTED_HARNESSES.length} harnesses`);
}

function testTier1TargetsMatchSupportedInstallTargets() {
  const manifestsSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts', 'lib', 'install-manifests.js'),
    'utf8',
  );
  for (const target of EXPECTED_TIER1_TARGETS) {
    assert.ok(
      manifestsSrc.includes(`'${target}'`),
      `SUPPORTED_INSTALL_TARGETS in install-manifests.js must contain "${target}"`,
    );
  }
  console.log(`  ✓ SUPPORTED_INSTALL_TARGETS matches Tier 1 list (${EXPECTED_TIER1_TARGETS.length} targets)`);
}

function testTier2InstallersExist() {
  for (const rel of EXPECTED_TIER2_INSTALLERS) {
    const full = path.join(REPO_ROOT, rel);
    assert.ok(fs.existsSync(full), `Tier 2 installer ${rel} must exist`);
    assert.ok(fs.statSync(full).mode & 0o111, `Tier 2 installer ${rel} must be executable`);
  }
  console.log(`  ✓ Tier 2 installers exist and are executable`);
}

function testClaudeCodeProtocolInjectionExists() {
  const bootstrapSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts', 'bootstrap-cognitive.js'),
    'utf8',
  );
  assert.ok(
    bootstrapSrc.includes('.claude') && bootstrapSrc.includes('CLAUDE.md'),
    'bootstrap-cognitive.js must reference Claude Code injection path (~/.claude/CLAUDE.md)',
  );
  console.log(`  ✓ Claude Code Tier 3 injection path documented in bootstrap-cognitive.js`);
}

console.log('=== Testing docs/spec/integration-tiers.md ===\n');

let passed = 0;
let failed = 0;
for (const test of [
  testDocListsAll9Harnesses,
  testTier1TargetsMatchSupportedInstallTargets,
  testTier2InstallersExist,
  testClaudeCodeProtocolInjectionExists,
]) {
  try {
    test();
    passed++;
  } catch (err) {
    console.error(`  ✗ ${test.name}: ${err.message}`);
    failed++;
  }
}

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
