/**
 * The prompt-library contract of the full profile: what every install target
 * receives, counted against the catalog the README advertises.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SUPPORTED_INSTALL_TARGETS, listInstallModules, resolveInstallPlan } = require('../../scripts/lib/install-manifests');
const { createManifestInstallPlan } = require('../../scripts/lib/install-executor');
const { buildCatalog } = require('../../scripts/ci/catalog');

const REPO_ROOT = path.join(__dirname, '..', '..');

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

function normalize(value) {
  return String(value || '').replaceAll('\\', '/');
}

// Every target receives the whole catalog unless a row below says otherwise:
// two targets read only the memory rule by design, and Claude Code leaves
// the Chinese mirror of the common rules out.
const EXCEPTIONS = {
  claude: {
    // Claude Code loads every unscoped rule into every session. rules/zh
    // mirrors rules/common in Chinese and would double that cost, so it
    // stays out of ~/.claude/rules.
    rules: catalog => catalog.rules.files.filter(file => !normalize(file).startsWith('rules/zh/')).length,
  },
  aider: {
    agents: () => 0, // Aider has no agent or command discovery
    commands: () => 0,
    rules: () => 1, // only rules/common/memory.md, merged into the read list
  },
  warp: {
    agents: () => 0, // Warp reads AGENTS.md; skills go through its index
    commands: () => 0,
    rules: () => 1,
  },
};

function expectedFor(target, family, catalog) {
  const override = EXCEPTIONS[target] && EXCEPTIONS[target][family];
  return override ? override(catalog) : catalog[family].count;
}

function stemOf(filePath) {
  return path.posix.basename(filePath).replace(/\.(md|mdc)$/i, '');
}

function parentOf(filePath) {
  return path.posix.basename(path.posix.dirname(filePath));
}

// Where each target keeps its agent and command files: agents/ and
// commands/ everywhere, except that Antigravity reads agents from its flat
// skills folder and commands from workflows/. Cursor prefixes the agent
// file name with egc-.
const AGENT_DIRS = { default: ['agents'], antigravity: ['skills'] };
const COMMAND_DIRS = { default: ['commands', 'command'], antigravity: ['workflows'] };

// What lands in the tool, indexed the way each family is discovered: an
// agent or command by its file name, a skill by its directory (or its flat
// file on Warp), a rule by its flattened name or by its namespace folder
// under a rules directory. Sources are not compared: Cursor, Codex and
// OpenCode take part of the library from the repository's own platform
// copies, which win the destination dedupe over the catalog files.
function plannedDestinations(target, homeDir, projectRoot) {
  const plan = createManifestInstallPlan({
    sourceRoot: REPO_ROOT,
    projectRoot,
    homeDir,
    target,
    profileId: 'full',
  });
  const index = { agents: new Set(), commands: new Set(), skills: new Set(), rules: new Set() };
  const agentDirs = AGENT_DIRS[target] || AGENT_DIRS.default;
  const commandDirs = COMMAND_DIRS[target] || COMMAND_DIRS.default;
  for (const operation of plan.operations) {
    if (typeof operation.destinationPath !== 'string') continue;
    const destination = normalize(operation.destinationPath);
    const parent = parentOf(destination);
    const stem = stemOf(destination);
    if (agentDirs.includes(parent)) index.agents.add(stem.replace(/^egc-/, ''));
    if (commandDirs.includes(parent)) index.commands.add(stem);
    if (path.posix.basename(destination) === 'SKILL.md') index.skills.add(parent);
    if (parent === 'skills') index.skills.add(stem);
    if (destination.includes('/rules/') || destination.includes('/.clinerules/')) {
      index.rules.add(stem);
      index.rules.add(`${parent}/${stem}`);
    }
  }
  return { plan, index };
}

function countDelivered(index, catalog) {
  return {
    agents: catalog.agents.files.filter(file => index.agents.has(stemOf(file))).length,
    skills: catalog.skills.files.filter(file => index.skills.has(parentOf(normalize(file)))).length,
    commands: catalog.commands.files.filter(file => index.commands.has(stemOf(file))).length,
    rules: catalog.rules.files.filter(file => {
      const namespace = normalize(file).split('/')[1];
      const stem = stemOf(file);
      return index.rules.has(`${namespace}-${stem}`) || index.rules.has(`${namespace}/${stem}`);
    }).length,
  };
}

function runTests() {
  console.log('\n=== Testing the full-profile library contract ===\n');

  let passed = 0;
  let failed = 0;

  const catalog = buildCatalog(REPO_ROOT);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-library-home-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-library-project-'));

  try {
    if (test('the catalog has every family the README counts', () => {
      assert.ok(catalog.agents.count > 0 && catalog.skills.count > 0 && catalog.commands.count > 0 && catalog.rules.count > 0);
    })) passed++; else failed++;

    for (const target of SUPPORTED_INSTALL_TARGETS) {
      if (test(`full profile on ${target} delivers the library the README promises`, () => {
        const { plan, index } = plannedDestinations(target, homeDir, projectRoot);
        const delivered = countDelivered(index, catalog);
        for (const family of ['agents', 'skills', 'commands', 'rules']) {
          const expected = expectedFor(target, family, catalog);
          assert.strictEqual(
            delivered[family],
            expected,
            `${target} receives ${delivered[family]} ${family}, expected ${expected} (skipped modules: ${plan.statePreview.resolution.skippedModules.join(', ') || 'none'})`
          );
        }
      })) passed++; else failed++;
    }

    if (test('no target records the full profile as an empty selection', () => {
      for (const target of SUPPORTED_INSTALL_TARGETS) {
        const { plan } = plannedDestinations(target, homeDir, projectRoot);
        assert.ok(
          plan.statePreview.resolution.selectedModules.length > 0,
          `${target} selected no module for the full profile`
        );
      }
    })) passed++; else failed++;

    if (test('every module resolves on every target it names', () => {
      for (const module of listInstallModules()) {
        for (const target of module.targets) {
          const plan = resolveInstallPlan({ moduleIds: [module.id], target, homeDir, projectRoot });
          assert.ok(
            plan.selectedModuleIds.includes(module.id) && !plan.skippedModuleIds.includes(module.id),
            `${module.id} names ${target} but resolving it there skips it (dependencies: ${(module.dependencies || []).join(', ') || 'none'})`
          );
        }
      }
    })) passed++; else failed++;

    if (test('targets that share the ~/.agents root plan one source per destination (Codex, Goose, OpenHands)', () => {
      const plans = {};
      for (const target of ['codex', 'goose', 'openhands']) {
        const plan = createManifestInstallPlan({ sourceRoot: REPO_ROOT, projectRoot, homeDir, target, profileId: 'full' });
        plans[target] = new Map(plan.operations
          .filter(operation => operation.kind === 'copy-file')
          .map(operation => [path.normalize(operation.destinationPath), operation.sourceRelativePath.replaceAll('\\', '/')]));
      }
      const conflicts = [];
      for (const [a, b] of [['codex', 'goose'], ['codex', 'openhands'], ['goose', 'openhands']]) {
        for (const [destination, source] of plans[a]) {
          const other = plans[b].get(destination);
          if (other !== undefined && other !== source) {
            conflicts.push(`${path.relative(homeDir, destination)}: ${a}=${source} ${b}=${other}`);
          }
        }
      }
      assert.deepStrictEqual(conflicts, [], `the last install would overwrite what the others recorded:\n${conflicts.slice(0, 5).join('\n')}`);
    })) passed++; else failed++;

    if (test('the .agents/skills mirror of the repository never ships: skills come from the catalog on every target', () => {
      const shipped = [];
      for (const target of SUPPORTED_INSTALL_TARGETS) {
        const plan = createManifestInstallPlan({ sourceRoot: REPO_ROOT, projectRoot, homeDir, target, profileId: 'full' });
        for (const operation of plan.operations) {
          if (operation.kind === 'copy-file' && /^\.agents\/skills\//.test(operation.sourceRelativePath.replaceAll('\\', '/'))) {
            shipped.push(`${target}: ${operation.sourceRelativePath}`);
          }
        }
      }
      assert.deepStrictEqual(shipped, [], `stale mirror files planned:\n${shipped.slice(0, 5).join('\n')}`);
    })) passed++; else failed++;
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
