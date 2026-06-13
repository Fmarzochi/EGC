/**
 * Tests for scripts/install-apply.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { applyInstallPlan } = require('../../scripts/lib/install/apply');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'install-apply.js');
const DEFAULT_INSTALL_APPLY_TIMEOUT_MS = process.platform === 'win32' ? 30000 : 10000;

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function run(args = [], options = {}) {
  const homeDir = options.homeDir || process.env.HOME;
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    ...(options.env || {}),
  };

  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      cwd: options.cwd,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.timeout || DEFAULT_INSTALL_APPLY_TIMEOUT_MS,
    });

    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status || 1,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || '',
    };
  }
}

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
  console.log('\n=== Testing install-apply.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('shows help with --help', () => {
    const result = run(['--help']);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Usage:'));
    assert.ok(result.stdout.includes('--dry-run'));
    assert.ok(result.stdout.includes('--profile <name>'));
    assert.ok(result.stdout.includes('--modules <id,id,...>'));
  })) passed++; else failed++;

  if (test('rejects mixing legacy languages with manifest profile flags', () => {
    const result = run(['--profile', 'core', 'typescript']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('cannot be combined'));
  })) passed++; else failed++;

  if (test('installs Gemini rules and writes install-state', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['typescript'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const geminiRoot = path.join(homeDir, '.gemini');
      assert.ok(fs.existsSync(path.join(geminiRoot, 'rules', 'egc', 'common', 'coding-style.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'rules', 'egc', 'typescript', 'testing.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'commands', 'plan.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'scripts', 'hooks', 'session-end.js')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'scripts', 'lib', 'utils.js')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'skills', 'egc', 'tdd-workflow', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'skills', 'egc', 'coding-standards', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'plugin.json')));

      const statePath = path.join(homeDir, '.gemini', 'egc', 'install-state.json');
      const state = readJson(statePath);
      assert.strictEqual(state.target.id, 'egc-home');
      assert.deepStrictEqual(state.request.legacyLanguages, ['typescript']);
      assert.strictEqual(state.request.legacyMode, true);
      assert.deepStrictEqual(state.request.modules, []);
      assert.ok(state.resolution.selectedModules.includes('rules-core'));
      assert.ok(state.resolution.selectedModules.includes('framework-language'));
      assert.ok(
        state.operations.some(operation => (
          operation.destinationPath === path.join(geminiRoot, 'rules', 'egc', 'common', 'coding-style.md')
        )),
        'Should record common rule file operation'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('installs Cursor configs and writes install-state', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--target', 'cursor', 'typescript'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'rules', 'common-coding-style.mdc')));
      assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'rules', 'typescript-testing.mdc')));
      assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'rules', 'common-agents.mdc')));
      assert.ok(!fs.existsSync(path.join(projectDir, '.cursor', 'rules', 'common-agents.md')));
      assert.ok(!fs.existsSync(path.join(projectDir, '.cursor', 'rules', 'README.mdc')));
      assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'agents', 'egc-architect.md')));
      assert.ok(!fs.existsSync(path.join(projectDir, '.cursor', 'agents', 'architect.md')));
      assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'commands', 'plan.md')));
      assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'hooks.json')));
      assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'mcp.json')));
      assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'hooks', 'session-start.js')));
      assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'scripts', 'lib', 'utils.js')));
      assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'skills', 'testing', 'tdd-workflow', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'skills', 'general', 'coding-standards', 'SKILL.md')));

      const hooksConfig = readJson(path.join(projectDir, '.cursor', 'hooks.json'));
      const mcpConfig = readJson(path.join(projectDir, '.cursor', 'mcp.json'));
      assert.strictEqual(hooksConfig.version, 1);
      assert.ok(hooksConfig.hooks.sessionStart, 'Should keep Cursor sessionStart hooks');
      assert.ok(mcpConfig.mcpServers.github, 'Should install shared MCP servers into Cursor');
      assert.ok(mcpConfig.mcpServers.context7, 'Should include bundled documentation MCPs');

      const statePath = path.join(projectDir, '.cursor', 'egc-install-state.json');
      const state = readJson(statePath);
      const normalizedProjectDir = fs.realpathSync(projectDir);
      assert.strictEqual(state.target.id, 'cursor-project');
      assert.strictEqual(state.target.root, path.join(normalizedProjectDir, '.cursor'));
      assert.deepStrictEqual(state.request.legacyLanguages, ['typescript']);
      assert.strictEqual(state.request.legacyMode, true);
      assert.ok(state.resolution.selectedModules.includes('framework-language'));
      assert.ok(
        state.operations.some(operation => (
          operation.destinationPath === path.join(normalizedProjectDir, '.cursor', 'commands', 'plan.md')
        )),
        'Should record manifest command file copy operation'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('installs Cursor MCP config by merging bundled servers into an existing mcp.json', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const cursorRoot = path.join(projectDir, '.cursor');
      fs.mkdirSync(cursorRoot, { recursive: true });
      fs.writeFileSync(path.join(cursorRoot, 'mcp.json'), JSON.stringify({
        mcpServers: {
          custom: {
            command: 'node',
            args: ['custom-mcp.js'],
          },
        },
      }, null, 2));

      const result = run(['--target', 'cursor', 'typescript'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const mcpConfig = readJson(path.join(projectDir, '.cursor', 'mcp.json'));
      assert.ok(mcpConfig.mcpServers.custom, 'Should preserve existing custom Cursor MCP servers');
      assert.ok(mcpConfig.mcpServers.github, 'Should merge bundled GitHub MCP server');
      assert.ok(mcpConfig.mcpServers.playwright, 'Should merge bundled Playwright MCP server');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('installs Antigravity configs and writes install-state', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--target', 'antigravity', 'typescript'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'rules', 'common-coding-style.md')));
      assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'rules', 'typescript-testing.md')));
      assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'workflows', 'plan.md')));
      assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'skills', 'architect.md')));

      const statePath = path.join(projectDir, '.agents', 'egc-install-state.json');
      const state = readJson(statePath);
      assert.strictEqual(state.target.id, 'antigravity-project');
      assert.deepStrictEqual(state.request.legacyLanguages, ['typescript']);
      assert.strictEqual(state.request.legacyMode, true);
      assert.deepStrictEqual(state.resolution.selectedModules, ['rules-core', 'agents-core', 'commands-core']);
      assert.ok(
        state.operations.some(operation => (
          operation.destinationPath.endsWith(path.join('.agents', 'workflows', 'plan.md'))
        )),
        'Should record manifest command file copy operation'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('supports dry-run without mutating the target project', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--target', 'cursor', '--dry-run', 'typescript'], {
        cwd: projectDir,
        homeDir,
      });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('Dry-run install plan'));
      assert.ok(result.stdout.includes('Mode: legacy-compat'));
      assert.ok(result.stdout.includes('Legacy languages: typescript'));
      assert.ok(!fs.existsSync(path.join(projectDir, '.cursor', 'hooks.json')));
      assert.ok(!fs.existsSync(path.join(projectDir, '.cursor', 'egc-install-state.json')));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('supports manifest profile dry-runs through the installer', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--profile', 'core', '--dry-run'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('Mode: manifest'));
      assert.ok(result.stdout.includes('Profile: core'));
      assert.ok(result.stdout.includes('Included components: (none)'));
      assert.ok(result.stdout.includes('Selected modules: rules-core, agents-core, commands-core, hooks-runtime, platform-configs, workflow-quality'));
      assert.ok(!fs.existsSync(path.join(homeDir, '.gemini', 'egc', 'install-state.json')));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('supports minimal profile dry-runs without hooks through the installer', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--profile', 'minimal', '--dry-run'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('Mode: manifest'));
      assert.ok(result.stdout.includes('Profile: minimal'));
      assert.ok(result.stdout.includes('Selected modules: rules-core, agents-core, commands-core, platform-configs, workflow-quality'));
      assert.ok(!result.stdout.includes('hooks-runtime'));
      assert.ok(!fs.existsSync(path.join(homeDir, '.gemini', 'egc', 'install-state.json')));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('installs manifest profiles and writes non-legacy install-state', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const geminiRoot = path.join(homeDir, '.gemini');
      assert.ok(fs.existsSync(path.join(geminiRoot, 'rules', 'egc', 'common', 'coding-style.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'agents', 'architect.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'commands', 'plan.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'hooks', 'hooks.json')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'scripts', 'hooks', 'session-end.js')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'scripts', 'lib', 'session-manager.js')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'plugin.json')));

      const state = readJson(path.join(geminiRoot, 'egc', 'install-state.json'));
      assert.strictEqual(state.request.profile, 'core');
      assert.strictEqual(state.request.legacyMode, false);
      assert.deepStrictEqual(state.request.legacyLanguages, []);
      assert.ok(state.resolution.selectedModules.includes('platform-configs'));
      assert.ok(
        state.operations.some(operation => (
          operation.destinationPath === path.join(geminiRoot, 'commands', 'plan.md')
        )),
        'Should record manifest-driven command file copy'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('installs the Claude Code SessionStart state hook and records install-state', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--target', 'claude', '--modules', 'workflow-quality'], {
        cwd: projectDir,
        homeDir,
      });
      assert.strictEqual(result.code, 0, result.stderr);

      const claudeRoot = path.join(homeDir, '.claude');
      const hookScriptPath = path.join(claudeRoot, 'egc', 'hooks', 'claude-session-start.js');
      assert.ok(fs.existsSync(hookScriptPath), 'Should copy the session-start hook script');

      const settings = readJson(path.join(claudeRoot, 'settings.json'));
      const sessionStartGroups = settings.hooks.SessionStart;
      assert.strictEqual(sessionStartGroups.length, 1);
      assert.ok(
        sessionStartGroups[0].hooks[0].command.includes(hookScriptPath),
        'SessionStart hook should invoke the installed EGC script'
      );

      const state = readJson(path.join(claudeRoot, 'egc', 'install-state.json'));
      assert.ok(
        state.operations.some(operation => (
          operation.kind === 'merge-claude-settings-hooks'
          && operation.destinationPath === path.join(claudeRoot, 'settings.json')
          && operation.hookScriptPath === hookScriptPath
        )),
        'Should record the settings.json hook merge in install-state'
      );
      assert.ok(
        state.operations.some(operation => (
          operation.kind === 'copy-file'
          && operation.destinationPath === hookScriptPath
        )),
        'Should record the hook script copy in install-state'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('claude reinstall is idempotent and preserves third-party settings.json content', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const claudeRoot = path.join(homeDir, '.claude');
      const settingsPath = path.join(claudeRoot, 'settings.json');
      fs.mkdirSync(claudeRoot, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        model: 'opus',
        hooks: {
          SessionStart: [
            { matcher: 'startup', hooks: [{ type: 'command', command: 'echo third-party' }] },
          ],
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] },
          ],
        },
      }, null, 2));

      const first = run(['--target', 'claude', '--modules', 'workflow-quality'], {
        cwd: projectDir,
        homeDir,
      });
      assert.strictEqual(first.code, 0, first.stderr);
      const second = run(['--target', 'claude', '--modules', 'workflow-quality'], {
        cwd: projectDir,
        homeDir,
      });
      assert.strictEqual(second.code, 0, second.stderr);

      const settings = readJson(settingsPath);
      assert.strictEqual(settings.model, 'opus');
      assert.strictEqual(settings.hooks.PreToolUse.length, 1);

      const sessionStartGroups = settings.hooks.SessionStart;
      assert.strictEqual(sessionStartGroups.length, 2, 'Reinstall must not duplicate the EGC hook');
      assert.strictEqual(sessionStartGroups[0].hooks[0].command, 'echo third-party');
      assert.ok(
        sessionStartGroups[1].hooks[0].command.includes(
          path.join(claudeRoot, 'egc', 'hooks', 'claude-session-start.js')
        )
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('preserves existing top-level Gemini rules and skills during managed install', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const geminiRoot = path.join(homeDir, '.gemini');
      const userRulePath = path.join(geminiRoot, 'rules', 'common', 'coding-style.md');
      const userSkillPath = path.join(geminiRoot, 'skills', 'testing', 'tdd-workflow', 'SKILL.md');
      fs.mkdirSync(path.dirname(userRulePath), { recursive: true });
      fs.mkdirSync(path.dirname(userSkillPath), { recursive: true });
      fs.writeFileSync(userRulePath, '# User custom rule\n');
      fs.writeFileSync(userSkillPath, '# User custom skill\n');

      const result = run(['--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      assert.strictEqual(fs.readFileSync(userRulePath, 'utf8'), '# User custom rule\n');
      assert.strictEqual(fs.readFileSync(userSkillPath, 'utf8'), '# User custom skill\n');
      assert.ok(fs.existsSync(path.join(geminiRoot, 'rules', 'egc', 'common', 'coding-style.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'skills', 'egc', 'tdd-workflow', 'SKILL.md')));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('installs antigravity manifest profiles while skipping only unsupported modules', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--target', 'antigravity', '--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'rules', 'common-coding-style.md')));
      assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'skills', 'architect.md')));
      assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'workflows', 'plan.md')));
      assert.ok(fs.existsSync(path.join(projectDir, '.agents', 'skills', 'tdd-workflow', 'SKILL.md')));

      const state = readJson(path.join(projectDir, '.agents', 'egc-install-state.json'));
      assert.strictEqual(state.request.profile, 'core');
      assert.strictEqual(state.request.legacyMode, false);
      assert.deepStrictEqual(
        state.resolution.selectedModules,
        ['rules-core', 'agents-core', 'commands-core', 'platform-configs', 'workflow-quality']
      );
      assert.ok(state.resolution.skippedModules.includes('hooks-runtime'));
      assert.ok(!state.resolution.skippedModules.includes('workflow-quality'));
      assert.ok(!state.resolution.skippedModules.includes('platform-configs'));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('installs explicit modules for cursor using manifest operations', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--target', 'cursor', '--modules', 'platform-configs'], {
        cwd: projectDir,
        homeDir,
      });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'hooks.json')));
      assert.ok(fs.existsSync(path.join(projectDir, '.cursor', 'rules', 'common-agents.mdc')));
      assert.ok(!fs.existsSync(path.join(projectDir, '.cursor', 'rules', 'common-agents.md')));

      const state = readJson(path.join(projectDir, '.cursor', 'egc-install-state.json'));
      assert.strictEqual(state.request.profile, null);
      assert.deepStrictEqual(state.request.modules, ['platform-configs']);
      assert.deepStrictEqual(state.request.includeComponents, []);
      assert.deepStrictEqual(state.request.excludeComponents, []);
      assert.strictEqual(state.request.legacyMode, false);
      assert.ok(state.resolution.selectedModules.includes('platform-configs'));
      assert.ok(
        !state.operations.some(operation => operation.destinationPath.endsWith('egc-install-state.json')),
        'Manifest copy operations should not include generated install-state files'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('rejects unknown explicit manifest modules before resolution', () => {
    const result = run(['--modules', 'ghost-module']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('Unknown install module: ghost-module'));
  })) passed++; else failed++;

  if (test('installs egc hooks without generating settings.json', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const geminiRoot = path.join(homeDir, '.gemini');
      assert.ok(fs.existsSync(path.join(geminiRoot, 'hooks', 'hooks.json')), 'hooks.json should be copied');
      assert.ok(!fs.existsSync(path.join(geminiRoot, 'settings.json')), 'settings.json should not be created just to install managed hooks');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('installs egc hooks with the safe plugin bootstrap contract', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const geminiRoot = path.join(homeDir, '.gemini');
      const installedHooks = readJson(path.join(geminiRoot, 'hooks', 'hooks.json'));

      const installedBashDispatcherEntry = installedHooks.hooks.PreToolUse.find(entry => entry.id === 'pre:bash:dispatcher');
      assert.ok(installedBashDispatcherEntry, 'hooks/hooks.json should include the consolidated Bash dispatcher hook');
      assert.strictEqual(typeof installedBashDispatcherEntry.hooks[0].command, 'string', 'hooks/hooks.json should install string-form commands for Gemini Code schema compatibility');
      assert.ok(
        installedBashDispatcherEntry.hooks[0].command.startsWith('node -e '),
        'hooks/hooks.json should use the inline node bootstrap contract'
      );
      assert.ok(
        installedBashDispatcherEntry.hooks[0].command.includes('plugin-hook-bootstrap.js'),
        'hooks/hooks.json should route plugin-managed hooks through the shared bootstrap'
      );
      assert.ok(
        installedBashDispatcherEntry.hooks[0].command.includes('GEMINI_PLUGIN_ROOT'),
        'hooks/hooks.json should still consult GEMINI_PLUGIN_ROOT for runtime resolution'
      );
      assert.ok(
        installedBashDispatcherEntry.hooks[0].command.includes('pre-bash-dispatcher.js'),
        'hooks/hooks.json should point the Bash preflight contract at the consolidated dispatcher'
      );
      assert.ok(
        !installedBashDispatcherEntry.hooks[0].command.includes('${GEMINI_PLUGIN_ROOT}'),
        'hooks/hooks.json should not retain raw GEMINI_PLUGIN_ROOT shell placeholders after install'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('preserves existing settings.json without mutating it during egc install', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const geminiRoot = path.join(homeDir, '.gemini');
      fs.mkdirSync(geminiRoot, { recursive: true });
      fs.writeFileSync(
        path.join(geminiRoot, 'settings.json'),
        JSON.stringify({
          effortLevel: 'high',
          env: { MY_VAR: '1' },
          hooks: {
            PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo custom-pretool' }] }],
            UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo custom-submit' }] }],
          },
        }, null, 2)
      );

      const result = run(['--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const settings = readJson(path.join(geminiRoot, 'settings.json'));
      assert.strictEqual(settings.effortLevel, 'high', 'existing effortLevel should be preserved');
      assert.deepStrictEqual(settings.env, { MY_VAR: '1' }, 'existing env should be preserved');
      assert.deepStrictEqual(
        settings.hooks.UserPromptSubmit,
        [{ matcher: '*', hooks: [{ type: 'command', command: 'echo custom-submit' }] }],
        'existing hooks should be left untouched'
      );
      assert.deepStrictEqual(
        settings.hooks.PreToolUse,
        [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo custom-pretool' }] }],
        'managed Gemini hooks should not be injected into settings.json'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('filters copied mcp config files when EGC_DISABLED_MCPS is set', () => {
    const tempDir = createTempDir('install-apply-mcp-');
    const sourcePath = path.join(tempDir, '.mcp.json');
    const destinationPath = path.join(tempDir, 'installed', '.mcp.json');
    const installStatePath = path.join(tempDir, 'installed', 'egc-install-state.json');
    const previousValue = process.env.EGC_DISABLED_MCPS;

    try {
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, JSON.stringify({
        mcpServers: {
          github: { command: 'npx' },
          exa: { url: 'https://mcp.exa.ai/mcp' },
          memory: { command: 'npx' },
        },
      }, null, 2));

      process.env.EGC_DISABLED_MCPS = 'github,memory';

      applyInstallPlan({
        targetRoot: path.join(tempDir, 'installed'),
        installStatePath,
        statePreview: {
          schemaVersion: 'egc.install.v1',
          installedAt: new Date().toISOString(),
          target: {
            id: 'test-install',
            kind: 'project',
            root: path.join(tempDir, 'installed'),
            installStatePath,
          },
          request: {
            profile: null,
            modules: ['test-mcp'],
            includeComponents: [],
            excludeComponents: [],
            legacyLanguages: [],
            legacyMode: false,
          },
          resolution: {
            selectedModules: ['test-mcp'],
            skippedModules: [],
          },
          source: {
            repoVersion: null,
            repoCommit: null,
            manifestVersion: 1,
          },
          operations: [],
        },
        operations: [{
          kind: 'copy-file',
          moduleId: 'test-mcp',
          sourcePath,
          sourceRelativePath: '.mcp.json',
          destinationPath,
          strategy: 'preserve-relative-path',
          ownership: 'managed',
          scaffoldOnly: false,
        }],
      });

      const installed = readJson(destinationPath);
      assert.deepStrictEqual(Object.keys(installed.mcpServers), ['exa']);
    } finally {
      if (previousValue === undefined) {
        delete process.env.EGC_DISABLED_MCPS;
      } else {
        process.env.EGC_DISABLED_MCPS = previousValue;
      }
      cleanup(tempDir);
    }
  })) passed++; else failed++;

  if (test('reinstall does not create settings.json when only managed hooks are installed', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const firstInstall = run(['--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(firstInstall.code, 0, firstInstall.stderr);

      const secondInstall = run(['--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(secondInstall.code, 0, secondInstall.stderr);

      assert.ok(!fs.existsSync(path.join(homeDir, '.gemini', 'settings.json')));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('reinstall leaves pre-existing hook-based settings.json untouched', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const geminiRoot = path.join(homeDir, '.gemini');
      fs.mkdirSync(geminiRoot, { recursive: true });
      const settingsPath = path.join(geminiRoot, 'settings.json');
      const legacySettings = {
        hooks: {
          PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo legacy-pretool' }] }],
        },
      };
      fs.writeFileSync(settingsPath, JSON.stringify(legacySettings, null, 2));

      const secondInstall = run(['--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(secondInstall.code, 0, secondInstall.stderr);

      const afterSecondInstall = readJson(settingsPath);
      assert.deepStrictEqual(afterSecondInstall, legacySettings);
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('ignores malformed existing settings.json during egc install', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const geminiRoot = path.join(homeDir, '.gemini');
      fs.mkdirSync(geminiRoot, { recursive: true });
      const settingsPath = path.join(geminiRoot, 'settings.json');
      fs.writeFileSync(settingsPath, '{ invalid json\n');

      const result = run(['--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '{ invalid json\n');
      assert.ok(fs.existsSync(path.join(geminiRoot, 'hooks', 'hooks.json')), 'hooks.json should still be copied');
      assert.ok(fs.existsSync(path.join(geminiRoot, 'egc', 'install-state.json')), 'install state should still be written');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('ignores non-object existing settings.json during egc install', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const geminiRoot = path.join(homeDir, '.gemini');
      fs.mkdirSync(geminiRoot, { recursive: true });
      const settingsPath = path.join(geminiRoot, 'settings.json');
      fs.writeFileSync(settingsPath, '[]\n');

      const result = run(['--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '[]\n');
      assert.ok(fs.existsSync(path.join(geminiRoot, 'hooks', 'hooks.json')), 'hooks.json should still be copied');
      assert.ok(fs.existsSync(path.join(geminiRoot, 'egc', 'install-state.json')), 'install state should still be written');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('fails when source hooks.json root is not an object before copying files', () => {
    const tempDir = createTempDir('install-apply-invalid-hooks-');
    const targetRoot = path.join(tempDir, '.gemini');
    const installStatePath = path.join(targetRoot, 'egc', 'install-state.json');
    const sourceHooksPath = path.join(tempDir, 'hooks.json');

    try {
      fs.writeFileSync(sourceHooksPath, '[]\n');

      assert.throws(() => {
        applyInstallPlan({
          targetRoot,
          installStatePath,
          statePreview: {
            schemaVersion: 'egc.install.v1',
            installedAt: new Date().toISOString(),
            target: {
              id: 'egc-home',
              kind: 'home',
              root: targetRoot,
              installStatePath,
            },
            request: {
              profile: 'core',
              modules: [],
              includeComponents: [],
              excludeComponents: [],
              legacyLanguages: [],
              legacyMode: false,
            },
            resolution: {
              selectedModules: ['hooks-runtime'],
              skippedModules: [],
            },
            source: {
              repoVersion: null,
              repoCommit: null,
              manifestVersion: 1,
            },
            operations: [],
          },
          adapter: { target: 'egc' },
          operations: [{
            kind: 'copy-file',
            moduleId: 'hooks-runtime',
            sourcePath: sourceHooksPath,
            sourceRelativePath: 'hooks/hooks.json',
            destinationPath: path.join(targetRoot, 'hooks', 'hooks.json'),
            strategy: 'preserve-relative-path',
            ownership: 'managed',
            scaffoldOnly: false,
          }],
        });
      }, /Invalid hooks config at .*expected a JSON object/);

      assert.ok(!fs.existsSync(path.join(targetRoot, 'hooks', 'hooks.json')), 'hooks.json should not be copied when source hooks are invalid');
      assert.ok(!fs.existsSync(installStatePath), 'install state should not be written when source hooks are invalid');
    } finally {
      cleanup(tempDir);
    }
  })) passed++; else failed++;

  if (test('installs from egc-install.json and persists component selections', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');
    const configPath = path.join(projectDir, 'egc-install.json');

    try {
      fs.writeFileSync(configPath, JSON.stringify({
        version: 1,
        target: 'egc',
        profile: 'developer',
        include: ['capability:security'],
        exclude: ['capability:orchestration'],
      }, null, 2));

      const result = run(['--config', configPath], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      assert.ok(fs.existsSync(path.join(homeDir, '.gemini', 'skills', 'egc', 'security-review', 'SKILL.md')));
      assert.ok(!fs.existsSync(path.join(homeDir, '.gemini', 'skills', 'egc', 'dmux-workflows', 'SKILL.md')));

      const state = readJson(path.join(homeDir, '.gemini', 'egc', 'install-state.json'));
      assert.strictEqual(state.request.profile, 'developer');
      assert.deepStrictEqual(state.request.includeComponents, ['capability:security']);
      assert.deepStrictEqual(state.request.excludeComponents, ['capability:orchestration']);
      assert.ok(state.resolution.selectedModules.includes('security'));
      assert.ok(!state.resolution.selectedModules.includes('orchestration'));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('auto-detects egc-install.json from the project root', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');
    const configPath = path.join(projectDir, 'egc-install.json');

    try {
      fs.writeFileSync(configPath, JSON.stringify({
        version: 1,
        target: 'egc',
        profile: 'developer',
        include: ['capability:security'],
        exclude: ['capability:orchestration'],
      }, null, 2));

      const result = run([], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      assert.ok(fs.existsSync(path.join(homeDir, '.gemini', 'skills', 'egc', 'security-review', 'SKILL.md')));
      assert.ok(!fs.existsSync(path.join(homeDir, '.gemini', 'skills', 'egc', 'dmux-workflows', 'SKILL.md')));

      const state = readJson(path.join(homeDir, '.gemini', 'egc', 'install-state.json'));
      assert.strictEqual(state.request.profile, 'developer');
      assert.deepStrictEqual(state.request.includeComponents, ['capability:security']);
      assert.deepStrictEqual(state.request.excludeComponents, ['capability:orchestration']);
      assert.ok(state.resolution.selectedModules.includes('security'));
      assert.ok(!state.resolution.selectedModules.includes('orchestration'));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('preserves legacy language installs when a project config is present', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');
    const configPath = path.join(projectDir, 'egc-install.json');

    try {
      fs.writeFileSync(configPath, JSON.stringify({
        version: 1,
        target: 'egc',
        profile: 'developer',
        include: ['capability:security'],
      }, null, 2));

      const result = run(['typescript'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const state = readJson(path.join(homeDir, '.gemini', 'egc', 'install-state.json'));
      assert.strictEqual(state.request.legacyMode, true);
      assert.deepStrictEqual(state.request.legacyLanguages, ['typescript']);
      assert.strictEqual(state.request.profile, null);
      assert.deepStrictEqual(state.request.includeComponents, []);
      assert.ok(state.resolution.selectedModules.includes('framework-language'));
      assert.ok(!state.resolution.selectedModules.includes('security'));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
