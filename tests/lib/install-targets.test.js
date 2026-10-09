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

const {
  createInstallTargetAdapter,
} = require('../../scripts/lib/install-targets/helpers');
const { runWithoutConfigHomeVariables } = require('../fixtures/harness-variables');

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
  const tally = ok => (ok ? passed++ : failed++);

  tally(test('lists supported target adapters', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(adapter => adapter.target);
    assert.ok(targets.includes('egc'), 'Should include egc target');
    assert.ok(targets.includes('cursor'), 'Should include cursor target');
    assert.ok(targets.includes('antigravity'), 'Should include antigravity target');
    assert.ok(targets.includes('codex'), 'Should include codex target');
    for (const retired of ['gemini', 'continue', 'roocode', 'amazonq']) {
      assert.ok(!targets.includes(retired), `${retired} was retired and must stay out of the registry`);
    }
    assert.ok(targets.includes('opencode'), 'Should include opencode target');
    assert.ok(targets.includes('codebuddy'), 'Should include codebuddy target');
    assert.ok(targets.includes('claude'), 'Should include claude target');
  }));

  tally(test('retired targets are no longer registered (gemini, continue, roocode, amazonq)', () => {
    for (const retired of ['gemini', 'continue', 'continue-project', 'roocode', 'roocode-project', 'amazonq', 'amazonq-home', 'amazonq-project']) {
      assert.throws(
        () => getInstallTargetAdapter(retired),
        /Install target retired/,
        `${retired} must stay retired, with the retirement explained`
      );
    }
  }));

  tally(test('the retired adapters left the tree; their ids stay recognized and the Roo Code seeding factory is gone', () => {
    const fsModule = require('fs');
    const repoRoot = path.join(__dirname, '..', '..');
    for (const gone of [
      path.join('scripts', 'lib', 'install-targets', 'gemini-project.js'),
      path.join('scripts', 'lib', 'install-targets', 'continue-home.js'),
      path.join('scripts', 'lib', 'install-targets', 'continue-project.js'),
      path.join('scripts', 'lib', 'install-targets', 'roocode-project.js'),
      path.join('scripts', 'lib', 'continue-gateguard-hooks.js'),
      path.join('scripts', 'lib', 'roocode-guardian-denylist.js'),
      path.join('scripts', 'lib', 'install-targets', 'amazonq-home.js'),
      path.join('scripts', 'lib', 'install-targets', 'amazonq-project.js'),
      path.join('scripts', 'hooks', 'amazonq-guardian-adapter.js'),
      path.join('scripts', 'lib', 'amazonq-guardian-operations.js'),
    ]) {
      assert.ok(!fsModule.existsSync(path.join(repoRoot, gone)), `${gone} was retired with its product and is not kept for rollback`);
    }
    for (const retired of ['gemini', 'gemini-project', 'continue', 'continue-home', 'continue-project', 'roocode', 'roocode-project', 'amazonq', 'amazonq-home', 'amazonq-project']) {
      assert.throws(() => getInstallTargetAdapter(retired), /Install target retired/, `${retired} is still recognized and explained without its file`);
    }
    const settingsHooks = require('../../scripts/lib/claude-settings-hooks');
    assert.strictEqual(settingsHooks.createRoocodeDenylistMergeOperation, undefined, 'nothing plans the Roo Code denylist any more');
    const handlers = settingsHooks.resolveHookOperationHandlers('roocode-denied-commands');
    assert.ok(typeof handlers.remove === 'function' && typeof handlers.inspect === 'function', 'what an old install recorded is still inspected and removed');
  }));

  tally(test('resolves cursor adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('cursor');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(root, path.join(projectRoot, '.cursor'));
    assert.strictEqual(statePath, path.join(projectRoot, '.cursor', 'egc-install-state.json'));
  }));

  tally(test('resolves egc adapter root and install-state path from home dir', () => {
    const adapter = getInstallTargetAdapter('egc');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir, repoRoot: '/repo/egc' });
    const statePath = adapter.getInstallStatePath({ homeDir, repoRoot: '/repo/egc' });

    assert.strictEqual(root, path.join(homeDir, '.gemini'));
    assert.strictEqual(statePath, path.join(homeDir, '.gemini', 'egc', 'install-state.json'));
  }));

  tally(test('warns when the egc install state cannot be read, since config/skills is then left as the person\'s (#1705)', () => {
    const fs = require('fs');
    const adapter = getInstallTargetAdapter('egc');
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-unreadable-state-'));
    try {
      const unreadable = issues => issues.filter(issue => issue.code === 'install-state-unreadable');
      assert.deepStrictEqual(unreadable(adapter.validate({ homeDir, repoRoot })), [], 'no warning without a state file');
      const statePath = adapter.getInstallStatePath({ homeDir, repoRoot });
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, '{');
      const warnings = unreadable(adapter.validate({ homeDir, repoRoot }));
      assert.strictEqual(warnings.length, 1, 'one warning for an unreadable state');
      assert.strictEqual(warnings[0].severity, 'warning');
      assert.ok(warnings[0].message.includes(path.join(homeDir, '.gemini', 'config', 'skills')), warnings[0].message);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }));

  tally(test('plans egc skills where the Antigravity CLI, IDE and 2.0 read them, and rules flat under config/rules with a trigger (#1668)', () => {
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

    const destinations = plan.operations.map(operation => operation.destinationPath);
    const under = prefix => destinations.some(destination => destination === prefix || destination.startsWith(prefix + path.sep));
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/tdd-workflow'
        && operation.destinationPath === path.join(homeDir, '.gemini', 'config', 'skills', 'tdd-workflow')
      )),
      'Should install bundled skills under config/skills, where every Antigravity surface reads them'
    );
    const skillDestinations = plan.operations
      .filter(operation => normalizedRelativePath(operation.sourceRelativePath) === 'skills/tdd-workflow')
      .map(operation => operation.destinationPath)
      .sort();
    assert.deepStrictEqual(
      skillDestinations,
      [
        path.join(homeDir, '.gemini', 'config', 'skills', 'tdd-workflow'),
      ].sort(),
      'Each skill lands exactly once, under config/skills'
    );
    assert.ok(
      !under(path.join(homeDir, '.gemini', 'skills')),
      'skills/egc was the retired Gemini CLI layout: nothing is planned under ~/.gemini/skills'
    );
    const { plannedFileContent } = require('../../scripts/lib/install/copy-transforms');
    const configRules = path.join(homeDir, '.gemini', 'config', 'rules');
    const ruleOperations = plan.operations.filter(operation => normalizedRelativePath(operation.sourceRelativePath).startsWith('rules/'));
    assert.ok(ruleOperations.length > 100, 'every catalog rule is planned');
    assert.ok(ruleOperations.every(operation => path.dirname(operation.destinationPath) === configRules), 'each rule is one flat file under config/rules');
    assert.strictEqual(new Set(ruleOperations.map(operation => operation.destinationPath)).size, ruleOperations.length, 'no two languages share a file name');
    assert.ok(!under(path.join(homeDir, '.gemini', 'rules')), 'the rules/egc tree is not written any more');
    assert.ok(!destinations.includes(path.join(configRules, 'README.md')), 'the rules README is not a rule');
    const planned = (source, destination) => {
      const operation = ruleOperations.find(candidate => normalizedRelativePath(candidate.sourceRelativePath) === source);
      assert.ok(operation, `${source} is planned`);
      assert.strictEqual(operation.destinationPath, path.join(configRules, destination));
      return plannedFileContent(path.join(repoRoot, source), operation.transform).toString('utf8');
    };
    assert.ok(planned('rules/golang/coding-style.md', 'golang-coding-style.md').startsWith('---\ntrigger: glob\n'), 'a rule with paths is a glob rule');
    assert.ok(planned('rules/common/coding-style.md', 'common-coding-style.md').startsWith('---\ntrigger: always_on\n'), 'a common rule is always on');
    assert.ok(planned('rules/zh/coding-style.md', 'zh-coding-style.md').startsWith('---\ntrigger: manual\n'), 'the Chinese translation of the common rules is manual, so the same rule never loads twice');
  }));

  tally(test('a bundled skill wins over a command of the same name, at home and in the project (#1706)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const projectRoot = '/workspace/app';
    const selections = [
      [{ id: 'commands-core', paths: ['commands'] }, { id: 'security', paths: ['skills/security/security-scan'] }],
      [{ id: 'commands-core', paths: ['commands'] }, { id: 'security', paths: ['skills/security/security-scan/SKILL.md'] }],
    ];
    const cases = selections.flatMap(modules => [
      ['egc', path.join(homeDir, '.gemini', 'config', 'skills'), modules],
      ['antigravity', path.join(projectRoot, '.agents', 'skills'), modules],
    ]);
    for (const [target, skillsRoot, modules] of cases) {
      const plan = planInstallTargetScaffold({ target, repoRoot, homeDir, projectRoot, modules });
      const shadowed = plan.operations.filter(operation => (
        operation.destinationPath === path.join(skillsRoot, 'security-scan')
        || operation.destinationPath.startsWith(path.join(skillsRoot, 'security-scan') + path.sep)
      ));
      assert.deepStrictEqual(shadowed.map(operation => normalizedRelativePath(operation.sourceRelativePath)), [modules[1].paths[0]], `${target}: the skill answers /security-scan, the command is not written over it (${modules[1].paths[0]})`);
      assert.ok(plan.operations.some(operation => operation.destinationPath === path.join(skillsRoot, 'plan', 'SKILL.md')), `${target}: the other commands are planned`);
    }
  }));

  tally(test('the egc target plans nothing that only the retired Gemini CLI read', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const root = path.join(homeDir, '.gemini');

    const plan = planInstallTargetScaffold({
      target: 'egc',
      repoRoot,
      homeDir,
      modules: [
        { id: 'agents-core', paths: ['.agents', 'agents', 'AGENTS.md'] },
        { id: 'commands-core', paths: ['commands'] },
        { id: 'hooks-runtime', paths: ['hooks', 'scripts/hooks', 'scripts/lib'] },
        { id: 'platform-configs', paths: ['.gemini-plugin', 'mcp-configs', 'scripts/setup-package-manager.js'] },
      ],
    });

    const destinations = plan.operations.map(operation => operation.destinationPath);
    const under = prefix => destinations.some(destination => destination === prefix || destination.startsWith(prefix + path.sep));
    for (const kept of ['AGENTS.md', path.join('scripts', 'hooks'), path.join('scripts', 'lib'), path.join('scripts', 'setup-package-manager.js')]) {
      assert.ok(destinations.includes(path.join(root, kept)), `${kept} is still written: Antigravity reads AGENTS.md and its hooks run from scripts/`);
    }
    const commandOperations = plan.operations.filter(operation => normalizedRelativePath(operation.sourceRelativePath).startsWith('commands/'));
    assert.deepStrictEqual(
      commandOperations.map(operation => operation.destinationPath).sort(),
      require('fs').readdirSync(path.join(repoRoot, 'commands')).filter(name => name.endsWith('.md'))
        .map(name => path.join(root, 'config', 'skills', name.slice(0, -3), 'SKILL.md')).sort(),
      'each command is a skill under config/skills, invoked as /<name> (#1706)'
    );
    assert.ok(commandOperations.every(operation => operation.transform === 'antigravity-command-skill'));
    assert.ok(!under(path.join(root, 'commands')), 'nothing is planned under ~/.gemini/commands any more (#1706)');
    const agentOperations = plan.operations.filter(operation => normalizedRelativePath(operation.sourceRelativePath).startsWith('agents/'));
    assert.deepStrictEqual(
      agentOperations.map(operation => normalizedRelativePath(operation.sourceRelativePath)).sort(),
      require('fs').readdirSync(path.join(repoRoot, 'agents')).filter(name => name.endsWith('.md')).map(name => `agents/${name}`).sort(),
      'every catalog agent is planned exactly once'
    );
    assert.ok(agentOperations.every(operation => (
      path.dirname(operation.destinationPath) === path.join(root, 'config', 'agents')
      && operation.transform === 'antigravity-agent-frontmatter'
    )), 'each agent is one file under config/agents, in the subagent format (#1669)');
    assert.ok(destinations.includes(path.join(root, 'config', 'agents', 'architect.md')));
    assert.ok(!under(path.join(root, 'agents')), 'nothing is planned under ~/.gemini/agents any more (#1669)');
    for (const residue of ['.agents', 'hooks', 'mcp-configs']) {
      assert.ok(!under(path.join(root, residue)), `${residue} was the retired Gemini CLI layout: nothing is planned there`);
    }
    assert.ok(!destinations.includes(root), 'the .gemini-plugin manifest is no longer spread over the root (plugin.json, marketplace.json, README.md)');
    assert.ok(!destinations.some(destination => destination.includes('.gemini-plugin')), 'nor copied as a directory');
  }));

  tally(test('plans scaffold operations and flattens native target roots', () => {
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

    const hooksJsonRawCopy = plan.operations.find(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === '.cursor/hooks.json'
    ));
    const hooksJsonMerge = plan.operations.find(operation => (
      operation.destinationPath === path.join(projectRoot, '.cursor', 'hooks.json')
      && operation.kind === 'merge-claude-settings-hooks'
    ));
    const mcpJson = plan.operations.find(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === '.mcp.json'
    ));
    const preserved = plan.operations.find(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === '.cursor/rules/common-coding-style.md'
    ));

    assert.ok(
      !hooksJsonRawCopy,
      'Should not copy the repo\'s own .cursor/hooks.json raw -- the Guardian merge operation owns that destination alone'
    );
    assert.ok(hooksJsonMerge, 'hooks.json should still be planned, but only via the Guardian merge operation');
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
  }));

  tally(test('cursor adapter always plans the Guardian beforeShellExecution hook, even with no modules selected (EGC-494/EGC-498)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'cursor',
      repoRoot,
      projectRoot,
      modules: [],
    });
    const targetRoot = path.join(projectRoot, '.cursor');
    const adapterScriptDestination = path.join(targetRoot, 'scripts', 'hooks', 'cursor-guardian-adapter.js');

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/pre-bash-guardian-validate.js'
        && operation.destinationPath === path.join(targetRoot, 'scripts', 'hooks', 'pre-bash-guardian-validate.js')
      )),
      'Should plan the shared Guardian validator copy even with no modules selected'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/cursor-guardian-adapter.js'
        && operation.destinationPath === adapterScriptDestination
      )),
      'Should plan the Cursor-specific adapter copy even with no modules selected'
    );

    const mergeOperation = plan.operations.find(
      operation => operation.kind === 'merge-claude-settings-hooks' && operation.hookEvent === 'beforeShellExecution'
    );
    assert.ok(mergeOperation, 'Should plan the beforeShellExecution hooks.json merge');
    assert.strictEqual(mergeOperation.destinationPath, path.join(targetRoot, 'hooks.json'));
    assert.strictEqual(mergeOperation.hookScriptPath, adapterScriptDestination);
  }));

  tally(test('cursor .cursor module never copies the repo\'s own hooks.json raw (the Guardian merge owns that destination alone)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'cursor',
      repoRoot,
      projectRoot,
      modules: [{ id: 'platform-configs', paths: ['.cursor'] }],
    });
    const targetRoot = path.join(projectRoot, '.cursor');
    const hooksJsonDestination = path.join(targetRoot, 'hooks.json');

    const operationsForHooksJson = plan.operations.filter(operation => operation.destinationPath === hooksJsonDestination);
    assert.strictEqual(
      operationsForHooksJson.length,
      2,
      'Exactly two operations should target hooks.json: the Guardian merge (beforeShellExecution) and the Crusher merge (preToolUse) -- never a raw copy'
    );
    assert.ok(
      operationsForHooksJson.every(operation => operation.kind === 'merge-claude-settings-hooks'),
      'Every operation targeting hooks.json must be a merge, never a raw copy that would clobber the other event\'s entry'
    );

    const guardianMerge = operationsForHooksJson.find(operation => operation.hookEvent === 'beforeShellExecution');
    assert.ok(guardianMerge, 'Should include the Guardian beforeShellExecution merge');
    assert.strictEqual(
      guardianMerge.seedPath,
      path.join(repoRoot, '.cursor', 'hooks.json'),
      'The Guardian merge operation should carry the repo\'s own hooks.json as a seed, so a fresh install still gets EGC\'s other platform hooks (sessionStart, GateGuard, etc.), not just the Guardian entry'
    );

    const crusherMerge = operationsForHooksJson.find(operation => operation !== guardianMerge);
    assert.ok(crusherMerge, 'Should include the Crusher preToolUse merge');
    assert.strictEqual(
      crusherMerge.hookEvent,
      'cursor:preToolUse',
      'The Crusher merge must use its own internal dispatch key, distinct from Kiro\'s preToolUse operation.hookEvent, which uses the same literal event name for a different merge schema'
    );
    assert.strictEqual(
      crusherMerge.seedPath,
      undefined,
      'The Crusher merge should never carry a seedPath -- only the Guardian merge seeds the fresh file, so the repo\'s own hooks.json is never seeded twice'
    );
  }));

  tally(test('cursor Guardian merge omits seedPath when the .cursor module was not selected (minimal/rules-only installs stay minimal)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'cursor',
      repoRoot,
      projectRoot,
      modules: [{ id: 'rules-core', paths: ['rules'] }],
    });
    const targetRoot = path.join(projectRoot, '.cursor');
    const hooksJsonDestination = path.join(targetRoot, 'hooks.json');

    const mergeOperation = plan.operations.find(operation => operation.destinationPath === hooksJsonDestination);
    assert.ok(mergeOperation, 'The Guardian merge should still be planned unconditionally');
    assert.strictEqual(
      mergeOperation.seedPath,
      undefined,
      'Should not seed this repo\'s own platform hooks (dashboard-emit, tmux blocker, etc.) into an install that never selected .cursor'
    );
  }));

  tally(test('cursor hooks-runtime module does not duplicate the Guardian\'s own per-file copies (its directory scaffold already covers them)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'cursor',
      repoRoot,
      projectRoot,
      modules: [{ id: 'hooks-runtime', paths: ['scripts/hooks', 'scripts/lib'] }],
    });

    const guardianAdapterCopies = plan.operations.filter(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/cursor-guardian-adapter.js'
    ));
    assert.strictEqual(
      guardianAdapterCopies.length,
      1,
      'The adapter script should come from the scripts/hooks directory scaffold exactly once, not also as a redundant standalone copy'
    );
  }));

  tally(test('plans cursor rules with flat namespaced filenames to avoid rule collisions', () => {
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
  }));

  tally(test('does not install root AGENTS.md into Cursor nested context', () => {
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
  }));

  tally(test('plans cursor agents with egc-prefixed filenames to avoid agent collisions', () => {
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
  }));

  tally(test('plans cursor platform rule files as .mdc and excludes rule README docs', () => {
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
      !plan.operations.some(operation => normalizedRelativePath(operation.sourceRelativePath) === '.cursor/hooks.json'),
      'Should not copy the repo\'s own .cursor/hooks.json raw -- the Guardian merge operation owns that destination alone'
    );
    assert.ok(
      plan.operations.some(operation => (
        operation.destinationPath === path.join(projectRoot, '.cursor', 'hooks.json')
        && operation.kind === 'merge-claude-settings-hooks'
      )),
      'hooks.json should still be planned, but only via the Guardian merge operation'
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
  }));

  tally(test('deduplicates cursor rule destinations when rules-core and platform-configs overlap', () => {
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
  }));

  tally(test('prefers native cursor hooks when hooks-runtime and platform-configs overlap', () => {
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
  }));

  tally(test('plans antigravity remaps for workflows, subagents, and flat rules (#1669)', () => {
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

    const commandOperations = plan.operations.filter(operation => normalizedRelativePath(operation.sourceRelativePath).startsWith('commands/'));
    assert.deepStrictEqual(
      commandOperations.map(operation => operation.destinationPath).sort(),
      require('fs').readdirSync(path.join(repoRoot, 'commands')).filter(name => name.endsWith('.md'))
        .map(name => path.join(projectRoot, '.agents', 'skills', name.slice(0, -3), 'SKILL.md')).sort(),
      'each command is a workspace skill, since Antigravity stops running workflows (#1706)'
    );
    assert.ok(!plan.operations.some(operation => operation.destinationPath.startsWith(path.join(projectRoot, '.agents', 'workflows'))), 'nothing is planned under .agents/workflows');
    const agentOperations = plan.operations.filter(operation => normalizedRelativePath(operation.sourceRelativePath).startsWith('agents/'));
    assert.deepStrictEqual(
      agentOperations.map(operation => normalizedRelativePath(operation.sourceRelativePath)).sort(),
      require('fs').readdirSync(path.join(repoRoot, 'agents')).filter(name => name.endsWith('.md')).map(name => `agents/${name}`).sort(),
      'every catalog agent is planned exactly once'
    );
    assert.ok(agentOperations.every(operation => (
      path.dirname(operation.destinationPath) === path.join(projectRoot, '.agents', 'agents')
      && operation.transform === 'antigravity-agent-frontmatter'
    )), 'each agent is one file under .agents/agents, where Antigravity reads workspace subagents');
    assert.ok(!plan.operations.some(operation => operation.destinationPath.startsWith(path.join(projectRoot, '.agents', 'skills') + path.sep)
      && normalizedRelativePath(operation.sourceRelativePath).startsWith('agents')), 'no agent lands under .agents/skills any more');
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'rules/common/coding-style.md'
        && operation.destinationPath === path.join(projectRoot, '.agents', 'rules', 'common-coding-style.md')
      )),
      'Should flatten common rules for antigravity'
    );
  }));

  tally(test('exposes validate and planOperations on adapters', () => {
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
  }));

  tally(test('the missing-IDE warning names Devin Desktop and links to it, not to Windsurf', () => {
    const adapter = getInstallTargetAdapter('windsurf-home');
    const homeDir = path.join(os.tmpdir(), 'egc-devin-desktop-home-that-does-not-exist');
    const warning = adapter.validate({ homeDir, repoRoot: '/repo/egc' })
      .find(issue => issue.code === 'ide-not-detected');

    assert.ok(warning, 'a home without ~/.codeium/windsurf gets the ide-not-detected warning');
    assert.match(warning.message, /^Devin Desktop does not appear to be installed/);
    assert.match(warning.message, /https:\/\/devin\.ai\/desktop/);
    assert.ok(!warning.message.includes('Windsurf'), 'the former product name is gone from the warning');
  }));

  // #1491, decision 3: Crush installs only where Crush is present, so a home
  // without its config directory gets the same warning --require-detected
  // turns into a refusal.
  tally(test('the missing-IDE warning names Crush and links to it when its config directory is absent', () => runWithoutConfigHomeVariables(() => {
    const adapter = getInstallTargetAdapter('crush');
    const homeDir = path.join(os.tmpdir(), 'egc-crush-home-that-does-not-exist');
    const warning = adapter.validate({ homeDir, repoRoot: '/repo/egc' })
      .find(issue => issue.code === 'ide-not-detected');

    assert.ok(warning, 'a home without ~/.config/crush gets the ide-not-detected warning');
    assert.match(warning.message, /^Crush does not appear to be installed/);
    assert.match(warning.message, /https:\/\/github\.com\/charmbracelet\/crush/);
    assert.ok(warning.message.includes(path.join(homeDir, '.config', 'crush')), 'the warning names the expected config directory');
  })));

  // Devin Desktop loads .devin/skills/ when it exists and only falls back to
  // .windsurf/skills/ when it does not (never merged), so the skills
  // directory decides the root. These cases pin that down.
  tally(test('windsurf-project writes where Devin Desktop reads skills: .devin/ once .devin/skills/ exists, .windsurf/ while it holds the only skills, .devin/ on a fresh project', () => {
    const fs = require('fs');
    const adapter = getInstallTargetAdapter('windsurf-project');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-devin-workspace-'));
    try {
      assert.strictEqual(adapter.resolveRoot({ projectRoot }), path.join(projectRoot, '.devin'), 'a fresh project gets the current layout');
      fs.mkdirSync(path.join(projectRoot, '.windsurf'));
      assert.strictEqual(adapter.resolveRoot({ projectRoot }), path.join(projectRoot, '.windsurf'), 'a project that only has .windsurf/ keeps it: a new .devin/skills/ beside it would hide every skill in it');
      assert.ok(!adapter.validate({ projectRoot, repoRoot: '/repo/egc' }).some(issue => issue.code === 'ide-not-detected'), 'the legacy directory counts as the tool being there');
      fs.mkdirSync(path.join(projectRoot, '.devin'));
      assert.strictEqual(adapter.resolveRoot({ projectRoot }), path.join(projectRoot, '.windsurf'), 'a .devin/ without skills does not hide .windsurf/skills/, so the root stays');
      fs.mkdirSync(path.join(projectRoot, '.devin', 'skills'));
      assert.strictEqual(adapter.resolveRoot({ projectRoot }), path.join(projectRoot, '.devin'), 'once .devin/skills/ exists Devin reads skills only there');
      assert.strictEqual(adapter.getInstallStatePath({ projectRoot }), path.join(projectRoot, '.devin', 'egc-install-state.json'));
      assert.deepStrictEqual(
        adapter.resolveManagedRoots({ projectRoot }),
        [path.join(projectRoot, '.devin'), path.join(projectRoot, '.windsurf')],
        'retirement may clean both directories'
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }));

  tally(test('windsurf-project reports the install state it recorded under .windsurf/ once the root moved to .devin/', () => {
    const fs = require('fs');
    const adapter = getInstallTargetAdapter('windsurf-project');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-devin-legacy-state-'));
    try {
      const legacyStatePath = path.join(projectRoot, '.windsurf', 'egc-install-state.json');
      assert.deepStrictEqual(adapter.resolveLegacyInstallStatePaths({ projectRoot }), [], 'nothing legacy on a fresh project');
      fs.mkdirSync(path.join(projectRoot, '.windsurf'));
      fs.writeFileSync(legacyStatePath, '{}');
      assert.deepStrictEqual(adapter.resolveLegacyInstallStatePaths({ projectRoot }), [], 'while .windsurf/ is the root, its state is the current one');
      fs.mkdirSync(path.join(projectRoot, '.devin', 'skills'), { recursive: true });
      assert.deepStrictEqual(adapter.resolveLegacyInstallStatePaths({ projectRoot }), [legacyStatePath]);
      const plan = planInstallTargetScaffold({ target: 'windsurf-project', repoRoot: path.join(__dirname, '..', '..'), projectRoot, modules: [] });
      assert.deepStrictEqual(plan.legacyInstallStatePaths, [legacyStatePath], 'the plan carries it for the apply');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }));

  tally(test('an install into .devin/ retires what EGC copied under .windsurf/ and drops the legacy state', () => {
    const fs = require('fs');
    const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
    const { applyInstallPlan } = require('../../scripts/lib/install/apply');
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-devin-migration-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-devin-migration-home-'));
    try {
      const source = 'skills/ai/agent-eval/SKILL.md';
      const legacyRoot = path.join(projectRoot, '.windsurf');
      const legacyDestination = path.join(legacyRoot, 'skills', 'agent-eval', 'SKILL.md');
      const legacyStatePath = path.join(legacyRoot, 'egc-install-state.json');
      fs.mkdirSync(path.dirname(legacyDestination), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, source), legacyDestination);
      const stateFields = {
        request: { profile: 'developer', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: ['skills-extended'], skippedModules: [] },
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      };
      writeInstallState(legacyStatePath, createInstallState({
        ...stateFields,
        adapter: { id: 'windsurf-project', target: 'windsurf', kind: 'project' },
        targetRoot: legacyRoot,
        installStatePath: legacyStatePath,
        operations: [{
          kind: 'copy-file',
          moduleId: 'skills-extended',
          sourceRelativePath: source,
          destinationPath: legacyDestination,
          strategy: 'preserve-relative-path',
          ownership: 'managed',
          scaffoldOnly: false,
        }],
      }));
      fs.mkdirSync(path.join(projectRoot, '.devin', 'skills'), { recursive: true });

      const modules = [{ id: 'skills-extended', paths: [source] }];
      const plan = planInstallTargetScaffold({ target: 'windsurf-project', repoRoot, projectRoot, modules });
      assert.strictEqual(plan.targetRoot, path.join(projectRoot, '.devin'));
      assert.ok(plan.retirements.some(entry => entry.destinationPath === legacyDestination), 'the .windsurf/ copy left the plan and is offered for retirement');

      // Hydrated the way the install command materializes a scaffold plan
      // before handing it to the apply.
      const operations = plan.operations.map(operation => ({
        ...operation,
        kind: 'copy-file',
        scaffoldOnly: false,
        sourcePath: path.join(repoRoot, operation.sourceRelativePath),
      }));
      const statePreview = createInstallState({
        ...stateFields,
        adapter: plan.adapter,
        targetRoot: plan.targetRoot,
        installStatePath: plan.installStatePath,
        operations,
      });
      applyInstallPlan({ ...plan, operations, statePreview }, { homeDir });
      assert.ok(fs.existsSync(path.join(projectRoot, '.devin', 'skills', 'agent-eval', 'SKILL.md')), 'the skill now lives where Devin reads it');
      assert.ok(fs.existsSync(plan.installStatePath), 'the state now lives under .devin/');
      assert.ok(!fs.existsSync(legacyDestination), 'the byte-identical copy under .windsurf/ is gone');
      assert.ok(!fs.existsSync(legacyStatePath), 'the legacy state is gone with it');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }));

  tally(test('throws on unknown target adapter', () => {
    assert.throws(
      () => getInstallTargetAdapter('ghost-target'),
      /Unknown install target adapter/
    );
  }));

  tally(test('resolves codebuddy adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('codebuddy');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'codebuddy-project');
    assert.strictEqual(adapter.target, 'codebuddy');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.codebuddy'));
    assert.strictEqual(statePath, path.join(projectRoot, '.codebuddy', 'egc-install-state.json'));
  }));

  tally(test('resolves cline adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('cline');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'cline-project');
    assert.strictEqual(adapter.target, 'cline');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.clinerules'));
    assert.strictEqual(
      statePath,
      path.join(projectRoot, '.clinerules', 'egc-install-state.json')
    );
  }));

  tally(test('cline adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('cline');
    const byId = getInstallTargetAdapter('cline-project');

    assert.strictEqual(byTarget.id, 'cline-project');
    assert.strictEqual(byId.id, 'cline-project');
    assert.ok(byTarget.supports('cline'));
    assert.ok(byTarget.supports('cline-project'));
  }));

  tally(test('plans cline rules as flat namespaced files under .clinerules', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'cline',
      repoRoot,
      projectRoot,
      modules: [
        {
          id: 'rules-core',
          paths: ['rules'],
        },
      ],
    });

    assert.strictEqual(plan.adapter.id, 'cline-project');
    assert.strictEqual(plan.targetRoot, path.join(projectRoot, '.clinerules'));
    assert.strictEqual(
      plan.installStatePath,
      path.join(projectRoot, '.clinerules', 'egc-install-state.json')
    );

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'rules/common/coding-style.md'
        && operation.destinationPath === path.join(
          projectRoot,
          '.clinerules',
          'common-coding-style.md'
        )
      )),
      'Should flatten common rules into namespaced files for Cline'
    );

    assert.ok(
      !plan.operations.some(operation => (
        operation.destinationPath === path.join(
          projectRoot,
          '.clinerules',
          'common',
          'coding-style.md'
        )
      )),
      'Should not preserve nested rule directories for Cline installs'
    );
  }));

  tally(test('cline adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(adapter => adapter.target);

    assert.ok(targets.includes('cline'), 'Should include cline target');
  }));

  tally(test('cline adapter always plans the Guardian PreToolUse hook (Unix + Windows), even with no modules selected', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';
    const targetRoot = path.join(projectRoot, '.clinerules');
    const hooksDir = path.join(targetRoot, 'hooks');

    const plan = planInstallTargetScaffold({
      target: 'cline',
      repoRoot,
      projectRoot,
      modules: [],
    });

    // Cline has no hooks.json to merge into -- discovery is by filename, so
    // this is a plain file copy per platform, not a HOOK_OPERATION_KIND merge.
    // PreToolUse/PreToolUse.ps1 are thin shims (Cline requires this exact
    // filename); the real adapter, with its own require()'d dependencies,
    // installs at the normal .clinerules/scripts/hooks/ location instead.
    const unixShim = plan.operations.find(operation => operation.destinationPath === path.join(hooksDir, 'PreToolUse'));
    const windowsShim = plan.operations.find(operation => operation.destinationPath === path.join(hooksDir, 'PreToolUse.ps1'));

    assert.ok(unixShim, 'Should plan the Unix PreToolUse shim copy even with no modules selected');
    assert.ok(windowsShim, 'Should plan the Windows PreToolUse.ps1 shim copy even with no modules selected');
    assert.strictEqual(normalizedRelativePath(unixShim.sourceRelativePath), 'scripts/hooks/cline-pretooluse-shim.js');
    assert.strictEqual(normalizedRelativePath(windowsShim.sourceRelativePath), 'scripts/hooks/cline-guardian-adapter.ps1');

    const realAdapterDestination = path.join(targetRoot, 'scripts', 'hooks', 'cline-guardian-adapter.js');
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/cline-guardian-adapter.js'
        && operation.destinationPath === realAdapterDestination
      )),
      'Should plan the real adapter at .clinerules/scripts/hooks/, next to its own dependencies'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/pre-bash-guardian-validate.js'
        && operation.destinationPath === path.join(targetRoot, 'scripts', 'hooks', 'pre-bash-guardian-validate.js')
      )),
      'Should plan the shared Guardian validator script copy at the destination cline-guardian-adapter.js requires as a sibling'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/lib/adapter-stdin-json.js'
        && operation.destinationPath === path.join(targetRoot, 'scripts', 'lib', 'adapter-stdin-json.js')
      )),
      'Should plan the shared adapter-stdin-json.js dependency copy at the destination cline-guardian-adapter.js requires as a sibling'
    );
  }));

  tally(test('cline adapter refuses to overwrite a pre-existing, non-EGC PreToolUse hook, but reinstalls over its own', () => {
    // Cline has no hooks.json to merge into -- unlike every other host, it
    // looks up exactly one file per hook name, so silently overwriting a
    // user's own unrelated .clinerules/hooks/PreToolUse (and later deleting
    // it on uninstall, with no restore) would destroy their file with no
    // way back (cubic-dev-ai P1 finding, PR #1087). This needs a real
    // filesystem, not the synthetic /workspace/app paths every other test
    // in this file uses, since the check reads the actual destination.
    const fs = require('fs');
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-cline-hook-test-'));
    try {
      const hooksDir = path.join(projectRoot, '.clinerules', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });

      const foreignHookPath = path.join(hooksDir, 'PreToolUse');
      fs.writeFileSync(foreignHookPath, '#!/usr/bin/env node\n// a user\'s own unrelated hook, nothing to do with EGC\n');

      const planWithForeignFile = planInstallTargetScaffold({ target: 'cline', repoRoot, projectRoot, modules: [] });
      assert.ok(
        !planWithForeignFile.operations.some(operation => operation.destinationPath === foreignHookPath),
        'Should NOT plan an operation that would overwrite the pre-existing foreign PreToolUse file'
      );

      // Once EGC's own shim is the one on disk (recognizable by its header
      // marker), reinstall/repair must still work normally.
      fs.copyFileSync(path.join(repoRoot, 'scripts', 'hooks', 'cline-pretooluse-shim.js'), foreignHookPath);
      const planOverOwnFile = planInstallTargetScaffold({ target: 'cline', repoRoot, projectRoot, modules: [] });
      assert.ok(
        planOverOwnFile.operations.some(operation => operation.destinationPath === foreignHookPath),
        'Should plan the normal reinstall operation once the existing file is recognizably EGC\'s own'
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }));

  tally(test('codebuddy adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('codebuddy');
    const byId = getInstallTargetAdapter('codebuddy-project');

    assert.strictEqual(byTarget.id, 'codebuddy-project');
    assert.strictEqual(byId.id, 'codebuddy-project');
    assert.ok(byTarget.supports('codebuddy'));
    assert.ok(byTarget.supports('codebuddy-project'));
  }));

  tally(test('plans codebuddy rules with flat namespaced filenames', () => {
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
  }));

  tally(test('exposes validate and planOperations on codebuddy adapter', () => {
    const codebuddyAdapter = getInstallTargetAdapter('codebuddy');

    assert.strictEqual(typeof codebuddyAdapter.planOperations, 'function');
    assert.strictEqual(typeof codebuddyAdapter.validate, 'function');
    assert.ok(
      !codebuddyAdapter.validate({ projectRoot: '/workspace/app', repoRoot: '/repo/egc' })
        .some(i => i.severity === 'error'),
      'codebuddy adapter should have no blocking validation errors'
    );
  }));

  tally(test('resolves claude adapter root and install-state path from home dir', () => {
    const adapter = getInstallTargetAdapter('claude');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'claude-home');
    assert.strictEqual(adapter.target, 'claude');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.claude'));
    assert.strictEqual(statePath, path.join(homeDir, '.claude', 'egc', 'install-state.json'));
  }));

  tally(test('claude adapter strips category from skill paths and installs flat', () => {
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
  }));

  tally(test('claude adapter always plans the SessionStart state hook operations', () => {
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
  }));

  tally(test('claude adapter plans the Scrubber write hook for Edit, Write, and MultiEdit', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const plan = planInstallTargetScaffold({ target: 'claude', repoRoot, homeDir, modules: [] });
    const scrubberMerges = plan.operations.filter(
      operation => normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/scrubber-hook.js'
        && operation.hookEvent === 'PreToolUse'
    );
    assert.strictEqual(scrubberMerges.length, 3, 'Should register the Scrubber hook for Edit, Write, and MultiEdit');
    for (const op of scrubberMerges) {
      assert.strictEqual(op.destinationPath, path.join(homeDir, '.claude', 'settings.json'));
    }
    assert.deepStrictEqual(scrubberMerges.map(o => o.hookMatcher).sort(), ['Edit', 'MultiEdit', 'Write']);
    // The hook script and its scrubber-lib dependencies are copied too, so a
    // minimal install without hooks-runtime still has a working hook.
    for (const dep of ['scripts/hooks/scrubber-hook.js', 'scripts/lib/scrubber/engine.js', 'scripts/lib/scrubber/binary-guard.js']) {
      assert.ok(
        plan.operations.some(op => normalizedRelativePath(op.sourceRelativePath) === dep && op.hookEvent !== 'PreToolUse'),
        `Should copy ${dep}`
      );
    }
  }));

  tally(test('claude adapter copies egc-memory-save.js and its lib deps even with no modules selected (EGC-495)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'claude',
      repoRoot,
      homeDir,
      modules: [],
    });
    const scriptDestination = path.join(
      homeDir, '.claude', 'scripts', 'hooks', 'egc-memory-save.js'
    );

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/egc-memory-save.js'
        && operation.destinationPath === scriptDestination
      )),
      'Should plan the egc-memory-save.js copy even with no modules selected, so PreCompact never points at a missing script'
    );

    for (const libSource of ['scripts/lib/state-snapshot.js', 'scripts/lib/branch-state.js']) {
      assert.ok(
        plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === libSource
          && operation.destinationPath === path.join(homeDir, '.claude', ...libSource.split('/'))
        )),
        `Should plan the ${libSource} copy even with no modules selected`
      );
    }

    const preCompactMergeOperation = plan.operations.find(
      operation => operation.kind === 'merge-claude-settings-hooks' && operation.hookEvent === 'PreCompact'
    );
    assert.ok(preCompactMergeOperation, 'Should plan the PreCompact settings.json hook merge');
    assert.strictEqual(preCompactMergeOperation.hookScriptPath, scriptDestination);
  }));

  tally(test('claude adapter registers the GateGuard fact-force hook on Edit/Write/MultiEdit, not just Bash', () => {
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
  }));

  tally(test('codex adapter wires GateGuard into ~/.codex/hooks.json, not ~/.agents (Codex CLI does not read hooks from its skills root)', () => {
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
  }));

  tally(test('codex adapter also wires the Token Crusher into ~/.codex/hooks.json on the Bash matcher', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'codex',
      repoRoot,
      homeDir,
      modules: [],
    });

    const codexHome = path.join(homeDir, '.codex');
    const crusherScriptPath = path.join(codexHome, 'scripts', 'hooks', 'crusher-hook.js');

    const crusherHookOps = plan.operations.filter(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.hookEvent === 'PreToolUse'
      && operation.hookScriptPath === crusherScriptPath
    ));
    assert.strictEqual(crusherHookOps.length, 1, 'Crusher is registered once, on Bash only (apply_patch has nothing to crush)');
    assert.strictEqual(crusherHookOps[0].hookMatcher, 'Bash');
    assert.strictEqual(crusherHookOps[0].destinationPath, path.join(codexHome, 'hooks.json'));

    // The whole crusher dependency tree must be scaffolded so the requires resolve.
    for (const src of [
      'scripts/hooks/crusher-hook.js',
      'scripts/hooks/pre-bash-crusher-rewrite.js',
      'scripts/hooks/pretooluse-output.js',
      'scripts/lib/crusher/engine.js',
    ]) {
      const op = plan.operations.find(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === src
        && operation.destinationPath === path.join(codexHome, ...src.split('/'))
      ));
      assert.ok(op, `Should scaffold ${src} into ~/.codex`);
    }
  }));

  tally(test('codex adapter also wires EGC Guardian into ~/.codex/hooks.json on the Bash matcher (2026-07-27 gap fix)', () => {
    // Confirmed via https://developers.openai.com/codex/hooks (redirects to
    // https://learn.chatgpt.com/docs/hooks) that Codex supports the plain
    // exit-code-2-plus-stderr blocking contract pre-bash-guardian-validate.js
    // already uses for Claude Code, as an alternative to the JSON
    // hookSpecificOutput.permissionDecision form -- so it is wired directly,
    // with no translation adapter (unlike Devin Desktop's).
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'codex',
      repoRoot,
      homeDir,
      modules: [],
    });

    const codexHome = path.join(homeDir, '.codex');
    const guardianScriptPath = path.join(codexHome, 'scripts', 'hooks', 'pre-bash-guardian-validate.js');

    const guardianHookOps = plan.operations.filter(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.hookEvent === 'PreToolUse'
      && operation.hookScriptPath === guardianScriptPath
    ));
    assert.strictEqual(guardianHookOps.length, 1, 'Guardian is registered once, on Bash only (it validates shell commands, not file edits)');
    assert.strictEqual(guardianHookOps[0].hookMatcher, 'Bash');
    assert.strictEqual(guardianHookOps[0].destinationPath, path.join(codexHome, 'hooks.json'));

    for (const src of [
      'scripts/hooks/pre-bash-guardian-validate.js',
      'scripts/lib/guardian-bin.js',
      'scripts/lib/shell-split.js',
    ]) {
      const op = plan.operations.find(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === src
        && operation.destinationPath === path.join(codexHome, ...src.split('/'))
      ));
      assert.ok(op, `Should scaffold ${src} into ~/.codex`);
    }
  }));


  // Devin Local, the agent in Devin Desktop since Cascade was removed on
  // 2026-09-08, reads lifecycle hooks in the Claude Code settings shape:
  // "hooks" in ~/.config/devin/config.json (%APPDATA%\devin\config.json on
  // Windows) and, per project, in .devin/config.local.json, the local
  // override that keeps this machine's absolute script paths out of the
  // committed .devin/config.json (docs.devin.ai/cli/extensibility/hooks).
  // The matchers follow `devin migrate hooks`, which turns pre_run_command
  // into ^exec$ and pre_write_code into ^(edit|write|notebook_edit)$;
  // multi_edit and apply_patch are the vendor's other file-writing tools.
  const { resolveDevinUserConfigPath } = require('../../scripts/lib/devin-local-hooks');
  for (const [target, rootFn, configFn] of [
    ['windsurf', homeDir => path.join(homeDir, '.codeium', 'windsurf'), homeDir => resolveDevinUserConfigPath(homeDir)],
    ['windsurf-project', (_homeDir, projectRoot) => path.join(projectRoot, '.devin'), (_homeDir, projectRoot) => path.join(projectRoot, '.devin', 'config.local.json')],
  ]) {
    tally(test(`${target} adapter wires GateGuard and the Guardian into Devin Local's PreToolUse hooks and no longer into the Cascade events`, () => {
      const repoRoot = path.join(__dirname, '..', '..');
      const homeDir = '/Users/example';
      const projectRoot = '/workspace/app';
      const plan = planInstallTargetScaffold({ target, repoRoot, homeDir, projectRoot, modules: [] });
      const targetRoot = rootFn(homeDir, projectRoot);
      const configPath = configFn(homeDir, projectRoot);
      const scriptOf = name => path.join(targetRoot, 'scripts', 'hooks', name);
      const byJson = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));

      const hookOperations = plan.operations.filter(operation => operation.kind === 'merge-claude-settings-hooks');
      assert.deepStrictEqual(
        hookOperations.map(operation => [operation.hookEvent, operation.hookMatcher, operation.hookScriptPath, operation.destinationPath]).sort(byJson),
        [
          ['PreToolUse', '^(exec|edit|write|notebook_edit|multi_edit|apply_patch)$', scriptOf('windsurf-gateguard-adapter.js'), configPath],
          ['PreToolUse', '^exec$', scriptOf('windsurf-guardian-adapter.js'), configPath],
        ].sort(byJson)
      );
      assert.ok(plan.managedRoots.includes(path.resolve(path.dirname(configPath))), 'the folder of the Devin config is a root the install owns');

      for (const [source, destination] of [
        ['scripts/hooks/windsurf-gateguard-adapter.js', scriptOf('windsurf-gateguard-adapter.js')],
        ['scripts/hooks/gateguard-fact-force.js', scriptOf('gateguard-fact-force.js')],
        ['scripts/hooks/windsurf-guardian-adapter.js', scriptOf('windsurf-guardian-adapter.js')],
        ['scripts/hooks/pre-bash-guardian-validate.js', scriptOf('pre-bash-guardian-validate.js')],
        ['scripts/lib/guardian-bin.js', path.join(targetRoot, 'scripts', 'lib', 'guardian-bin.js')],
        ['scripts/lib/shell-split.js', path.join(targetRoot, 'scripts', 'lib', 'shell-split.js')],
      ]) {
        assert.ok(plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === source && operation.destinationPath === destination
        )), `copies ${source} (the adapters require it in-process)`);
      }
    }));
  }

  tally(test('the Devin Local user config sits in ~/.config/devin on Linux and macOS, and in %APPDATA%\\devin on Windows', () => {
    assert.strictEqual(resolveDevinUserConfigPath('/home/u', { platform: 'linux' }), path.join('/home/u', '.config', 'devin', 'config.json'));
    assert.strictEqual(resolveDevinUserConfigPath('/Users/u', { platform: 'darwin' }), path.join('/Users/u', '.config', 'devin', 'config.json'), 'macOS uses ~/.config too');
    assert.strictEqual(
      resolveDevinUserConfigPath(os.homedir(), { platform: 'win32', env: { APPDATA: path.join('R:', 'Roaming') } }),
      path.join('R:', 'Roaming', 'devin', 'config.json'),
      'the real home follows %APPDATA%'
    );
    assert.strictEqual(
      resolveDevinUserConfigPath('/sandbox/home', { platform: 'win32', env: { APPDATA: path.join('R:', 'Roaming') } }),
      path.join('/sandbox/home', 'AppData', 'Roaming', 'devin', 'config.json'),
      'a home other than the real one never writes into the real %APPDATA%'
    );
  }));

  // Devin reads its config as JSONC; EGC writes plain JSON, so a file with
  // comments would lose them. It is refused before the install changes
  // anything, with the file named, instead of failing half-way through.
  tally(test('a Devin config EGC cannot rewrite without losing what is in it is refused up front, with the file named', () => {
    const fs = require('fs');
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-devin-jsonc-home-'));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-devin-jsonc-project-'));
    const plan = target => planInstallTargetScaffold({ target, repoRoot, homeDir, projectRoot, modules: [] });
    try {
      const userConfig = resolveDevinUserConfigPath(homeDir);
      const commented = '{\n  // mine\n  "theme_mode": "dark"\n}\n';
      fs.mkdirSync(path.dirname(userConfig), { recursive: true });
      fs.writeFileSync(userConfig, commented);
      assert.throws(() => plan('windsurf'), error => error.message.includes(userConfig) && /comments/.test(error.message));
      assert.strictEqual(fs.readFileSync(userConfig, 'utf8'), commented, 'the file is untouched');
      fs.writeFileSync(userConfig, '{"theme_mode":"dark"}');
      assert.doesNotThrow(() => plan('windsurf'), 'plain JSON is fine');
      fs.writeFileSync(userConfig, '  \n');
      assert.doesNotThrow(() => plan('windsurf'), 'an empty file is written from scratch');
      fs.rmSync(userConfig);
      fs.mkdirSync(userConfig);
      assert.throws(() => plan('windsurf'), error => error.message.includes(userConfig) && /cannot be read/.test(error.message), 'a config that cannot be read is refused with the reason');
      fs.rmSync(userConfig, { recursive: true });

      const projectConfig = path.join(projectRoot, '.devin', 'config.local.json');
      fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
      fs.writeFileSync(projectConfig, '[]');
      assert.throws(() => plan('windsurf-project'), error => error.message.includes(projectConfig), 'a config that is not a JSON object is refused too');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }));

  tally(test('old hook entries leave only after the current ones are written: a failed install keeps them, and a matcher change ends with the entry written once', () => {
    const fs = require('fs');
    const { applyInstallPlan } = require('../../scripts/lib/install/apply');
    const { applyWindsurfGateGuardHookToFile } = require('../../scripts/lib/windsurf-gateguard-hooks');
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-hook-order-'));
    try {
      const windsurfRoot = path.join(homeDir, '.codeium', 'windsurf');
      const hooksJson = path.join(windsurfRoot, 'hooks.json');
      const guardianScript = path.join(windsurfRoot, 'scripts', 'hooks', 'windsurf-guardian-adapter.js');
      const configPath = resolveDevinUserConfigPath(homeDir);
      const base = planInstallTargetScaffold({ target: 'windsurf', repoRoot, homeDir, projectRoot: homeDir, modules: [] });
      const guardianEntry = base.operations.find(operation => operation.hookMatcher === '^exec$');
      const cascadeEntry = {
        kind: 'merge-claude-settings-hooks',
        moduleId: guardianEntry.moduleId,
        destinationPath: hooksJson,
        hookEvent: 'pre_run_command',
        hookScriptPath: guardianScript,
      };

      fs.mkdirSync(windsurfRoot, { recursive: true });
      applyWindsurfGateGuardHookToFile(hooksJson, 'pre_run_command', guardianScript);
      const before = fs.readFileSync(hooksJson, 'utf8');
      const broken = {
        kind: 'copy-file',
        moduleId: guardianEntry.moduleId,
        sourceRelativePath: 'scripts/hooks/does-not-exist.js',
        sourcePath: path.join(repoRoot, 'scripts', 'hooks', 'does-not-exist.js'),
        destinationPath: path.join(windsurfRoot, 'scripts', 'hooks', 'does-not-exist.js'),
        strategy: 'preserve-relative-path',
        ownership: 'managed',
        scaffoldOnly: false,
      };
      assert.throws(() => applyInstallPlan({ ...base, operations: [guardianEntry, broken], hookRetirements: [cascadeEntry], statePreview: {} }, { homeDir }));
      assert.strictEqual(fs.readFileSync(hooksJson, 'utf8'), before, 'the install stopped before its end, so the old entry is still there');

      const { createInstallState } = require('../../scripts/lib/install-state');
      const stateOf = operations => createInstallState({
        adapter: base.adapter,
        targetRoot: base.targetRoot,
        installStatePath: base.installStatePath,
        request: { profile: null, modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations,
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      });
      const oldMatcher = { ...guardianEntry, hookMatcher: '^Bash$' };
      applyInstallPlan({ ...base, operations: [oldMatcher], hookRetirements: [], statePreview: stateOf([oldMatcher]) }, { homeDir });
      const result = applyInstallPlan({ ...base, operations: [guardianEntry], hookRetirements: [oldMatcher, cascadeEntry], statePreview: stateOf([guardianEntry]) }, { homeDir });
      const groups = JSON.parse(fs.readFileSync(configPath, 'utf8')).hooks.PreToolUse;
      assert.deepStrictEqual(
        groups.filter(group => group.hooks.some(entry => entry.command.includes('windsurf-guardian-adapter.js'))).map(group => [group.matcher, group.hooks.length]),
        [['^exec$', 1]],
        'the entry under the old matcher is gone and the current one is there once'
      );
      assert.ok(!fs.readFileSync(hooksJson, 'utf8').includes('windsurf-guardian-adapter.js'), 'the Cascade entry is gone');
      assert.deepStrictEqual(result.retiredHooks.map(entry => entry.hookEvent).sort(), ['PreToolUse', 'pre_run_command']);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }));

  tally(test('hook entries and adapter-owned files that left the plan are retired only within their bounds', () => {
    const fs = require('fs');
    const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-hook-retire-'));
    try {
      const windsurfRoot = path.join(homeDir, '.codeium', 'windsurf');
      const statePath = path.join(windsurfRoot, 'egc', 'install-state.json');
      const hooksJson = path.join(windsurfRoot, 'hooks.json');
      const adapterScript = path.join(windsurfRoot, 'scripts', 'hooks', 'windsurf-gateguard-adapter.js');
      const hookOp = (overrides) => ({
        kind: 'merge-claude-settings-hooks',
        moduleId: 'claude-gateguard-fact-force-hook',
        sourceRelativePath: 'scripts/hooks/windsurf-gateguard-adapter.js',
        destinationPath: hooksJson,
        strategy: 'merge-claude-settings-hooks',
        ownership: 'managed',
        scaffoldOnly: false,
        hookEvent: 'pre_run_command',
        hookScriptPath: adapterScript,
        ...overrides,
      });
      // A script an earlier version copied under a name the plan no longer uses.
      const renamedScript = path.join(windsurfRoot, 'scripts', 'hooks', 'gateguard-renamed.js');
      fs.mkdirSync(path.dirname(renamedScript), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, 'scripts', 'hooks', 'gateguard-fact-force.js'), renamedScript);
      const plannedPreToolUse = planInstallTargetScaffold({ target: 'windsurf', repoRoot, homeDir, projectRoot: homeDir, modules: [] })
        .operations.find(operation => operation.hookMatcher === '^exec$');
      const writeState = operations => writeInstallState(statePath, createInstallState({
        adapter: { id: 'windsurf-home', target: 'windsurf', kind: 'home' },
        targetRoot: windsurfRoot,
        installStatePath: statePath,
        request: { profile: null, modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations,
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      }));
      writeState([
        hookOp({}),
        hookOp({ moduleId: 'a-module-no-longer-installed' }),
        hookOp({ destinationPath: path.join(homeDir, 'elsewhere', 'hooks.json') }),
        { ...plannedPreToolUse },
        {
          kind: 'copy-file',
          moduleId: 'claude-gateguard-fact-force-hook',
          sourceRelativePath: 'scripts/hooks/gateguard-fact-force.js',
          destinationPath: renamedScript,
          strategy: 'preserve-relative-path',
          ownership: 'managed',
          scaffoldOnly: false,
        },
      ]);

      const plan = planInstallTargetScaffold({ target: 'windsurf', repoRoot, homeDir, projectRoot: homeDir, modules: [] });
      assert.deepStrictEqual(
        plan.hookRetirements.map(entry => [entry.hookEvent, entry.destinationPath, entry.moduleId]),
        [['pre_run_command', hooksJson, 'claude-gateguard-fact-force-hook']],
        'only the entry of a module still installed, in a file under the managed roots, that the plan no longer makes'
      );
      assert.ok(plan.retirements.some(entry => entry.destinationPath === renamedScript), 'the adapter-owned copy that left the plan is retired like any other');

      fs.writeFileSync(statePath, '{ not json');
      const unreadable = planInstallTargetScaffold({ target: 'windsurf', repoRoot, homeDir, projectRoot: homeDir, modules: [] });
      assert.deepStrictEqual(unreadable.hookRetirements, [], 'an unreadable state retires nothing');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }));

  tally(test('resolves codex adapter root to ~/.agents and install-state path', () => {
    const adapter = getInstallTargetAdapter('codex');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'codex-home');
    assert.strictEqual(adapter.target, 'codex');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.agents'));
    assert.strictEqual(statePath, path.join(homeDir, '.agents', 'egc', 'codex-install-state.json'));
  }));

  tally(test('codex adapter strips category from skill paths and installs flat under ~/.agents/skills/', () => {
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
  }));

  tally(test('codex adapter filters out foreign-platform source paths (audit EGC-128)', () => {
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
  }));

  tally(test('resolves opencode adapter root to ~/.config/opencode and install-state path', () => {
    const adapter = getInstallTargetAdapter('opencode');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'opencode-home');
    assert.strictEqual(adapter.target, 'opencode');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.config', 'opencode'));
    assert.strictEqual(statePath, path.join(homeDir, '.config', 'opencode', 'egc', 'install-state.json'));
  }));

  tally(test('opencode adapter strips category from skill paths and installs flat under ~/.config/opencode/skills/', () => {
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
  }));

  tally(test('opencode adapter filters out foreign-platform source paths (audit EGC-128)', () => {
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
  }));

  tally(test('opencode adapter plans only the markdown folders of the egc-universal package, never its tools, plugin sources, package files or opencode.json (#1396)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const configDir = path.join(homeDir, '.config', 'opencode');

    const plan = planInstallTargetScaffold({
      target: 'opencode',
      repoRoot,
      homeDir,
      modules: [{ id: 'platform-configs', paths: ['.opencode'] }],
    });

    const packageOps = plan.operations.filter(op => normalizedRelativePath(op.sourceRelativePath).startsWith('.opencode'));
    assert.deepStrictEqual(
      packageOps.map(op => [normalizedRelativePath(op.sourceRelativePath), op.destinationPath]).sort(),
      [
        ['.opencode/commands', path.join(configDir, 'commands')],
        ['.opencode/instructions', path.join(configDir, 'instructions')],
        ['.opencode/prompts', path.join(configDir, 'prompts')],
      ],
      'commands, instructions and prompts land under the config directory by their own name, nothing else from the package'
    );
    assert.ok(!plan.operations.some(op => normalizedRelativePath(op.sourceRelativePath) === '.opencode'), 'the package root is never copied whole');

    // A module naming a package path directly follows the same rule.
    const direct = planInstallTargetScaffold({
      target: 'opencode',
      repoRoot,
      homeDir,
      modules: [{ id: 'x', paths: ['.opencode/tools', '.opencode/opencode.json', '.opencode/commands'] }],
    });
    const directOps = direct.operations.filter(op => normalizedRelativePath(op.sourceRelativePath).startsWith('.opencode'));
    assert.deepStrictEqual(directOps.map(op => normalizedRelativePath(op.sourceRelativePath)), ['.opencode/commands']);

    // One file inside a shipped directory is planned on its own.
    const single = planInstallTargetScaffold({
      target: 'opencode',
      repoRoot,
      homeDir,
      modules: [{ id: 'x', paths: ['.opencode/commands/build-fix.md', '.opencode/tools/index.ts'] }],
    });
    assert.deepStrictEqual(
      single.operations.filter(op => normalizedRelativePath(op.sourceRelativePath).startsWith('.opencode')).map(op => [normalizedRelativePath(op.sourceRelativePath), op.destinationPath]),
      [['.opencode/commands/build-fix.md', path.join(configDir, 'commands', 'build-fix.md')]]
    );
  }));

  tally(test('opencode adapter skips a shipped package directory that is a link (#1396)', () => {
    if (process.platform === 'win32') return;
    const fs = require('fs');
    const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-opencode-linked-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-opencode-elsewhere-'));
    try {
      fs.mkdirSync(path.join(fakeRepo, '.opencode', 'commands'), { recursive: true });
      fs.writeFileSync(path.join(fakeRepo, '.opencode', 'commands', 'a.md'), 'a');
      fs.writeFileSync(path.join(elsewhere, 'p.md'), 'p');
      fs.symlinkSync(elsewhere, path.join(fakeRepo, '.opencode', 'prompts'), 'dir');
      const plan = planInstallTargetScaffold({
        target: 'opencode',
        repoRoot: fakeRepo,
        homeDir: '/Users/example',
        modules: [{ id: 'platform-configs', paths: ['.opencode'] }],
      });
      const sources = plan.operations.map(op => normalizedRelativePath(op.sourceRelativePath)).filter(p => p.startsWith('.opencode'));
      assert.deepStrictEqual(sources, ['.opencode/commands'], 'the linked prompts directory is not planned');

      // Naming a file inside the linked directory does not get around it.
      const viaFile = planInstallTargetScaffold({
        target: 'opencode',
        repoRoot: fakeRepo,
        homeDir: '/Users/example',
        modules: [{ id: 'x', paths: ['.opencode/prompts/p.md', '.opencode/commands/a.md'] }],
      });
      assert.deepStrictEqual(
        viaFile.operations.map(op => normalizedRelativePath(op.sourceRelativePath)).filter(p => p.startsWith('.opencode')),
        ['.opencode/commands/a.md'],
        'a file under the linked directory is not planned either'
      );
    } finally {
      fs.rmSync(fakeRepo, { recursive: true, force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  }));

  tally(test('opencode adapter also retires a module file that left the plan, beside the package files it retires on its own', () => {
    const fs = require('fs');
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-opencode-retire-module-'));
    try {
      const planningInput = { target: 'opencode', repoRoot, homeDir, modules: [] };
      const adapter = getInstallTargetAdapter('opencode');
      const targetRoot = adapter.resolveRoot({ repoRoot, homeDir });
      const installStatePath = adapter.getInstallStatePath({ repoRoot, homeDir });
      const destination = path.join(targetRoot, 'scripts', 'auto-update.js');
      const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
      writeInstallState(installStatePath, createInstallState({
        adapter: { id: adapter.id },
        targetRoot,
        installStatePath,
        request: { profile: 'minimal', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: [
          { kind: 'copy-file', moduleId: 'platform-configs', sourceRelativePath: 'scripts/auto-update.js', destinationPath: destination, strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false },
          // The person's global config now: the package rule keeps it, and
          // the general rule must not offer it either.
          { kind: 'copy-file', moduleId: 'platform-configs', sourceRelativePath: '.opencode/opencode.json', destinationPath: path.join(targetRoot, 'opencode.json'), strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false },
        ],
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      }));
      const modules = [{ id: 'platform-configs', paths: ['.opencode', 'mcp-configs', 'scripts/setup-package-manager.js'] }];
      const plan = planInstallTargetScaffold({ ...planningInput, modules });
      assert.deepStrictEqual(plan.retirements.map(entry => entry.destinationPath), [destination]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }));

  tally(test('opencode adapter retires the package files an earlier install wrote, keeps the shipped folders and opencode.json, and plans nothing without a previous state (#1396)', () => {
    const fs = require('fs');
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-opencode-retire-'));
    const configDir = path.join(homeDir, '.config', 'opencode');
    try {
      assert.deepStrictEqual(planInstallTargetScaffold({ target: 'opencode', repoRoot, homeDir, modules: [] }).retirements, [], 'no previous install, nothing to retire');

      const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
      const statePath = path.join(configDir, 'egc', 'install-state.json');
      const previous = [
        ['.opencode/tools/index.ts', path.join(configDir, 'tools', 'index.ts')],
        ['.opencode/plugins/egc-hooks.ts', path.join(configDir, 'plugins', 'egc-hooks.ts')],
        ['.opencode/package.json', path.join(configDir, 'package.json')],
        ['.opencode/opencode.json', path.join(configDir, 'opencode.json')],
        ['.opencode/commands/build-fix.md', path.join(configDir, 'commands', 'build-fix.md')],
        ['scripts/hooks/opencode-egc-plugin.js', path.join(configDir, 'plugins', 'opencode-egc-plugin.js')],
        ['.opencode/dist/index.js', path.join(homeDir, 'elsewhere', 'index.js')],
      ];
      const state = createInstallState({
        adapter: { id: 'opencode-home' },
        targetRoot: configDir,
        installStatePath: statePath,
        request: { profile: 'full', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: previous.map(([sourceRelativePath, destinationPath]) => ({ kind: 'copy-file', moduleId: 'platform-configs', sourceRelativePath, destinationPath, strategy: 'sync-root-children', ownership: 'managed', scaffoldOnly: false })),
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      });
      writeInstallState(statePath, state);

      const plan = planInstallTargetScaffold({ target: 'opencode', repoRoot, homeDir, modules: [] });
      assert.deepStrictEqual(
        plan.retirements.map(entry => entry.destinationPath).sort(),
        [path.join(configDir, 'package.json'), path.join(configDir, 'plugins', 'egc-hooks.ts'), path.join(configDir, 'tools', 'index.ts')].sort(),
        'package files go; commands, opencode.json, the real plugin and a destination outside the root stay'
      );
      assert.ok(plan.retirements.every(entry => entry.sourcePath === path.join(repoRoot, ...entry.sourceRelativePath.split('/'))), 'each retirement names the file EGC copied, for the apply to compare');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }));

  tally(test('opencode adapter always plans the Guardian+Crusher plugin, even with no modules selected (EGC-494/EGC-498)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'opencode',
      repoRoot,
      homeDir,
      modules: [],
    });

    const pluginDestination = path.join(homeDir, '.config', 'opencode', 'plugins', 'opencode-egc-plugin.js');
    assert.ok(
      plan.operations.some(op => (
        normalizedRelativePath(op.sourceRelativePath) === 'scripts/hooks/opencode-egc-plugin.js'
        && op.destinationPath === pluginDestination
      )),
      'Should copy the OpenCode Guardian+Crusher plugin into ~/.config/opencode/plugins/'
    );
    assert.ok(
      plan.operations.some(op => normalizedRelativePath(op.sourceRelativePath) === 'scripts/hooks/pre-bash-guardian-validate.js'),
      'Should copy pre-bash-guardian-validate.js so the plugin\'s require() resolves'
    );
    assert.ok(
      plan.operations.some(op => normalizedRelativePath(op.sourceRelativePath) === 'scripts/hooks/pre-bash-crusher-rewrite.js'),
      'Should copy pre-bash-crusher-rewrite.js so the plugin\'s require() resolves'
    );
  }));

  tally(test('codebuddy adapter strips category from skill paths and installs flat', () => {
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
  }));

  tally(test('antigravity-project adapter uses .agents (plural) as root directory', () => {
    const adapter = getInstallTargetAdapter('antigravity');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });

    assert.strictEqual(root, path.join(projectRoot, '.agents'));
  }));

  tally(test('resolves windsurf home adapter root to ~/.codeium/windsurf and install-state path', () => {
    const adapter = getInstallTargetAdapter('windsurf');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'windsurf-home');
    assert.strictEqual(adapter.target, 'windsurf');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.codeium', 'windsurf'));
    assert.strictEqual(statePath, path.join(homeDir, '.codeium', 'windsurf', 'egc', 'install-state.json'));
  }));

  tally(test('windsurf adapter strips category from skill paths and installs flat', () => {
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
  }));

  tally(test('resolves amp home adapter root to ~/.amp and install-state path', () => {
    const adapter = getInstallTargetAdapter('amp');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'amp-home');
    assert.strictEqual(adapter.target, 'amp');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.amp'));
    assert.strictEqual(statePath, path.join(homeDir, '.amp', 'egc', 'install-state.json'));
  }));

  tally(test('amp adapter strips category from skill paths and installs flat', () => {
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
  }));

  tally(test('amp home adapter plans the Guardian+Crusher plugin under ~/.config/amp/, not ~/.amp/ (EGC-507)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const configRoot = path.join(homeDir, '.config', 'amp');

    const plan = planInstallTargetScaffold({
      target: 'amp',
      repoRoot,
      homeDir,
      modules: [],
    });

    assert.strictEqual(plan.adapter.id, 'amp-home');
    const pluginOperation = plan.operations.find(operation => (
      operation.destinationPath === path.join(configRoot, 'plugins', 'egc-guardian-crusher.ts')
    ));
    assert.ok(pluginOperation, 'Should plan the plugin copy under ~/.config/amp/plugins/, not ~/.amp/plugins/');
    assert.strictEqual(normalizedRelativePath(pluginOperation.sourceRelativePath), 'scripts/hooks/amp-guardian-crusher-plugin.ts');

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/pre-bash-guardian-validate.js'
        && operation.destinationPath === path.join(configRoot, 'scripts', 'hooks', 'pre-bash-guardian-validate.js')
      )),
      'Should plan the shared Guardian validator copy next to the plugin, even with no modules selected'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/pre-bash-crusher-rewrite.js'
        && operation.destinationPath === path.join(configRoot, 'scripts', 'hooks', 'pre-bash-crusher-rewrite.js')
      )),
      'Should plan the shared Crusher rewrite engine copy next to the plugin, even with no modules selected'
    );
  }));

  tally(test('amp project adapter plans the Guardian+Crusher plugin under .amp/plugins/ (EGC-507)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';
    const targetRoot = path.join(projectRoot, '.amp');

    const plan = planInstallTargetScaffold({
      target: 'amp-project',
      repoRoot,
      projectRoot,
      modules: [],
    });

    assert.strictEqual(plan.adapter.id, 'amp-project');
    const pluginOperation = plan.operations.find(operation => (
      operation.destinationPath === path.join(targetRoot, 'plugins', 'egc-guardian-crusher.ts')
    ));
    assert.ok(pluginOperation, 'Should plan the plugin copy under .amp/plugins/');
    assert.strictEqual(normalizedRelativePath(pluginOperation.sourceRelativePath), 'scripts/hooks/amp-guardian-crusher-plugin.ts');

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/pre-bash-guardian-validate.js'
        && operation.destinationPath === path.join(targetRoot, 'scripts', 'hooks', 'pre-bash-guardian-validate.js')
      )),
      'Should plan the shared Guardian validator copy under the same .amp/ root as skills, even with no modules selected'
    );
  }));

  tally(test('resolves copilot home adapter root to ~/.github and install-state path', () => {
    const adapter = getInstallTargetAdapter('copilot');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'copilot-home');
    assert.strictEqual(adapter.target, 'copilot');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.github'));
    assert.strictEqual(statePath, path.join(homeDir, '.github', 'egc', 'install-state.json'));
  }));

  tally(test('copilot adapter strips category from skill paths and installs flat', () => {
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
  }));

  tally(test('lists all 3 new IDE targets in adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(adapter => adapter.target);
    assert.ok(targets.includes('windsurf'), 'Should include windsurf target');
    assert.ok(targets.includes('amp'), 'Should include amp target');
    assert.ok(targets.includes('copilot'), 'Should include copilot target');
  }));

  tally(test('resolves zed home adapter root to ~/.config/zed and install-state path', () => {
    const adapter = getInstallTargetAdapter('zed');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'zed-home');
    assert.strictEqual(adapter.target, 'zed');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.config', 'zed'));
    assert.strictEqual(statePath, path.join(homeDir, '.config', 'zed', 'egc', 'install-state.json'));
  }));

  tally(test('zed adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('zed');
    const byId = getInstallTargetAdapter('zed-home');

    assert.strictEqual(byTarget.id, 'zed-home');
    assert.strictEqual(byId.id, 'zed-home');
    assert.ok(byTarget.supports('zed'));
    assert.ok(byTarget.supports('zed-home'));
  }));

  tally(test('zed adapter strips category from skill paths and installs flat under ~/.config/zed/skills/', () => {
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
  }));

  tally(test('zed adapter handles already-flat skill paths without double-stripping', () => {
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
  }));

  tally(test('exposes validate and planOperations on zed adapter', () => {
    const zedAdapter = getInstallTargetAdapter('zed');

    assert.strictEqual(typeof zedAdapter.planOperations, 'function');
    assert.strictEqual(typeof zedAdapter.validate, 'function');
    assert.ok(
      !zedAdapter.validate({ homeDir: '/Users/example', repoRoot: '/repo/egc' })
        .some(i => i.severity === 'error'),
      'zed adapter should have no blocking validation errors'
    );
  }));

  tally(test('zed adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('zed'), 'Should include zed target');
  }));

  tally(test('every schema target enum value has a matching adapter (regression guard)', () => {
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
  }));

  tally(test('every adapter target is listed in the schema enum (regression guard)', () => {
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
  }));

  tally(test('every adapter target is in SUPPORTED_INSTALL_TARGETS (regression guard)', () => {
    const { SUPPORTED_INSTALL_TARGETS } = require('../../scripts/lib/install-manifests');
    const adapters = listInstallTargetAdapters();

    for (const adapter of adapters) {
      assert.ok(
        SUPPORTED_INSTALL_TARGETS.includes(adapter.target),
        `Adapter target "${adapter.target}" is not in SUPPORTED_INSTALL_TARGETS. ` +
        `Supported: ${SUPPORTED_INSTALL_TARGETS.join(', ')}`
      );
    }
  }));

  tally(test('claude target resolves a skills module on its own, without dragging platform-configs (issue #160)', () => {
    const { resolveInstallPlan } = require('../../scripts/lib/install-manifests');

    const plan = resolveInstallPlan({
      moduleIds: ['workflow-quality'],
      target: 'claude',
      homeDir: os.tmpdir(),
      projectRoot: os.tmpdir(),
    });

    assert.deepStrictEqual(
      plan.selectedModuleIds,
      ['workflow-quality'],
      'a skills module needs no platform module to install'
    );
    assert.strictEqual(
      plan.skippedModuleIds.length,
      0,
      'no modules should be silently skipped'
    );
  }));

  tally(test('copilot adapter registers the GateGuard fact-force hook at ~/.copilot/hooks/hooks.json', () => {
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
  }));

  tally(test('crusher hook is registered on Bash and scaffolded for Copilot and Antigravity', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const projectRoot = '/workspace/app';

    const cases = [
      { target: 'copilot', input: { homeDir }, hooksFilePath: path.join(homeDir, '.copilot', 'hooks', 'hooks.json'), root: path.join(homeDir, '.github') },
      { target: 'antigravity', input: { projectRoot }, hooksFilePath: path.join(projectRoot, '.agents', 'hooks.json'), root: path.join(projectRoot, '.agents') },
    ];

    for (const { target, input, hooksFilePath, root } of cases) {
      const plan = planInstallTargetScaffold({ target, repoRoot, modules: [], ...input });
      const crusherScriptPath = path.join(root, 'scripts', 'hooks', 'crusher-hook.js');

      const crusherOps = plan.operations.filter(operation => (
        operation.kind === 'merge-claude-settings-hooks'
        && operation.hookEvent === 'PreToolUse'
        && operation.destinationPath === hooksFilePath
        && operation.hookScriptPath === crusherScriptPath
      ));
      assert.strictEqual(crusherOps.length, 1, `${target}: crusher registered once`);
      assert.strictEqual(crusherOps[0].hookMatcher, 'Bash', `${target}: crusher on Bash`);

      assert.ok(
        plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/crusher-hook.js'
          && operation.destinationPath === crusherScriptPath
        )),
        `${target}: crusher hook script scaffolded`
      );
      assert.ok(
        plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === 'scripts/lib/crusher/engine.js'
          && operation.destinationPath === path.join(root, 'scripts', 'lib', 'crusher', 'engine.js')
        )),
        `${target}: crusher engine dependency scaffolded`
      );
    }
  }));

  // Session-mesh wake-signal notice: Antigravity inherited the Gemini CLI
  // hook loop, which reads the hookSpecificOutput.additionalContext field
  // mesh-events-inject.js emits, so the same standalone script is registered
  // on UserPromptSubmit at both the project hooks file (antigravity target)
  // and the global one (egc target owns ~/.gemini).
  tally(test('mesh notice hook is registered on UserPromptSubmit and scaffolded for Antigravity, Codex, and Trae', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const projectRoot = '/workspace/app';

    const cases = [
      { target: 'antigravity', input: { projectRoot }, hooksFilePath: path.join(projectRoot, '.agents', 'hooks.json'), root: path.join(projectRoot, '.agents') },
      { target: 'egc', input: { homeDir }, hooksFilePath: path.join(homeDir, '.gemini', 'antigravity-cli', 'hooks.json'), root: path.join(homeDir, '.gemini') },
      { target: 'codex', input: { homeDir }, hooksFilePath: path.join(homeDir, '.codex', 'hooks.json'), root: path.join(homeDir, '.codex') },
      // Trae feeds plain-text stdout to the model, so its registered command
      // is the host adapter, not the shared JSON-emitting script directly.
      { target: 'trae', input: { projectRoot }, hooksFilePath: path.join(projectRoot, '.trae', 'hooks.json'), root: path.join(projectRoot, '.trae'), registeredScript: 'trae-mesh-notice-adapter.js' },
    ];

    for (const { target, input, hooksFilePath, root, registeredScript } of cases) {
      const plan = planInstallTargetScaffold({ target, repoRoot, modules: [], ...input });
      const meshScriptPath = path.join(root, 'scripts', 'hooks', registeredScript || 'mesh-events-inject.js');

      const meshOps = plan.operations.filter(operation => (
        operation.kind === 'merge-claude-settings-hooks'
        && operation.hookEvent === 'UserPromptSubmit'
        && operation.destinationPath === hooksFilePath
        && operation.hookScriptPath === meshScriptPath
      ));
      assert.strictEqual(meshOps.length, 1, `${target}: mesh notice registered once`);
      assert.strictEqual(meshOps[0].hookMatcher, undefined, `${target}: prompt hooks carry no tool matcher`);

      assert.ok(
        plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === `scripts/hooks/${registeredScript || 'mesh-events-inject.js'}`
          && operation.destinationPath === meshScriptPath
        )),
        `${target}: registered hook script scaffolded`
      );
      assert.ok(
        plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/mesh-events-inject.js'
          && operation.destinationPath === path.join(root, 'scripts', 'hooks', 'mesh-events-inject.js')
        )),
        `${target}: shared mesh implementation scaffolded`
      );
    }
  }));

  // Amp has no hooks.json: its turn boundary is the agent.start plugin event,
  // so the mesh ships as a plugin file plus the shared script it requires.
  tally(test('mesh notice plugin is scaffolded for Amp at both plugin roots', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const projectRoot = '/workspace/app';

    const cases = [
      { target: 'amp-project', input: { projectRoot }, pluginRoot: path.join(projectRoot, '.amp') },
      { target: 'amp-home', input: { homeDir }, pluginRoot: path.join(homeDir, '.config', 'amp') },
    ];

    for (const { target, input, pluginRoot } of cases) {
      const plan = planInstallTargetScaffold({ target, repoRoot, modules: [], ...input });

      assert.ok(
        plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/amp-mesh-notice-plugin.ts'
          && operation.destinationPath === path.join(pluginRoot, 'plugins', 'egc-mesh-notice.ts')
        )),
        `${target}: mesh notice plugin scaffolded`
      );
      assert.ok(
        plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/mesh-events-inject.js'
          && operation.destinationPath === path.join(pluginRoot, 'scripts', 'hooks', 'mesh-events-inject.js')
        )),
        `${target}: shared mesh script scaffolded next to the plugin`
      );
    }
  }));

  // Kiro takes a dedicated whole-file hook document under <root>/hooks/,
  // dispatched on its own tag so apply/remove never merge user content.
  tally(test('mesh notice hook document is planned for Kiro at both roots', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const projectRoot = '/workspace/app';

    const cases = [
      { target: 'kiro-project', input: { projectRoot }, root: path.join(projectRoot, '.kiro') },
      { target: 'kiro-home', input: { homeDir }, root: path.join(homeDir, '.kiro') },
    ];

    for (const { target, input, root } of cases) {
      const plan = planInstallTargetScaffold({ target, repoRoot, modules: [], ...input });
      const meshScriptPath = path.join(root, 'scripts', 'hooks', 'mesh-events-inject.js');

      const docOps = plan.operations.filter(operation => (
        operation.kind === 'merge-claude-settings-hooks'
        && operation.hookEvent === 'kiro-mesh-hook-file'
        && operation.destinationPath === path.join(root, 'hooks', 'egc-mesh-notice.json')
        && operation.hookScriptPath === meshScriptPath
      ));
      assert.strictEqual(docOps.length, 1, `${target}: hook document planned once`);

      assert.ok(
        plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/mesh-events-inject.js'
          && operation.destinationPath === meshScriptPath
        )),
        `${target}: shared mesh script scaffolded under the adapter root`
      );
    }
  }));

  // EGC Guardian: 2026-07-27 audit (EGC-460..464) found these three targets
  // had GateGuard + Crusher wired (tests above) but never the Guardian
  // command validator itself -- neither one actually checks a Bash command
  // against the Guardian's allowlist/denylist.
  tally(test('Guardian hook is registered on Bash and scaffolded for Copilot and Antigravity', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const projectRoot = '/workspace/app';

    const cases = [
      { target: 'copilot', input: { homeDir }, hooksFilePath: path.join(homeDir, '.copilot', 'hooks', 'hooks.json'), root: path.join(homeDir, '.github') },
      { target: 'antigravity', input: { projectRoot }, hooksFilePath: path.join(projectRoot, '.agents', 'hooks.json'), root: path.join(projectRoot, '.agents') },
    ];

    for (const { target, input, hooksFilePath, root } of cases) {
      const plan = planInstallTargetScaffold({ target, repoRoot, modules: [], ...input });
      const guardianScriptPath = path.join(root, 'scripts', 'hooks', 'pre-bash-guardian-validate.js');

      const guardianOps = plan.operations.filter(operation => (
        operation.kind === 'merge-claude-settings-hooks'
        && operation.hookEvent === 'PreToolUse'
        && operation.destinationPath === hooksFilePath
        && operation.hookScriptPath === guardianScriptPath
      ));
      assert.strictEqual(guardianOps.length, 1, `${target}: Guardian registered once`);
      assert.strictEqual(guardianOps[0].hookMatcher, 'Bash', `${target}: Guardian on Bash`);

      for (const src of ['scripts/hooks/pre-bash-guardian-validate.js', 'scripts/lib/guardian-bin.js', 'scripts/lib/shell-split.js']) {
        assert.ok(
          plan.operations.some(operation => (
            normalizedRelativePath(operation.sourceRelativePath) === src
            && operation.destinationPath === path.join(root, ...src.split('/'))
          )),
          `${target}: ${src} scaffolded`
        );
      }
    }
  }));

  tally(test('codebuddy adapter registers the GateGuard fact-force hook at .codebuddy/settings.json', () => {
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
  }));

  // EGC-539: the GateGuard PreToolUse merge operations above were registered
  // unconditionally (test above), but the script the hooks point at was
  // never actually copied -- so a codebuddy install whose selected modules
  // did not include scripts/hooks/scripts/lib wrote a hooks.json entry
  // pointing at a file that never existed on disk. Same pattern the sibling
  // Crusher/Guardian tests below already guard for their own scripts.
  tally(test('codebuddy adapter also scaffolds the GateGuard script and its utils.js dependency, unconditional of module selection', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'codebuddy',
      repoRoot,
      projectRoot,
      modules: [],
    });

    const scriptOp = plan.operations.find(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/gateguard-fact-force.js'
      && operation.destinationPath === path.join(
        projectRoot, '.codebuddy', 'scripts', 'hooks', 'gateguard-fact-force.js'
      )
    ));
    assert.ok(scriptOp, 'Should scaffold gateguard-fact-force.js into .codebuddy even with no modules selected');

    const utilsOp = plan.operations.find(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === 'scripts/lib/utils.js'
      && operation.destinationPath === path.join(projectRoot, '.codebuddy', 'scripts', 'lib', 'utils.js')
    ));
    assert.ok(utilsOp, 'Should scaffold gateguard-fact-force.js\'s utils.js dependency alongside it');
  }));

  // Cubic review (EGC-539, PR #1142): a codebuddy install that explicitly
  // selects a module whose paths already cover scripts/hooks/scripts/lib
  // (e.g. 'hooks-runtime') must not double-copy gateguard-fact-force.js and
  // utils.js -- once via moduleOperations, once via the unconditional copy
  // the test above exercises.
  tally(test('codebuddy adapter does not double-copy the GateGuard script when a selected module already covers scripts/hooks and scripts/lib', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'codebuddy',
      repoRoot,
      projectRoot,
      modules: [{ id: 'hooks-runtime', paths: ['scripts/hooks', 'scripts/lib'] }],
    });

    // A module path of 'scripts/hooks' (a directory, not a single file)
    // scaffolds via moduleOperations as one directory-level copy operation
    // whose recursive copy already includes gateguard-fact-force.js -- it
    // does not appear as a per-file operation. The explicit file-level copy
    // this test guards against would come only from createHookOperations's
    // own createGateGuardScriptCopyOperations call, which should have been
    // skipped here since the module already covers it.
    const moduleLevelHooksOp = plan.operations.find(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks'
      && operation.destinationPath === path.join(projectRoot, '.codebuddy', 'scripts', 'hooks')
    ));
    assert.ok(moduleLevelHooksOp, 'Expected the selected hooks-runtime module to scaffold scripts/hooks as a directory-level operation');

    const moduleLevelLibOp = plan.operations.find(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === 'scripts/lib'
      && operation.destinationPath === path.join(projectRoot, '.codebuddy', 'scripts', 'lib')
    ));
    assert.ok(moduleLevelLibOp, 'Expected the selected hooks-runtime module to scaffold scripts/lib as a directory-level operation');

    // Merge operations (createPreToolUseGateGuardHookMergeOperation, one
    // each for Edit/Write/MultiEdit/Bash) legitimately carry
    // sourceRelativePath: 'scripts/hooks/gateguard-fact-force.js' too --
    // they reference the script path to build the hook command, they don't
    // copy it. createManagedOperation sets `kind`, not `type` (every other
    // assertion in this file uses operation.kind); an earlier version of
    // this test asserted on operation.type, which is always undefined, so
    // these two checks passed trivially regardless of whether the
    // double-copy regression was actually present (cubic review caught
    // this). Only 'copy-path' operations represent an actual file copy, so
    // the double-copy check must scope to that operation kind.
    const explicitFileLevelScriptOp = plan.operations.find(operation => (
      operation.kind === 'copy-path'
      && normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/gateguard-fact-force.js'
    ));
    assert.strictEqual(explicitFileLevelScriptOp, undefined, 'createGateGuardScriptCopyOperations\' explicit file-level copy should be skipped when the module already covers scripts/hooks');

    const explicitFileLevelUtilsOp = plan.operations.find(operation => (
      operation.kind === 'copy-path'
      && normalizedRelativePath(operation.sourceRelativePath) === 'scripts/lib/utils.js'
    ));
    assert.strictEqual(explicitFileLevelUtilsOp, undefined, 'createGateGuardScriptCopyOperations\' explicit file-level copy of utils.js should be skipped when the module already covers scripts/lib');
  }));

  // Cubic review (EGC-539, PR #1142), violation 1: a module selection that
  // covers only ONE of scripts/hooks or scripts/lib (not both) must still
  // get the explicit copy for the file it does NOT already cover -- an
  // earlier `.some()`-based guard treated covering either one as proof both
  // were scaffolded, silently dropping utils.js in this scenario and
  // reintroducing the ENOENT fail-open this PR exists to fix.
  tally(test('codebuddy adapter still copies utils.js when a selected module covers only scripts/hooks, not scripts/lib', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'codebuddy',
      repoRoot,
      projectRoot,
      modules: [{ id: 'hooks-only', paths: ['scripts/hooks'] }],
    });

    // scripts/hooks is covered by the module (no duplicate expected), but
    // scripts/lib is not, so utils.js must still be copied explicitly.
    const explicitFileLevelScriptOp = plan.operations.find(operation => (
      operation.kind === 'copy-path'
      && normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/gateguard-fact-force.js'
    ));
    assert.strictEqual(explicitFileLevelScriptOp, undefined, 'gateguard-fact-force.js is already covered by the scripts/hooks module, the explicit copy should still be skipped');

    const explicitFileLevelUtilsOp = plan.operations.find(operation => (
      operation.kind === 'copy-path'
      && normalizedRelativePath(operation.sourceRelativePath) === 'scripts/lib/utils.js'
      && operation.destinationPath === path.join(projectRoot, '.codebuddy', 'scripts', 'lib', 'utils.js')
    ));
    assert.ok(explicitFileLevelUtilsOp, 'utils.js must still be explicitly copied: the selected module does not cover scripts/lib at all');
  }));

  // Cubic review (EGC-539, PR #1142), violation 2: a module selection that
  // pins a single unrelated file inside scripts/hooks or scripts/lib (not
  // the whole directory, not the GateGuard files themselves) must not be
  // mistaken for coverage of gateguard-fact-force.js/utils.js -- an earlier
  // `startsWith('scripts/hooks/')` guard matched any file in that
  // directory, wrongly skipping the explicit copy.
  tally(test('codebuddy adapter still copies the GateGuard script when a selected module only pins an unrelated file in scripts/hooks/scripts/lib', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'codebuddy',
      repoRoot,
      projectRoot,
      modules: [{ id: 'unrelated-files', paths: ['scripts/hooks/pretooluse-output.js', 'scripts/lib/crusher/engine.js'] }],
    });

    const explicitFileLevelScriptOp = plan.operations.find(operation => (
      operation.kind === 'copy-path'
      && normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/gateguard-fact-force.js'
      && operation.destinationPath === path.join(projectRoot, '.codebuddy', 'scripts', 'hooks', 'gateguard-fact-force.js')
    ));
    assert.ok(explicitFileLevelScriptOp, 'gateguard-fact-force.js must still be explicitly copied: the selected module only pins an unrelated file in scripts/hooks, not the directory or the GateGuard script itself');

    const explicitFileLevelUtilsOp = plan.operations.find(operation => (
      operation.kind === 'copy-path'
      && normalizedRelativePath(operation.sourceRelativePath) === 'scripts/lib/utils.js'
      && operation.destinationPath === path.join(projectRoot, '.codebuddy', 'scripts', 'lib', 'utils.js')
    ));
    assert.ok(explicitFileLevelUtilsOp, 'utils.js must still be explicitly copied: the selected module only pins an unrelated file in scripts/lib, not the directory or utils.js itself');
  }));

  tally(test('codebuddy adapter also registers the Token Crusher on Bash at .codebuddy/settings.json', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'codebuddy',
      repoRoot,
      projectRoot,
      modules: [],
    });
    const settingsPath = path.join(projectRoot, '.codebuddy', 'settings.json');
    const crusherScriptPath = path.join(projectRoot, '.codebuddy', 'scripts', 'hooks', 'crusher-hook.js');

    const crusherOps = plan.operations.filter(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.hookEvent === 'PreToolUse'
      && operation.destinationPath === settingsPath
      && operation.hookScriptPath === crusherScriptPath
    ));
    assert.strictEqual(crusherOps.length, 1, 'Crusher registered once, on Bash');
    assert.strictEqual(crusherOps[0].hookMatcher, 'Bash');

    for (const src of [
      'scripts/hooks/crusher-hook.js',
      'scripts/hooks/pre-bash-crusher-rewrite.js',
      'scripts/hooks/pretooluse-output.js',
      'scripts/lib/crusher/engine.js',
    ]) {
      const op = plan.operations.find(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === src
        && operation.destinationPath === path.join(projectRoot, '.codebuddy', ...src.split('/'))
      ));
      assert.ok(op, `Should scaffold ${src} into .codebuddy`);
    }
  }));

  tally(test('codebuddy adapter also registers the EGC Guardian on Bash at .codebuddy/settings.json', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'codebuddy',
      repoRoot,
      projectRoot,
      modules: [],
    });
    const settingsPath = path.join(projectRoot, '.codebuddy', 'settings.json');
    const guardianScriptPath = path.join(projectRoot, '.codebuddy', 'scripts', 'hooks', 'pre-bash-guardian-validate.js');

    const guardianOps = plan.operations.filter(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.hookEvent === 'PreToolUse'
      && operation.destinationPath === settingsPath
      && operation.hookScriptPath === guardianScriptPath
    ));
    assert.strictEqual(guardianOps.length, 1, 'Guardian registered once, on Bash');
    assert.strictEqual(guardianOps[0].hookMatcher, 'Bash');

    for (const src of [
      'scripts/hooks/pre-bash-guardian-validate.js',
      'scripts/lib/guardian-bin.js',
      'scripts/lib/shell-split.js',
    ]) {
      const op = plan.operations.find(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === src
        && operation.destinationPath === path.join(projectRoot, '.codebuddy', ...src.split('/'))
      ));
      assert.ok(op, `Should scaffold ${src} into .codebuddy`);
    }
  }));

  tally(test('antigravity-project adapter registers the GateGuard fact-force hook at .agents/hooks.json', () => {
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
  }));

  tally(test('egc-home adapter registers the GateGuard fact-force hook for Antigravity global scope too', () => {
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

    // cubic-dev-ai review (PR #1052, 2026-07-27): this test already used
    // modules: [] (no hooks-runtime module selected), so if the script copy
    // were still implicit/optional the hooks.json entry above would point
    // at a file that was never actually scaffolded. Asserting the copy
    // operation exists here, in the same modules: [] scenario, proves the
    // registration is now self-sufficient regardless of module selection.
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/gateguard-fact-force.js'
        && operation.destinationPath === gateGuardScriptPath
      )),
      'gateguard-fact-force.js must be copied unconditionally, not only via the hooks-runtime module'
    );
  }));

  // EGC Guardian: cubic-dev-ai review (PR #1052, 2026-07-27) found
  // createGlobalBashGuardianHookMergeOperation existed in
  // antigravity-settings-hooks.js but was never called from gemini-home.js,
  // so global Antigravity installs never got the Guardian despite GateGuard
  // (test above) being wired. A follow-up review then found the same
  // registered-but-never-copied gap once it WAS wired.
  tally(test('egc-home adapter registers the EGC Guardian on Bash for Antigravity global scope too', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'egc',
      repoRoot,
      homeDir,
      modules: [],
    });
    const hooksFilePath = path.join(homeDir, '.gemini', 'antigravity-cli', 'hooks.json');
    const guardianScriptPath = path.join(
      homeDir, '.gemini', 'scripts', 'hooks', 'pre-bash-guardian-validate.js'
    );

    const guardianOperations = plan.operations.filter(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.hookEvent === 'PreToolUse'
      && operation.destinationPath === hooksFilePath
      && operation.hookScriptPath === guardianScriptPath
    ));
    assert.strictEqual(guardianOperations.length, 1, 'Guardian registered once for the Antigravity global hooks.json');
    assert.strictEqual(guardianOperations[0].hookMatcher, 'Bash', 'Guardian only needs the Bash matcher');

    for (const src of ['scripts/hooks/pre-bash-guardian-validate.js', 'scripts/lib/guardian-bin.js', 'scripts/lib/shell-split.js']) {
      assert.ok(
        plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === src
          && operation.destinationPath === path.join(homeDir, '.gemini', ...src.split('/'))
        )),
        `${src} must be copied unconditionally (modules: []), not only via the hooks-runtime module`
      );
    }
  }));

  // Token Crusher: 2026-07-21 audit left Antigravity's PROJECT-level
  // registration (.agents/hooks.json, antigravity-project.js) wired but its
  // GLOBAL registration (this egc-home target, ~/.gemini/antigravity-cli/
  // hooks.json) unverified/unwired -- same pattern as the GateGuard/Guardian
  // global gaps above. Closed 2026-07-28.
  tally(test('egc-home adapter registers the Token Crusher on Bash for Antigravity global scope too', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'egc',
      repoRoot,
      homeDir,
      modules: [],
    });
    const hooksFilePath = path.join(homeDir, '.gemini', 'antigravity-cli', 'hooks.json');
    const crusherScriptPath = path.join(
      homeDir, '.gemini', 'scripts', 'hooks', 'crusher-hook.js'
    );

    const crusherOperations = plan.operations.filter(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.hookEvent === 'PreToolUse'
      && operation.destinationPath === hooksFilePath
      && operation.hookScriptPath === crusherScriptPath
    ));
    assert.strictEqual(crusherOperations.length, 1, 'Crusher registered once for the Antigravity global hooks.json');
    assert.strictEqual(crusherOperations[0].hookMatcher, 'Bash', 'Crusher only needs the Bash matcher');

    for (const src of ['scripts/hooks/crusher-hook.js', 'scripts/hooks/pre-bash-crusher-rewrite.js', 'scripts/hooks/pretooluse-output.js', 'scripts/lib/crusher/engine.js']) {
      assert.ok(
        plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === src
          && operation.destinationPath === path.join(homeDir, '.gemini', ...src.split('/'))
        )),
        `${src} must be copied unconditionally (modules: []), not only via the hooks-runtime module`
      );
    }
  }));

  // cubic-dev-ai review (PR #1052, 2026-07-27): making the copies above
  // unconditional meant a DEFAULT install (which does select hooks-runtime)
  // now recorded two copy-path operations per script -- one from
  // hooks-runtime's own directory-level scaffold of scripts/hooks and
  // scripts/lib, one from the explicit calls above. Both write the same
  // bytes to the same destination, but duplicate the install-state
  // bookkeeping. This must not regress: the explicit per-file operations
  // should be suppressed whenever the broader directory copy already
  // covers them.
  tally(test('egc-home adapter does not duplicate GateGuard/Guardian script copies when hooks-runtime IS selected (default install)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'egc',
      repoRoot,
      homeDir,
      modules: [{ id: 'hooks-runtime', paths: ['hooks', 'scripts/hooks', 'scripts/lib'] }],
    });

    const directoryDestinations = [
      path.join(homeDir, '.gemini', 'scripts', 'hooks'),
      path.join(homeDir, '.gemini', 'scripts', 'lib'),
    ];
    for (const destination of directoryDestinations) {
      const matches = plan.operations.filter(operation => (
        operation.kind === 'copy-path' && operation.destinationPath === destination
      ));
      assert.strictEqual(matches.length, 1, `${destination} should be scaffolded once, by hooks-runtime's own directory copy`);
    }

    for (const src of [
      'scripts/hooks/gateguard-fact-force.js',
      'scripts/lib/utils.js',
      'scripts/hooks/pre-bash-guardian-validate.js',
      'scripts/lib/guardian-bin.js',
      'scripts/lib/shell-split.js',
      'scripts/hooks/crusher-hook.js',
      'scripts/hooks/pre-bash-crusher-rewrite.js',
      'scripts/hooks/pretooluse-output.js',
      'scripts/lib/crusher/engine.js',
    ]) {
      const destination = path.join(homeDir, '.gemini', ...src.split('/'));
      const fileLevelCopies = plan.operations.filter(operation => (
        operation.kind === 'copy-path' && operation.destinationPath === destination
      ));
      assert.strictEqual(
        fileLevelCopies.length,
        0,
        `${src} must not get its own copy-path operation when the parent directory is already being copied`
      );
    }

    // The hooks.json registrations themselves are unrelated to the copy
    // dedup and must still be present.
    const hooksFilePath = path.join(homeDir, '.gemini', 'antigravity-cli', 'hooks.json');
    assert.ok(
      plan.operations.some(operation => (
        operation.kind === 'merge-claude-settings-hooks' && operation.destinationPath === hooksFilePath
      )),
      'hooks.json registrations must survive the copy dedup'
    );
  }));

  tally(test('resolves kiro home adapter root to ~/.kiro and install-state path', () => {
    const adapter = getInstallTargetAdapter('kiro');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'kiro-home');
    assert.strictEqual(adapter.target, 'kiro');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.kiro'));
    assert.strictEqual(statePath, path.join(homeDir, '.kiro', 'egc', 'install-state.json'));
  }));

  tally(test('resolves kiro project adapter root to .kiro and install-state path', () => {
    const adapter = getInstallTargetAdapter('kiro-project');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'kiro-project');
    assert.strictEqual(adapter.target, 'kiro');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.kiro'));
    assert.strictEqual(statePath, path.join(projectRoot, '.kiro', 'egc-install-state.json'));
  }));

  tally(test('kiro adapter supports lookup by target and adapter id', () => {
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
  }));

  tally(test('kiro home adapter strips category from skill paths and installs flat under ~/.kiro/skills/', () => {
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
  }));

  tally(test('kiro project adapter strips category from skill paths and installs flat under .kiro/skills/', () => {
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
  }));

  tally(test('kiro home and project adapters always plan the Guardian preToolUse hook, even with no modules selected (EGC-494/EGC-498)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const projectRoot = '/workspace/app';

    for (const { target, targetRoot, extra } of [
      { target: 'kiro', targetRoot: path.join(homeDir, '.kiro'), extra: { homeDir } },
      { target: 'kiro-project', targetRoot: path.join(projectRoot, '.kiro'), extra: { projectRoot } },
    ]) {
      const plan = planInstallTargetScaffold({ target, repoRoot, modules: [], ...extra });
      const adapterScriptDestination = path.join(targetRoot, 'scripts', 'hooks', 'kiro-guardian-adapter.js');

      assert.ok(
        plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/pre-bash-guardian-validate.js'
          && operation.destinationPath === path.join(targetRoot, 'scripts', 'hooks', 'pre-bash-guardian-validate.js')
        )),
        `[${target}] Should plan the shared Guardian validator copy even with no modules selected`
      );
      assert.ok(
        plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/kiro-guardian-adapter.js'
          && operation.destinationPath === adapterScriptDestination
        )),
        `[${target}] Should plan the Kiro-specific adapter copy even with no modules selected`
      );

      const mergeOperation = plan.operations.find(
        operation => operation.kind === 'merge-claude-settings-hooks' && operation.hookEvent === 'preToolUse'
      );
      assert.ok(mergeOperation, `[${target}] Should plan the preToolUse agent-config merge`);
      assert.strictEqual(mergeOperation.destinationPath, path.join(targetRoot, 'agents', 'default.json'));
      assert.strictEqual(mergeOperation.hookScriptPath, adapterScriptDestination);
    }
  }));

  tally(test('kiro adapters are included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('kiro'), 'Should include kiro target');
  }));

  tally(test('Cursor/Devin Desktop/Kiro all plan a copy of adapter-stdin-json.js, the shared dependency their translation adapters require() (2026-07-29 MODULE_NOT_FOUND regression)', () => {
    // cubic-dev-ai flagged this on PR #1073 (Kiro) as a P1: the adapter
    // scripts require('../lib/adapter-stdin-json') for their
    // truncation-aware stdin reader, but none of the three hosts' copy
    // operations ever included that file -- confirmed for real on the
    // local machine after merge: every one of the three adapters crashed
    // with MODULE_NOT_FOUND on its very first invocation. No prior test
    // caught it because every other test either stubs the adapter's
    // require() away or only checks the hooks.json/agent-config merge
    // content, never the full file set an install actually produces.
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const projectRoot = '/workspace/app';
    const adapterStdinJsonSource = 'scripts/lib/adapter-stdin-json.js';

    for (const { label, target, targetRoot, extra, modules } of [
      { label: 'cursor', target: 'cursor', targetRoot: path.join(projectRoot, '.cursor'), extra: { projectRoot }, modules: [] },
      { label: 'windsurf-home', target: 'windsurf', targetRoot: path.join(homeDir, '.codeium', 'windsurf'), extra: { homeDir }, modules: [] },
      { label: 'windsurf-project', target: 'windsurf-project', targetRoot: path.join(projectRoot, '.devin'), extra: { projectRoot }, modules: [] },
      { label: 'kiro-home', target: 'kiro', targetRoot: path.join(homeDir, '.kiro'), extra: { homeDir }, modules: [] },
      { label: 'kiro-project', target: 'kiro-project', targetRoot: path.join(projectRoot, '.kiro'), extra: { projectRoot }, modules: [] },
    ]) {
      const plan = planInstallTargetScaffold({ target, repoRoot, modules, ...extra });
      assert.ok(
        plan.operations.some(operation => (
          normalizedRelativePath(operation.sourceRelativePath) === adapterStdinJsonSource
          && operation.destinationPath === path.join(targetRoot, 'scripts', 'lib', 'adapter-stdin-json.js')
        )),
        `[${label}] Should plan a copy of adapter-stdin-json.js alongside the Guardian adapter`
      );
    }
  }));

  tally(test('trae and opencode ship the write validator next to the Bash guardian', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';
    const homeDir = '/Users/example';
    const traePlan = planInstallTargetScaffold({ target: 'trae', repoRoot, modules: [], projectRoot });
    const traeHooks = path.join(projectRoot, '.trae', 'hooks.json');
    const traeWriteScript = path.join(projectRoot, '.trae', 'scripts', 'hooks', 'pre-write-guardian-validate.js');
    const merges = traePlan.operations.filter(operation => (
      operation.kind === 'merge-claude-settings-hooks'
      && operation.destinationPath === traeHooks
      && operation.hookScriptPath === traeWriteScript
    ));
    assert.strictEqual(merges.length, 1, 'trae registers the write validator once');
    assert.strictEqual(merges[0].hookEvent, 'PreToolUse');
    assert.strictEqual(merges[0].hookMatcher, 'Edit|Write');
    assert.ok(traePlan.operations.some(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/pre-write-guardian-validate.js'
      && operation.destinationPath === traeWriteScript
    )), 'trae scaffolds the write validator script');

    const opencodePlan = planInstallTargetScaffold({ target: 'opencode', repoRoot, modules: [], homeDir });
    const opencodeWriteScript = path.join(homeDir, '.config', 'opencode', 'scripts', 'hooks', 'pre-write-guardian-validate.js');
    assert.ok(opencodePlan.operations.some(operation => (
      normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/pre-write-guardian-validate.js'
      && operation.destinationPath === opencodeWriteScript
    )), 'opencode scaffolds the write validator script for its plugin');
  }));

  tally(test('resolves trae adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('trae');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'trae-project');
    assert.strictEqual(adapter.target, 'trae');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.trae'));
    assert.strictEqual(statePath, path.join(projectRoot, '.trae', 'egc-install-state.json'));
  }));

  tally(test('resolves junie home adapter root to ~/.junie and install-state path', () => {
    const adapter = getInstallTargetAdapter('junie');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'junie-home');
    assert.strictEqual(adapter.target, 'junie');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.junie'));
    assert.strictEqual(statePath, path.join(homeDir, '.junie', 'egc', 'install-state.json'));
  }));

  tally(test('resolves junie project adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('junie-project');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'junie-project');
    assert.strictEqual(adapter.target, 'junie');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.junie'));
    assert.strictEqual(statePath, path.join(projectRoot, '.junie', 'egc-install-state.json'));
  }));

  tally(test('junie adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('junie');
    const byId = getInstallTargetAdapter('junie-home');
    const projectById = getInstallTargetAdapter('junie-project');

    assert.strictEqual(byTarget.id, 'junie-home');
    assert.strictEqual(byId.id, 'junie-home');
    assert.strictEqual(projectById.id, 'junie-project');
    assert.ok(byTarget.supports('junie'));
    assert.ok(byTarget.supports('junie-home'));
    assert.ok(projectById.supports('junie'));
    assert.ok(projectById.supports('junie-project'));
  }));

  tally(test('junie home adapter always plans Guardian and Crusher on PreToolUse/Bash, even with no modules selected', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const targetRoot = path.join(homeDir, '.junie');
    const configJsonPath = path.join(targetRoot, 'config.json');

    const plan = planInstallTargetScaffold({
      target: 'junie',
      repoRoot,
      homeDir,
      modules: [],
    });

    const mergeOperations = plan.operations.filter(operation => operation.destinationPath === configJsonPath);
    assert.strictEqual(mergeOperations.length, 2, 'Guardian and Crusher should each plan exactly one merge into ~/.junie/config.json');
    assert.ok(
      mergeOperations.every(operation => operation.hookEvent === 'PreToolUse' && operation.hookMatcher === 'Bash'),
      'Both merges must target PreToolUse with the Bash matcher'
    );

    const guardianMerge = mergeOperations.find(operation => operation.moduleId === 'egc-bash-guardian-hook');
    const crusherMerge = mergeOperations.find(operation => operation.moduleId === 'egc-crusher-hook');
    assert.ok(guardianMerge, 'Should plan the Guardian merge');
    assert.ok(crusherMerge, 'Should plan the Crusher merge');
    assert.strictEqual(guardianMerge.hookScriptPath, path.join(targetRoot, 'scripts', 'hooks', 'junie-guardian-adapter.js'));
    assert.strictEqual(crusherMerge.hookScriptPath, path.join(targetRoot, 'scripts', 'hooks', 'junie-crusher-adapter.js'));

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/junie-guardian-adapter.js'
        && operation.destinationPath === guardianMerge.hookScriptPath
      )),
      'Should plan the Junie-specific Guardian translation adapter copy even with no modules selected'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/junie-crusher-adapter.js'
        && operation.destinationPath === crusherMerge.hookScriptPath
      )),
      'Should plan the Junie-specific Crusher translation adapter copy even with no modules selected'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/lib/adapter-stdin-json.js'
        && operation.destinationPath === path.join(targetRoot, 'scripts', 'lib', 'adapter-stdin-json.js')
      )),
      'Should plan the shared adapter-stdin-json.js copy (both Junie adapters require it) -- regression guard for the exact MODULE_NOT_FOUND gap fixed in #1076'
    );
  }));

  tally(test('trae adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('trae');
    const byId = getInstallTargetAdapter('trae-project');

    assert.strictEqual(byTarget.id, 'trae-project');
    assert.strictEqual(byId.id, 'trae-project');
    assert.ok(byTarget.supports('trae'));
    assert.ok(byTarget.supports('trae-project'));
  }));

  tally(test('trae adapter preserves category structure under .trae/skills/ (default scaffold, no flat stripping)', () => {
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
      'Should preserve skills/<category>/<name> structure under .trae/skills/, the default scaffold'
    );
  }));

  tally(test('trae adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('trae'), 'Should include trae target');
  }));

  tally(test('trae adapter always plans Guardian and Crusher on PreToolUse/RunCommand, even with no modules selected', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';
    const targetRoot = path.join(projectRoot, '.trae');
    const hooksJsonPath = path.join(targetRoot, 'hooks.json');

    const plan = planInstallTargetScaffold({
      target: 'trae',
      repoRoot,
      projectRoot,
      modules: [],
    });

    const mergeOperations = plan.operations.filter(operation => operation.destinationPath === hooksJsonPath);
    assert.strictEqual(mergeOperations.length, 4, 'Guardian, write validator, Crusher, and mesh notice should each plan exactly one merge into .trae/hooks.json');
    assert.ok(
      mergeOperations
        .filter(operation => operation.hookEvent === 'PreToolUse')
        .every(operation => operation.hookMatcher === 'RunCommand' || operation.hookMatcher === 'Edit|Write'),
      'Tool merges must target PreToolUse with the RunCommand matcher (Trae\'s tool_name for shell, not Bash/Shell)'
    );

    const guardianMerge = mergeOperations.find(operation => operation.moduleId === 'egc-bash-guardian-hook');
    const crusherMerge = mergeOperations.find(operation => operation.moduleId === 'egc-crusher-hook');
    const meshMerge = mergeOperations.find(operation => operation.moduleId === 'egc-mesh-notice-hook');
    assert.ok(guardianMerge, 'Should plan the Guardian merge');
    assert.ok(crusherMerge, 'Should plan the Crusher merge');
    assert.ok(meshMerge, 'Should plan the mesh notice merge');
    assert.strictEqual(meshMerge.hookEvent, 'UserPromptSubmit', 'mesh notice rides the prompt boundary');
    assert.strictEqual(
      meshMerge.hookScriptPath,
      path.join(targetRoot, 'scripts', 'hooks', 'trae-mesh-notice-adapter.js'),
      'Trae registers the plain-text host adapter, not the JSON-emitting script'
    );
    assert.strictEqual(guardianMerge.hookScriptPath, path.join(targetRoot, 'scripts', 'hooks', 'pre-bash-guardian-validate.js'));
    assert.strictEqual(crusherMerge.hookScriptPath, path.join(targetRoot, 'scripts', 'hooks', 'crusher-hook.js'));

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/pre-bash-guardian-validate.js'
        && operation.destinationPath === guardianMerge.hookScriptPath
      )),
      'Should plan the shared Guardian validator script copy even with no modules selected'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/crusher-hook.js'
        && operation.destinationPath === crusherMerge.hookScriptPath
      )),
      'Should plan the shared Crusher hook script copy even with no modules selected'
    );
  }));

  tally(test('trae adapter accepts a singular input.module and treats a fully empty input as no modules', () => {
    // planInstallTargetScaffold() (used by the tests above) always normalizes
    // to an array before calling adapter.planOperations(), so these two
    // fallback branches are only reachable by calling the adapter directly --
    // the same shape install-executor.js's non-array call sites use.
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';
    const adapter = getInstallTargetAdapter('trae');
    const planningInput = { repoRoot, projectRoot, homeDir: '/home/example' };

    const singularModuleOperations = adapter.planOperations({
      ...planningInput,
      module: { id: 'workflow', paths: ['skills/workflow/tdd-workflow'] },
    });
    assert.ok(
      singularModuleOperations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
      )),
      'A singular input.module should still be scaffolded like a one-element modules array'
    );

    const noModulesOperations = adapter.planOperations({ ...planningInput });
    const hooksJsonOps = noModulesOperations.filter(operation => (
      operation.destinationPath === path.join(projectRoot, '.trae', 'hooks.json')
    ));
    assert.strictEqual(
      hooksJsonOps.length,
      4,
      'Guardian, write validator, Crusher, and mesh notice should still be planned unconditionally when neither modules nor module is present'
    );
  }));

  tally(test('resolves goose adapter root to ~/.agents (shared with Codex) and its own install-state path', () => {
    const adapter = getInstallTargetAdapter('goose');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'goose-home');
    assert.strictEqual(adapter.target, 'goose');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.agents'));
    assert.strictEqual(statePath, path.join(homeDir, '.agents', 'egc', 'goose-install-state.json'));
  }));

  tally(test('goose adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('goose');
    const byId = getInstallTargetAdapter('goose-home');

    assert.strictEqual(byTarget.id, 'goose-home');
    assert.strictEqual(byId.id, 'goose-home');
    assert.ok(byTarget.supports('goose'));
    assert.ok(byTarget.supports('goose-home'));
  }));

  tally(test('goose adapter strips category from skill paths and installs flat under ~/.agents/skills/', () => {
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
  }));

  tally(test('goose adapter wires the Guardian hook under its own self-contained plugin root (EGC-498 corrected)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'goose',
      repoRoot,
      homeDir,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    const mergeOperation = plan.operations.find(operation => operation.kind === 'merge-claude-settings-hooks');
    assert.ok(mergeOperation, 'Goose adapter should register a Guardian hook merge operation (real hook confirmed against aaif-goose/goose docs)');
    assert.strictEqual(
      mergeOperation.destinationPath,
      path.join(homeDir, '.agents', 'plugins', 'egc-guardian', 'hooks', 'hooks.json')
    );

    const adapterScriptOperation = plan.operations.find(operation => (
      operation.destinationPath === path.join(homeDir, '.agents', 'plugins', 'egc-guardian', 'scripts', 'hooks', 'goose-guardian-adapter.js')
    ));
    assert.ok(adapterScriptOperation, 'Goose adapter should copy goose-guardian-adapter.js as a sibling of the shared Guardian scripts, not the shared .agents/scripts/ root');
  }));

  tally(test('goose adapter has no Token Crusher wiring (no rewrite capability documented)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'goose',
      repoRoot,
      homeDir,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.ok(
      !plan.operations.some(operation => operation.destinationPath && operation.destinationPath.includes('crusher')),
      'Goose adapter should not register any Crusher-related operation'
    );
  }));

  tally(test('goose adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('goose'), 'Should include goose target');
  }));

  tally(test('resolves openhands adapter root to ~/.agents (shared with Codex/Goose) and its own install-state path', () => {
    const adapter = getInstallTargetAdapter('openhands');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'openhands-home');
    assert.strictEqual(adapter.target, 'openhands');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.agents'));
    assert.strictEqual(statePath, path.join(homeDir, '.agents', 'egc', 'openhands-install-state.json'));
  }));

  tally(test('openhands adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('openhands');
    const byId = getInstallTargetAdapter('openhands-home');

    assert.strictEqual(byTarget.id, 'openhands-home');
    assert.strictEqual(byId.id, 'openhands-home');
    assert.ok(byTarget.supports('openhands'));
    assert.ok(byTarget.supports('openhands-home'));
  }));

  tally(test('openhands adapter strips category from skill paths and installs flat under ~/.agents/skills/', () => {
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
  }));

  tally(test('openhands adapter has no GateGuard hook wiring', () => {
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
  }));

  tally(test('openhands adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('openhands'), 'Should include openhands target');
  }));

  tally(test('resolves aider adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('aider');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'aider-project');
    assert.strictEqual(adapter.target, 'aider');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.aider'));
    assert.strictEqual(statePath, path.join(projectRoot, '.aider', 'egc-install-state.json'));
  }));

  tally(test('aider adapter emits a flat skill copy plus a merge-yaml-read-list operation per skill', () => {
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
    assert.strictEqual(mergeOp.readEntry, '.aider/skills/tdd-workflow.md');
  }));

  tally(test('aider adapter filters out non-skill, non-rules module paths (agents, commands)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'aider',
      repoRoot,
      projectRoot,
      modules: [{ id: 'agents-core', paths: ['agents'] }, { id: 'commands-core', paths: ['commands'] }],
    });

    assert.strictEqual(plan.operations.length, 0, 'Non-skill, non-rules module paths should not produce operations');
  }));

  tally(test("aider adapter copies rules-core's memory.md and merges it into the read: list", () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'aider',
      repoRoot,
      projectRoot,
      modules: [{ id: 'rules-core', paths: ['rules'] }],
    });

    assert.strictEqual(plan.operations.length, 2, 'should emit a copy operation and a read-list merge operation');
    const copyOp = plan.operations.find(o => o.strategy === 'preserve-relative-path');
    const mergeOp = plan.operations.find(o => o.kind === 'merge-yaml-read-list');
    assert.ok(copyOp, 'must emit a copy operation for memory.md');
    assert.strictEqual(copyOp.destinationPath, path.join(projectRoot, '.aider', 'rules', 'common', 'memory.md'));
    assert.ok(mergeOp, 'must emit a merge-yaml-read-list operation');
    assert.strictEqual(mergeOp.destinationPath, path.join(projectRoot, '.aider.conf.yml'));
    assert.strictEqual(mergeOp.readEntry, '.aider/rules/common/memory.md');
  }));

  tally(test('aider adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('aider'), 'Should include aider target');
  }));

  tally(test('resolves qwen adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('qwen');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'qwen-project');
    assert.strictEqual(adapter.target, 'qwen');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.qwen'));
    assert.strictEqual(statePath, path.join(projectRoot, '.qwen', 'egc-install-state.json'));
  }));

  tally(test('qwen adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('qwen');
    const byId = getInstallTargetAdapter('qwen-project');

    assert.strictEqual(byTarget.id, 'qwen-project');
    assert.strictEqual(byId.id, 'qwen-project');
    assert.ok(byTarget.supports('qwen'));
    assert.ok(byTarget.supports('qwen-project'));
  }));

  tally(test('qwen adapter installs skills into the native .qwen/skills directory', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'qwen',
      repoRoot,
      projectRoot,
      modules: [{ id: 'testing', paths: ['skills/testing/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'qwen-project');

    const operation = plan.operations.find(op => (
      normalizedRelativePath(op.sourceRelativePath) === 'skills/testing/tdd-workflow'
    ));
    assert.ok(operation, 'Should plan the skill copy operation');
    assert.strictEqual(operation.kind, 'copy-path');
    assert.strictEqual(
      operation.destinationPath,
      path.join(projectRoot, '.qwen', 'skills', 'tdd-workflow')
    );
  }));

  tally(test('qwen adapter passes non-skill paths through and appears in the adapter list', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'qwen',
      repoRoot,
      projectRoot,
      modules: [{ id: 'rules-core', paths: ['rules'] }],
    });

    const rulesOperation = plan.operations.find(operation => (
      operation.destinationPath === path.join(projectRoot, '.qwen', 'rules')
    ));
    assert.ok(rulesOperation, 'Should pass the non-skill rules path through unchanged');
    assert.ok(
      listInstallTargetAdapters().some(adapter => adapter.target === 'qwen'),
      'Should include qwen target'
    );
  }));

  tally(test('qwen adapter always plans Guardian and Crusher on PreToolUse/run_shell_command, even with no modules selected', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';
    const settingsJsonPath = path.join(projectRoot, '.qwen', 'settings.json');

    const plan = planInstallTargetScaffold({
      target: 'qwen',
      repoRoot,
      projectRoot,
      modules: [],
    });

    const mergeOperations = plan.operations.filter(operation => operation.destinationPath === settingsJsonPath);
    assert.strictEqual(mergeOperations.length, 2, 'Guardian and Crusher should each plan exactly one merge into .qwen/settings.json');
    assert.ok(
      mergeOperations.every(operation => operation.hookEvent === 'PreToolUse' && operation.hookMatcher === 'run_shell_command'),
      'Both merges must target PreToolUse with the run_shell_command matcher (Qwen\'s tool_name for shell)'
    );

    const guardianMerge = mergeOperations.find(operation => operation.moduleId === 'egc-bash-guardian-hook');
    const crusherMerge = mergeOperations.find(operation => operation.moduleId === 'egc-crusher-hook');
    assert.ok(guardianMerge, 'Should plan the Guardian merge');
    assert.ok(crusherMerge, 'Should plan the Crusher merge');

    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/pre-bash-guardian-validate.js'
        && operation.destinationPath === guardianMerge.hookScriptPath
      )),
      'Should plan the shared Guardian validator script copy even with no modules selected'
    );
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'scripts/hooks/crusher-hook.js'
        && operation.destinationPath === crusherMerge.hookScriptPath
      )),
      'Should plan the shared Crusher hook script copy even with no modules selected'
    );
  }));

  tally(test('resolves kimi adapter root and install-state path from the home directory', () => {
    const previous = process.env.KIMI_CODE_HOME;
    delete process.env.KIMI_CODE_HOME;
    try {
      const adapter = getInstallTargetAdapter('kimi');
      const homeDir = '/home/example';
      assert.strictEqual(adapter.id, 'kimi-home');
      assert.strictEqual(adapter.target, 'kimi');
      assert.strictEqual(adapter.kind, 'home');
      assert.strictEqual(adapter.resolveRoot({ homeDir }), path.join(homeDir, '.kimi-code'));
      assert.strictEqual(
        adapter.getInstallStatePath({ homeDir }),
        path.join(homeDir, '.kimi-code', 'egc', 'install-state.json')
      );
      const byId = getInstallTargetAdapter('kimi-home');
      assert.strictEqual(byId.target, 'kimi', 'kimi is reachable by target id and adapter id');
      const { listInstallTargetAdapters } = require('../../scripts/lib/install-targets/registry');
      assert.ok(listInstallTargetAdapters().some(a => a.target === 'kimi'), 'kimi is registered in the adapter list');
    } finally {
      if (previous === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previous;
    }
  }));

  tally(test('kimi adapter routes resolveRoot, every plan destination and every managed root through KIMI_CODE_HOME', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/home/example';
    const previous = process.env.KIMI_CODE_HOME;
    const customHome = path.resolve('/custom/egc-kimi-home');
    try {
      process.env.KIMI_CODE_HOME = customHome;
      const adapter = getInstallTargetAdapter('kimi');
      assert.strictEqual(adapter.resolveRoot({ homeDir }), customHome, 'resolveRoot honours KIMI_CODE_HOME');
      const plan = planInstallTargetScaffold({ target: 'kimi', repoRoot, homeDir, modules: [{ id: 'rules-core', paths: ['rules'] }] });
      assert.strictEqual(plan.targetRoot, customHome, 'the plan target root is KIMI_CODE_HOME, not ~/.kimi-code');
      assert.ok(plan.installStatePath.startsWith(customHome), 'the install-state path sits under KIMI_CODE_HOME');
      assert.ok(plan.operations.length > 0, 'the rules module plans at least one operation');
      for (const operation of plan.operations) {
        assert.ok(
          String(operation.destinationPath).startsWith(customHome),
          `every destination must sit under KIMI_CODE_HOME, found ${operation.destinationPath}`
        );
      }
      assert.ok(plan.managedRoots.length > 0, 'the plan declares at least one managed root');
      for (const root of plan.managedRoots) {
        assert.ok(root === customHome || root.startsWith(customHome + path.sep), `managed root ${root} must sit under KIMI_CODE_HOME`);
      }
    } finally {
      if (previous === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previous;
    }
  }));

  tally(test('kimi adapter installs skills flat under the .kimi-code/skills directory', () => {
    const previous = process.env.KIMI_CODE_HOME;
    delete process.env.KIMI_CODE_HOME;
    try {
      const repoRoot = path.join(__dirname, '..', '..');
      const homeDir = '/home/example';
      const plan = planInstallTargetScaffold({ target: 'kimi', repoRoot, homeDir, modules: [{ id: 'skills-core', paths: ['skills'] }] });
      const skillsRoot = path.join(homeDir, '.kimi-code', 'skills');
      assert.ok(
        plan.operations.some(operation => String(operation.destinationPath).startsWith(skillsRoot)),
        'at least one skill lands under ~/.kimi-code/skills'
      );
    } finally {
      if (previous === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previous;
    }
  }));

  tally(test('resolves warp adapter root and install-state path from project root', () => {
    const adapter = getInstallTargetAdapter('warp');
    const projectRoot = '/workspace/app';
    const root = adapter.resolveRoot({ projectRoot });
    const statePath = adapter.getInstallStatePath({ projectRoot });

    assert.strictEqual(adapter.id, 'warp-project');
    assert.strictEqual(adapter.target, 'warp');
    assert.strictEqual(adapter.kind, 'project');
    assert.strictEqual(root, path.join(projectRoot, '.warp'));
    assert.strictEqual(statePath, path.join(projectRoot, '.warp', 'egc-install-state.json'));
  }));

  tally(test('warp adapter emits a flat skill copy plus a merge-markdown-skill-index operation per skill', () => {
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
    assert.strictEqual(mergeOp.relativePath, '.warp/skills/tdd-workflow.md');
    assert.ok(mergeOp.skillDescription.startsWith('Use this skill when writing new features'));
    assert.ok(mergeOp.skillDescription.length <= 110, 'Description should be truncated to the shared max length');
  }));

  tally(test('warp adapter extracts a description from a multiline YAML block-scalar frontmatter field', () => {
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
  }));

  tally(test('warp adapter falls back to an empty description when SKILL.md has no frontmatter', () => {
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
  }));

  tally(test('warp adapter filters out non-skill, non-rules module paths (agents, commands)', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'warp',
      repoRoot,
      projectRoot,
      modules: [{ id: 'agents-core', paths: ['agents'] }, { id: 'commands-core', paths: ['commands'] }],
    });

    assert.strictEqual(plan.operations.length, 0, 'Non-skill, non-rules module paths should not produce operations');
  }));

  tally(test("warp adapter copies rules-core's memory.md and merges an index entry into AGENTS.md", () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const projectRoot = '/workspace/app';

    const plan = planInstallTargetScaffold({
      target: 'warp',
      repoRoot,
      projectRoot,
      modules: [{ id: 'rules-core', paths: ['rules'] }],
    });

    assert.strictEqual(plan.operations.length, 2, 'should emit a copy operation and an AGENTS.md merge operation');
    const copyOp = plan.operations.find(o => o.strategy === 'preserve-relative-path');
    const mergeOp = plan.operations.find(o => o.kind === 'merge-markdown-skill-index');
    assert.ok(copyOp, 'must emit a copy operation for memory.md');
    assert.strictEqual(copyOp.destinationPath, path.join(projectRoot, '.warp', 'rules', 'common', 'memory.md'));
    assert.ok(mergeOp, 'must emit a merge-markdown-skill-index operation');
    assert.strictEqual(mergeOp.destinationPath, path.join(projectRoot, 'AGENTS.md'));
    assert.strictEqual(mergeOp.skillName, 'EGC Session Memory');
  }));

  tally(test('warp adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('warp'), 'Should include warp target');
  }));

  tally(test('generic planRetirements (the default every target gets with no adapter override) retires a file that left the plan, keeps a still-planned file and a destination outside the root, and plans nothing without a previous install (#1412)', () => {
    const fs = require('fs');
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-generic-retire-repo-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-generic-retire-home-'));
    try {
      fs.mkdirSync(path.join(repoRoot, 'commands'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'commands', 'kept.md'), 'kept');
      fs.writeFileSync(path.join(repoRoot, 'commands', 'old-name.md'), 'renamed away, source unchanged');

      // A plain adapter with no planOperations/planRetirements of its own,
      // the shape most real targets are (windsurf, amp, copilot, ...): it
      // gets the shared defaults for both.
      const adapter = createInstallTargetAdapter({
        id: 'egc-generic-retire-target',
        target: 'egc-generic-retire-target',
        kind: 'home',
        rootSegments: ['egc-generic-retire-target'],
        installStatePathSegments: ['egc', 'install-state.json'],
      });

      const targetRoot = adapter.resolveRoot({ repoRoot, homeDir });
      const installStatePath = adapter.getInstallStatePath({ repoRoot, homeDir });
      const planningInput = { repoRoot, homeDir, modules: [{ id: 'x', paths: ['commands/kept.md'] }] };

      assert.deepStrictEqual(adapter.planRetirements(planningInput), [], 'no previous install, nothing to retire');

      const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
      const previous = [
        // Still named by a module path in planningInput below: stays.
        ['commands/kept.md', path.join(targetRoot, 'commands', 'kept.md')],
        // Renamed away: the source is still in the repo, just not
        // referenced by any module path anymore. This is the common case
        // (a command or prompt renamed in the package): retired.
        ['commands/old-name.md', path.join(targetRoot, 'commands', 'old-name.md')],
        // Dropped from the package entirely, source gone too. Still a
        // *candidate* here: apply.js's identity check (#1411) is what
        // actually refuses to delete it, since it cannot verify the file
        // is unchanged.
        ['commands/removed.md', path.join(targetRoot, 'commands', 'removed.md')],
        // Outside this target's root: never a candidate, whatever the
        // state says.
        ['commands/escaped.md', path.join(homeDir, 'elsewhere', 'escaped.md')],
      ];
      const state = createInstallState({
        adapter: { id: adapter.id },
        targetRoot,
        installStatePath,
        request: { profile: 'full', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: previous.map(([sourceRelativePath, destinationPath]) => ({
          kind: 'copy-file',
          moduleId: 'x',
          sourceRelativePath,
          destinationPath,
          strategy: 'preserve-relative-path',
          ownership: 'managed',
          scaffoldOnly: false,
        })),
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      });
      writeInstallState(installStatePath, state);

      const expectedDestinations = [
        path.join(targetRoot, 'commands', 'old-name.md'),
        path.join(targetRoot, 'commands', 'removed.md'),
      ].sort();

      const retirements = adapter.planRetirements(planningInput);
      assert.deepStrictEqual(
        retirements.map(entry => entry.destinationPath).sort(),
        expectedDestinations,
        'the renamed-away and dropped files are offered up; the still-planned file and the one outside the root are not'
      );
      for (const entry of retirements) {
        assert.strictEqual(
          entry.sourcePath,
          path.join(repoRoot, ...entry.sourceRelativePath.split('/')),
          'each candidate names the file EGC copied, for apply.js to compare'
        );
      }

      // registry.js passes the already-planned operations through to avoid
      // planning a second time; the result must not depend on that.
      const withPrecomputedOperations = adapter.planRetirements({
        ...planningInput,
        operations: adapter.planOperations(planningInput),
      });
      assert.deepStrictEqual(
        withPrecomputedOperations.map(entry => entry.destinationPath).sort(),
        expectedDestinations,
        'passing already-planned operations through gives the same result as planning them again'
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }));

  tally(test('generic planRetirements treats a directory-shaped scaffold operation as covering every file under it (#1412)', () => {
    const fs = require('fs');
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-generic-retire-dir-repo-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-generic-retire-dir-home-'));
    try {
      fs.mkdirSync(path.join(repoRoot, 'bundle', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'bundle', 'a.md'), 'a');
      fs.writeFileSync(path.join(repoRoot, 'bundle', 'nested', 'b.md'), 'b');

      const adapter = createInstallTargetAdapter({
        id: 'egc-generic-retire-dir-target',
        target: 'egc-generic-retire-dir-target',
        kind: 'home',
        rootSegments: ['egc-generic-retire-dir-target'],
        installStatePathSegments: ['egc', 'install-state.json'],
      });

      const targetRoot = adapter.resolveRoot({ repoRoot, homeDir });
      const installStatePath = adapter.getInstallStatePath({ repoRoot, homeDir });
      // A single module path naming the whole directory, the same shape a
      // recursive scaffold copy plans: one 'copy-path' operation for
      // 'bundle', not one per file underneath.
      const planningInput = { repoRoot, homeDir, modules: [{ id: 'x', paths: ['bundle'] }] };

      const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
      // What an earlier install actually recorded: one copy-file entry per
      // file the directory copy produced, as install-executor.js's
      // materializeScaffoldOperation expands it.
      const state = createInstallState({
        adapter: { id: adapter.id },
        targetRoot,
        installStatePath,
        request: { profile: 'full', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: [
          { kind: 'copy-file', moduleId: 'x', sourceRelativePath: 'bundle/a.md', destinationPath: path.join(targetRoot, 'bundle', 'a.md'), strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false },
          { kind: 'copy-file', moduleId: 'x', sourceRelativePath: 'bundle/nested/b.md', destinationPath: path.join(targetRoot, 'bundle', 'nested', 'b.md'), strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false },
        ],
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      });
      writeInstallState(installStatePath, state);

      assert.deepStrictEqual(
        adapter.planRetirements(planningInput),
        [],
        'both files still live inside the planned directory, so neither is offered up'
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }));

  tally(test('generic planRetirements retires a file recorded under a planned directory once it leaves that directory, and a root-wide directory copy no longer shields another module file that left the plan', () => {
    const fs = require('fs');
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-generic-retire-left-repo-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-generic-retire-left-home-'));
    try {
      fs.mkdirSync(path.join(repoRoot, 'bundle', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'bundle', 'a.md'), 'a');
      // A tooling file the installer never copies today, recorded by an
      // older install that did.
      fs.writeFileSync(path.join(repoRoot, 'bundle', '.gitignore'), 'x');
      // A generated install-state left in the source tree: the executor
      // never copies it, so it covers nothing.
      fs.mkdirSync(path.join(repoRoot, 'bundle', 'egc'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'bundle', 'egc', 'install-state.json'), '{}');
      fs.writeFileSync(path.join(repoRoot, 'bundle', 'egc', 'codex-install-state.json'), '{}');
      fs.mkdirSync(path.join(repoRoot, 'rootcopy'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'rootcopy', 'kept.md'), 'kept');
      fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'scripts', 'dropped.js'), 'dropped');

      const adapter = createInstallTargetAdapter({
        id: 'egc-generic-retire-left-target',
        target: 'egc-generic-retire-left-target',
        kind: 'home',
        rootSegments: ['egc-generic-retire-left-target'],
        installStatePathSegments: ['egc', 'install-state.json'],
        // Like codex's '.agents -> .agents': one module copies a whole
        // directory onto the target root itself.
        planOperations(input, self) {
          const root = self.resolveRoot(input);
          return [
            { kind: 'copy-path', moduleId: 'x', sourceRelativePath: 'bundle', destinationPath: path.join(root, 'bundle'), strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false },
            { kind: 'copy-path', moduleId: 'y', sourceRelativePath: 'rootcopy', destinationPath: root, strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false },
          ];
        },
      });

      const targetRoot = adapter.resolveRoot({ repoRoot, homeDir });
      const installStatePath = adapter.getInstallStatePath({ repoRoot, homeDir });
      const planningInput = { repoRoot, homeDir, modules: [{ id: 'x', paths: ['bundle'] }, { id: 'y', paths: ['rootcopy'] }, { id: 'z', paths: [] }] };
      const copy = (moduleId, sourceRelativePath, destination) => ({ kind: 'copy-file', moduleId, sourceRelativePath, destinationPath: destination, strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false });

      const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
      writeInstallState(installStatePath, createInstallState({
        adapter: { id: adapter.id },
        targetRoot,
        installStatePath,
        request: { profile: 'full', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: [
          copy('x', 'bundle/a.md', path.join(targetRoot, 'bundle', 'a.md')),
          copy('x', 'bundle/nested/b.md', path.join(targetRoot, 'bundle', 'nested', 'b.md')),
          copy('x', 'bundle/.gitignore', path.join(targetRoot, 'bundle', '.gitignore')),
          copy('x', 'bundle/egc/install-state.json', path.join(targetRoot, 'bundle', 'egc', 'install-state.json')),
          copy('x', 'bundle/egc/codex-install-state.json', path.join(targetRoot, 'bundle', 'egc', 'codex-install-state.json')),
          copy('y', 'rootcopy/kept.md', path.join(targetRoot, 'kept.md')),
          copy('z', 'scripts/dropped.js', path.join(targetRoot, 'scripts', 'dropped.js')),
        ],
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      }));

      assert.deepStrictEqual(
        adapter.planRetirements(planningInput).map(entry => path.relative(targetRoot, entry.destinationPath)).sort(),
        [path.join('bundle', '.gitignore'), path.join('bundle', 'egc', 'codex-install-state.json'), path.join('bundle', 'egc', 'install-state.json'), path.join('bundle', 'nested', 'b.md'), path.join('scripts', 'dropped.js')].sort(),
        'b.md left the planned directory, .gitignore and the generated install-state are never copied, and dropped.js left its module; a.md and kept.md are still written'
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }));

  tally(test('generic planRetirements honors a declared second managed root, so an adapter that writes outside its own root can still retire its files (#1412)', () => {
    const fs = require('fs');
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-generic-retire-roots-repo-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-generic-retire-roots-home-'));
    try {
      fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'scripts', 'plugin.ts'), 'plugin');

      // Mirrors amp-home's real shape: skills under the adapter root, plugin
      // scripts under a second XDG-style root (resolveAmpConfigRoot), both
      // declared via resolveManagedRoots.
      const rootsTarget = path.join(homeDir, '.config', 'egc-generic-retire-roots-target');
      const adapter = createInstallTargetAdapter({
        id: 'egc-generic-retire-roots-target',
        target: 'egc-generic-retire-roots-target',
        kind: 'home',
        rootSegments: ['egc-generic-retire-roots-target'],
        installStatePathSegments: ['egc', 'install-state.json'],
        resolveManagedRoots(input) {
          return [path.join(input.homeDir || homeDir, 'egc-generic-retire-roots-target'), path.join(input.homeDir || homeDir, '.config', 'egc-generic-retire-roots-target')];
        },
      });
      const installStatePath = adapter.getInstallStatePath({ repoRoot, homeDir });
      const planningInput = { repoRoot, homeDir, modules: [{ id: 'x', paths: ['scripts/plugin.ts'] }] };

      const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
      const state = createInstallState({
        adapter: { id: adapter.id },
        targetRoot: rootsTarget,
        installStatePath,
        request: { profile: 'full', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: [
          { kind: 'copy-file', moduleId: 'x', sourceRelativePath: 'scripts/plugin.ts', destinationPath: path.join(rootsTarget, 'plugins', 'plugin.ts'), strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false },
          // A destination under a root this adapter does NOT trust: stays
          // untouched even though the module dropped it.
          { kind: 'copy-file', moduleId: 'x', sourceRelativePath: 'scripts/plugin.ts', destinationPath: path.join(homeDir, 'untrusted', 'plugin.ts'), strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false },
        ],
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      });
      writeInstallState(installStatePath, state);

      assert.deepStrictEqual(
        adapter.planRetirements(planningInput).map(entry => entry.destinationPath),
        [path.join(rootsTarget, 'plugins', 'plugin.ts')],
        'the file under the declared second root is offered up; the one under an untrusted root is not'
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }));

  tally(test('generic planRetirements does not retire a file a sibling adapter sharing the same root still owns (#1412)', () => {
    const fs = require('fs');
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-generic-retire-sibling-repo-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-generic-retire-sibling-home-'));
    try {
      fs.mkdirSync(path.join(repoRoot, 'skills', 'shared'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'skills', 'shared', 'SKILL.md'), 'shared skill');
      fs.mkdirSync(path.join(repoRoot, 'skills', 'kept'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'skills', 'kept', 'SKILL.md'), 'kept skill');

      const adapterA = createInstallTargetAdapter({
        id: 'egc-generic-retire-sibling-a',
        target: 'egc-generic-retire-sibling-a',
        kind: 'home',
        rootSegments: ['egc-generic-retire-shared-root'],
        installStatePathSegments: ['egc', 'a-install-state.json'],
      });
      const adapterB = createInstallTargetAdapter({
        id: 'egc-generic-retire-sibling-b',
        target: 'egc-generic-retire-sibling-b',
        kind: 'home',
        rootSegments: ['egc-generic-retire-shared-root'],
        installStatePathSegments: ['egc', 'b-install-state.json'],
      });

      const targetRoot = adapterA.resolveRoot({ repoRoot, homeDir });
      const siblingBStatePath = adapterB.getInstallStatePath({ repoRoot, homeDir });
      const planningInputA = { repoRoot, homeDir, modules: [{ id: 'x', paths: ['skills/kept/SKILL.md'] }] };

      const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
      // A's own previous state: it installed the shared skill, but its plan
      // dropped it. B's sibling state still owns the same destination.
      const stateA = createInstallState({
        adapter: { id: adapterA.id },
        targetRoot,
        installStatePath: adapterA.getInstallStatePath({ repoRoot, homeDir }),
        request: { profile: 'full', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: [
          { kind: 'copy-file', moduleId: 'x', sourceRelativePath: 'skills/shared/SKILL.md', destinationPath: path.join(targetRoot, 'skills', 'shared', 'SKILL.md'), strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false },
        ],
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      });
      const stateB = {
        ...createInstallState({
          adapter: { id: adapterB.id },
          targetRoot,
          installStatePath: siblingBStatePath,
          request: { profile: 'full', modules: [], legacyLanguages: [], legacyMode: false },
          resolution: { selectedModules: [], skippedModules: [] },
          operations: [
            { kind: 'copy-file', moduleId: 'y', sourceRelativePath: 'skills/shared/SKILL.md', destinationPath: path.join(targetRoot, 'skills', 'shared', 'SKILL.md'), strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false },
          ],
          source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
        }),
      };
      writeInstallState(adapterA.getInstallStatePath({ repoRoot, homeDir }), stateA);
      writeInstallState(siblingBStatePath, stateB);

      assert.deepStrictEqual(
        adapterA.planRetirements({
          ...planningInputA,
          operations: adapterA.planOperations(planningInputA),
          siblingStatePaths: [siblingBStatePath],
        }),
        [],
        'B still owns the shared skill, so A must not retire it'
      );

      // Once B no longer records the destination, A's candidate is offered.
      writeInstallState(siblingBStatePath, {
        ...stateB,
        operations: stateB.operations.filter(operation => operation.kind !== 'copy-file'),
      });
      const retirements = adapterA.planRetirements({
        ...planningInputA,
        operations: adapterA.planOperations(planningInputA),
        siblingStatePaths: [siblingBStatePath],
      });
      assert.deepStrictEqual(
        retirements.map(entry => entry.destinationPath),
        [path.join(targetRoot, 'skills', 'shared', 'SKILL.md')],
        'with no sibling ownership left, the dropped skill is offered up'
      );

      // A sibling that never installed anything has no state file: absent,
      // and the candidate is still offered up.
      const absentSibling = path.join(homeDir, 'nowhere', 'install-state.json');
      assert.deepStrictEqual(
        adapterA.planRetirements({ ...planningInputA, operations: adapterA.planOperations(planningInputA), siblingStatePaths: [absentSibling] }).map(entry => entry.destinationPath),
        [path.join(targetRoot, 'skills', 'shared', 'SKILL.md')],
        'a missing sibling state owns nothing'
      );

      // A sibling state that exists but cannot be parsed may still own the
      // destination: nothing is offered up until it can be read again.
      fs.writeFileSync(siblingBStatePath, '{ not json');
      assert.deepStrictEqual(
        adapterA.planRetirements({ ...planningInputA, operations: adapterA.planOperations(planningInputA), siblingStatePaths: [siblingBStatePath] }),
        [],
        'a malformed sibling state suppresses retirement'
      );

      // A dangling link at the sibling's state path is not an absence: the
      // link is there, the state behind it is not, so nothing is offered up.
      if (process.platform !== 'win32') {
        const dangling = path.join(homeDir, 'dangling-install-state.json');
        fs.symlinkSync(path.join(homeDir, 'nowhere.json'), dangling);
        assert.deepStrictEqual(
          adapterA.planRetirements({ ...planningInputA, operations: adapterA.planOperations(planningInputA), siblingStatePaths: [dangling] }),
          [],
          'a dangling link at a sibling state path suppresses retirement'
        );
      }

      // Same for a state that is valid but unreadable (no permission bits),
      // and for a state whose parent cannot be inspected; root reads
      // everything, so the checks only mean something elsewhere.
      if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
        const sealed = path.join(homeDir, 'sealed');
        const sealedState = path.join(sealed, 'install-state.json');
        fs.mkdirSync(sealed);
        writeInstallState(sealedState, stateB);
        fs.chmodSync(sealed, 0o000);
        try {
          assert.deepStrictEqual(
            adapterA.planRetirements({ ...planningInputA, operations: adapterA.planOperations(planningInputA), siblingStatePaths: [sealedState] }),
            [],
            'a sibling state behind an inaccessible parent suppresses retirement'
          );
        } finally {
          fs.chmodSync(sealed, 0o700);
        }

        writeInstallState(siblingBStatePath, stateB);
        fs.chmodSync(siblingBStatePath, 0o000);
        try {
          assert.deepStrictEqual(
            adapterA.planRetirements({ ...planningInputA, operations: adapterA.planOperations(planningInputA), siblingStatePaths: [siblingBStatePath] }),
            [],
            'an unreadable sibling state suppresses retirement'
          );
        } finally {
          fs.chmodSync(siblingBStatePath, 0o600);
        }
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }));

  tally(test('generic planRetirements leaves the files of a module that was not selected this run alone, and only offers up what left a module the plan still includes (#1412)', () => {
    const fs = require('fs');
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-generic-retire-subset-repo-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-generic-retire-subset-home-'));
    try {
      fs.mkdirSync(path.join(repoRoot, 'commands'), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, 'skills', 'tool'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'commands', 'kept.md'), 'kept');
      fs.writeFileSync(path.join(repoRoot, 'commands', 'old-name.md'), 'renamed away, source unchanged');
      fs.writeFileSync(path.join(repoRoot, 'skills', 'tool', 'SKILL.md'), 'a skill of another module');

      const adapter = createInstallTargetAdapter({
        id: 'egc-generic-retire-subset-target',
        target: 'egc-generic-retire-subset-target',
        kind: 'home',
        rootSegments: ['egc-generic-retire-subset-target'],
        installStatePathSegments: ['egc', 'install-state.json'],
      });
      const targetRoot = adapter.resolveRoot({ repoRoot, homeDir });
      const installStatePath = adapter.getInstallStatePath({ repoRoot, homeDir });

      const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
      // A full install recorded two modules; module y is not selected below.
      const state = createInstallState({
        adapter: { id: adapter.id },
        targetRoot,
        installStatePath,
        request: { profile: 'full', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: [
          { kind: 'copy-file', moduleId: 'x', sourceRelativePath: 'commands/kept.md', destinationPath: path.join(targetRoot, 'commands', 'kept.md'), strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false },
          { kind: 'copy-file', moduleId: 'x', sourceRelativePath: 'commands/old-name.md', destinationPath: path.join(targetRoot, 'commands', 'old-name.md'), strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false },
          { kind: 'copy-file', moduleId: 'y', sourceRelativePath: 'skills/tool/SKILL.md', destinationPath: path.join(targetRoot, 'skills', 'tool', 'SKILL.md'), strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false },
        ],
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      });
      writeInstallState(installStatePath, state);

      // A targeted install of module x only: y's skill is not in the plan, but
      // it was not dropped from the package either, so it stays untouched.
      const subset = adapter.planRetirements({ repoRoot, homeDir, modules: [{ id: 'x', paths: ['commands/kept.md'] }] });
      assert.deepStrictEqual(
        subset.map(entry => entry.destinationPath),
        [path.join(targetRoot, 'commands', 'old-name.md')],
        'only the file that left module x is offered up; module y was simply not selected'
      );

      // With both modules selected the answer is the same: y still covers its skill.
      const both = adapter.planRetirements({ repoRoot, homeDir, modules: [{ id: 'x', paths: ['commands/kept.md'] }, { id: 'y', paths: ['skills/tool/SKILL.md'] }] });
      assert.deepStrictEqual(both.map(entry => entry.destinationPath), [path.join(targetRoot, 'commands', 'old-name.md')]);

      // No modules selected at all: nothing is offered up.
      assert.deepStrictEqual(adapter.planRetirements({ repoRoot, homeDir, modules: [] }), []);

      // No repoRoot: identities cannot be compared, so nothing is offered up.
      assert.deepStrictEqual(adapter.planRetirements({ homeDir, modules: [{ id: 'x', paths: ['commands/kept.md'] }] }), []);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }));

  tally(test('planInstallTargetScaffold carries the managed roots of the target into the plan, for the apply to check retirements against (#1412)', () => {
    const fs = require('fs');
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-managed-roots-repo-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-managed-roots-home-'));
    try {
      const amp = planInstallTargetScaffold({ target: 'amp-home', repoRoot, homeDir, modules: [] });
      assert.deepStrictEqual(
        amp.managedRoots.map(normalizedRelativePath).sort(),
        [path.join(homeDir, '.amp'), path.join(homeDir, '.config', 'amp')].map(normalizedRelativePath).sort(),
        'amp-home declares its skills root and its plugin config root'
      );
      const claude = planInstallTargetScaffold({ target: 'claude-home', repoRoot, homeDir, modules: [] });
      assert.deepStrictEqual(claude.managedRoots, [claude.targetRoot], 'a target with one root declares just that root');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }));

  tally(test('identity paths .agents and AGENTS.md are foreign for targets that only take the agent files', () => {
    const { isForeignPlatformPath } = require('../../scripts/lib/install-targets/helpers');
    for (const target of ['claude', 'windsurf', 'amp', 'copilot', 'junie', 'goose', 'openhands', 'opencode', 'qwen', 'cline', 'kiro', 'crush']) {
      assert.ok(isForeignPlatformPath('.agents', target), `.agents must not land on ${target}`);
      assert.ok(isForeignPlatformPath('AGENTS.md', target), `AGENTS.md must not land on ${target}`);
      assert.ok(!isForeignPlatformPath('agents', target), `agents/ must land on ${target}`);
    }
    for (const target of ['egc', 'codex', 'antigravity', 'cursor', 'codebuddy', 'zed']) {
      assert.ok(!isForeignPlatformPath('.agents', target), `.agents stays on ${target}`);
      assert.ok(!isForeignPlatformPath('AGENTS.md', target), `AGENTS.md stays on ${target}`);
    }
  }));

  tally(test('claude adapter installs the agents under ~/.claude/agents with the Claude Code frontmatter transform', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const plan = planInstallTargetScaffold({
      target: 'claude',
      repoRoot,
      homeDir,
      modules: [{ id: 'agents-core', paths: ['.agents', 'agents', 'AGENTS.md'] }],
    });
    const agentOps = plan.operations.filter(op => normalizedRelativePath(op.sourceRelativePath).startsWith('agents/'));
    assert.ok(agentOps.length >= 60, `expected one operation per agent file, got ${agentOps.length}`);
    const reviewer = agentOps.find(op => normalizedRelativePath(op.sourceRelativePath) === 'agents/code-reviewer.md');
    assert.ok(reviewer, 'code-reviewer must be planned');
    assert.strictEqual(reviewer.destinationPath, path.join(homeDir, '.claude', 'agents', 'code-reviewer.md'));
    assert.strictEqual(reviewer.transform, 'claude-agent-frontmatter');
    assert.ok(
      !plan.operations.some(op => ['.agents', 'AGENTS.md'].includes(normalizedRelativePath(op.sourceRelativePath))),
      '.agents and AGENTS.md are Codex and Antigravity files'
    );
  }));

  tally(test('claude adapter installs a single agent file with the same transform and a command as-is', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const plan = planInstallTargetScaffold({
      target: 'claude',
      repoRoot,
      homeDir,
      modules: [{ id: 'engineering-auditor', paths: ['agents/engineering-auditor.md', 'commands/engineering-fix.md', 'commands/engineering-audit.md'] }, { id: 'skills-fixture', paths: ['skills/general/engineering-audit'] }],
    });
    const agent = plan.operations.find(op => normalizedRelativePath(op.sourceRelativePath) === 'agents/engineering-auditor.md');
    assert.ok(agent, 'the agent file must be planned');
    assert.strictEqual(agent.destinationPath, path.join(homeDir, '.claude', 'agents', 'engineering-auditor.md'));
    assert.strictEqual(agent.transform, 'claude-agent-frontmatter');
    const command = plan.operations.find(op => normalizedRelativePath(op.sourceRelativePath) === 'commands/engineering-fix.md');
    assert.ok(command, 'the command file must be planned');
    assert.strictEqual(command.destinationPath, path.join(homeDir, '.claude', 'commands', 'engineering-fix.md'));
    assert.ok(!plan.operations.some(op => normalizedRelativePath(op.sourceRelativePath) === 'commands/engineering-audit.md'), 'a single-file command shadowed by the engineering-audit skill of the same plan stays out');
    assert.strictEqual(command.transform, undefined);
  }));

  tally(test('claude adapter installs the rules flat under ~/.claude/rules, without the Chinese mirror or READMEs', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const plan = planInstallTargetScaffold({
      target: 'claude',
      repoRoot,
      homeDir,
      modules: [{ id: 'rules-core', paths: ['rules'] }],
    });
    const ruleOps = plan.operations.filter(op => normalizedRelativePath(op.sourceRelativePath).startsWith('rules/'));
    assert.ok(ruleOps.length >= 90, `expected one operation per rule file, got ${ruleOps.length}`);
    const common = ruleOps.find(op => normalizedRelativePath(op.sourceRelativePath) === 'rules/common/coding-style.md');
    assert.ok(common, 'the common coding-style rule must be planned');
    assert.strictEqual(common.destinationPath, path.join(homeDir, '.claude', 'rules', 'common-coding-style.md'));
    assert.ok(
      !ruleOps.some(op => normalizedRelativePath(op.sourceRelativePath).startsWith('rules/zh/')),
      'rules/zh mirrors rules/common and would load into every session'
    );
    assert.ok(
      !ruleOps.some(op => path.basename(op.sourceRelativePath).toLowerCase() === 'readme.md'),
      'a README is navigation, not a rule'
    );
  }));

  tally(test('claude adapter installs the commands under ~/.claude/commands', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const plan = planInstallTargetScaffold({
      target: 'claude',
      repoRoot,
      homeDir,
      modules: [{ id: 'commands-core', paths: ['commands'] }],
    });
    const plans = plan.operations.filter(op => normalizedRelativePath(op.sourceRelativePath).startsWith('commands/'));
    assert.ok(plans.length >= 70, `${plans.length} command files planned`);
    assert.ok(plans.every(op => path.dirname(op.destinationPath) === path.join(homeDir, '.claude', 'commands')), 'every command lands in ~/.claude/commands');
    assert.ok(plans.some(op => normalizedRelativePath(op.sourceRelativePath) === 'commands/plan.md' && op.destinationPath === path.join(homeDir, '.claude', 'commands', 'plan.md')));
  }));

  tally(test('claude adapter leaves out a command whose name is also a skill of the same plan: Claude Code would list the slash command twice', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const commandNames = plan => new Set(plan.operations
      .filter(op => normalizedRelativePath(op.sourceRelativePath).startsWith('commands/'))
      .map(op => path.basename(op.destinationPath, '.md')));
    const withSkills = planInstallTargetScaffold({ target: 'claude', repoRoot, homeDir, modules: [
      { id: 'commands-core', paths: ['commands'] },
      { id: 'skills-fixture', paths: ['skills/security/security-scan', 'skills/ai', 'skills/general/engineering-audit'] },
    ] });
    const names = commandNames(withSkills);
    assert.ok(names.has('plan') && names.has('review-pr'), 'ordinary commands still land');
    for (const shadowed of ['autonomous-lesson-learning', 'engineering-audit', 'security-scan']) {
      assert.ok(!names.has(shadowed), `${shadowed} is a skill of this plan and its command stays out`);
    }
    const withoutSkills = commandNames(planInstallTargetScaffold({ target: 'claude', repoRoot, homeDir, modules: [{ id: 'commands-core', paths: ['commands'] }] }));
    assert.ok(withoutSkills.has('security-scan') && withoutSkills.has('engineering-audit'), 'a plan without the skill keeps the command');
    assert.ok(withSkills.operations.filter(op => normalizedRelativePath(op.sourceRelativePath).startsWith('commands/')).every(op => path.dirname(op.destinationPath) === path.join(homeDir, '.claude', 'commands')));
  }));

  tally(test('opencode adapter installs the catalog agents flat under ~/.config/opencode/agents in the shape OpenCode validates', () => {
    const { OPENCODE_AGENT_FRONTMATTER_TRANSFORM, plannedFileContent } = require('../../scripts/lib/install/copy-transforms');
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';
    const plan = planInstallTargetScaffold({ target: 'opencode', repoRoot, homeDir, modules: [{ id: 'agents-core', paths: ['agents'] }] });
    const agents = plan.operations.filter(op => normalizedRelativePath(op.sourceRelativePath).startsWith('agents/'));
    assert.ok(agents.length >= 60, `${agents.length} agent files planned`);
    assert.ok(agents.every(op => op.transform === OPENCODE_AGENT_FRONTMATTER_TRANSFORM), 'every agent goes through the OpenCode transform');
    assert.ok(agents.every(op => path.dirname(op.destinationPath) === path.join(homeDir, '.config', 'opencode', 'agents')));
    const fs = require('fs');
    for (const op of agents) {
      const source = fs.readFileSync(path.join(repoRoot, normalizedRelativePath(op.sourceRelativePath)), 'utf8');
      const content = plannedFileContent(path.join(repoRoot, normalizedRelativePath(op.sourceRelativePath)), op.transform).toString('utf8');
      const head = content.split('\n---\n')[0];
      if (/^tools:/m.test(source)) {
        assert.ok(/^tools:\n( {2}[a-z][\w-]*: true\n)+/m.test(head), `${op.sourceRelativePath}: tools is an object of lowercase id to true`);
      }
      assert.ok(/^mode: subagent$/m.test(head), `${op.sourceRelativePath}: subagent`);
      assert.ok(!/^(model|stack|color):/m.test(head), `${op.sourceRelativePath}: no model, stack or color`);
    }
  }));

  tally(test('kiro adapters plan the Kiro platform assets from the repository .kiro directory at the Kiro root and skip the files other targets keep (retired .kiro/install.sh)', () => {
    const fs = require('fs');
    const REPO_ROOT = path.join(__dirname, '..', '..');
    const { KIRO_PLATFORM_DIRS } = require('../../scripts/lib/kiro-platform-operations');
    const { getInstallTargetAdapter, listInstallTargetAdapters } = require('../../scripts/lib/install-targets/registry');
    const modules = [
      { id: 'platform-configs', paths: ['.kiro', '.cursor', 'mcp-configs', 'scripts/auto-update.js', 'scripts/setup-package-manager.js'] },
      { id: 'agents-core', paths: ['agents'] },
    ];
    for (const adapter of listInstallTargetAdapters().filter(entry => entry.target === 'kiro')) {
      const input = { repoRoot: REPO_ROOT, projectRoot: '/proj', homeDir: '/home/u', modules };
      const targetRoot = adapter.resolveRoot(input);
      const operations = adapter.planOperations(input, adapter);
      const platform = operations.filter(op => op.moduleId === 'platform-configs');
      assert.deepStrictEqual(
        platform.map(op => op.sourceRelativePath).sort(),
        KIRO_PLATFORM_DIRS.map(dir => `.kiro/${dir}`).sort(),
        `${adapter.id} plans ${platform.map(op => op.sourceRelativePath).join(', ')}`
      );
      for (const op of platform) {
        assert.strictEqual(path.normalize(op.destinationPath), path.normalize(path.join(targetRoot, op.sourceRelativePath.slice('.kiro/'.length))));
        assert.ok(fs.existsSync(path.join(REPO_ROOT, op.sourceRelativePath)), `${op.sourceRelativePath} exists in the repository`);
      }
      const agents = operations.filter(op => op.moduleId === 'agents-core');
      assert.strictEqual(agents.length, 1);
      assert.strictEqual(agents[0].destinationPath, path.join(targetRoot, 'agents'), 'the catalog agents share the Kiro agents directory');
    }
    assert.strictEqual(getInstallTargetAdapter('kiro').kind, 'home');
  }));

  tally(test('the .kiro directory is a Kiro platform path: foreign everywhere else, native on Kiro, and the catalog agent of the same name yields to the Kiro-shaped one', () => {
    const REPO_ROOT = path.join(__dirname, '..', '..');
    const fs = require('fs');
    const { isForeignPlatformPath } = require('../../scripts/lib/install-targets/helpers');
    assert.strictEqual(isForeignPlatformPath('.kiro', 'kiro'), false);
    assert.strictEqual(isForeignPlatformPath('.kiro/agents', 'cursor'), true);
    assert.strictEqual(isForeignPlatformPath('.kiro', 'egc'), true);
    const { createManifestInstallPlan } = require('../../scripts/lib/install-executor');
    // Real directories: the planner checks every destination against its
    // root with resolved paths, and a bare '/home/u' has no drive on Windows.
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-platform-home-'));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-platform-project-'));
    let materialized;
    try {
      materialized = createManifestInstallPlan({ sourceRoot: REPO_ROOT, target: 'kiro', profileId: 'full', homeDir, projectRoot });
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
    const same = (a, b) => path.normalize(a) === path.normalize(b);
    const posix = value => String(value).replaceAll('\\', '/');
    const planner = materialized.operations.filter(op => op.kind === 'copy-file' && same(op.destinationPath, path.join(homeDir, '.kiro', 'agents', 'planner.md')));
    assert.strictEqual(planner.length, 1, `one planner.md lands: ${planner.map(op => op.sourceRelativePath).join(', ')}`);
    assert.strictEqual(posix(planner[0].sourceRelativePath), '.kiro/agents/planner.md', 'the Kiro-shaped agent wins over the catalog one (source paths carry the platform separator)');
    const jsonAgent = materialized.operations.find(op => op.kind === 'copy-file' && same(op.destinationPath, path.join(homeDir, '.kiro', 'agents', 'planner.json')));
    assert.ok(jsonAgent, 'the Kiro JSON agent lands too');
    const stray = materialized.operations.filter(op => /(^|\/)\.kiro\/(README\.md|docs\/|skills\/|install\.sh)/.test(posix(op.sourceRelativePath)));
    assert.deepStrictEqual(stray, [], 'the README, the docs, the hand-curated skills and the retired script stay out');
    const foreign = materialized.operations.filter(op => /^(mcp-configs|scripts\/auto-update\.js|scripts\/setup-package-manager\.js)/.test(posix(op.sourceRelativePath)));
    assert.deepStrictEqual(foreign, [], 'files other targets keep on their roots stay out of Kiro');
  }));

  tally(test('the Trae adapter resolves .trae-cn when TRAE_ENV=cn at resolution time, as the retired .trae/install.sh allowed', () => {
    const trae = require('../../scripts/lib/install-targets/trae-project');
    const previous = process.env.TRAE_ENV;
    try {
      process.env.TRAE_ENV = 'cn';
      assert.strictEqual(trae.resolveRoot({ projectRoot: '/p' }), path.join('/p', '.trae-cn'));
      delete process.env.TRAE_ENV;
      assert.strictEqual(trae.resolveRoot({ projectRoot: '/p' }), path.join('/p', '.trae'), 'the choice follows the environment at resolution time, not at require time');
    } finally {
      if (previous === undefined) delete process.env.TRAE_ENV; else process.env.TRAE_ENV = previous;
    }
  }));

  tally(test('resolves crush adapter root and install-state path', () => runWithoutConfigHomeVariables(() => {
    const adapter = getInstallTargetAdapter('crush');
    const homeDir = '/Users/example';
    const root = adapter.resolveRoot({ homeDir });
    const statePath = adapter.getInstallStatePath({ homeDir });

    assert.strictEqual(adapter.id, 'crush-home');
    assert.strictEqual(adapter.target, 'crush');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(root, path.join(homeDir, '.config', 'crush'));
    assert.strictEqual(statePath, path.join(homeDir, '.config', 'crush', 'egc', 'crush-install-state.json'));
  })));

  tally(test('crush adapter respects CRUSH_GLOBAL_CONFIG and XDG_CONFIG_HOME the way Crush does', () => runWithoutConfigHomeVariables(() => {
    const adapter = getInstallTargetAdapter('crush');
    const homeDir = '/Users/example';
    const savedLocalAppData = process.env.LOCALAPPDATA;
    try {
      // %LOCALAPPDATA% holds only Crush's data config: the global config
      // directory stays ~/.config/crush on Windows too.
      process.env.LOCALAPPDATA = path.join(homeDir, 'AppData', 'Local');
      assert.strictEqual(adapter.resolveRoot({ homeDir }), path.join(homeDir, '.config', 'crush'));

      process.env.XDG_CONFIG_HOME = path.resolve('/custom/xdg');
      assert.strictEqual(adapter.resolveRoot({ homeDir }), path.join(path.resolve('/custom/xdg'), 'crush'));

      // A relative XDG_CONFIG_HOME is invalid under the XDG spec.
      process.env.XDG_CONFIG_HOME = 'relative/xdg';
      assert.strictEqual(adapter.resolveRoot({ homeDir }), path.join(homeDir, '.config', 'crush'));

      // Crush always treats the override as a directory, whatever its name.
      process.env.CRUSH_GLOBAL_CONFIG = '/custom/path/crush.json';
      assert.strictEqual(adapter.resolveRoot({ homeDir }), path.resolve('/custom/path/crush.json'));
      assert.strictEqual(adapter.resolveCrushConfigPath({ homeDir }), path.join(path.resolve('/custom/path/crush.json'), 'crush.json'));

      process.env.CRUSH_GLOBAL_CONFIG = '/custom/dir';
      assert.strictEqual(adapter.resolveRoot({ homeDir }), path.resolve('/custom/dir'));

      // Crush opens a relative override from its working directory, so the
      // install resolves it against the current one, not the home.
      process.env.CRUSH_GLOBAL_CONFIG = 'relative-crush';
      assert.strictEqual(adapter.resolveRoot({ homeDir }), path.resolve(process.cwd(), 'relative-crush'));
      assert.ok(path.isAbsolute(adapter.resolveCrushConfigPath({ homeDir })), 'crush.json path is absolute');
    } finally {
      if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocalAppData;
    }
  })));

  tally(test('crush adapter supports lookup by target and adapter id', () => {
    const byTarget = getInstallTargetAdapter('crush');
    const byId = getInstallTargetAdapter('crush-home');

    assert.strictEqual(byTarget.id, 'crush-home');
    assert.strictEqual(byId.id, 'crush-home');
    assert.ok(byTarget.supports('crush'));
    assert.ok(byTarget.supports('crush-home'));
  }));

  tally(test('crush adapter resolves managed roots including both config dir and ~/.agents', () => runWithoutConfigHomeVariables(() => {
    const adapter = getInstallTargetAdapter('crush');
    const homeDir = '/Users/example';
    const managedRoots = adapter.resolveManagedRoots({ homeDir });
    assert.deepStrictEqual(managedRoots, [
      path.join(homeDir, '.config', 'crush'),
      path.join(homeDir, '.agents'),
    ]);
  })));

  tally(test('crush adapter strips category from skill paths and installs flat under ~/.agents/skills/', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'crush',
      repoRoot,
      homeDir,
      modules: [{ id: 'workflow', paths: ['skills/workflow/tdd-workflow'] }],
    });

    assert.strictEqual(plan.adapter.id, 'crush-home');
    assert.ok(
      plan.operations.some(operation => (
        normalizedRelativePath(operation.sourceRelativePath) === 'skills/workflow/tdd-workflow'
        && operation.destinationPath === path.join(homeDir, '.agents', 'skills', 'tdd-workflow')
      )),
      'Should strip category and install skill flat under ~/.agents/skills/'
    );
  }));

  tally(test('crush adapter plans agents, commands, and rules under ~/.config/crush/', () => runWithoutConfigHomeVariables(() => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'crush',
      repoRoot,
      homeDir,
      modules: [
        { id: 'agents-core', paths: ['agents'] },
        { id: 'commands-core', paths: ['commands'] },
        { id: 'rules-core', paths: ['rules'] },
      ],
    });

    const agentsDir = path.join(homeDir, '.config', 'crush', 'agents');
    const commandsDir = path.join(homeDir, '.config', 'crush', 'commands');
    const rulesDir = path.join(homeDir, '.config', 'crush', 'rules');

    assert.ok(
      plan.operations.some(op => op.destinationPath && (op.destinationPath === agentsDir || op.destinationPath.startsWith(agentsDir + path.sep))),
      'Agents should land under ~/.config/crush/agents'
    );
    assert.ok(
      plan.operations.some(op => op.destinationPath && (op.destinationPath === commandsDir || op.destinationPath.startsWith(commandsDir + path.sep))),
      'Commands should land under ~/.config/crush/commands'
    );
    assert.ok(
      plan.operations.some(op => op.destinationPath && (op.destinationPath === rulesDir || op.destinationPath.startsWith(rulesDir + path.sep))),
      'Rules should land under ~/.config/crush/rules'
    );
  })));

  tally(test('crush adapter plans Guardian and Crusher hooks in crush.json', () => runWithoutConfigHomeVariables(() => {
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = '/Users/example';

    const plan = planInstallTargetScaffold({
      target: 'crush',
      repoRoot,
      homeDir,
      modules: [],
    });

    const mergeOps = plan.operations.filter(op => op.kind === 'merge-claude-settings-hooks');
    assert.strictEqual(mergeOps.length, 2, 'Should plan both Guardian and Crusher hook merge operations');
    const crushJsonPath = path.join(homeDir, '.config', 'crush', 'crush.json');
    assert.ok(mergeOps.every(op => op.destinationPath === crushJsonPath), 'Hooks should target crush.json');
    assert.ok(mergeOps.some(op => op.hookMatcher === '^(bash|edit|write|multiedit)$'), 'Guardian hook matcher');
    assert.ok(mergeOps.some(op => op.hookMatcher === '^bash$'), 'Crusher hook matcher');
  })));

  tally(test('crush adapter is included in the full adapter list', () => {
    const adapters = listInstallTargetAdapters();
    const targets = adapters.map(a => a.target);
    assert.ok(targets.includes('crush'), 'Should include crush target');
  }));
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
