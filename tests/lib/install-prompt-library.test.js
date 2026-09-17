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
  PROJECT_TARGETS_AT_HOME,
  detectPromptLibraryTargets,
  detectProjectTargetsAtHome,
  planPromptLibraryInstall,
  projectTargetEnv,
  runPromptLibraryInstall,
} = require('../../scripts/lib/install/prompt-library');
const { getInstallTargetAdapter, listInstallTargetAdapters } = require('../../scripts/lib/install-targets/registry');
const { CLI_TIMEOUT_MS, FULL_INSTALL_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

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

  if (test('Trae and CodeBuddy are detected for a home install by their directories (both Trae editions) or their commands, and by nothing else', () => {
    for (const [target, entry] of Object.entries(PROJECT_TARGETS_AT_HOME)) {
      assert.strictEqual(getInstallTargetAdapter(target).kind, 'project', `${target} is a project target installed at home`);
      for (const dir of entry.dirs) {
        const homeDir = makeHome([dir]);
        try {
          assert.deepStrictEqual(detectProjectTargetsAtHome({ homeDir, commandExists: () => false }), [target], `${dir} must detect ${target}`);
        } finally {
          fs.rmSync(homeDir, { recursive: true, force: true });
        }
      }
      const bare = makeHome([]);
      try {
        for (const command of entry.commands) {
          assert.deepStrictEqual(detectProjectTargetsAtHome({ homeDir: bare, commandExists: name => name === command }), [target]);
        }
        assert.deepStrictEqual(detectProjectTargetsAtHome({ homeDir: bare, commandExists: () => false }), []);
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    }
    assert.deepStrictEqual(Object.keys(PROJECT_TARGETS_AT_HOME).sort(), ['codebuddy', 'trae']);
  })) passed++; else failed++;

  if (test('a call without homeDir reads the real home instead of throwing', () => {
    const targets = detectPromptLibraryTargets({ commandExists: () => false });
    assert.ok(Array.isArray(targets));
    const plan = planPromptLibraryInstall({ commandExists: () => false });
    assert.ok(Array.isArray(plan.targets) && Array.isArray(plan.homeProjectTargets));
  })) passed++; else failed++;

  if (test('runs install-apply with the full profile for every detected target: home targets from the repository, Trae and CodeBuddy with the home as the working directory', () => {
    const homeDir = makeHome(['.claude', '.amp', '.trae-cn', '.codebuddy']);
    const calls = [];
    const logs = [];
    try {
      const result = runPromptLibraryInstall({
        repoRoot: REPO_ROOT,
        homeDir,
        commandExists: () => false,
        spawn: (command, args, options) => {
          calls.push({ command, args, options });
          return { status: 0 };
        },
        log: line => logs.push(line),
      });

      const installApply = path.join(REPO_ROOT, 'scripts', 'install-apply.js');
      assert.ok(calls.every(call => call.command === process.execPath && call.args[0] === installApply), `${JSON.stringify(calls)}`);
      assert.deepStrictEqual(calls.map(call => call.args.slice(1)), [
        ['--target', 'claude', '--profile', 'full'],
        ['--target', 'amp', '--profile', 'full'],
        ['--target', 'trae', '--profile', 'full'],
        ['--target', 'codebuddy', '--profile', 'full'],
      ]);
      assert.deepStrictEqual(calls.map(call => call.options.cwd), [REPO_ROOT, REPO_ROOT, homeDir, homeDir]);
      assert.ok(calls.every(call => call.options.env.HOME === homeDir && call.options.env.USERPROFILE === homeDir));
      assert.strictEqual(calls[2].options.env.TRAE_ENV, 'cn', 'only .trae-cn exists, so Trae installs into the Chinese edition');
      assert.strictEqual(calls[3].options.env.TRAE_ENV, process.env.TRAE_ENV, 'CodeBuddy inherits the environment untouched');
      assert.deepStrictEqual(result.installed, ['claude', 'amp', 'trae', 'codebuddy']);
      assert.deepStrictEqual(result.failed, []);
      assert.deepStrictEqual(result.homeProjectTargets, ['trae', 'codebuddy']);
      assert.ok(logs.some(line => line.includes('Claude Code')) && logs.some(line => line.includes('Trae')), logs.join('\n'));
      assert.ok(!calls.some(call => call.command === 'bash'), 'no shell script runs any more');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('the Chinese edition of Trae is chosen only when it is the sole edition present and the environment says nothing', () => {
    const previous = process.env.TRAE_ENV;
    try {
      delete process.env.TRAE_ENV;
      for (const [dirs, expected] of [[['.trae-cn'], { TRAE_ENV: 'cn' }], [['.trae'], {}], [['.trae', '.trae-cn'], {}]]) {
        const homeDir = makeHome(dirs);
        try {
          assert.deepStrictEqual(projectTargetEnv('trae', homeDir), expected, `${dirs.join('+')}`);
          assert.deepStrictEqual(projectTargetEnv('codebuddy', homeDir), {});
        } finally {
          fs.rmSync(homeDir, { recursive: true, force: true });
        }
      }
      process.env.TRAE_ENV = 'cn';
      const homeDir = makeHome(['.trae-cn']);
      try {
        assert.deepStrictEqual(projectTargetEnv('trae', homeDir), {}, 'an explicit TRAE_ENV is left alone');
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    } finally {
      if (previous === undefined) delete process.env.TRAE_ENV; else process.env.TRAE_ENV = previous;
    }
  })) passed++; else failed++;

  if (test('reports the targets whose install failed instead of stopping at the first one', () => {
    const homeDir = makeHome(['.claude', '.amp', '.trae']);
    try {
      const result = runPromptLibraryInstall({
        repoRoot: REPO_ROOT,
        homeDir,
        commandExists: () => false,
        spawn: (command, args) => ({ status: args.includes('claude') || args.includes('trae') ? 1 : 0 }),
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
        spawn: () => { throw new Error('nothing should run'); },
        log: line => logs.push(line),
      });
      assert.deepStrictEqual(result.installed, []);
      assert.deepStrictEqual(result.homeProjectTargets, []);
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
        timeout: CLI_TIMEOUT_MS,
      });
      assert.ok(/no supported tool/i.test(output), output);

      // A detected tool whose install fails: the Windsurf root is a file, so
      // it is detected but nothing can be written under it.
      fs.mkdirSync(path.join(homeDir, '.codeium'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, '.codeium', 'windsurf'), 'not a directory');
      const failing = spawnSync(process.execPath, [cli], {
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: homeDir },
        encoding: 'utf8',
        timeout: FULL_INSTALL_TIMEOUT_MS,
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
