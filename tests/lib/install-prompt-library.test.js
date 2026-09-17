/**
 * Tests for scripts/lib/install/prompt-library.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  HOME_TARGET_COMMANDS,
  HOME_TARGET_DIRS,
  LEGACY_LIBRARY_SCRIPTS,
  detectPromptLibraryTargets,
  planPromptLibraryInstall,
  runPromptLibraryInstall,
} = require('../../scripts/lib/install/prompt-library');
const { getInstallTargetAdapter, listInstallTargetAdapters } = require('../../scripts/lib/install-targets/registry');

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

function defaultHomeTargets() {
  return [...new Set(listInstallTargetAdapters().map(adapter => adapter.target))]
    .filter(target => getInstallTargetAdapter(target).kind === 'home');
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

  if (test('never lists a target whose default adapter installs into a project: the bare install runs from any directory', () => {
    const homeDir = makeHome(['.cursor', '.trae', '.claude', '.amazonq/rules', '.aws/amazonq']);
    try {
      const targets = detectPromptLibraryTargets({ homeDir, commandExists: () => true });
      for (const target of targets) {
        assert.strictEqual(getInstallTargetAdapter(target).kind, 'home', `${target} resolves to a project adapter by default and must stay out`);
      }
      for (const projectFirst of ['cursor', 'trae', 'amazonq', 'antigravity', 'codebuddy', 'qwen', 'cline', 'aider', 'warp']) {
        assert.ok(!targets.includes(projectFirst), `${projectFirst} must not be installed from the bare path`);
      }
      assert.ok(targets.includes('claude'));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('each home target is detected by its own command and by nothing else', () => {
    const homeDir = makeHome([]);
    try {
      for (const target of defaultHomeTargets()) {
        const commands = HOME_TARGET_COMMANDS[target];
        assert.ok(Array.isArray(commands) && commands.length > 0, `${target} needs a command hint`);
        for (const command of commands) {
          const targets = detectPromptLibraryTargets({ homeDir, commandExists: name => name === command });
          assert.deepStrictEqual(targets, [target], `command ${command} detected ${targets.join(', ')}`);
        }
      }
      assert.deepStrictEqual(detectPromptLibraryTargets({ homeDir, commandExists: () => false }), []);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('a shared ~/.agents root does not detect Codex, Goose and OpenHands together', () => {
    const cases = [['.agents', []], ['.codex', ['codex']], ['.config/goose', ['goose']], ['.openhands', ['openhands']]];
    for (const [dir, expected] of cases) {
      const homeDir = makeHome([dir]);
      try {
        const targets = detectPromptLibraryTargets({ homeDir, commandExists: () => false });
        assert.deepStrictEqual(targets, expected, `${dir} detected ${targets.join(', ')}`);
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    }
    for (const target of Object.keys(HOME_TARGET_DIRS)) {
      assert.strictEqual(getInstallTargetAdapter(target).resolveRoot({ homeDir: '/h' }), path.join('/h', '.agents'), `${target} shares the .agents root`);
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

  if (test('runs install-apply with the full profile for every detected target, then the legacy scripts, and counts both as installed', () => {
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
      assert.deepStrictEqual(result.installed, ['claude', 'amp', 'trae']);
      assert.deepStrictEqual(result.failed, []);
      assert.ok(logs.some(line => line.includes('Claude Code')), logs.join('\n'));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('reports the targets whose install failed instead of stopping at the first one', () => {
    const homeDir = makeHome(['.claude', '.amp', '.trae']);
    try {
      const result = runPromptLibraryInstall({
        repoRoot: REPO_ROOT,
        homeDir,
        commandExists: () => false,
        bashAvailable: true,
        spawn: (command, args) => ({ status: args.includes('claude') || command === 'bash' ? 1 : 0 }),
        log: () => {},
      });
      assert.deepStrictEqual(result.installed, ['amp']);
      assert.deepStrictEqual(result.failed, ['claude', 'trae']);
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

  if (test('the CLI says so and exits 0 when no tool is detected, and exits 1 when a target fails', () => {
    const { execFileSync, spawnSync } = require('child_process');
    const cli = path.join(REPO_ROOT, 'scripts', 'install-prompt-library.js');
    const homeDir = makeHome([]);
    try {
      const output = execFileSync(process.execPath, [cli], {
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: homeDir },
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.ok(/no supported tool/i.test(output), output);

      // A detected tool whose install fails: the Windsurf root is a file, so
      // it is detected but nothing can be written under it.
      fs.mkdirSync(path.join(homeDir, '.codeium'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, '.codeium', 'windsurf'), 'not a directory');
      const failing = spawnSync(process.execPath, [cli], {
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: homeDir },
        encoding: 'utf8',
      });
      assert.notStrictEqual(failing.status, 0, `${failing.stdout}\n${failing.stderr}`);
      assert.ok(/not installed to: windsurf/.test(failing.stderr), failing.stderr);
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
