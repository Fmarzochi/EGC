/**
 * Validates docs/spec/integration-tiers.md matches reality:
 *   - All harnesses are listed, and the list's length matches SUPPORTED_INSTALL_TARGETS
 *   - Public English metadata advertises the same harness count
 *   - Every Tier 1 target named in the doc is in SUPPORTED_INSTALL_TARGETS
 *   - No tool directory at the repository root carries a per-tool install script (Tier 2 is retired)
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

// Gemini CLI, Continue.dev, and Roo Code were retired on 2026-08-16 (shut
// down, shut down, and archived upstream respectively): they left this list
// together with SUPPORTED_INSTALL_TARGETS and the doc's table.
const EXPECTED_HARNESSES = [
  'Claude Code',
  'Antigravity',
  'Qwen Code',
  'Cursor',
  'Codex CLI',
  'OpenCode',
  'CodeBuddy',
  'Kiro',
  'Trae',
  'Junie',
  'Goose',
  'OpenHands',
  'Aider',
  'Cline',
  'Warp',
  'Devin Desktop',
  'Amp',
  'VS Code Copilot',
  'Zed',
  'Kimi Code CLI',
];

const EXPECTED_TIER1_TARGETS = ['egc', 'claude', 'cursor', 'antigravity', 'codex', 'qwen', 'opencode', 'codebuddy', 'windsurf', 'amp', 'copilot', 'zed', 'kiro', 'trae', 'junie', 'goose', 'openhands', 'aider', 'cline', 'warp', 'kimi'];

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
    // The spec doc itself advertises the count in prose (intro and the
    // guarantees section), which the 2026-08-16 retirement round proved can
    // drift silently when only the table is updated.
    ['docs/spec/integration-tiers.md', loadDoc()],
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

// The per-tool install scripts (.kiro/install.sh, .trae/install.sh and the
// CodeBuddy pair) were retired: every asset ships through a Tier 1 adapter.
// Every tool directory at the repository root is checked, so a script under
// a new name or extension cannot bring the path back unnoticed.
function testTier2InstallersRetired() {
  const scriptName = /^(un)?install\.(sh|bash|zsh|js|mjs|cjs|ps1|cmd|bat|py)$/i;
  const toolDirs = fs.readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('.') && entry.name !== '.git')
    .map(entry => entry.name);
  for (const required of ['.kiro', '.trae', '.codebuddy']) {
    assert.ok(toolDirs.includes(required), `${required} is a tool directory of the repository`);
  }
  const found = toolDirs.flatMap(dir => fs.readdirSync(path.join(REPO_ROOT, dir))
    .filter(name => scriptName.test(name))
    .map(name => `${dir}/${name}`));
  assert.deepStrictEqual(found, [], `per-tool install scripts were retired and must not come back: ${found.join(', ')}`);
  console.log(`  ✓ no per-tool install script under ${toolDirs.length} tool directories`);
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

// Junie reads AGENTS.md now; .junie/guidelines.md is its legacy format (#1655).
function testJunieRowDocumentsAgentsMd() {
  // A Windows checkout can carry CRLF, which would hide the trailing `|`.
  const lines = loadDoc().split(/\r?\n/);
  const row = lines.find(line => line.includes('**JetBrains Junie**'));
  assert.ok(row, 'the harness table must have a JetBrains Junie row');
  // The column comes from the header, so a new column cannot shift the check.
  const header = lines.slice(0, lines.indexOf(row)).reverse().find(line => /^\|.*\bInstall path\b.*\|$/.test(line));
  assert.ok(header, 'the harness table must have an Install path column');
  const pathColumn = header.split('|').map(cell => cell.trim()).indexOf('Install path');
  const pathCell = row.split('|')[pathColumn] || '';
  assert.ok(pathCell.trim(), 'the Junie row must fill the Install path column');
  assert.ok(!pathCell.includes('guidelines.md'), 'the Junie path must not be the legacy .junie/guidelines.md');
  for (const file of ['`.junie/AGENTS.md`', '`~/.junie/AGENTS.md`', '`.junie/guidelines.md`', '`.junie/guidelines/`']) {
    assert.ok(row.includes(file), `the Junie row must name ${file}`);
  }
  // The project files are alternatives: Junie uses the first that exists.
  assert.ok(/first of these that exists/.test(row), 'the Junie row must say the project files are alternatives');
  // Matched as a whole Markdown link, not as a URL substring.
  assert.ok(
    /\[[^\]]+\]\(https:\/\/junie\.jetbrains\.com\/docs\/guidelines-and-memory\.html\)/.test(row),
    'the Junie row must link the official page'
  );
  const targetsDir = path.join(REPO_ROOT, 'scripts', 'lib', 'install-targets');
  const writers = fs.readdirSync(targetsDir)
    .filter(name => name.endsWith('.js'))
    .filter(name => fs.readFileSync(path.join(targetsDir, name), 'utf8').includes('guidelines.md'));
  assert.deepStrictEqual(writers, [], `no install target may write the legacy guidelines.md: ${writers.join(', ')}`);
  console.log('  ✓ Junie row documents AGENTS.md and no target writes guidelines.md');
}

console.log('=== Testing docs/spec/integration-tiers.md ===\n');

let passed = 0;
let failed = 0;
for (const test of [
  testDocListsAllHarnesses,
  testPublicHarnessCountMatchesRegistry,
  testTier1TargetsMatchSupportedInstallTargets,
  testTier2InstallersRetired,
  testClaudeCodeProtocolInjectionExists,
  testJunieRowDocumentsAgentsMd,
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
