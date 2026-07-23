/**
 * Validates docs/spec/integration-tiers.md matches reality:
 *   - All harnesses are listed, and the list's length matches SUPPORTED_INSTALL_TARGETS
 *   - Public English metadata advertises the same harness count
 *   - Every Tier 1 target named in the doc is in SUPPORTED_INSTALL_TARGETS
 *   - Every Tier 2 harness has a real installer script
 *   - Tier 3 entries reference real injection paths in bootstrap-cognitive.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'spec', 'integration-tiers.md');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');
const GLAMA_PATH = path.join(REPO_ROOT, 'glama.json');
const COPILOT_INSTRUCTIONS_PATH = path.join(REPO_ROOT, '.github', 'copilot-instructions.md');

const EXPECTED_HARNESSES = [
  'Claude Code',
  'Antigravity',
  'Gemini CLI',
  'Qwen Code',
  'Cursor',
  'Codex CLI',
  'OpenCode',
  'CodeBuddy',
  'Kiro',
  'Trae',
  'Junie',
  'Goose',
  'Amazon Q Developer CLI',
  'Roo Code',
  'OpenHands',
  'Aider',
  'Cline',
  'Warp',
  'Windsurf',
  'Amp',
  'VS Code Copilot',
  'Continue.dev',
  'Zed',
];

const EXPECTED_TIER1_TARGETS = ['egc', 'claude', 'cursor', 'antigravity', 'codex', 'gemini', 'qwen', 'opencode', 'codebuddy', 'windsurf', 'amp', 'copilot', 'zed', 'continue', 'kiro', 'trae', 'junie', 'goose', 'amazonq', 'roocode', 'openhands', 'aider', 'cline', 'warp'];
const EXPECTED_TIER2_INSTALLERS = ['.kiro/install.sh', '.trae/install.sh'];

function loadDoc() {
  assert.ok(fs.existsSync(DOC_PATH), `integration-tiers.md must exist at ${DOC_PATH}`);
  return fs.readFileSync(DOC_PATH, 'utf8');
}

function getSupportedHarnessCount() {
  const { SUPPORTED_INSTALL_TARGETS } = require(
    path.join(REPO_ROOT, 'scripts', 'lib', 'install-manifests.js'),
  );
  return SUPPORTED_INSTALL_TARGETS.filter(target => target !== 'egc').length;
}

function testDocListsAllHarnesses() {
  const doc = loadDoc();
  for (const harness of EXPECTED_HARNESSES) {
    assert.ok(
      doc.includes(harness),
      `integration-tiers.md must list harness "${harness}"`,
    );
  }

  // EXPECTED_HARNESSES is a hand-maintained list of *display names*, which
  // can't be derived automatically from SUPPORTED_INSTALL_TARGETS' slugs
  // (e.g. 'amazonq' -> 'Amazon Q Developer CLI') without another lookup
  // table to keep in sync. What CAN be checked automatically: its length
  // must match the real target count, so adding a harness to the registry
  // without adding it here fails loudly instead of this test silently
  // covering one fewer harness than actually exist. 'egc' itself isn't a
  // third-party harness name, so it's excluded from the count.
  const realHarnessCount = getSupportedHarnessCount();
  assert.strictEqual(
    EXPECTED_HARNESSES.length,
    realHarnessCount,
    `EXPECTED_HARNESSES has ${EXPECTED_HARNESSES.length} entries but SUPPORTED_INSTALL_TARGETS has ` +
    `${realHarnessCount} real harnesses (excluding 'egc') — a harness was added or removed without updating this test.`,
  );

  console.log(`  ✓ integration-tiers.md lists all ${EXPECTED_HARNESSES.length} harnesses (count verified against SUPPORTED_INSTALL_TARGETS)`);
}

function testPublicHarnessCountMatchesRegistry() {
  const realHarnessCount = getSupportedHarnessCount();
  const expectedPhrase = `${realHarnessCount} AI coding tools`;
  const sources = [
    ['README.md', fs.readFileSync(README_PATH, 'utf8')],
    ['package.json description', JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8')).description || ''],
    ['glama.json description', JSON.parse(fs.readFileSync(GLAMA_PATH, 'utf8')).description || ''],
    ['.github/copilot-instructions.md', fs.readFileSync(COPILOT_INSTRUCTIONS_PATH, 'utf8')],
  ];

  for (const [label, content] of sources) {
    const advertisedCounts = content.match(/\b\d+ AI coding tools\b/g) || [];
    assert.ok(advertisedCounts.length > 0, `${label} must advertise the supported AI coding tool count`);
    assert.deepStrictEqual(
      [...new Set(advertisedCounts)],
      [expectedPhrase],
      `${label} must advertise ${expectedPhrase}, found: ${advertisedCounts.join(', ')}`,
    );
  }

  console.log(`  ✓ public English metadata advertises ${realHarnessCount} AI coding tools`);
}

function testTier1TargetsMatchSupportedInstallTargets() {
  const { SUPPORTED_INSTALL_TARGETS } = require(
    path.join(REPO_ROOT, 'scripts', 'lib', 'install-manifests.js'),
  );
  const expectedSet = new Set(EXPECTED_TIER1_TARGETS);
  const actualSet = new Set(SUPPORTED_INSTALL_TARGETS);
  const missingInActual = [...expectedSet].filter(x => !actualSet.has(x));
  const extraInActual = [...actualSet].filter(x => !expectedSet.has(x));
  assert.deepStrictEqual(
    missingInActual,
    [],
    `Targets documented but missing in SUPPORTED_INSTALL_TARGETS: ${missingInActual.join(', ')}`,
  );
  assert.deepStrictEqual(
    extraInActual,
    [],
    `Targets in SUPPORTED_INSTALL_TARGETS but not in integration-tiers.md: ${extraInActual.join(', ')}. Update the doc.`,
  );
  console.log(`  ✓ SUPPORTED_INSTALL_TARGETS exactly matches Tier 1 list (${EXPECTED_TIER1_TARGETS.length} targets, bidirectional)`);
}

function testTier2InstallersExist() {
  const isWindows = process.platform === 'win32';
  for (const rel of EXPECTED_TIER2_INSTALLERS) {
    const full = path.join(REPO_ROOT, rel);
    assert.ok(fs.existsSync(full), `Tier 2 installer ${rel} must exist`);
    if (!isWindows) {
      assert.ok(fs.statSync(full).mode & 0o111, `Tier 2 installer ${rel} must be executable`);
    }
  }
  console.log(`  ✓ Tier 2 installers exist${isWindows ? '' : ' and are executable'}`);
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
  testDocListsAllHarnesses,
  testPublicHarnessCountMatchesRegistry,
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
