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
const { FULL_INSTALL_TIMEOUT_MS, CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');
const DEFAULT_INSTALL_APPLY_TIMEOUT_MS = FULL_INSTALL_TIMEOUT_MS;
const PROBE = { timeout: CLI_TIMEOUT_MS };

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
  const tally = ok => (ok ? passed++ : failed++);

  tally(test('merge-json never carries a prototype key into the config', () => {
    const { deepMergeJson } = require('../../scripts/lib/install/apply');
    const merged = deepMergeJson({ mcpServers: { a: { command: 'x' } } }, JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"p": 1}}, "mcpServers": {"b": {"command": "y"}}}'));
    assert.strictEqual(Object.prototype.polluted, undefined, 'the global prototype is untouched');
    assert.strictEqual(merged.polluted, undefined);
    assert.ok(!Object.hasOwn(merged, 'constructor'), 'constructor is not a data key');
    assert.deepStrictEqual(Object.keys(merged.mcpServers).sort(), ['a', 'b']);
    const nested = deepMergeJson({}, JSON.parse('{"new": {"__proto__": {"p": 1}, "keep": 1}, "list": [{"__proto__": {"q": 2}, "ok": true}]}'));
    assert.ok(!Object.hasOwn(nested.new, '__proto__'), 'a new subtree is filtered too');
    assert.strictEqual(nested.new.keep, 1);
    assert.ok(!Object.hasOwn(nested.list[0], '__proto__'), 'objects inside arrays are filtered');
    assert.strictEqual(nested.list[0].ok, true);

  }));


  tally(test('shows help with --help', () => {
    const result = run(['--help'], PROBE);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Usage:'));
    assert.ok(result.stdout.includes('--dry-run'));
    assert.ok(result.stdout.includes('--profile <name>'));
    assert.ok(result.stdout.includes('--modules <id,id,...>'));
  }));

  tally(test('rejects mixing legacy languages with manifest profile flags', () => {
    const result = run(['--profile', 'core', 'typescript']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('cannot be combined'));
  }));

  if (process.platform !== 'win32') {
    tally(test('bare install delegates to the shipped install.sh wrapper', () => {
      const homeDir = createTempDir('install-apply-home-');
      const projectDir = createTempDir('install-apply-project-');
      const binDir = createTempDir('install-apply-bin-');

      try {
        const fakeBash = path.join(binDir, 'bash');
        fs.writeFileSync(fakeBash, '#!/bin/sh\necho "WRAPPER CALLED: $1"\nexit 0\n');
        fs.chmodSync(fakeBash, 0o755);

        const result = run([], {
          cwd: projectDir,
          homeDir,
          env: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
        });
        assert.strictEqual(result.code, 0, result.stderr);
        assert.ok(result.stdout.includes('WRAPPER CALLED'));
        assert.ok(result.stdout.includes(path.join('scripts', 'install.sh')));
      } finally {
        cleanup(homeDir);
        cleanup(projectDir);
        cleanup(binDir);
      }
    }));
  }

  if (process.platform !== 'win32') {
    tally(test('bare install surfaces a wrapper launch failure instead of swallowing it', () => {
      const homeDir = createTempDir('install-apply-home-');
      const projectDir = createTempDir('install-apply-project-');
      const binDir = createTempDir('install-apply-bin-');

      try {
        fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
        const result = run([], { cwd: projectDir, homeDir, env: { PATH: binDir } });
        assert.strictEqual(result.code, 1);
        assert.ok(result.stderr.includes('failed to launch bash'));
      } finally {
        cleanup(homeDir);
        cleanup(projectDir);
        cleanup(binDir);
      }
    }));
  }

  tally(test('delegated bare install keeps the explicit selection contract', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run([], {
        cwd: projectDir,
        homeDir,
        env: { EGC_INSTALL_DELEGATED: '1' },
      });
      assert.strictEqual(result.code, 1);
      assert.ok(result.stderr.includes('No install profile'));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('installs Gemini rules and writes install-state', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['typescript'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const geminiRoot = path.join(homeDir, '.gemini');
      // Antigravity reads its skills from config/skills and
      // its hooks run from scripts/; the skills/egc namespace, hooks/hooks.json
      // and plugin.json of the retired Gemini CLI are not written any more.
      assert.ok(fs.existsSync(path.join(geminiRoot, 'rules', 'egc', 'common', 'coding-style.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'rules', 'egc', 'typescript', 'testing.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'commands', 'plan.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'config', 'skills', 'tdd-workflow', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'config', 'skills', 'coding-standards', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'scripts', 'hooks', 'session-end.js')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'scripts', 'lib', 'utils.js')));
      assert.ok(!fs.existsSync(path.join(geminiRoot, 'skills')));
      assert.ok(!fs.existsSync(path.join(geminiRoot, 'hooks', 'hooks.json')));
      assert.ok(!fs.existsSync(path.join(geminiRoot, 'plugin.json')));

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
          operation.destinationPath === path.join(geminiRoot, 'config', 'skills', 'tdd-workflow', 'SKILL.md')
        )),
        'Should record the Antigravity CLI skill file operation'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('an upgrade moves the managed skills from antigravity-cli/skills to config/skills and keeps the person\'s files (#1705)', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const args = ['--target', 'egc', '--profile', 'minimal', '--allow-undetected'];
      const env = { EGC_INSTALL_DELEGATED: '1' };
      const first = run(args, { cwd: projectDir, homeDir, env });
      assert.strictEqual(first.code, 0, first.stderr);

      const geminiRoot = path.join(homeDir, '.gemini');
      const ideSkills = path.join(geminiRoot, 'config', 'skills');
      const cliSkills = path.join(geminiRoot, 'antigravity-cli', 'skills');
      const statePath = path.join(geminiRoot, 'egc', 'install-state.json');
      const skills = fs.readdirSync(ideSkills).sort();
      assert.ok(skills.length > 1, 'the minimal profile installs skills');
      assert.ok(!fs.existsSync(cliSkills), 'a fresh install writes no second copy under antigravity-cli/skills');

      const state = readJson(statePath);
      for (const operation of state.operations) {
        if (operation.destinationPath.startsWith(ideSkills + path.sep)) {
          operation.destinationPath = path.join(cliSkills, path.relative(ideSkills, operation.destinationPath));
        }
      }
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      fs.mkdirSync(path.dirname(cliSkills), { recursive: true });
      fs.renameSync(ideSkills, cliSkills);
      const [edited, ...untouched] = skills;
      fs.writeFileSync(path.join(cliSkills, edited, 'SKILL.md'), 'edited by hand');
      const own = path.join(cliSkills, 'my-own-skill', 'SKILL.md');
      fs.mkdirSync(path.dirname(own), { recursive: true });
      fs.writeFileSync(own, '# mine');

      const upgraded = run(args, { cwd: projectDir, homeDir, env });
      assert.strictEqual(upgraded.code, 0, upgraded.stderr);
      for (const skill of skills) {
        assert.ok(fs.existsSync(path.join(ideSkills, skill, 'SKILL.md')), `${skill} is under config/skills after the upgrade`);
      }
      for (const skill of untouched) {
        assert.ok(!fs.existsSync(path.join(cliSkills, skill, 'SKILL.md')), `the managed ${skill} under antigravity-cli/skills is retired`);
      }
      assert.strictEqual(fs.readFileSync(path.join(cliSkills, edited, 'SKILL.md'), 'utf8'), 'edited by hand', 'an edited managed copy stays');
      assert.strictEqual(fs.readFileSync(own, 'utf8'), '# mine', 'the person\'s own skill under antigravity-cli/skills stays');
      const recorded = readJson(statePath).operations.map(operation => operation.destinationPath);
      assert.ok(recorded.some(destination => destination.startsWith(ideSkills + path.sep)), 'the state records the config/skills copies');
      assert.ok(!recorded.some(destination => destination.startsWith(cliSkills + path.sep)), 'and no antigravity-cli/skills copy any more');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('a skill the person keeps under config/skills with the name of an EGC skill is never overwritten (#1705)', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const args = ['--target', 'egc', '--profile', 'minimal', '--allow-undetected'];
      const env = { EGC_INSTALL_DELEGATED: '1' };
      const planned = run([...args, '--dry-run'], { cwd: projectDir, homeDir });
      assert.strictEqual(planned.code, 0, planned.stderr);

      const geminiRoot = path.join(homeDir, '.gemini');
      const ideSkills = path.join(geminiRoot, 'config', 'skills');
      const plannedLine = planned.stdout.split('\n').find(line => line.includes(ideSkills + path.sep));
      assert.ok(plannedLine, 'the plan writes skills under config/skills');
      const skill = path.relative(ideSkills, plannedLine.slice(plannedLine.indexOf(ideSkills))).split(path.sep)[0];
      const own = path.join(ideSkills, skill, 'SKILL.md');
      fs.mkdirSync(path.dirname(own), { recursive: true });
      fs.writeFileSync(own, '# mine');

      for (const pass of ['install', 'reinstall']) {
        const result = run(args, { cwd: projectDir, homeDir, env });
        assert.strictEqual(result.code, 0, `${pass}: ${result.stderr}`);
        assert.strictEqual(fs.readFileSync(own, 'utf8'), '# mine', `${pass}: the person's ${skill} under config/skills stays theirs`);
      }
      const recorded = readJson(path.join(geminiRoot, 'egc', 'install-state.json')).operations.map(operation => operation.destinationPath);
      assert.ok(!recorded.some(destination => destination.startsWith(path.join(ideSkills, skill) + path.sep)), 'the person\'s skill is never recorded as managed');
      assert.ok(recorded.some(destination => destination.startsWith(ideSkills + path.sep)), 'the other skills still land under config/skills');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  if (process.platform !== 'win32') {
    tally(test('an upgrade removes the June 2026 links left under antigravity-cli/skills and keeps the person\'s link (#1789)', () => {
      const homeDir = createTempDir('install-apply-home-');
      const projectDir = createTempDir('install-apply-project-');
      const outside = createTempDir('install-apply-outside-');

      try {
        const args = ['--target', 'egc', '--profile', 'minimal', '--allow-undetected'];
        const env = { EGC_INSTALL_DELEGATED: '1' };
        const first = run(args, { cwd: projectDir, homeDir, env });
        assert.strictEqual(first.code, 0, first.stderr);

        const geminiRoot = path.join(homeDir, '.gemini');
        const cliSkills = path.join(geminiRoot, 'antigravity-cli', 'skills');
        const managed = path.join(geminiRoot, 'skills', 'egc', 'june-live');
        fs.mkdirSync(managed, { recursive: true });
        fs.writeFileSync(path.join(managed, 'SKILL.md'), 'old copy');
        fs.mkdirSync(cliSkills, { recursive: true });
        const liveLink = path.join(cliSkills, 'june-live');
        const goneLink = path.join(cliSkills, 'june-gone');
        const ownLink = path.join(cliSkills, 'mine');
        fs.symlinkSync(managed, liveLink, 'dir');
        fs.symlinkSync(path.join(geminiRoot, 'skills', 'egc', 'june-gone'), goneLink, 'dir');
        fs.symlinkSync(outside, ownLink, 'dir');

        const dryRun = run([...args, '--dry-run'], { cwd: projectDir, homeDir });
        assert.strictEqual(dryRun.code, 0, dryRun.stderr);
        assert.ok(dryRun.stdout.includes('Legacy links to remove'), dryRun.stdout);
        assert.ok(dryRun.stdout.includes(`- ${liveLink} (pointed at `), 'the live June link is listed');
        assert.ok(dryRun.stdout.includes(`- ${goneLink} (pointed at `), 'the dangling June link is listed');
        assert.ok(!dryRun.stdout.includes(ownLink), 'the person\'s link is not listed');
        assert.ok(fs.lstatSync(liveLink).isSymbolicLink(), 'the dry run touches nothing');

        const upgraded = run(args, { cwd: projectDir, homeDir, env });
        assert.strictEqual(upgraded.code, 0, upgraded.stderr);
        assert.ok(upgraded.stdout.includes(`removed legacy link: ${liveLink}`), upgraded.stdout);
        assert.ok(upgraded.stdout.includes(`removed legacy link: ${goneLink}`), upgraded.stdout);
        assert.strictEqual(fs.lstatSync(liveLink, { throwIfNoEntry: false }), undefined, 'the live June link is gone');
        assert.strictEqual(fs.lstatSync(goneLink, { throwIfNoEntry: false }), undefined, 'the dangling June link is gone');
        assert.ok(fs.lstatSync(ownLink).isSymbolicLink(), 'the person\'s link stays');
        assert.strictEqual(fs.readFileSync(path.join(managed, 'SKILL.md'), 'utf8'), 'old copy', 'what the link pointed at is untouched');
      } finally {
        cleanup(homeDir);
        cleanup(projectDir);
        cleanup(outside);
      }
    }));
  }

  if (process.platform !== 'win32') {
    tally(test('the June link scan never follows a linked antigravity-cli or skills/egc folder (#1789)', () => {
      const { findStrandedLegacyLinks } = require('../../scripts/lib/install/apply');
      const homeDir = createTempDir('install-apply-home-');
      const outside = createTempDir('install-apply-outside-');

      try {
        const root = path.join(homeDir, '.gemini');
        const managed = path.join(root, 'skills', 'egc');
        fs.mkdirSync(path.join(outside, 'skills'), { recursive: true });
        fs.symlinkSync(path.join(managed, 'june'), path.join(outside, 'skills', 'june'), 'dir');
        fs.mkdirSync(root, { recursive: true });
        fs.symlinkSync(outside, path.join(root, 'antigravity-cli'), 'dir');
        assert.deepStrictEqual(findStrandedLegacyLinks({ targetRoot: root, operations: [] }), [], 'a linked antigravity-cli is never scanned');

        fs.unlinkSync(path.join(root, 'antigravity-cli'));
        const cliSkills = path.join(root, 'antigravity-cli', 'skills');
        fs.mkdirSync(cliSkills, { recursive: true });
        fs.symlinkSync(path.join(managed, 'june'), path.join(cliSkills, 'june'), 'dir');
        fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
        fs.symlinkSync(outside, managed, 'dir');
        assert.deepStrictEqual(findStrandedLegacyLinks({ targetRoot: root, operations: [] }), [], 'a link reached through a linked skills/egc is not EGC\'s');

        fs.unlinkSync(managed);
        fs.mkdirSync(managed, { recursive: true });
        assert.deepStrictEqual(
          findStrandedLegacyLinks({ targetRoot: root, operations: [] }).map(link => link.linkPath),
          [path.join(cliSkills, 'june')],
          'with real folders the June link is found'
        );
      } finally {
        cleanup(homeDir);
        cleanup(outside);
      }
    }));

    tally(test('the June link scan finds a link into the real path of skills/egc when the target root sits behind an alias (#1789)', () => {
      const { findStrandedLegacyLinks } = require('../../scripts/lib/install/apply');
      const homeDir = createTempDir('install-apply-home-');
      const aliasParent = createTempDir('install-apply-alias-');

      try {
        const realRoot = path.join(fs.realpathSync(homeDir), '.gemini');
        fs.mkdirSync(path.join(realRoot, 'skills', 'egc', 'june'), { recursive: true });
        const cliSkills = path.join(realRoot, 'antigravity-cli', 'skills');
        fs.mkdirSync(cliSkills, { recursive: true });
        fs.symlinkSync(path.join(realRoot, 'skills', 'egc', 'june'), path.join(cliSkills, 'june'), 'dir');
        const alias = path.join(aliasParent, 'home');
        fs.symlinkSync(homeDir, alias, 'dir');
        const aliasRoot = path.join(alias, '.gemini');

        assert.deepStrictEqual(
          findStrandedLegacyLinks({ targetRoot: aliasRoot, operations: [] }).map(link => link.linkPath),
          [path.join(aliasRoot, 'antigravity-cli', 'skills', 'june')],
          'a June link spelled through the real path of the managed copy is found'
        );
      } finally {
        cleanup(aliasParent);
        cleanup(homeDir);
      }
    }));
  }

  tally(test('an upgrade retires a managed copy whose source changed since EGC wrote it, and keeps an edited one (#1789)', () => {
    const crypto = require('crypto');
    const sha256 = content => crypto.createHash('sha256').update(content).digest('hex');
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const args = ['--target', 'egc', '--profile', 'minimal', '--allow-undetected'];
      const env = { EGC_INSTALL_DELEGATED: '1' };
      const first = run(args, { cwd: projectDir, homeDir, env });
      assert.strictEqual(first.code, 0, first.stderr);

      const geminiRoot = path.join(homeDir, '.gemini');
      const ideSkills = path.join(geminiRoot, 'config', 'skills');
      const cliSkills = path.join(geminiRoot, 'antigravity-cli', 'skills');
      const statePath = path.join(geminiRoot, 'egc', 'install-state.json');
      const state = readJson(statePath);
      const copies = state.operations.filter(operation => operation.kind === 'copy-file');
      assert.ok(copies.length > 0, 'the install records file copies');
      for (const operation of copies) {
        assert.strictEqual(operation.contentSha256, sha256(fs.readFileSync(operation.destinationPath)), `${operation.destinationPath} records the hash of what EGC wrote`);
      }

      const [stale, edited] = fs.readdirSync(ideSkills).sort();
      assert.ok(stale && edited, 'two skills to work with');
      const staleContent = 'the SKILL.md an earlier release wrote, before its source changed';
      for (const operation of state.operations) {
        for (const skill of [stale, edited]) {
          const skillDir = path.join(ideSkills, skill);
          if (!operation.destinationPath.startsWith(skillDir + path.sep)) continue;
          operation.destinationPath = path.join(cliSkills, skill, path.relative(skillDir, operation.destinationPath));
          if (skill === stale && path.basename(operation.destinationPath) === 'SKILL.md') operation.contentSha256 = sha256(staleContent);
        }
      }
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      fs.mkdirSync(cliSkills, { recursive: true });
      for (const skill of [stale, edited]) fs.renameSync(path.join(ideSkills, skill), path.join(cliSkills, skill));
      fs.writeFileSync(path.join(cliSkills, stale, 'SKILL.md'), staleContent);
      fs.writeFileSync(path.join(cliSkills, edited, 'SKILL.md'), 'edited by hand');

      const upgraded = run(args, { cwd: projectDir, homeDir, env });
      assert.strictEqual(upgraded.code, 0, upgraded.stderr);
      assert.ok(!fs.existsSync(path.join(cliSkills, stale, 'SKILL.md')), 'the stale managed copy is retired although it differs from the current source');
      assert.strictEqual(fs.readFileSync(path.join(cliSkills, edited, 'SKILL.md'), 'utf8'), 'edited by hand', 'an edited managed copy stays');
      for (const skill of [stale, edited]) {
        assert.ok(fs.existsSync(path.join(ideSkills, skill, 'SKILL.md')), `${skill} is written under config/skills`);
      }
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('installs Cursor configs and writes install-state', () => {
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
      assert.deepStrictEqual(
        mcpConfig.mcpServers,
        {},
        'Cursor installs must not inject bundled third-party MCP servers'
      );

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
  }));

  tally(test('installs Aider memory protocol via rules-core and writes valid install-state', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--target', 'aider', '--modules', 'rules-core'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const memoryPath = path.join(projectDir, '.aider', 'rules', 'common', 'memory.md');
      assert.ok(fs.existsSync(memoryPath), 'memory.md should be copied into .aider/rules/common/');
      assert.ok(fs.readFileSync(memoryPath, 'utf8').includes('get_state'));

      const confPath = path.join(projectDir, '.aider.conf.yml');
      assert.ok(fs.existsSync(confPath), '.aider.conf.yml should be created');
      assert.ok(fs.readFileSync(confPath, 'utf8').includes('.aider/rules/common/memory.md'));

      // Regression guard: install-state.schema.json requires sourceRelativePath
      // on every recorded operation, including merge-kind ones. Missing it
      // previously made this exact install fail with
      // "Invalid install-state (create): /operations/1 must have required
      // property 'sourceRelativePath'" the first time a merge operation was
      // ever the second operation recorded for a target.
      const statePath = path.join(projectDir, '.aider', 'egc-install-state.json');
      const state = readJson(statePath);
      assert.ok(state.operations.some(op => op.kind === 'merge-yaml-read-list' && op.sourceRelativePath));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('installs Warp memory protocol via rules-core and writes valid install-state', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--target', 'warp', '--modules', 'rules-core'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const memoryPath = path.join(projectDir, '.warp', 'rules', 'common', 'memory.md');
      assert.ok(fs.existsSync(memoryPath), 'memory.md should be copied into .warp/rules/common/');
      assert.ok(fs.readFileSync(memoryPath, 'utf8').includes('get_state'));

      const agentsPath = path.join(projectDir, 'AGENTS.md');
      assert.ok(fs.existsSync(agentsPath), 'AGENTS.md should be created');
      const agentsContent = fs.readFileSync(agentsPath, 'utf8');
      assert.ok(agentsContent.includes('EGC Session Memory'));
      assert.ok(agentsContent.includes('.warp/rules/common/memory.md'));

      // Same install-state schema regression guard as the Aider test above.
      const statePath = path.join(projectDir, '.warp', 'egc-install-state.json');
      const state = readJson(statePath);
      assert.ok(state.operations.some(op => op.kind === 'merge-markdown-skill-index' && op.sourceRelativePath));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('Cursor install preserves an existing mcp.json without injecting bundled servers', () => {
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
      assert.ok(!mcpConfig.mcpServers.github, 'Must not inject the bundled GitHub MCP server');
      assert.ok(!mcpConfig.mcpServers.playwright, 'Must not inject the bundled Playwright MCP server');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('installs Antigravity configs and writes install-state', () => {
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
  }));

  tally(test('supports dry-run without mutating the target project', () => {
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
  }));

  tally(test('lists the egc-universal package files an earlier OpenCode install wrote in the dry run and retires them on apply (#1396)', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');
    try {
      const configDir = path.join(homeDir, '.config', 'opencode');
      const statePath = path.join(configDir, 'egc', 'install-state.json');
      const repoRoot = path.join(__dirname, '..', '..');
      fs.mkdirSync(path.join(configDir, 'tools'), { recursive: true });
      // The bytes EGC copied there, and one file the person edited since.
      fs.copyFileSync(path.join(repoRoot, '.opencode', 'tools', 'index.ts'), path.join(configDir, 'tools', 'index.ts'));
      fs.copyFileSync(path.join(repoRoot, '.opencode', 'package.json'), path.join(configDir, 'package.json'));
      fs.writeFileSync(path.join(configDir, 'tools', 'run-tests.ts'), 'edited by hand');
      fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({ model: 'mine/model' }));
      const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
      const previous = [
        ['.opencode/tools/index.ts', path.join(configDir, 'tools', 'index.ts')],
        ['.opencode/tools/run-tests.ts', path.join(configDir, 'tools', 'run-tests.ts')],
        ['.opencode/package.json', path.join(configDir, 'package.json')],
        ['.opencode/opencode.json', path.join(configDir, 'opencode.json')],
      ];
      writeInstallState(statePath, createInstallState({
        adapter: { id: 'opencode-home' },
        targetRoot: configDir,
        installStatePath: statePath,
        request: { profile: 'minimal', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: previous.map(([sourceRelativePath, destinationPath]) => ({ kind: 'copy-file', moduleId: 'platform-configs', sourceRelativePath, destinationPath, strategy: 'sync-root-children', ownership: 'managed', scaffoldOnly: false })),
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      }));

      const dryRun = run(['--target', 'opencode', '--profile', 'minimal', '--dry-run', '--allow-undetected'], { cwd: projectDir, homeDir });
      assert.strictEqual(dryRun.code, 0, dryRun.stderr);
      assert.ok(dryRun.stdout.includes('Files to retire'), dryRun.stdout);
      assert.ok(dryRun.stdout.includes(`- ${path.join(configDir, 'tools', 'index.ts')}`));
      assert.ok(dryRun.stdout.includes(`- ${path.join(configDir, 'package.json')}`));
      assert.ok(!dryRun.stdout.includes(`- ${path.join(configDir, 'opencode.json')}`), 'opencode.json is never retired');
      assert.ok(!dryRun.stdout.includes(`- ${path.join(configDir, 'tools', 'run-tests.ts')}`), 'the dry run does not list the file the person edited, because the apply keeps it');
      const dryJson = run(['--target', 'opencode', '--profile', 'minimal', '--dry-run', '--allow-undetected', '--json'], { cwd: projectDir, homeDir });
      assert.deepStrictEqual(JSON.parse(dryJson.stdout).plan.retirements.map(entry => entry.destinationPath).sort(), [path.join(configDir, 'package.json'), path.join(configDir, 'tools', 'index.ts')].sort(), 'the JSON dry run lists exactly what the apply removes');
      assert.ok(fs.existsSync(path.join(configDir, 'tools', 'index.ts')), 'the dry run touches nothing');
      assert.ok(!dryRun.stdout.includes('.opencode/tools/'), 'the tools are not planned any more');
      assert.ok(!dryRun.stdout.includes('.opencode/opencode.json'), 'the package opencode.json is not planned any more');

      const applied = run(['--target', 'opencode', '--profile', 'minimal', '--allow-undetected'], { cwd: projectDir, homeDir, env: { EGC_INSTALL_DELEGATED: '1' } });
      assert.strictEqual(applied.code, 0, applied.stderr);
      assert.ok(applied.stdout.includes(`retired file: ${path.join(configDir, 'tools', 'index.ts')}`), applied.stdout);
      assert.ok(!fs.existsSync(path.join(configDir, 'tools', 'index.ts')), 'the file EGC wrote is gone');
      assert.strictEqual(fs.readFileSync(path.join(configDir, 'tools', 'run-tests.ts'), 'utf8'), 'edited by hand', 'the file the person edited stays');
      assert.ok(!fs.existsSync(path.join(configDir, 'package.json')));
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8')), { model: 'mine/model' }, 'the person\'s opencode.json is untouched');
      assert.ok(fs.existsSync(path.join(configDir, 'plugins', 'opencode-egc-plugin.js')), 'the real plugin is installed');

      const again = run(['--target', 'opencode', '--profile', 'minimal', '--allow-undetected', '--json'], { cwd: projectDir, homeDir, env: { EGC_INSTALL_DELEGATED: '1' } });
      assert.deepStrictEqual(JSON.parse(again.stdout).result.retiredFiles, [], 'nothing left to retire');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));
  // Devin Local reads its hooks from ~/.config/devin/config.json
  // (%APPDATA%\devin\config.json on Windows). APPDATA points inside the
  // temporary home, so a Windows run never touches the runner's own.
  const devinEnv = homeDir => ({ EGC_INSTALL_DELEGATED: '1', APPDATA: path.join(homeDir, 'AppData', 'Roaming') });
  const devinConfigOf = homeDir => (process.platform === 'win32'
    ? path.join(homeDir, 'AppData', 'Roaming', 'devin', 'config.json')
    : path.join(homeDir, '.config', 'devin', 'config.json'));
  const DEVIN_GATEGUARD_MATCHER = '^(exec|edit|write|notebook_edit|multi_edit|apply_patch)$';

  tally(test('a Devin Desktop install wires the Guardian and GateGuard into Devin Local\'s PreToolUse hooks, keeps the person\'s settings and never duplicates on reinstall', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');
    try {
      const configPath = devinConfigOf(homeDir);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        theme_mode: 'dark',
        hooks: { PreToolUse: [{ matcher: '^read$', hooks: [{ type: 'command', command: 'echo mine' }] }] },
      }, null, 2));
      for (let round = 1; round <= 2; round++) {
        const applied = run(['--target', 'windsurf', '--profile', 'minimal', '--allow-undetected'], { cwd: projectDir, homeDir, env: devinEnv(homeDir) });
        assert.strictEqual(applied.code, 0, `round ${round}: ${applied.stderr}`);
      }
      const config = readJson(configPath);
      assert.strictEqual(config.theme_mode, 'dark', 'the person\'s settings stay');
      const groups = config.hooks.PreToolUse;
      assert.deepStrictEqual(groups.map(group => group.matcher), ['^read$', DEVIN_GATEGUARD_MATCHER, '^exec$']);
      assert.deepStrictEqual(groups.map(group => group.hooks.length), [1, 1, 1], 'a reinstall adds no second entry');
      const scripts = path.join(homeDir, '.codeium', 'windsurf', 'scripts', 'hooks');
      assert.ok(groups[1].hooks[0].command.includes(path.join(scripts, 'windsurf-gateguard-adapter.js')), groups[1].hooks[0].command);
      assert.ok(groups[2].hooks[0].command.includes(path.join(scripts, 'windsurf-guardian-adapter.js')), groups[2].hooks[0].command);
      assert.ok(fs.existsSync(path.join(scripts, 'windsurf-guardian-adapter.js')), 'the script the entry runs is there');
      assert.ok(!fs.existsSync(path.join(homeDir, '.codeium', 'windsurf', 'hooks.json')), 'no Cascade hooks file is written any more');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('an upgrade removes the Cascade hook entries an earlier Devin Desktop install wrote and keeps the person\'s own', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');
    try {
      const windsurfRoot = path.join(homeDir, '.codeium', 'windsurf');
      const hooksJsonPath = path.join(windsurfRoot, 'hooks.json');
      const statePath = path.join(windsurfRoot, 'egc', 'install-state.json');
      const gateGuardAdapter = path.join(windsurfRoot, 'scripts', 'hooks', 'windsurf-gateguard-adapter.js');
      const guardianAdapter = path.join(windsurfRoot, 'scripts', 'hooks', 'windsurf-guardian-adapter.js');
      fs.mkdirSync(windsurfRoot, { recursive: true });
      fs.writeFileSync(hooksJsonPath, JSON.stringify({ hooks: { pre_run_command: [{ command: 'echo mine' }] } }, null, 2));
      // What an earlier install wrote for Cascade, which Devin Desktop removed
      // on 2026-09-08: the entries in hooks.json and the operations in its state.
      const { applyWindsurfGateGuardHookToFile } = require('../../scripts/lib/windsurf-gateguard-hooks');
      const recorded = [
        ['pre_write_code', gateGuardAdapter, 'claude-gateguard-fact-force-hook', 'scripts/hooks/windsurf-gateguard-adapter.js'],
        ['pre_run_command', gateGuardAdapter, 'claude-gateguard-fact-force-hook', 'scripts/hooks/windsurf-gateguard-adapter.js'],
        ['pre_run_command', guardianAdapter, 'egc-bash-guardian-hook', 'scripts/hooks/windsurf-guardian-adapter.js'],
      ];
      for (const [event, script] of recorded) {
        applyWindsurfGateGuardHookToFile(hooksJsonPath, event, script);
      }
      const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
      writeInstallState(statePath, createInstallState({
        adapter: { id: 'windsurf-home', target: 'windsurf', kind: 'home' },
        targetRoot: windsurfRoot,
        installStatePath: statePath,
        request: { profile: 'minimal', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: recorded.map(([hookEvent, hookScriptPath, moduleId, sourceRelativePath]) => ({
          kind: 'merge-claude-settings-hooks',
          moduleId,
          sourceRelativePath,
          destinationPath: hooksJsonPath,
          strategy: 'merge-claude-settings-hooks',
          ownership: 'managed',
          scaffoldOnly: false,
          hookEvent,
          hookScriptPath,
        })),
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      }));
      const before = fs.readFileSync(hooksJsonPath, 'utf8');
      const retiredShape = entries => entries.map(entry => `${entry.hookEvent} ${path.basename(entry.hookScriptPath)}`).sort();
      const expected = recorded.map(([event, script]) => `${event} ${path.basename(script)}`).sort();

      const dryRun = run(['--target', 'windsurf', '--profile', 'minimal', '--dry-run', '--allow-undetected', '--json'], { cwd: projectDir, homeDir, env: devinEnv(homeDir) });
      assert.strictEqual(dryRun.code, 0, dryRun.stderr);
      assert.deepStrictEqual(retiredShape(JSON.parse(dryRun.stdout).plan.hookRetirements), expected, 'the dry run lists the three Cascade entries EGC wrote');
      assert.strictEqual(fs.readFileSync(hooksJsonPath, 'utf8'), before, 'the dry run touches nothing');

      const applied = run(['--target', 'windsurf', '--profile', 'minimal', '--allow-undetected'], { cwd: projectDir, homeDir, env: devinEnv(homeDir) });
      assert.strictEqual(applied.code, 0, applied.stderr);
      assert.ok(applied.stdout.includes(`retired hook entry: pre_write_code in ${hooksJsonPath}`), applied.stdout);
      const hooksJson = fs.readFileSync(hooksJsonPath, 'utf8');
      assert.ok(!hooksJson.includes('windsurf-gateguard-adapter') && !hooksJson.includes('windsurf-guardian-adapter'), `no EGC entry is left: ${hooksJson}`);
      assert.deepStrictEqual(readJson(hooksJsonPath).hooks.pre_run_command, [{ command: 'echo mine' }], 'the person\'s own entry stays');
      const groups = readJson(devinConfigOf(homeDir)).hooks.PreToolUse;
      assert.deepStrictEqual(groups.map(group => group.matcher), [DEVIN_GATEGUARD_MATCHER, '^exec$'], 'the Devin Local entries replace them');

      const again = run(['--target', 'windsurf', '--profile', 'minimal', '--allow-undetected', '--json'], { cwd: projectDir, homeDir, env: devinEnv(homeDir) });
      assert.deepStrictEqual(JSON.parse(again.stdout).result.retiredHooks, [], 'nothing left to retire');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('an upgrade retires the Gemini CLI residue an earlier install wrote under ~/.gemini and keeps the person\'s own files', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');
    try {
      const geminiRoot = path.join(homeDir, '.gemini');
      const statePath = path.join(geminiRoot, 'egc', 'install-state.json');
      const repoRoot = path.join(__dirname, '..', '..');
      // The bytes an earlier install copied for the retired Gemini CLI,
      // recorded under the modules the core profile still selects.
      const residue = [
        ['skills/testing/tdd-workflow/SKILL.md', path.join(geminiRoot, 'skills', 'egc', 'tdd-workflow', 'SKILL.md'), 'workflow-quality'],
        ['.agents/AGENTS.md', path.join(geminiRoot, '.agents', 'AGENTS.md'), 'agents-core'],
        ['mcp-configs/mcp-servers.json', path.join(geminiRoot, 'mcp-configs', 'mcp-servers.json'), 'platform-configs'],
        ['.gemini-plugin/plugin.json', path.join(geminiRoot, 'plugin.json'), 'platform-configs'],
      ];
      for (const [source, destination] of residue) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, ...source.split('/')), destination);
      }
      // One retired file the person edited since, and one file of their own.
      const edited = path.join(geminiRoot, 'hooks', 'hooks.json');
      fs.mkdirSync(path.dirname(edited), { recursive: true });
      fs.writeFileSync(edited, 'edited by hand');
      const own = path.join(geminiRoot, 'skills', 'mine', 'SKILL.md');
      fs.mkdirSync(path.dirname(own), { recursive: true });
      fs.writeFileSync(own, '# mine');
      const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
      const recorded = [...residue, ['hooks/hooks.json', edited, 'hooks-runtime']];
      writeInstallState(statePath, createInstallState({
        adapter: { id: 'egc-home' },
        targetRoot: geminiRoot,
        installStatePath: statePath,
        request: { profile: 'core', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: recorded.map(([sourceRelativePath, destinationPath, moduleId]) => ({ kind: 'copy-file', moduleId, sourceRelativePath, destinationPath, strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false })),
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      }));

      const dryRun = run(['--target', 'egc', '--profile', 'core', '--dry-run', '--allow-undetected', '--json'], { cwd: projectDir, homeDir });
      assert.strictEqual(dryRun.code, 0, dryRun.stderr);
      const planned = JSON.parse(dryRun.stdout).plan.retirements.map(entry => entry.destinationPath).sort();
      const expectedRetirements = residue.map(([, destination]) => destination).sort();
      assert.deepStrictEqual(planned, expectedRetirements, `the dry run lists exactly the files EGC wrote for the retired Gemini CLI, never the one the person edited: planned ${JSON.stringify(planned)}, expected ${JSON.stringify(expectedRetirements)}`);
      assert.ok(fs.existsSync(residue[0][1]), 'the dry run touches nothing');

      const applied = run(['--target', 'egc', '--profile', 'core', '--allow-undetected'], { cwd: projectDir, homeDir, env: { EGC_INSTALL_DELEGATED: '1' } });
      assert.strictEqual(applied.code, 0, applied.stderr);
      for (const [, destination] of residue) {
        assert.ok(!fs.existsSync(destination), `${destination} is gone`);
      }
      assert.ok(!fs.existsSync(path.join(geminiRoot, 'skills', 'egc')), 'the emptied skills/egc directory is gone');
      assert.ok(!fs.existsSync(path.join(geminiRoot, '.agents')), 'the emptied .agents directory is gone');
      assert.ok(!fs.existsSync(path.join(geminiRoot, 'mcp-configs')), 'the emptied mcp-configs directory is gone');
      assert.strictEqual(fs.readFileSync(own, 'utf8'), '# mine', 'the person\'s own skill stays, and ~/.gemini/skills with it');
      assert.strictEqual(fs.readFileSync(edited, 'utf8'), 'edited by hand', 'a retired file the person edited since stays');
      assert.ok(fs.existsSync(path.join(geminiRoot, 'config', 'skills', 'tdd-workflow', 'SKILL.md')), 'the Antigravity CLI skills are written');
      assert.ok(fs.existsSync(path.join(geminiRoot, 'AGENTS.md')), 'AGENTS.md, which Antigravity reads, is written');
      for (const kept of [path.join('rules', 'egc', 'common', 'coding-style.md'), path.join('agents', 'architect.md'), path.join('commands', 'plan.md')]) {
        assert.ok(fs.existsSync(path.join(geminiRoot, kept)), `${kept} is still delivered until its family moves to the directory Antigravity reads`);
      }
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  if (process.platform !== 'win32') {
    tally(test('lists a June 2026 legacy skill link in the dry run and reports it migrated on apply (#1400)', () => {
      const homeDir = createTempDir('install-apply-home-');
      const projectDir = createTempDir('install-apply-project-');
      try {
        // Find a skill the egc target installs, from the plan itself.
        const planned = run(['--target', 'egc', '--profile', 'minimal', '--dry-run', '--allow-undetected'], { cwd: projectDir, homeDir });
        assert.strictEqual(planned.code, 0, planned.stderr);
        const cliSkills = path.join(homeDir, '.gemini', 'config', 'skills');
        const match = planned.stdout.split('\n').map(line => line.trim()).find(line => line.includes(cliSkills));
        assert.ok(match, 'the plan writes Antigravity CLI skills');
        const skill = path.relative(cliSkills, match.slice(match.indexOf(cliSkills))).split(path.sep)[0];
        // The June layout: the skill under the Antigravity CLI is a link into
        // the Gemini home copy.
        const managed = path.join(homeDir, '.gemini', 'skills', 'egc', skill);
        fs.mkdirSync(managed, { recursive: true });
        fs.writeFileSync(path.join(managed, 'SKILL.md'), 'old copy');
        fs.mkdirSync(cliSkills, { recursive: true });
        // Gated on platform above, like the other link tests in this file:
        // a link that cannot be created fails loudly instead of passing.
        fs.symlinkSync(managed, path.join(cliSkills, skill), 'dir');

        const dryRun = run(['--target', 'egc', '--profile', 'minimal', '--dry-run', '--allow-undetected'], { cwd: projectDir, homeDir });
        assert.strictEqual(dryRun.code, 0, dryRun.stderr);
        assert.ok(dryRun.stdout.includes('Legacy links to migrate'), dryRun.stdout);
        assert.ok(dryRun.stdout.includes(`- ${path.join(cliSkills, skill)} (pointed at `), 'the link is listed with its target');
        assert.ok(fs.lstatSync(path.join(cliSkills, skill)).isSymbolicLink(), 'the dry run touches nothing');
        const json = run(['--target', 'egc', '--profile', 'minimal', '--dry-run', '--allow-undetected', '--json'], { cwd: projectDir, homeDir });
        assert.strictEqual(JSON.parse(json.stdout).plan.legacyLinks.length, 1, 'the JSON plan carries the list');

        const applied = run(['--target', 'egc', '--profile', 'minimal', '--allow-undetected'], { cwd: projectDir, homeDir, env: { EGC_INSTALL_DELEGATED: '1' } });
        assert.strictEqual(applied.code, 0, applied.stderr);
        assert.ok(applied.stdout.includes(`migrated legacy link: ${path.join(cliSkills, skill)} (pointed at `), applied.stdout);
        assert.ok(fs.lstatSync(path.join(cliSkills, skill)).isDirectory(), 'the link became a real directory');
        assert.ok(fs.existsSync(path.join(cliSkills, skill, 'SKILL.md')), 'with the real file inside');
        assert.strictEqual(fs.readFileSync(path.join(managed, 'SKILL.md'), 'utf8').length > 0, true, 'the copy it pointed at is still there');

        const again = run(['--target', 'egc', '--profile', 'minimal', '--allow-undetected', '--json'], { cwd: projectDir, homeDir, env: { EGC_INSTALL_DELEGATED: '1' } });
        assert.deepStrictEqual(JSON.parse(again.stdout).result.migratedLegacyLinks, [], 'nothing left to migrate');
      } finally {
        cleanup(homeDir);
        cleanup(projectDir);
      }
    }));
  }

  tally(test('a skill the egc target installs first as a single file is listed as a file-to-dir transition in the dry run (#1428)', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');
    try {
      const repoRoot = path.join(__dirname, '..', '..');
      // Find a skill the egc target installs this run, straight from the plan.
      const planned = run(['--target', 'egc', '--profile', 'minimal', '--dry-run', '--allow-undetected'], { cwd: projectDir, homeDir });
      assert.strictEqual(planned.code, 0, planned.stderr);
      const cliSkills = path.join(homeDir, '.gemini', 'config', 'skills');
      const chosen = planned.stdout.split('\n')
        .map(line => line.trim())
        .map(line => /^- (.+?) -> (.+)$/.exec(line))
        .filter(match => match && match[2].includes(cliSkills + path.sep))
        .map(match => ({ sourceRelative: match[1], destination: match[2] }))
        .find(entry => entry.destination.split(path.sep).length > cliSkills.split(path.sep).length + 1);
      assert.ok(chosen, 'a skill with a directory of its own is planned');
      const parent = path.join(cliSkills, path.relative(cliSkills, chosen.destination).split(path.sep)[0]);
      // An earlier install recorded that skill destination as a single file,
      // and the plan now wants a directory there. The bytes written match the
      // planned child source, so the transition is provable.
      fs.mkdirSync(path.dirname(parent), { recursive: true });
      const childSource = path.join(repoRoot, chosen.sourceRelative.split('/').join(path.sep));
      assert.ok(fs.existsSync(childSource), `the planned source exists: ${chosen.sourceRelative}`);
      fs.copyFileSync(childSource, parent);
      const statePath = path.join(homeDir, '.gemini', 'egc', 'install-state.json');
      const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');
      writeInstallState(statePath, createInstallState({
        adapter: { id: 'egc' },
        targetRoot: path.join(homeDir, '.gemini'),
        installStatePath: statePath,
        request: { profile: 'minimal', modules: [], legacyLanguages: [], legacyMode: false },
        resolution: { selectedModules: [], skippedModules: [] },
        // moduleId 'unselected' keeps the transitioned file out of the
        // retirement list, so the dry-run output stays readable.
        operations: [{ kind: 'copy-file', moduleId: 'unselected', sourceRelativePath: chosen.sourceRelative, destinationPath: parent, strategy: 'preserve-relative-path', ownership: 'managed', scaffoldOnly: false }],
        source: { repoVersion: require('../../package.json').version, repoCommit: 'abc123', manifestVersion: 1 },
      }));

      const dryRun = run(['--target', 'egc', '--profile', 'minimal', '--dry-run', '--allow-undetected'], { cwd: projectDir, homeDir });
      assert.strictEqual(dryRun.code, 0, dryRun.stderr);
      assert.ok(dryRun.stdout.includes('Shape transitions (a source changed between a file and a directory):'), dryRun.stdout);
      assert.ok(dryRun.stdout.includes(`${parent}: file retired, written as a directory`), dryRun.stdout);
      assert.ok(fs.statSync(parent).isFile(), 'the dry run leaves the file as a file');
      const dryJson = run(['--target', 'egc', '--profile', 'minimal', '--dry-run', '--allow-undetected', '--json'], { cwd: projectDir, homeDir });
      const plan = JSON.parse(dryJson.stdout).plan;
      assert.strictEqual(plan.shapeTransitions.length, 1, 'exactly one transition is planned');
      assert.strictEqual(plan.shapeTransitions[0].type, 'file-to-dir');
      assert.strictEqual(plan.shapeTransitions[0].destinationPath, parent, 'the file that claims the directory spot');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('supports manifest profile dry-runs through the installer', () => {
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
  }));

  tally(test('supports minimal profile dry-runs without hooks through the installer', () => {
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
  }));

  tally(test('installs manifest profiles and writes non-legacy install-state', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const geminiRoot = path.join(homeDir, '.gemini');
      // What Antigravity reads stays, and so do the families that still wait
      // for their Antigravity directory (rules/egc, agents, commands); the
      // hooks/hooks.json only the retired Gemini CLI read is not written.
      assert.ok(fs.existsSync(path.join(geminiRoot, 'AGENTS.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'scripts', 'hooks', 'session-end.js')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'rules', 'egc', 'common', 'coding-style.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'agents', 'architect.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'commands', 'plan.md')));
      assert.ok(!fs.existsSync(path.join(geminiRoot, 'hooks', 'hooks.json')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'scripts', 'lib', 'session-manager.js')));
      assert.ok(!fs.existsSync(path.join(geminiRoot, 'plugin.json')), 'the plugin manifest only the retired Gemini CLI read is not written');

      const state = readJson(path.join(geminiRoot, 'egc', 'install-state.json'));
      assert.strictEqual(state.request.profile, 'core');
      assert.strictEqual(state.request.legacyMode, false);
      assert.deepStrictEqual(state.request.legacyLanguages, []);
      assert.ok(state.resolution.selectedModules.includes('platform-configs'));
      assert.ok(
        state.operations.some(operation => (
          operation.destinationPath === path.join(geminiRoot, 'config', 'skills', 'tdd-workflow', 'SKILL.md')
        )),
        'Should record the manifest-driven Antigravity CLI skill copy'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('writes the home-scoped Guardian CLI marker on every install (EGC-465, Copilot/CodeBuddy resolution gap)', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const markerPath = path.join(homeDir, '.egc', 'guardian-cli-path.json');
      assert.ok(fs.existsSync(markerPath), 'Should write ~/.egc/guardian-cli-path.json');
      const marker = readJson(markerPath);
      const repoRoot = path.join(__dirname, '..', '..');
      assert.strictEqual(path.resolve(marker.packageRoot), path.resolve(repoRoot));
      assert.ok(
        fs.existsSync(path.join(marker.packageRoot, 'mcp', 'servers', 'egc-guardian', 'src', 'guardian-cli.ts')),
        'marker packageRoot should resolve to the real repo root'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('a Guardian CLI marker write failure warns but does not fail the install (EGC-465)', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      // A plain file sitting where the marker's parent directory needs to be
      // created: mkdirSync(..., {recursive: true}) cannot turn a file into a
      // directory, so writeGuardianCliMarker()'s write fails -- this must be
      // swallowed (logged, not thrown), since it is only one of four
      // resolution strategies and must never break a real install.
      fs.writeFileSync(path.join(homeDir, '.egc'), 'not a directory');

      // run()'s helper hardcodes stderr to '' on a successful (exit 0) run
      // -- execFileSync only exposes stderr via the thrown error on
      // failure. spawnSync captures both streams uniformly regardless of
      // exit code, which this specific assertion needs.
      const { spawnSync } = require('child_process');
      const spawned = spawnSync('node', [SCRIPT, '--profile', 'core'], {
        cwd: projectDir,
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        encoding: 'utf8',
        timeout: DEFAULT_INSTALL_APPLY_TIMEOUT_MS,
      });
      const result = { code: spawned.status, stdout: spawned.stdout, stderr: spawned.stderr };
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(
        result.stderr.includes('Failed to write Guardian CLI marker'),
        `Expected a warning about the marker write failure, got stderr: ${result.stderr}`
      );

      const geminiRoot = path.join(homeDir, '.gemini');
      assert.ok(
        fs.existsSync(path.join(geminiRoot, 'egc', 'install-state.json')),
        'the rest of the install should still complete normally'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('installs the Claude Code SessionStart state hook and records install-state', () => {
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
  }));

  tally(test('claude reinstall is idempotent and preserves third-party settings.json content', () => {
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

      const preToolUseGroups = settings.hooks.PreToolUse;
      assert.strictEqual(preToolUseGroups.length, 11, 'Reinstall must not duplicate PreToolUse hooks');
      assert.strictEqual(preToolUseGroups[0].hooks[0].command, 'echo guard');
      assert.ok(
        preToolUseGroups[1].hooks[0].command.includes('bash-hook-dispatcher.js'),
        'EGC bash dispatcher should be registered in PreToolUse'
      );
      assert.ok(
        preToolUseGroups[2].hooks[0].command.includes('pre-write-guardian-validate.js'),
        'EGC write validator should be registered for Edit'
      );
      assert.strictEqual(preToolUseGroups[2].matcher, 'Edit');
      assert.strictEqual(preToolUseGroups[3].matcher, 'Write');
      assert.strictEqual(preToolUseGroups[4].matcher, 'MultiEdit');
      assert.ok(
        preToolUseGroups[5].hooks[0].command.includes('scrubber-hook.js'),
        'EGC Scrubber should be registered for Edit'
      );
      assert.strictEqual(preToolUseGroups[5].matcher, 'Edit');
      assert.strictEqual(preToolUseGroups[6].matcher, 'Write');
      assert.strictEqual(preToolUseGroups[7].matcher, 'MultiEdit');
      assert.ok(
        preToolUseGroups[8].hooks[0].command.includes('gateguard-fact-force.js'),
        'EGC GateGuard fact-forcing gate should be registered for Edit'
      );
      assert.strictEqual(preToolUseGroups[8].matcher, 'Edit');
      assert.strictEqual(preToolUseGroups[9].matcher, 'Write');
      assert.strictEqual(preToolUseGroups[10].matcher, 'MultiEdit');

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
  }));

  tally(test('preserves existing top-level Gemini rules and skills during managed install', () => {
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
      assert.ok(fs.existsSync(path.join(geminiRoot, 'config', 'skills', 'tdd-workflow', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(geminiRoot, 'rules', 'egc', 'common', 'coding-style.md')), 'the managed copy lands in its own namespace next to the person\'s rules');
      assert.ok(!fs.existsSync(path.join(geminiRoot, 'skills', 'egc')), 'no managed copy lands next to the person\'s skills');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('installs antigravity manifest profiles while skipping only unsupported modules', () => {
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
  }));

  tally(test('installs explicit modules for cursor using manifest operations', () => {
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
  }));

  tally(test('rejects unknown explicit manifest modules before resolution', () => {
    const result = run(['--modules', 'ghost-module'], PROBE);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('Unknown install module: ghost-module'));
  }));

  tally(test('installs egc hooks without generating settings.json', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      const result = run(['--profile', 'core'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const geminiRoot = path.join(homeDir, '.gemini');
      // Antigravity's hooks land in its own files; the hooks/hooks.json and
      // settings.json of the retired Gemini CLI are neither copied nor created.
      assert.ok(fs.existsSync(path.join(geminiRoot, 'config', 'hooks.json')), 'the Antigravity guardian hook is registered in config/hooks.json');
      assert.ok(fs.existsSync(path.join(geminiRoot, 'antigravity-cli', 'hooks.json')), 'the Antigravity CLI hooks are registered in antigravity-cli/hooks.json');
      assert.ok(!fs.existsSync(path.join(geminiRoot, 'hooks', 'hooks.json')), 'the Gemini CLI hooks file is not copied any more');
      assert.ok(!fs.existsSync(path.join(geminiRoot, 'settings.json')), 'settings.json should not be created just to install managed hooks');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('the shipped hooks/hooks.json keeps the safe bootstrap contract (the claude target copies it as is)', () => {
    const homeDir = createTempDir('install-apply-home-');
    const projectDir = createTempDir('install-apply-project-');

    try {
      // The egc target no longer copies hooks/hooks.json (only the retired
      // Gemini CLI read it there); the claude target still copies the file
      // unchanged, so the contract of the shipped file is checked there.
      const result = run(['--target', 'claude', '--profile', 'core', '--allow-undetected'], { cwd: projectDir, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const claudeRoot = path.join(homeDir, '.claude');
      const installedHooks = readJson(path.join(claudeRoot, 'hooks', 'hooks.json'));

      const installedBashDispatcherEntry = installedHooks.hooks.PreToolUse.find(entry => entry.id === 'pre:bash:dispatcher');
      assert.ok(installedBashDispatcherEntry, 'hooks/hooks.json should include the consolidated Bash dispatcher hook');
      assert.strictEqual(typeof installedBashDispatcherEntry.hooks[0].command, 'string', 'hooks/hooks.json should install string-form commands for Claude Code schema compatibility');
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
  }));

  tally(test('preserves existing settings.json without mutating it during egc install', () => {
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
  }));

  tally(test('filters copied mcp config files when EGC_DISABLED_MCPS is set', () => {
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
  }));

  tally(test('reinstall does not create settings.json when only managed hooks are installed', () => {
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
  }));

  tally(test('reinstall leaves pre-existing hook-based settings.json untouched', () => {
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
  }));

  tally(test('ignores malformed existing settings.json during egc install', () => {
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
      assert.ok(fs.existsSync(path.join(geminiRoot, 'config', 'hooks.json')), 'the Antigravity hooks should still be registered');
      assert.ok(fs.existsSync(path.join(geminiRoot, 'egc', 'install-state.json')), 'install state should still be written');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('ignores non-object existing settings.json during egc install', () => {
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
      assert.ok(fs.existsSync(path.join(geminiRoot, 'config', 'hooks.json')), 'the Antigravity hooks should still be registered');
      assert.ok(fs.existsSync(path.join(geminiRoot, 'egc', 'install-state.json')), 'install state should still be written');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  }));

  tally(test('installs from egc-install.json and persists component selections', () => {
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

      assert.ok(fs.existsSync(path.join(homeDir, '.gemini', 'config', 'skills', 'security-review', 'SKILL.md')));
      assert.ok(!fs.existsSync(path.join(homeDir, '.gemini', 'config', 'skills', 'dmux-workflows', 'SKILL.md')));

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
  }));

  tally(test('auto-detects egc-install.json from the project root', () => {
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

      assert.ok(fs.existsSync(path.join(homeDir, '.gemini', 'config', 'skills', 'security-review', 'SKILL.md')));
      assert.ok(!fs.existsSync(path.join(homeDir, '.gemini', 'config', 'skills', 'dmux-workflows', 'SKILL.md')));

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
  }));

  tally(test('preserves legacy language installs when a project config is present', () => {
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
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
