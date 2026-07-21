/**
 * Tests for scripts/lib/install-targets/registry.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');

const {
  getInstallTargetAdapter,
  listInstallTargetAdapters,
  planInstallTargetScaffold,
} = require('../../scripts/lib/install-targets/registry');

function normalizedRelativePath(value) {
  return String(value || '').replace(/\\/g, '/');
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
  console.log('\n=== Testing install-target adapters ===\n');

  let passed = 0;
  let failed = 0;

  if (test('lists supported target adapters', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(adapter => adapter.target);
    assert.ok(targets.includes('egc'), 'Should include egc target');
    assert.ok(targets.includes('cursor'), 'Should include cursor target');
    assert.ok(targets.includes('antigravity'), 'Should include antigravity target');
    assert.ok(targets.includes('codex'), 'Should include codex target');
    assert.ok(targets.includes('gemini'), 'Should include gemini target');
    assert.ok(targets.includes('opencode'), 'Should include opencode target');
    assert.ok(targets.includes('codebuddy'), 'Should include codebuddy target');
    assert.ok(targets.includes('claude'), 'Should include claude target');
  })) passed++; else failed++;

  if (test('resolves cursor adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('cursor');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(root, path.join(projectRoot, '.cursor'));
    assert.strictEqual(statePath, path.join(projectRoot, '.cursor', 'egc-install-state.json'));
  })) passed++; else failed++;

  if (test('resolves egc adapter root and install-state path from home dir', () => {
    const adapter = getInstallTargetAdapter('egc');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir, repoRoot: '/repo/egc' });
    const statePath = adapter.getInstallStatePath({ homeDir, repoRoot: '/repo/egc' });

    assert.strictEqual(root, path.join(homeDir, '.gemini'));
    assert.strictEqual(statePath, path.join(homeDir, '.gemini', 'egc', 'install-state.json'));
  })) passed++; else failed++;

  if (test('plans egc rules and skills under EGC-managed subdirectories', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'egc',
      repoRoot,
      homeDir,
      modules: [
        {
          id: 'rules-core',
          paths: ['rules'],
        },
        {
          id: 'workflow-quality',
          paths: ['skills/tdd-workflow'],
        },
      ],
    });

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'rules'
        && operation.destinationPath === path.join(homeDir, '.gemini', 'rules', 'egc')
      )),
      'Should install bundled Gemini rules under rules/egc'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/tdd-workflow'
        && operation.destinationPath === path.join(homeDir, '.gemini', 'skills', 'egc', 'tdd-workflow')
      )),
      'Should install bundled Gemini skills under skills/egc'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/tdd-workflow'
        && operation.destinationPath === path.join(homeDir, '.gemini', 'antigravity-cli', 'skills', 'tdd-workflow')
      )),
      'Should also install bundled Gemini skills under antigravity-cli/skills for AGY'
    );
  })) passed++; else failed++;

  if (test('plans scaffold operations and flattens native target roots', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';
    const modules = [
      {
        id: 'platform-configs',
        paths: ['.cursor', 'mcp-configs'],
      },
      {
        id: 'rules-core',
        paths: ['rules'],
      },
    ];

    const plan = planInstallTargetScaffold({
      target: 'cursor',
      repoRoot,
      projectRoot,
      modules,
    });

    assert.strictEqual(plan.adapter.id, 'cursor-project');
    assert.strictEqual(plan.targetRoot, path.join(projectRoot, '.cursor'));
    assert.strictEqual(plan.installStatePath, path.join(projectRoot, '.cursor', 'egc-install-state.json'));

    const hooksJson = plan.operations.find(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === '.cursor/hooks.json'
    ));
    const mcpJson = plan.operations.find(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === '.mcp.json'
    ));
    const preserved = plan.operations.find(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === '.cursor/rules/common-coding-style.md'
    ));

    assert.ok(hooksJson, 'Should preserve non-rule Cursor platform config files');
    assert.strictEqual(hooksJson.strategy, 'preserve-relative-path');
    assert.strictEqual(hooksJson.destinationPath, path.join(projectRoot, '.cursor', 'hooks.json'));
    assert.ok(mcpJson, 'Should materialize a Cursor MCP config from the shared root MCP config');
    assert.strictEqual(mcpJson.kind, 'merge-json');
    assert.strictEqual(mcpJson.strategy, 'merge-json');
    assert.strictEqual(mcpJson.destinationPath, path.join(projectRoot, '.cursor', 'mcp.json'));

    assert.ok(preserved, 'Should include flattened Cursor rule scaffold operations');
    assert.strictEqual(preserved.strategy, 'flatten-copy');
    assert.strictEqual(
      preserved.destinationPath,
      path.join(projectRoot, '.cursor', 'rules', 'common-coding-style.mdc')
    );
  })) passed++; else failed++;

  if (test('plans cursor rules with flat namespaced filenames to avoid rule collisions', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'cursor',
      repoRoot,
      projectRoot,
      modules: [
        {
          id: 'rules-core',
          paths: ['rules'],
        },
      ],
    });

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'rules/common/coding-style.md'
        && operation.destinationPath === path.join(projectRoot, '.cursor', 'rules', 'common-coding-style.mdc')
      )),
      'Should flatten common rules into namespaced .mdc files'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'rules/typescript/testing.md'
        && operation.destinationPath === path.join(projectRoot, '.cursor', 'rules', 'typescript-testing.mdc')
      )),
      'Should flatten language rules into namespaced .mdc files'
    );
    assert.ok(
      !plan.operations.some(operation => (
        operation.destinationPath === path.join(projectRoot, '.cursor', 'rules', 'common', 'coding-style.md')
      )),
      'Should not preserve nested rule directories for cursor installs'
    );
    assert.ok(
      !plan.operations.some(operation => (
        operation.destinationPath === path.join(projectRoot, '.cursor', 'rules', 'common-coding-style.md')
      )),
      'Should not emit .md Cursor rule files'
    );
    assert.ok(
      !plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'rules/README.md'
      )),
      'Should not install Cursor README docs as runtime rule files'
    );
    assert.ok(
      !plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'rules/zh/README.md'
      )),
      'Should not flatten localized README docs into Cursor rule files'
    );
  })) passed++; else failed++;

  if (test('does not install root AGENTS.md into Cursor nested context', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'cursor',
      repoRoot,
      projectRoot,
      modules: [
        {
          id: 'agents-core',
          paths: ['.agents', 'agents', 'AGENTS.md'],
        },
      ],
    });

    assert.ok(
      !plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'AGENTS.md'
      )),
      'Cursor installs should not copy EGC root AGENTS.md into host project context'
    );
    assert.ok(
      !plan.operations.some(operation => (
        operation.destinationPath === path.join(projectRoot, '.cursor', 'AGENTS.md')
      )),
      'Cursor installs should not create .cursor/AGENTS.md'
    );
  })) passed++; else failed++;

  if (test('plans cursor agents with egc-prefixed filenames to avoid agent collisions', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'cursor',
      repoRoot,
      projectRoot,
      modules: [
        {
          id: 'agents-core',
          paths: ['agents'],
        },
      ],
    });

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'agents/architect.md'
        && operation.destinationPath === path.join(projectRoot, '.cursor', 'agents', 'egc-architect.md')
      )),
      'Should prefix Cursor agent files with egc-'
    );
    assert.ok(
      !plan.operations.some(operation => (
        operation.destinationPath === path.join(projectRoot, '.cursor', 'agents', 'architect.md')
      )),
      'Should not write bare Cursor agent filenames'
    );
    assert.ok(
      !plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'agents'
        && operation.destinationPath === path.join(projectRoot, '.cursor', 'agents')
      )),
      'Should not plan a whole-directory Cursor agent copy'
    );
  })) passed++; else failed++;

  if (test('plans cursor platform rule files as .mdc and excludes rule README docs', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'cursor',
      repoRoot,
      projectRoot,
      modules: [
        {
          id: 'platform-configs',
          paths: ['.cursor'],
        },
      ],
    });

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === '.cursor/rules/common-agents.md'
        && operation.destinationPath === path.join(projectRoot, '.cursor', 'rules', 'common-agents.mdc')
      )),
      'Should rename Cursor platform rule files to .mdc'
    );
    assert.ok(
      !plan.operations.some(operation => (
        operation.destinationPath === path.join(projectRoot, '.cursor', 'rules', 'common-agents.md')
      )),
      'Should not preserve .md Cursor platform rule files'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === '.cursor/hooks.json'
        && operation.destinationPath === path.join(projectRoot, '.cursor', 'hooks.json')
      )),
      'Should preserve non-rule Cursor platform config files'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === '.mcp.json'
        && operation.kind === 'merge-json'
        && operation.destinationPath === path.join(projectRoot, '.cursor', 'mcp.json')
      )),
      'Should materialize a project-level Cursor MCP config'
    );
    assert.ok(
      !plan.operations.some(operation => (
        operation.destinationPath === path.join(projectRoot, '.cursor', 'rules', 'README.mdc')
      )),
      'Should not emit Cursor rule README docs as .mdc files'
    );
  })) passed++; else failed++;

  if (test('deduplicates cursor rule destinations when rules-core and platform-configs overlap', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'cursor',
      repoRoot,
      projectRoot,
      modules: [
        {
          id: 'rules-core',
          paths: ['rules'],
        },
        {
          id: 'platform-configs',
          paths: ['.cursor'],
        },
      ],
    });

    const commonAgentsDestinations = plan.operations.filter(operation => (
      operation.destinationPath === path.join(projectRoot, '.cursor', 'rules', 'common-agents.mdc')
    ));

    assert.strictEqual(commonAgentsDestinations.length, 1, 'Should keep only one common-agents.mdc operation');
    assert.strictEqual(
      normalizedRelativePath(commonAgentsDestinations[0].sourceRelativePath),
      '.cursor/rules/common-agents.md',
      'Should prefer native .cursor/rules content when cursor platform rules would collide'
    );
  })) passed++; else failed++;

  if (test('prefers native cursor hooks when hooks-runtime and platform-configs overlap', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'cursor',
      repoRoot,
      projectRoot,
      modules: [
        {
          id: 'hooks-runtime',
          paths: ['hooks', 'scripts/hooks', 'scripts/lib'],
        },
        {
          id: 'platform-configs',
          paths: ['.cursor'],
        },
      ],
    });

    const hooksDestinations = plan.operations.filter(operation => (
      operation.destinationPath === path.join(projectRoot, '.cursor', 'hooks')
    ));

    assert.strictEqual(hooksDestinations.length, 1, 'Should keep only one .cursor/hooks scaffold operation');
    assert.strictEqual(
      normalizedRelativePath(hooksDestinations[0].sourceRelativePath),
      '.cursor/hooks',
      'Should prefer native Cursor hooks over generic hooks-runtime hooks'
    );
  })) passed++; else failed++;

  if (test('plans antigravity remaps for workflows, skills, and flat rules', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'antigravity',
      repoRoot,
      projectRoot,
      modules: [
        {
          id: 'commands-core',
          paths: ['commands'],
        },
        {
          id: 'agents-core',
          paths: ['agents'],
        },
        {
          id: 'rules-core',
          paths: ['rules'],
        },
      ],
    });

    assert.ok(
      plan.operations.some(operation => (
        operation.sourceRelativePath === 'commands'
        && operation.destinationPath === path.join(projectRoot, '.agents', 'workflows')
      )),
      'Should remap commands into workflows'
    );
    assert.ok(
      plan.operations.some(operation => (
        operation.sourceRelativePath === 'agents'
        && operation.destinationPath === path.join(projectRoot, '.agents', 'skills')
      )),
      'Should remap agents into skills'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'rules/common/coding-style.md'
        && operation.destinationPath === path.join(projectRoot, '.agents', 'rules', 'common-coding-style.md')
      )),
      'Should flatten common rules for antigravity'
    );
  })) passed++; else failed++;

  if (test('exposes validate and planOperations on adapters', () => {
    const claudeAdapter = getInstallTargetAdapter('egc');
    const cursorAdapter = getInstallTargetAdapter('cursor');

    assert.strictEqual(typeof claudeAdapter.planOperations, 'function');
    assert.strictEqual(typeof claudeAdapter.validate, 'function');
    assert.ok(
      !claudeAdapter.validate({ homeDir: '/Users/example', repoRoot: '/repo/egc' })
        .some(i => i.severity === 'error'),
      'claude adapter should have no blocking validation errors'
    );

    assert.strictEqual(typeof cursorAdapter.planOperations, 'function');
    assert.strictEqual(typeof cursorAdapter.validate, 'function');
    assert.ok(
      !cursorAdapter.validate({ projectRoot: '/workspace/app', repoRoot: '/repo/egc' })
        .some(i => i.severity === 'error'),
      'cursor adapter should have no blocking validation errors'
    );
  })) passed++; else failed++;

  if (test('throws on unknown target adapter', () => {
    assert.throws(
      () => getInstallTargetAdapter('ghost-target'),
      /Unknown install target adapter/
    );
  })) passed++; else failed++;

  if (test('resolves codebuddy adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('codebuddy');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'codebuddy-project');
    assert.strictEqual(adapter.target, 'codebuddy');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.codebuddy'));
    assert.strictEqual(statePath, path.join(projectRoot, '.codebuddy', 'egc-install-state.json'));
  })) passed++; else failed++;

  if (test('resolves gemini adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('gemini');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'gemini-project');
    assert.strictEqual(adapter.target, 'gemini');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.gemini'));
    assert.strictEqual(statePath, path.join(projectRoot, '.gemini', 'egc-install-state.json'));
  })) passed++; else failed++;

  if (test('codebuddy adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('codebuddy');
    const byId = getInstallTargetAdapter('codebuddy-project');

    assert.strictEqual(byTarget.id, 'codebuddy-project');
    assert.strictEqual(byId.id, 'codebuddy-project');
    assert.ok(byTarget.supports('codebuddy'));
    assert.ok(byTarget.supports('codebuddy-project'));
  })) passed++; else failed++;

  if (test('plans codebuddy rules with flat namespaced filenames', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'codebuddy',
      repoRoot,
      projectRoot,
      modules: [
        {
          id: 'rules-core',
          paths: ['rules'],
        },
      ],
    });

    assert.strictEqual(plan.adapter.id, 'codebuddy-project');
    assert.strictEqual(plan.targetRoot, path.join(projectRoot, '.codebuddy'));
    assert.strictEqual(plan.installStatePath, path.join(projectRoot, '.codebuddy', 'egc-install-state.json'));

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'rules/common/coding-style.md'
        && operation.destinationPath === path.join(projectRoot, '.codebuddy', 'rules', 'common-coding-style.md')
      )),
      'Should flatten common rules into namespaced files for codebuddy'
    );
    assert.ok(
      !plan.operations.some(operation => (
        operation.destinationPath === path.join(projectRoot, '.codebuddy', 'rules', 'common', 'coding-style.md')
      )),
      'Should not preserve nested rule directories for codebuddy installs'
    );
  })) passed++; else failed++;

  if (test('exposes validate and planOperations on codebuddy adapter', () => {
    const codebuddyAdapter = getInstallTargetAdapter('codebuddy');

    assert.strictEqual(typeof codebuddyAdapter.planOperations, 'function');
    assert.strictEqual(typeof codebuddyAdapter.validate, 'function');
    assert.ok(
      !codebuddyAdapter.validate({ projectRoot: '/workspace/app', repoRoot: '/repo/egc' })
        .some(i => i.severity === 'error'),
      'codebuddy adapter should have no blocking validation errors'
    );
  })) passed++; else failed++;

  if (test('resolves claude adapter root and install-state path from home dir', () => {
    const adapter = getInstallTargetAdapter('claude');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'claude-home');
    assert.strictEqual(adapter.target, 'claude');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.claude'));
    assert.strictEqual(statePath, path.join(homeDir, '.claude', 'egc', 'install-state.json'));
  })) passed++; else failed++;

  if (test('claude adapter strips category from skill paths and installs flat', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'claude',
      repoRoot,
      homeDir,
      modules: [
        {
          id: 'workflow',
          paths: ['skills/workflow/tdd-workflow'],
        },
      ],
    });

    assert.strictEqual(plan.adapter.id, 'claude-home');
    assert.strictEqual(plan.targetRoot, path.join(homeDir, '.claude'));

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(homeDir, '.claude', 'skills', 'tdd-workflow')
      )),
      'Should strip category and install skill flat under ~/.claude/skills/'
    );
  })) passed++; else failed++;

  if (test('claude adapter always plans the SessionStart state hook operations', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'claude',
      repoRoot,
      homeDir,
      modules: [],
    });
    const hookScriptPath = path.join(
      homeDir, '.claude', 'egc', 'hooks', 'claude-session-start.js'
    );

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/claude-session-start.js'
        && operation.destinationPath === hookScriptPath
      )),
      'Should plan the hook script copy even with no modules selected'
    );

    const mergeOperation = plan.operations.find(
      operation => operation.kind === 'merge-claude-settings-hooks'
    );
    assert.ok(mergeOperation, 'Should plan the settings.json hook merge');
    assert.strictEqual(
      mergeOperation.destinationPath,
      path.join(homeDir, '.claude', 'settings.json')
    );
    assert.strictEqual(mergeOperation.ownership, 'managed');
    assert.strictEqual(mergeOperation.hookEvent, 'SessionStart');
    assert.strictEqual(mergeOperation.hookScriptPath, hookScriptPath);
    assert.ok(mergeOperation.hookCommand.includes(hookScriptPath));
  })) passed++; else failed++;

  if (test('claude adapter registers the GateGuard fact-force hook on Edit/Write/MultiEdit, not just Bash', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'claude',
      repoRoot,
      homeDir,
      modules: [],
    });
    const gateGuardScriptPath = path.join(
      homeDir, '.claude', 'scripts', 'hooks', 'gateguard-fact-force.js'
    );

    const gateGuardOperations = plan.operations.filter(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.hookEvent === 'PreToolUse'
      && operation.hookScriptPath === gateGuardScriptPath
    ));

    const matchers = gateGuardOperations.map(operation => operation.hookMatcher).sort();
    assert.deepStrictEqual(
      matchers,
      ['Edit', 'MultiEdit', 'Write'],
      'GateGuard should be registered on Edit, Write, and MultiEdit (Bash already gets it via the dispatcher)'
    );

    const writeValidatorScriptPath = path.join(
      homeDir, '.claude', 'scripts', 'hooks', 'pre-write-guardian-validate.js'
    );
    const stillHasWriteValidator = plan.operations.some(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.hookEvent === 'PreToolUse'
      && operation.hookScriptPath === writeValidatorScriptPath
      && operation.hookMatcher === 'Edit'
    ));
    assert.ok(stillHasWriteValidator, 'GateGuard should be additive, not a replacement for the protected-path write validator');
  })) passed++; else failed++;

  if (test('codex adapter wires GateGuard into ~/.codex/hooks.json, not ~/.agents (Codex CLI does not read hooks from its skills root)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'codex',
      repoRoot,
      homeDir,
      modules: [],
    });

    const codexHome = path.join(homeDir, '.codex');
    const gateGuardScriptPath = path.join(codexHome, 'scripts', 'hooks', 'gateguard-fact-force.js');

    const hooksJsonOperations = plan.operations.filter(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.hookEvent === 'PreToolUse'
      && operation.hookScriptPath === gateGuardScriptPath
    ));

    assert.ok(hooksJsonOperations.length > 0, 'Should plan at least one PreToolUse merge into ~/.codex/hooks.json');
    for (const operation of hooksJsonOperations) {
      assert.strictEqual(operation.destinationPath, path.join(codexHome, 'hooks.json'));
    }

    const matchers = hooksJsonOperations.map(operation => operation.hookMatcher).sort();
    assert.deepStrictEqual(
      matchers,
      ['Bash', 'apply_patch'],
      'Codex sends tool_name "apply_patch" for file edits (Edit/Write are matcher aliases only) and "Bash" for shell commands'
    );

    const scriptCopyOperation = plan.operations.find(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/gateguard-fact-force.js'
      && operation.destinationPath === gateGuardScriptPath
    ));
    assert.ok(scriptCopyOperation, 'Should copy gateguard-fact-force.js into ~/.codex/scripts/hooks/');

    const libCopyOperation = plan.operations.find(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === 'scripts/lib/utils.js'
      && operation.destinationPath === path.join(codexHome, 'scripts', 'lib', 'utils.js')
    ));
    assert.ok(libCopyOperation, 'Should copy gateguard-fact-force.js\'s only dependency alongside it');
  })) passed++; else failed++;

  for (const [target, expectedRootSegments] of [['continue', ['.continue']], ['continue-project', ['.continue']]]) {
    if (test(`${target} adapter wires GateGuard PreToolUse for Edit/Write/MultiEdit/Bash into settings.json`, () => {
      const repoRoot = path.join(__dirname, '..', '..');
      const isProject = target === 'continue-project';
      const homeDir = '/Users/example';
      const projectRoot = '/workspace/app';

      const plan = planInstallTargetScaffold({
        target,
        repoRoot,
        homeDir,
        projectRoot,
        modules: [],
      });

      const targetRoot = path.join(isProject ? projectRoot : homeDir, ...expectedRootSegments);
      const gateGuardScriptPath = path.join(targetRoot, 'scripts', 'hooks', 'gateguard-fact-force.js');

      const gateGuardOperations = plan.operations.filter(operation => (
        operation.kind === 'merge-claude-settings-hooks'
        && operation.hookEvent === 'PreToolUse'
        && operation.hookScriptPath === gateGuardScriptPath
      ));

      const matchers = gateGuardOperations.map(operation => operation.hookMatcher).sort();
      assert.deepStrictEqual(matchers, ['Bash', 'Edit', 'MultiEdit', 'Write']);
      for (const operation of gateGuardOperations) {
        assert.strictEqual(operation.destinationPath, path.join(targetRoot, 'settings.json'));
      }

      const scriptCopyOperation = plan.operations.find(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/gateguard-fact-force.js'
        && operation.destinationPath === gateGuardScriptPath
      ));
      assert.ok(scriptCopyOperation, 'Should copy gateguard-fact-force.js into Continue\'s own root, unconditional of module selection');
    })) passed++; else failed++;
  }

  for (const [target, rootFn] of [
    ['windsurf', homeDir => path.join(homeDir, '.codeium', 'windsurf')],
    ['windsurf-project', (_homeDir, projectRoot) => path.join(projectRoot, '.windsurf')],
  ]) {
    if (test(`${target} adapter wires GateGuard into hooks.json via the Windsurf-contract adapter script (pre_write_code + pre_run_command)`, () => {
      const repoRoot = path.join(__dirname, '..', '..');
      const homeDir = '/Users/example';
      const projectRoot = '/workspace/app';

      const plan = planInstallTargetScaffold({
        target,
        repoRoot,
        homeDir,
        projectRoot,
        modules: [],
      });

      const targetRoot = rootFn(homeDir, projectRoot);
      const adapterScriptPath = path.join(targetRoot, 'scripts', 'hooks', 'windsurf-gateguard-adapter.js');
      const hooksJsonPath = path.join(targetRoot, 'hooks.json');

      const hookOperations = plan.operations.filter(operation => (
        operation.kind === 'merge-claude-settings-hooks'
        && operation.hookScriptPath === adapterScriptPath
        && operation.destinationPath === hooksJsonPath
      ));
      const events = hookOperations.map(operation => operation.hookEvent).sort();
      assert.deepStrictEqual(events, ['pre_run_command', 'pre_write_code']);

      const adapterCopyOperation = plan.operations.find(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/windsurf-gateguard-adapter.js'
        && operation.destinationPath === adapterScriptPath
      ));
      assert.ok(adapterCopyOperation, 'Should copy the Windsurf-contract adapter script');

      const gateGuardScriptPath = path.join(targetRoot, 'scripts', 'hooks', 'gateguard-fact-force.js');
      const gateGuardCopyOperation = plan.operations.find(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/gateguard-fact-force.js'
        && operation.destinationPath === gateGuardScriptPath
      ));
      assert.ok(gateGuardCopyOperation, 'Should also copy gateguard-fact-force.js itself (the adapter requires it in-process)');
    })) passed++; else failed++;
  }

  if (test('resolves codex adapter root to ~/.agents and install-state path', () => {
    const adapter = getInstallTargetAdapter('codex');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'codex-home');
    assert.strictEqual(adapter.target, 'codex');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.agents'));
    assert.strictEqual(statePath, path.join(homeDir, '.agents', 'egc', 'codex-install-state.json'));
  })) passed++; else failed++;

  if (test('codex adapter strips category from skill paths and installs flat under ~/.agents/skills/', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'codex',
      repoRoot,
      homeDir,
      modules: [
        {
          id: 'workflow',
          paths: ['skills/workflow/tdd-workflow'],
        },
      ],
    });

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(homeDir, '.agents', 'skills', 'tdd-workflow')
      )),
      'Should strip category and install skill flat under ~/.agents/skills/'
    );
  })) passed++; else failed++;

  if (test('codex adapter filters out foreign-platform source paths (audit EGC-128)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'codex',
      repoRoot,
      homeDir,
      modules: [
        {
          id: 'workflow',
          paths: ['.cursor', '.opencode', '.gemini', '.gemini-plugin', 'skills/workflow/tdd-workflow'],
        },
      ],
    });

    for (const foreign of ['.cursor', '.opencode', '.gemini', '.gemini-plugin']) {
      assert.ok(
        !plan.operations.some(op => normalizedRelativePath(op.sourceRelativePath) === foreign),
        `Should filter out ${foreign} (owned by a different platform) instead of copying it into ~/.agents/`
      );
    }
    assert.ok(
      plan.operations.some(op => normalizedRelativePath(op.sourceRelativePath) === 'skills/workflow/tdd-workflow'),
      'Should still install the module\'s own skill path'
    );
  })) passed++; else failed++;

  if (test('resolves opencode adapter root to ~/.config/opencode and install-state path', () => {
    const adapter = getInstallTargetAdapter('opencode');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'opencode-home');
    assert.strictEqual(adapter.target, 'opencode');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.config', 'opencode'));
    assert.strictEqual(statePath, path.join(homeDir, '.config', 'opencode', 'egc', 'install-state.json'));
  })) passed++; else failed++;

  if (test('opencode adapter strips category from skill paths and installs flat under ~/.config/opencode/skills/', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'opencode',
      repoRoot,
      homeDir,
      modules: [
        {
          id: 'workflow',
          paths: ['skills/workflow/tdd-workflow'],
        },
      ],
    });

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(homeDir, '.config', 'opencode', 'skills', 'tdd-workflow')
      )),
      'Should strip category and install skill flat under ~/.config/opencode/skills/'
    );
  })) passed++; else failed++;

  if (test('opencode adapter filters out foreign-platform source paths (audit EGC-128)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'opencode',
      repoRoot,
      homeDir,
      modules: [
        {
          id: 'workflow',
          paths: ['.cursor', '.codex', '.gemini', '.gemini-plugin', 'skills/workflow/tdd-workflow'],
        },
      ],
    });

    for (const foreign of ['.cursor', '.codex', '.gemini', '.gemini-plugin']) {
      assert.ok(
        !plan.operations.some(op => normalizedRelativePath(op.sourceRelativePath) === foreign),
        `Should filter out ${foreign} (owned by a different platform) instead of copying it into ~/.config/opencode/`
      );
    }
    assert.ok(
      plan.operations.some(op => normalizedRelativePath(op.sourceRelativePath) === 'skills/workflow/tdd-workflow'),
      'Should still install the module\'s own skill path'
    );
  })) passed++; else failed++;

  if (test('codebuddy adapter strips category from skill paths and installs flat', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'codebuddy',
      repoRoot,
      projectRoot,
      modules: [
        {
          id: 'workflow',
          paths: ['skills/workflow/tdd-workflow'],
        },
      ],
    });

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(projectRoot, '.codebuddy', 'skills', 'tdd-workflow')
      )),
      'Should strip category and install skill flat under .codebuddy/skills/'
    );
  })) passed++; else failed++;

  if (test('antigravity-project adapter uses .agents (plural) as root directory', () => {
    const adapter = getInstallTargetAdapter('antigravity');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });

    assert.strictEqual(root, path.join(projectRoot, '.agents'));
  })) passed++; else failed++;

  if (test('resolves windsurf home adapter root to ~/.codeium/windsurf and install-state path', () => {
    const adapter = getInstallTargetAdapter('windsurf');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'windsurf-home');
    assert.strictEqual(adapter.target, 'windsurf');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.codeium', 'windsurf'));
    assert.strictEqual(statePath, path.join(homeDir, '.codeium', 'windsurf', 'egc', 'install-state.json'));
  })) passed++; else failed++;

  if (test('windsurf adapter strips category from skill paths and installs flat', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'windsurf',
      repoRoot,
      homeDir,
      modules: [
        {
          id: 'workflow',
          paths: ['skills/workflow/tdd-workflow'],
        },
      ],
    });

    assert.strictEqual(plan.adapter.id, 'windsurf-home');
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(homeDir, '.codeium', 'windsurf', 'skills', 'tdd-workflow')
      )),
      'Should strip category and install skill flat under ~/.codeium/windsurf/skills/'
    );
  })) passed++; else failed++;

  if (test('resolves amp home adapter root to ~/.amp and install-state path', () => {
    const adapter = getInstallTargetAdapter('amp');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'amp-home');
    assert.strictEqual(adapter.target, 'amp');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.amp'));
    assert.strictEqual(statePath, path.join(homeDir, '.amp', 'egc', 'install-state.json'));
  })) passed++; else failed++;

  if (test('amp adapter strips category from skill paths and installs flat', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'amp',
      repoRoot,
      homeDir,
      modules: [
        {
          id: 'workflow',
          paths: ['skills/workflow/tdd-workflow'],
        },
      ],
    });

    assert.strictEqual(plan.adapter.id, 'amp-home');
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(homeDir, '.amp', 'skills', 'tdd-workflow')
      )),
      'Should strip category and install skill flat under ~/.amp/skills/'
    );
  })) passed++; else failed++;

  if (test('resolves copilot home adapter root to ~/.github and install-state path', () => {
    const adapter = getInstallTargetAdapter('copilot');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'copilot-home');
    assert.strictEqual(adapter.target, 'copilot');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.github'));
    assert.strictEqual(statePath, path.join(homeDir, '.github', 'egc', 'install-state.json'));
  })) passed++; else failed++;

  if (test('copilot adapter strips category from skill paths and installs flat', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'copilot',
      repoRoot,
      homeDir,
      modules: [
        {
          id: 'workflow',
          paths: ['skills/workflow/tdd-workflow'],
        },
      ],
    });

    assert.strictEqual(plan.adapter.id, 'copilot-home');
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(homeDir, '.github', 'skills', 'tdd-workflow')
      )),
      'Should strip category and install skill flat under ~/.github/skills/'
    );
  })) passed++; else failed++;

  if (test('lists all 3 new IDE targets in adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(adapter => adapter.target);
    assert.ok(targets.includes('windsurf'), 'Should include windsurf target');
    assert.ok(targets.includes('amp'), 'Should include amp target');
    assert.ok(targets.includes('copilot'), 'Should include copilot target');
  })) passed++; else failed++;

  if (test('resolves zed home adapter root to ~/.config/zed and install-state path', () => {
    const adapter = getInstallTargetAdapter('zed');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'zed-home');
    assert.strictEqual(adapter.target, 'zed');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.config', 'zed'));
    assert.strictEqual(statePath, path.join(homeDir, '.config', 'zed', 'egc', 'install-state.json'));
  })) passed++; else failed++;

  if (test('zed adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('zed');
    const byId = getInstallTargetAdapter('zed-home');

    assert.strictEqual(byTarget.id, 'zed-home');
    assert.strictEqual(byId.id, 'zed-home');
    assert.ok(byTarget.supports('zed'));
    assert.ok(byTarget.supports('zed-home'));
  })) passed++; else failed++;

  if (test('zed adapter strips category from skill paths and installs flat under ~/.config/zed/skills/', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'zed',
      repoRoot,
      homeDir,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'zed-home');
    assert.strictEqual(plan.targetRoot, path.join(homeDir, '.config', 'zed'));
    assert.strictEqual(plan.installStatePath, path.join(homeDir, '.config', 'zed', 'egc', 'install-state.json'));
    assert.ok(
      plan.operations.some(op =>
        normalizedRelativePath(op.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && op.destinationPath === path.join(homeDir, '.config', 'zed', 'skills', 'tdd-workflow')
      ),
      'Should strip category and install skill flat under ~/.config/zed/skills/'
    );
  })) passed++; else failed++;

  if (test('zed adapter handles already-flat skill paths without double-stripping', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'zed',
      repoRoot,
      homeDir,
      modules: [{ id: 'workflow', paths: ['skills/tdd-workflow'] }],
    });

    assert.ok(
      plan.operations.some(op =>
        normalizedRelativePath(op.sourceRelativePath) === 'skills/tdd-workflow'
        && op.destinationPath === path.join(homeDir, '.config', 'zed', 'skills', 'tdd-workflow')
      ),
      'Should handle already-flat skill path without stripping anything'
    );
  })) passed++; else failed++;

  if (test('exposes validate and planOperations on zed adapter', () => {
    const zedAdapter = getInstallTargetAdapter('zed');

    assert.strictEqual(typeof zedAdapter.planOperations, 'function');
    assert.strictEqual(typeof zedAdapter.validate, 'function');
    assert.ok(
      !zedAdapter.validate({ homeDir: '/Users/example', repoRoot: '/repo/egc' })
        .some(i => i.severity === 'error'),
      'zed adapter should have no blocking validation errors'
    );
  })) passed++; else failed++;

  if (test('zed adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('zed'), 'Should include zed target');
  })) passed++; else failed++;

  if (test('resolves continue home adapter root to ~/.continue and install-state path', () => {
    const adapter = getInstallTargetAdapter('continue');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'continue-home');
    assert.strictEqual(adapter.target, 'continue');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.continue'));
    assert.strictEqual(statePath, path.join(homeDir, '.continue', 'egc', 'install-state.json'));
  })) passed++; else failed++;

  if (test('continue adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('continue');
    const byId = getInstallTargetAdapter('continue-home');
    const projectById = getInstallTargetAdapter('continue-project');

    assert.strictEqual(byTarget.id, 'continue-home');
    assert.strictEqual(byId.id, 'continue-home');
    assert.strictEqual(projectById.id, 'continue-project');
    assert.ok(byTarget.supports('continue'));
    assert.ok(byTarget.supports('continue-home'));
  })) passed++; else failed++;

  if (test('continue adapter strips category from skill paths and installs flat under ~/.continue/skills/', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'continue',
      repoRoot,
      homeDir,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'continue-home');
    assert.strictEqual(plan.targetRoot, path.join(homeDir, '.continue'));
    assert.strictEqual(plan.installStatePath, path.join(homeDir, '.continue', 'egc', 'install-state.json'));
    assert.ok(
      plan.operations.some(op =>
        normalizedRelativePath(op.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && op.destinationPath === path.join(homeDir, '.continue', 'skills', 'tdd-workflow')
      ),
      'Should strip category and install skill flat under ~/.continue/skills/'
    );
  })) passed++; else failed++;

  if (test('continue adapter handles already-flat skill paths without double-stripping', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'continue',
      repoRoot,
      homeDir,
      modules: [{ id: 'workflow', paths: ['skills/tdd-workflow'] }],
    });

    assert.ok(
      plan.operations.some(op =>
        normalizedRelativePath(op.sourceRelativePath) === 'skills/tdd-workflow'
        && op.destinationPath === path.join(homeDir, '.continue', 'skills', 'tdd-workflow')
      ),
      'Should handle already-flat skill path without stripping anything'
    );
  })) passed++; else failed++;

  if (test('continue-project adapter resolves root to <project>/.continue', () => {
    const adapter = getInstallTargetAdapter('continue-project');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.target, 'continue');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.continue'));
    assert.strictEqual(statePath, path.join(projectRoot, '.continue', 'egc-install-state.json'));
  })) passed++; else failed++;

  if (test('continue adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('continue'), 'Should include continue target');
  })) passed++; else failed++;

  if (test('continue-project adapter strips category from skill paths and installs flat under .continue/skills/', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'continue-project',
      repoRoot,
      projectRoot,
      homeDir: '/Users/example',
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'continue-project');
    assert.strictEqual(plan.targetRoot, path.join(projectRoot, '.continue'));
    assert.strictEqual(plan.installStatePath, path.join(projectRoot, '.continue', 'egc-install-state.json'));
    assert.ok(
      plan.operations.some(op =>
        normalizedRelativePath(op.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && op.destinationPath === path.join(projectRoot, '.continue', 'skills', 'tdd-workflow')
      ),
      'Should strip category and install skill flat under .continue/skills/'
    );
  })) passed++; else failed++;

  if (test('continue-project adapter handles already-flat skill paths without double-stripping', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'continue-project',
      repoRoot,
      projectRoot,
      homeDir: '/Users/example',
      modules: [{ id: 'workflow', paths: ['skills/tdd-workflow'] }],
    });

    assert.ok(
      plan.operations.some(op =>
        normalizedRelativePath(op.sourceRelativePath) === 'skills/tdd-workflow'
        && op.destinationPath === path.join(projectRoot, '.continue', 'skills', 'tdd-workflow')
      ),
      'Should handle already-flat skill path without stripping anything'
    );
  })) passed++; else failed++;

  if (test('continue-project adapter passes non-skill paths through the default scaffold operation', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'continue-project',
      repoRoot,
      projectRoot,
      homeDir: '/Users/example',
      modules: [{ id: 'workflow', paths: ['AGENTS.md'] }],
    });

    assert.ok(
      plan.operations.some(op =>
        normalizedRelativePath(op.sourceRelativePath) === 'AGENTS.md'
        && op.destinationPath === path.join(projectRoot, '.continue', 'AGENTS.md')
        && op.strategy === 'preserve-relative-path'
      ),
      'Should pass non-skill paths through to the default scaffold operation'
    );
  })) passed++; else failed++;

  if (test('continue-project adapter filters out foreign-platform source paths', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'continue-project',
      repoRoot,
      projectRoot,
      homeDir: '/Users/example',
      modules: [{ id: 'workflow', paths: ['.cursor', 'skills/tdd-workflow'] }],
    });

    assert.ok(
      !plan.operations.some(op => normalizedRelativePath(op.sourceRelativePath) === '.cursor'),
      'Should filter out paths owned by a different platform (.cursor belongs to the cursor target)'
    );
    assert.ok(
      plan.operations.some(op => normalizedRelativePath(op.sourceRelativePath) === 'skills/tdd-workflow'),
      'Should still install the module\'s own skill path'
    );
  })) passed++; else failed++;

  if (test('continue-project adapter exposes validate and planOperations with no blocking errors', () => {
    const continueProjectAdapter = getInstallTargetAdapter('continue-project');

    assert.strictEqual(typeof continueProjectAdapter.planOperations, 'function');
    assert.strictEqual(typeof continueProjectAdapter.validate, 'function');
    assert.ok(
      !continueProjectAdapter.validate({ projectRoot: '/workspace/app', homeDir: '/Users/example' })
        .some(i => i.severity === 'error'),
      'continue-project adapter should have no blocking validation errors'
    );
  })) passed++; else failed++;

  if (test('every schema target enum value has a matching adapter (regression guard)', () => {
    const schemaPath = path.join(__dirname, '..', '..', 'schemas', 'egc-install-config.schema.json');
    const schema = JSON.parse(require('fs').readFileSync(schemaPath, 'utf8'));
    const schemaTargets = schema.properties.target.enum;
    const adapters = listInstallTargetAdapters();
    const adapterTargets = adapters.map(a => a.target);

    for (const target of schemaTargets) {
      assert.ok(
        adapterTargets.includes(target),
        `Schema target "${target}" has no matching adapter. ` +
        `Available adapter targets: ${adapterTargets.join(', ')}`
      );
    }
  })) passed++; else failed++;

  if (test('every adapter target is listed in the schema enum (regression guard)', () => {
    const schemaPath = path.join(__dirname, '..', '..', 'schemas', 'egc-install-config.schema.json');
    const schema = JSON.parse(require('fs').readFileSync(schemaPath, 'utf8'));
    const schemaTargets = schema.properties.target.enum;
    const adapters = listInstallTargetAdapters();

    for (const adapter of adapters) {
      assert.ok(
        schemaTargets.includes(adapter.target),
        `Adapter target "${adapter.target}" is not in schema enum. ` +
        `Schema targets: ${schemaTargets.join(', ')}`
      );
    }
  })) passed++; else failed++;

  if (test('every adapter target is in SUPPORTED_INSTALL_TARGETS (regression guard)', () => {
    const { SUPPORTED_INSTALL_TARGETS } = require('../../scripts/lib/install-manifests');
    const adapters = listInstallTargetAdapters();

    for (const adapter of adapters) {
      assert.ok(
        SUPPORTED_INSTALL_TARGETS.includes(adapter.target),
        `Adapter target "${adapter.target}" is not in SUPPORTED_INSTALL_TARGETS. ` +
        `Supported: ${SUPPORTED_INSTALL_TARGETS.join(', ')}`
      );
    }
  })) passed++; else failed++;

  if (test('claude target resolves skill modules that depend on platform-configs (issue #160)', () => {
    const { resolveInstallPlan } = require('../../scripts/lib/install-manifests');

    const plan = resolveInstallPlan({
      moduleIds: ['workflow-quality'],
      target: 'claude',
      homeDir: os.tmpdir(),
      projectRoot: os.tmpdir(),
    });

    assert.ok(
      plan.selectedModuleIds.includes('workflow-quality'),
      'workflow-quality must be selected for claude target'
    );
    assert.ok(
      plan.selectedModuleIds.includes('platform-configs'),
      'platform-configs must be selected as dependency for claude target'
    );
    assert.strictEqual(
      plan.skippedModuleIds.length,
      0,
      'no modules should be silently skipped'
    );

    const platformConfigOps = plan.operations.filter(op => op.moduleId === 'platform-configs');
    assert.strictEqual(
      platformConfigOps.length,
      0,
      'platform-configs must produce zero file operations for claude (all paths are egc-platform-specific)'
    );
  })) passed++; else failed++;

  if (test('copilot adapter registers the GateGuard fact-force hook at ~/.copilot/hooks/hooks.json', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'copilot',
      repoRoot,
      homeDir,
      modules: [],
    });
    const hooksFilePath = path.join(homeDir, '.copilot', 'hooks', 'hooks.json');
    const gateGuardScriptPath = path.join(
      homeDir, '.github', 'scripts', 'hooks', 'gateguard-fact-force.js'
    );

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/gateguard-fact-force.js'
        && operation.destinationPath === gateGuardScriptPath
      )),
      'Should scaffold the GateGuard script under the copilot home root even with no modules selected'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/lib/utils.js'
        && operation.destinationPath === path.join(homeDir, '.github', 'scripts', 'lib', 'utils.js')
      )),
      'Should scaffold the GateGuard utils.js dependency alongside the hook script'
    );

    const gateGuardOperations = plan.operations.filter(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.hookEvent === 'PreToolUse'
      && operation.destinationPath === hooksFilePath
      && operation.hookScriptPath === gateGuardScriptPath
    ));
    const matchers = gateGuardOperations.map(operation => operation.hookMatcher).sort();
    assert.deepStrictEqual(
      matchers,
      ['Bash', 'Edit', 'MultiEdit', 'Write'],
      'GateGuard should be registered on Edit, Write, MultiEdit and Bash for VS Code Copilot'
    );
  })) passed++; else failed++;

  if (test('codebuddy adapter registers the GateGuard fact-force hook at .codebuddy/settings.json', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'codebuddy',
      repoRoot,
      projectRoot,
      modules: [],
    });
    const settingsPath = path.join(projectRoot, '.codebuddy', 'settings.json');
    const gateGuardScriptPath = path.join(
      projectRoot, '.codebuddy', 'scripts', 'hooks', 'gateguard-fact-force.js'
    );

    const gateGuardOperations = plan.operations.filter(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.hookEvent === 'PreToolUse'
      && operation.destinationPath === settingsPath
      && operation.hookScriptPath === gateGuardScriptPath
    ));
    const matchers = gateGuardOperations.map(operation => operation.hookMatcher).sort();
    assert.deepStrictEqual(
      matchers,
      ['Bash', 'Edit', 'MultiEdit', 'Write'],
      'GateGuard should be registered on Edit, Write, MultiEdit and Bash for CodeBuddy'
    );
  })) passed++; else failed++;

  if (test('antigravity-project adapter registers the GateGuard fact-force hook at .agents/hooks.json', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'antigravity',
      repoRoot,
      projectRoot,
      modules: [],
    });
    const hooksFilePath = path.join(projectRoot, '.agents', 'hooks.json');
    const gateGuardScriptPath = path.join(
      projectRoot, '.agents', 'scripts', 'hooks', 'gateguard-fact-force.js'
    );

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/gateguard-fact-force.js'
        && operation.destinationPath === gateGuardScriptPath
      )),
      'Should scaffold the GateGuard script under .agents/ even with no modules selected'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/lib/utils.js'
        && operation.destinationPath === path.join(projectRoot, '.agents', 'scripts', 'lib', 'utils.js')
      )),
      'Should scaffold the GateGuard utils.js dependency alongside the hook script'
    );

    const gateGuardOperations = plan.operations.filter(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.hookEvent === 'PreToolUse'
      && operation.destinationPath === hooksFilePath
      && operation.hookScriptPath === gateGuardScriptPath
    ));
    const matchers = gateGuardOperations.map(operation => operation.hookMatcher).sort();
    assert.deepStrictEqual(
      matchers,
      ['Bash', 'Edit', 'MultiEdit', 'Write'],
      'GateGuard should be registered on Edit, Write, MultiEdit and Bash for Antigravity project scope'
    );
  })) passed++; else failed++;

  if (test('egc-home adapter registers the GateGuard fact-force hook for Antigravity global scope too', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'egc',
      repoRoot,
      homeDir,
      modules: [],
    });
    const hooksFilePath = path.join(homeDir, '.gemini', 'antigravity-cli', 'hooks.json');
    const gateGuardScriptPath = path.join(
      homeDir, '.gemini', 'scripts', 'hooks', 'gateguard-fact-force.js'
    );

    const gateGuardOperations = plan.operations.filter(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.hookEvent === 'PreToolUse'
      && operation.destinationPath === hooksFilePath
      && operation.hookScriptPath === gateGuardScriptPath
    ));
    const matchers = gateGuardOperations.map(operation => operation.hookMatcher).sort();
    assert.deepStrictEqual(
      matchers,
      ['Bash', 'Edit', 'MultiEdit', 'Write'],
      'GateGuard should be registered on Edit, Write, MultiEdit and Bash for Antigravity global hooks.json, ' +
      'separate from Gemini CLI\'s own ~/.gemini/hooks/hooks.json'
    );
  })) passed++; else failed++;

  if (test('resolves kiro home adapter root to ~/.kiro and install-state path', () => {
    const adapter = getInstallTargetAdapter('kiro');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'kiro-home');
    assert.strictEqual(adapter.target, 'kiro');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.kiro'));
    assert.strictEqual(statePath, path.join(homeDir, '.kiro', 'egc', 'install-state.json'));
  })) passed++; else failed++;

  if (test('resolves kiro project adapter root to .kiro and install-state path', () => {
    const adapter = getInstallTargetAdapter('kiro-project');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'kiro-project');
    assert.strictEqual(adapter.target, 'kiro');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.kiro'));
    assert.strictEqual(statePath, path.join(projectRoot, '.kiro', 'egc-install-state.json'));
  })) passed++; else failed++;

  if (test('kiro adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('kiro');
    const byId = getInstallTargetAdapter('kiro-home');
    const projectById = getInstallTargetAdapter('kiro-project');

    assert.strictEqual(byTarget.id, 'kiro-home');
    assert.strictEqual(byId.id, 'kiro-home');
    assert.strictEqual(projectById.id, 'kiro-project');
    assert.ok(byTarget.supports('kiro'));
    assert.ok(byTarget.supports('kiro-home'));
    assert.ok(projectById.supports('kiro'));
    assert.ok(projectById.supports('kiro-project'));
  })) passed++; else failed++;

  if (test('kiro home adapter strips category from skill paths and installs flat under ~/.kiro/skills/', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'kiro',
      repoRoot,
      homeDir,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'kiro-home');
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(homeDir, '.kiro', 'skills', 'tdd-workflow')
      )),
      'Should strip category and install skill flat under ~/.kiro/skills/'
    );
  })) passed++; else failed++;

  if (test('kiro project adapter strips category from skill paths and installs flat under .kiro/skills/', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'kiro-project',
      repoRoot,
      projectRoot,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'kiro-project');
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(projectRoot, '.kiro', 'skills', 'tdd-workflow')
      )),
      'Should strip category and install skill flat under .kiro/skills/'
    );
  })) passed++; else failed++;

  if (test('kiro adapters are included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('kiro'), 'Should include kiro target');
  })) passed++; else failed++;

  if (test('resolves trae adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('trae');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'trae-project');
    assert.strictEqual(adapter.target, 'trae');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.trae'));
    assert.strictEqual(statePath, path.join(projectRoot, '.trae', 'egc-install-state.json'));
  })) passed++; else failed++;

     if (test('resolves junie adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('junie');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'junie-project');
    assert.strictEqual(adapter.target, 'junie');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.junie'));
    assert.strictEqual(statePath, path.join(projectRoot, '.junie', 'egc-install-state.json'));
  })) passed++; else failed++;
 
    if (test('junie adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('junie');
    const byId = getInstallTargetAdapter('junie-project');

    assert.strictEqual(byTarget.id, 'junie-project');
    assert.strictEqual(byId.id, 'junie-project');
    assert.ok(byTarget.supports('junie'));
    assert.ok(byTarget.supports('junie-project'));
  })) passed++; else failed++;

  if (test('trae adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('trae');
    const byId = getInstallTargetAdapter('trae-project');

    assert.strictEqual(byTarget.id, 'trae-project');
    assert.strictEqual(byId.id, 'trae-project');
    assert.ok(byTarget.supports('trae'));
    assert.ok(byTarget.supports('trae-project'));
  })) passed++; else failed++;

  if (test('trae adapter preserves category structure under .trae/skills/ (default scaffold, no flat stripping)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'trae',
      repoRoot,
      projectRoot,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'trae-project');
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(projectRoot, '.trae', 'skills', 'workflow', 'tdd-workflow')
      )),
      'Should preserve skills/<category>/<name> structure under .trae/skills/, same default scaffold as gemini-project'
    );
  })) passed++; else failed++;

  if (test('trae adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('trae'), 'Should include trae target');
  })) passed++; else failed++;

  if (test('resolves goose adapter root to ~/.agents (shared with Codex) and its own install-state path', () => {
    const adapter = getInstallTargetAdapter('goose');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'goose-home');
    assert.strictEqual(adapter.target, 'goose');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.agents'));
    assert.strictEqual(statePath, path.join(homeDir, '.agents', 'egc', 'goose-install-state.json'));
  })) passed++; else failed++;

  if (test('goose adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('goose');
    const byId = getInstallTargetAdapter('goose-home');

    assert.strictEqual(byTarget.id, 'goose-home');
    assert.strictEqual(byId.id, 'goose-home');
    assert.ok(byTarget.supports('goose'));
    assert.ok(byTarget.supports('goose-home'));
  })) passed++; else failed++;

  if (test('goose adapter strips category from skill paths and installs flat under ~/.agents/skills/', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'goose',
      repoRoot,
      homeDir,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'goose-home');
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(homeDir, '.agents', 'skills', 'tdd-workflow')
      )),
      'Should strip category and install skill flat under ~/.agents/skills/, same root Codex writes to'
    );
  })) passed++; else failed++;

  if (test('goose adapter has no GateGuard hook wiring (unlike codex-home)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'goose',
      repoRoot,
      homeDir,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.ok(
      !plan.operations.some(operation => operation.kind === 'merge-claude-settings-hooks'),
      'Goose adapter should not register any hook merge operations'
    );
  })) passed++; else failed++;

  if (test('goose adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('goose'), 'Should include goose target');
  })) passed++; else failed++;

  if (test('resolves amazonq adapter root to .amazonq/rules and install-state path', () => {
    const adapter = getInstallTargetAdapter('amazonq');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'amazonq-project');
    assert.strictEqual(adapter.target, 'amazonq');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.amazonq', 'rules'));
    assert.strictEqual(statePath, path.join(projectRoot, '.amazonq', 'rules', 'egc-install-state.json'));
  })) passed++; else failed++;

  if (test('amazonq adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('amazonq');
    const byId = getInstallTargetAdapter('amazonq-project');

    assert.strictEqual(byTarget.id, 'amazonq-project');
    assert.strictEqual(byId.id, 'amazonq-project');
    assert.ok(byTarget.supports('amazonq'));
    assert.ok(byTarget.supports('amazonq-project'));
  })) passed++; else failed++;

  if (test('amazonq adapter preserves category structure under .amazonq/rules/ (default scaffold, no flat stripping)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'amazonq',
      repoRoot,
      projectRoot,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'amazonq-project');
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(projectRoot, '.amazonq', 'rules', 'skills', 'workflow', 'tdd-workflow')
      )),
      'Should preserve skills/<category>/<name> structure under .amazonq/rules/, same default scaffold as gemini-project'
    );
  })) passed++; else failed++;

  if (test('amazonq adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('amazonq'), 'Should include amazonq target');
  })) passed++; else failed++;

  if (test('resolves roocode adapter root to .roo/rules and install-state path', () => {
    const adapter = getInstallTargetAdapter('roocode');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'roocode-project');
    assert.strictEqual(adapter.target, 'roocode');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.roo', 'rules'));
    assert.strictEqual(statePath, path.join(projectRoot, '.roo', 'rules', 'egc-install-state.json'));
  })) passed++; else failed++;

  if (test('roocode adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('roocode');
    const byId = getInstallTargetAdapter('roocode-project');

    assert.strictEqual(byTarget.id, 'roocode-project');
    assert.strictEqual(byId.id, 'roocode-project');
    assert.ok(byTarget.supports('roocode'));
    assert.ok(byTarget.supports('roocode-project'));
  })) passed++; else failed++;

  if (test('roocode adapter preserves category structure under .roo/rules/', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'roocode',
      repoRoot,
      projectRoot,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'roocode-project');
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(
          projectRoot,
          '.roo',
          'rules',
          'skills',
          'workflow',
          'tdd-workflow'
        )
      )),
      'Should preserve skills/<category>/<name> structure under .roo/rules/'
    );
  })) passed++; else failed++;

  if (test('roocode adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('roocode'), 'Should include roocode target');
  })) passed++; else failed++;

  if (test('resolves openhands adapter root to ~/.agents (shared with Codex/Goose) and its own install-state path', () => {
    const adapter = getInstallTargetAdapter('openhands');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'openhands-home');
    assert.strictEqual(adapter.target, 'openhands');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.agents'));
    assert.strictEqual(statePath, path.join(homeDir, '.agents', 'egc', 'openhands-install-state.json'));
  })) passed++; else failed++;

  if (test('openhands adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('openhands');
    const byId = getInstallTargetAdapter('openhands-home');

    assert.strictEqual(byTarget.id, 'openhands-home');
    assert.strictEqual(byId.id, 'openhands-home');
    assert.ok(byTarget.supports('openhands'));
    assert.ok(byTarget.supports('openhands-home'));
  })) passed++; else failed++;

  if (test('openhands adapter strips category from skill paths and installs flat under ~/.agents/skills/', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'openhands',
      repoRoot,
      homeDir,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'openhands-home');
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(homeDir, '.agents', 'skills', 'tdd-workflow')
      )),
      'Should strip category and install skill flat under ~/.agents/skills/, same AgentSkills-standard root Codex/Goose write to'
    );
  })) passed++; else failed++;

  if (test('openhands adapter has no GateGuard hook wiring', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'openhands',
      repoRoot,
      homeDir,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.ok(
      !plan.operations.some(operation => operation.kind === 'merge-claude-settings-hooks'),
      'OpenHands adapter should not register any hook merge operations'
    );
  })) passed++; else failed++;

  if (test('openhands adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('openhands'), 'Should include openhands target');
  })) passed++; else failed++;

  if (test('resolves aider adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('aider');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'aider-project');
    assert.strictEqual(adapter.target, 'aider');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.aider'));
    assert.strictEqual(statePath, path.join(projectRoot, '.aider', 'egc-install-state.json'));
  })) passed++; else failed++;

  if (test('aider adapter emits a flat skill copy plus a merge-yaml-read-list operation per skill', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'aider',
      repoRoot,
      projectRoot,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'aider-project');

    const copyOp = plan.operations.find(op => op.kind === 'copy-path');
    assert.ok(copyOp, 'Should emit a copy-path operation for the skill file');
    assert.strictEqual(normalizedRelativePath(copyOp.sourceRelativePath), 'skills/workflow/tdd-workflow/SKILL.md');
    assert.strictEqual(copyOp.destinationPath, path.join(projectRoot, '.aider', 'skills', 'tdd-workflow.md'));

    const mergeOp = plan.operations.find(op => op.kind === 'merge-yaml-read-list');
    assert.ok(mergeOp, 'Should emit a merge-yaml-read-list operation for .aider.conf.yml');
    assert.strictEqual(mergeOp.destinationPath, path.join(projectRoot, '.aider.conf.yml'));
    assert.strictEqual(mergeOp.readEntry, path.join('.aider', 'skills', 'tdd-workflow.md'));
  })) passed++; else failed++;

  if (test('aider adapter filters out non-skill module paths (rules, agents, commands)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'aider',
      repoRoot,
      projectRoot,
      modules: [{ id: 'rules-core', paths: ['rules'] }],
    });

    assert.strictEqual(plan.operations.length, 0, 'Non-skill module paths should not produce operations');
  })) passed++; else failed++;

  if (test('aider adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('aider'), 'Should include aider target');
  })) passed++; else failed++;

  if (test('resolves warp adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('warp');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'warp-project');
    assert.strictEqual(adapter.target, 'warp');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.warp'));
    assert.strictEqual(statePath, path.join(projectRoot, '.warp', 'egc-install-state.json'));
  })) passed++; else failed++;

  if (test('warp adapter emits a flat skill copy plus a merge-markdown-skill-index operation per skill', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'warp',
      repoRoot,
      projectRoot,
      modules: [{ id: 'testing', paths: ['skills/testing/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'warp-project');

    const copyOp = plan.operations.find(op => op.kind === 'copy-path');
    assert.ok(copyOp, 'Should emit a copy-path operation for the skill file');
    assert.strictEqual(normalizedRelativePath(copyOp.sourceRelativePath), 'skills/testing/tdd-workflow/SKILL.md');
    assert.strictEqual(copyOp.destinationPath, path.join(projectRoot, '.warp', 'skills', 'tdd-workflow.md'));

    const mergeOp = plan.operations.find(op => op.kind === 'merge-markdown-skill-index');
    assert.ok(mergeOp, 'Should emit a merge-markdown-skill-index operation for AGENTS.md');
    assert.strictEqual(mergeOp.destinationPath, path.join(projectRoot, 'AGENTS.md'));
    assert.strictEqual(mergeOp.skillName, 'tdd-workflow');
    assert.strictEqual(mergeOp.relativePath, path.join('.warp', 'skills', 'tdd-workflow.md'));
    assert.ok(mergeOp.skillDescription.startsWith('Use this skill when writing new features'));
    assert.ok(mergeOp.skillDescription.length <= 110, 'Description should be truncated to the shared max length');
  })) passed++; else failed++;

  if (test('warp adapter extracts a description from a multiline YAML block-scalar frontmatter field', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'warp',
      repoRoot,
      projectRoot,
      modules: [{ id: 'ai', paths: ['skills/ai/token-budget-advisor'] }],
    });

    const mergeOp = plan.operations.find(op => op.kind === 'merge-markdown-skill-index');
    assert.ok(mergeOp, 'Should emit a merge operation for a skill with a block-scalar description');
    assert.ok(mergeOp.skillDescription.length > 0, 'Description should not be empty for a valid block scalar');
    assert.ok(!mergeOp.skillDescription.includes('\n'), 'Description should be collapsed onto one line');
  })) passed++; else failed++;

  if (test('warp adapter falls back to an empty description when SKILL.md has no frontmatter', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'warp',
      repoRoot,
      projectRoot,
      modules: [{ id: 'workflow', paths: ['skills/workflow/nonexistent-skill'] }],
    });

    const mergeOp = plan.operations.find(op => op.kind === 'merge-markdown-skill-index');
    assert.ok(mergeOp, 'Should still emit a merge operation even without a real source file');
    assert.strictEqual(mergeOp.skillDescription, '');
  })) passed++; else failed++;

  if (test('warp adapter filters out non-skill module paths (rules, agents, commands)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'warp',
      repoRoot,
      projectRoot,
      modules: [{ id: 'rules-core', paths: ['rules'] }],
    });

    assert.strictEqual(plan.operations.length, 0, 'Non-skill module paths should not produce operations');
  })) passed++; else failed++;

  if (test('warp adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('warp'), 'Should include warp target');
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
