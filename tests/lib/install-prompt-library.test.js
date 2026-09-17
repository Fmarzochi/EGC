/**
 * Tests for scripts/lib/install/prompt-library.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  LEGACY_LIBRARY_SCRIPTS,
  detectPromptLibraryTargets,
  planPromptLibraryInstall,
  runPromptLibraryInstall,
} = require('../../scripts/lib/install/prompt-library');
const { listInstallTargetAdapters } = require('../../scripts/lib/install-targets/registry');

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

function makeHome(dirs) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-library-home-'));
  for (const dir of dirs) {
    fs.mkdirSync(path.join(homeDir, ...dir.split('/')), { recursive: true });
  }
  return homeDir;
}

function homeTargets() {
  return [...new Set(listInstallTargetAdapters().filter(adapter => adapter.kind === 'home').map(adapter => adapter.target))];
}

function runTests() {
  console.log('\n=== Testing install/prompt-library.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('detects a home target by its config directory or by its command', () => {
    const homeDir = makeHome(['.claude', '.codeium/windsurf']);
    try {
      const targets = detectPromptLibraryTargets({
        homeDir,
        commandExists: name => name === 'opencode',
      });
      assert.deepStrictEqual([...targets].sort(), ['claude', 'opencode', 'windsurf'], `detected ${targets.join(', ')}`);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('never lists a project-only target: the bare install runs from any directory', () => {
    const homeDir = makeHome(['.cursor', '.trae', '.claude']);
    try {
      const targets = detectPromptLibraryTargets({ homeDir, commandExists: () => true });
      const projectOnly = listInstallTargetAdapters()
        .filter(adapter => adapter.kind === 'project')
        .map(adapter => adapter.target)
        .filter(target => !homeTargets().includes(target));
      for (const target of projectOnly) {
        assert.ok(!targets.includes(target), `${target} is project-only and must not be installed from the bare path`);
      }
      assert.ok(targets.includes('claude'));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('with every command present, every home target is detected once', () => {
    const homeDir = makeHome([]);
    try {
      const targets = detectPromptLibraryTargets({ homeDir, commandExists: () => true });
      for (const target of homeTargets()) {
        assert.ok(targets.includes(target), `${target} has a home adapter and a command hint but was not detected`);
      }
      assert.strictEqual(new Set(targets).size, targets.length, 'targets must be unique');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('plans the legacy scripts for the tools that still have one, only when bash is available', () => {
    const homeDir = makeHome(['.trae-cn', '.kiro', '.codebuddy']);
    try {
      const withBash = planPromptLibraryInstall({ homeDir, commandExists: () => false, bashAvailable: true });
      assert.deepStrictEqual(withBash.legacyScripts.map(entry => entry.target).sort(), ['codebuddy', 'kiro', 'trae']);
      assert.deepStrictEqual(withBash.skippedLegacyScripts, []);
      for (const entry of withBash.legacyScripts) {
        assert.ok(LEGACY_LIBRARY_SCRIPTS.some(script => script.script === entry.script));
        assert.ok(fs.existsSync(path.join(REPO_ROOT, entry.script)), `${entry.script} must exist in the repository`);
      }

      const withoutBash = planPromptLibraryInstall({ homeDir, commandExists: () => false, bashAvailable: false });
      assert.deepStrictEqual(withoutBash.legacyScripts, []);
      assert.deepStrictEqual(withoutBash.skippedLegacyScripts.map(entry => entry.target).sort(), ['codebuddy', 'kiro', 'trae']);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('runs install-apply with the full profile for every detected target, then the legacy scripts', () => {
    const homeDir = makeHome(['.claude', '.amp', '.trae']);
    const calls = [];
    const logs = [];
    try {
      const result = runPromptLibraryInstall({
        repoRoot: REPO_ROOT,
        homeDir,
        commandExists: () => false,
        bashAvailable: true,
        spawn: (command, args) => {
          calls.push({ command, args });
          return { status: 0 };
        },
        log: line => logs.push(line),
      });

      const installApply = path.join(REPO_ROOT, 'scripts', 'install-apply.js');
      const applied = calls.filter(call => call.args[0] === installApply).map(call => call.args.slice(1));
      assert.deepStrictEqual(applied, [
        ['--target', 'claude', '--profile', 'full'],
        ['--target', 'amp', '--profile', 'full'],
      ]);
      const legacy = calls.filter(call => call.command === 'bash').map(call => call.args);
      assert.deepStrictEqual(legacy, [[path.join(REPO_ROOT, '.trae', 'install.sh'), homeDir]]);
      assert.deepStrictEqual(result.failed, []);
      assert.ok(logs.some(line => line.includes('Claude Code')), logs.join('\n'));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('reports the targets whose install failed instead of stopping at the first one', () => {
    const homeDir = makeHome(['.claude', '.amp']);
    try {
      const result = runPromptLibraryInstall({
        repoRoot: REPO_ROOT,
        homeDir,
        commandExists: () => false,
        bashAvailable: false,
        spawn: (command, args) => ({ status: args.includes('claude') ? 1 : 0 }),
        log: () => {},
      });
      assert.deepStrictEqual(result.installed, ['amp']);
      assert.deepStrictEqual(result.failed, ['claude']);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('says so when no tool is detected', () => {
    const homeDir = makeHome([]);
    const logs = [];
    try {
      const result = runPromptLibraryInstall({
        repoRoot: REPO_ROOT,
        homeDir,
        commandExists: () => false,
        bashAvailable: false,
        spawn: () => { throw new Error('nothing should run'); },
        log: line => logs.push(line),
      });
      assert.deepStrictEqual(result.installed, []);
      assert.ok(logs.some(line => /no supported tool/i.test(line)), logs.join('\n'));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
