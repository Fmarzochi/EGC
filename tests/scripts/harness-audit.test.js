/**
 * Tests for scripts/harness-audit.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'harness-audit.js');
const { parseArgs } = require(SCRIPT);

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function buildEnv(options = {}) {
  const userProfile = options.userProfile || options.homeDir || process.env.USERPROFILE;
  const env = {
    ...process.env,
    USERPROFILE: userProfile,
  };

  if (Object.prototype.hasOwnProperty.call(options, 'homeDir')) {
    env.HOME = options.homeDir;
  } else {
    env.HOME = process.env.HOME;
  }

  return env;
}

function run(args = [], options = {}) {
  const stdout = execFileSync('node', [SCRIPT, ...args], {
    cwd: options.cwd || path.join(__dirname, '..', '..'),
    env: buildEnv(options),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  });

  return stdout;
}

function runProcess(args = [], options = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: options.cwd || path.join(__dirname, '..', '..'),
    env: buildEnv(options),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  });
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
  console.log('\n=== Testing harness-audit.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('parseArgs accepts supported forms and rejects invalid arguments', () => {
    const rootDir = createTempDir('harness-audit-args-root-');

    try {
      assert.strictEqual(parseArgs(['node', 'script', '--help']).help, true);
      assert.strictEqual(parseArgs(['node', 'script', '-h']).help, true);

      const spaced = parseArgs(['node', 'script', '--format', 'json', '--scope', 'skills', '--root', rootDir]);
      assert.strictEqual(spaced.format, 'json');
      assert.strictEqual(spaced.scope, 'skills');
      assert.strictEqual(spaced.root, path.resolve(rootDir));

      const equals = parseArgs(['node', 'script', '--format=json', '--scope=hooks', `--root=${rootDir}`]);
      assert.strictEqual(equals.format, 'json');
      assert.strictEqual(equals.scope, 'hooks');
      assert.strictEqual(equals.root, path.resolve(rootDir));

      assert.strictEqual(parseArgs(['node', 'script', 'commands']).scope, 'commands');
      assert.strictEqual(parseArgs(['node', 'script', '--scope']).scope, 'repo');
      assert.throws(() => parseArgs(['node', 'script', '--format', 'xml']), /Invalid format: xml/);
      assert.throws(() => parseArgs(['node', 'script', '--scope', 'bad-scope']), /Invalid scope: bad-scope/);
      assert.throws(() => parseArgs(['node', 'script', '--unknown']), /Unknown argument: --unknown/);
    } finally {
      cleanup(rootDir);
    }
  })) passed++; else failed++;

  if (test('cli help exits cleanly and invalid cli args exit with stderr', () => {
    const help = runProcess(['--help']);
    assert.strictEqual(help.status, 0);
    assert.strictEqual(help.stderr, '');
    assert.ok(help.stdout.includes('Usage: node scripts/harness-audit.js'));
    assert.ok(help.stdout.includes('Deterministic harness audit'));

    const invalid = runProcess(['--format', 'xml']);
    assert.strictEqual(invalid.status, 1);
    assert.strictEqual(invalid.stdout, '');
    assert.ok(invalid.stderr.includes('Error: Invalid format: xml. Use text or json.'));
  })) passed++; else failed++;

  if (test('json output is deterministic between runs', () => {
    const first = run(['repo', '--format', 'json']);
    const second = run(['repo', '--format', 'json']);

    assert.strictEqual(first, second);
  })) passed++; else failed++;

  if (test('report includes bounded scores and fixed categories', () => {
    const parsed = JSON.parse(run(['repo', '--format', 'json']));

    assert.strictEqual(parsed.deterministic, true);
    assert.strictEqual(parsed.rubric_version, '2026-03-30');
    assert.strictEqual(parsed.target_mode, 'repo');
    assert.ok(parsed.overall_score >= 0);
    assert.ok(parsed.max_score > 0);
    assert.ok(parsed.overall_score <= parsed.max_score);

    const categoryNames = Object.keys(parsed.categories);
    assert.ok(categoryNames.includes('Tool Coverage'));
    assert.ok(categoryNames.includes('Context Efficiency'));
    assert.ok(categoryNames.includes('Quality Gates'));
    assert.ok(categoryNames.includes('Memory Persistence'));
    assert.ok(categoryNames.includes('Eval Coverage'));
    assert.ok(categoryNames.includes('Security Guardrails'));
    assert.ok(categoryNames.includes('Cost Efficiency'));
  })) passed++; else failed++;

  if (test('scope filtering changes max score and check list', () => {
    const full = JSON.parse(run(['repo', '--format', 'json']));
    const scoped = JSON.parse(run(['hooks', '--format', 'json']));

    assert.strictEqual(scoped.scope, 'hooks');
    assert.ok(scoped.max_score < full.max_score);
    assert.ok(scoped.checks.length < full.checks.length);
    assert.ok(scoped.checks.every(check => check.path.includes('hooks') || check.path.includes('scripts/hooks')));
  })) passed++; else failed++;

  if (test('text format includes summary header', () => {
    const output = run(['repo']);
    assert.ok(output.includes('Harness Audit (repo, repo):'));
    assert.ok(output.includes('Top 3 Actions:') || output.includes('Checks:'));
  })) passed++; else failed++;

  if (test('detects repo mode from structural markers when package name differs', () => {
    const projectRoot = createTempDir('harness-audit-structural-repo-');

    try {
      fs.mkdirSync(path.join(projectRoot, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, '.gemini-plugin'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, 'skills'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'scripts', 'harness-audit.js'), '#!/usr/bin/env node\n');
      fs.writeFileSync(path.join(projectRoot, '.gemini-plugin', 'plugin.json'), JSON.stringify({ name: 'egc' }, null, 2));
      fs.writeFileSync(
        path.join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'forked-harness', scripts: { test: 'node scripts/validate-commands.js && node tests/run-all.js' } }, null, 2)
      );

      const parsed = JSON.parse(run(['--format=json', `--root=${projectRoot}`]));
      assert.strictEqual(parsed.target_mode, 'repo');
      assert.strictEqual(parsed.root_dir, path.resolve(projectRoot));
    } finally {
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('audits consumer projects from cwd instead of the EGC repo root', () => {
    const homeDir = createTempDir('harness-audit-home-');
    const projectRoot = createTempDir('harness-audit-project-');

    try {
      fs.mkdirSync(path.join(homeDir, '.gemini', 'plugins', 'egc', '.gemini-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, '.gemini', 'plugins', 'egc', '.gemini-plugin', 'plugin.json'),
        JSON.stringify({ name: 'egc' }, null, 2)
      );

      fs.mkdirSync(path.join(projectRoot, '.github', 'workflows'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, '.gemini'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# Project instructions\n');
      fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
      fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules\n.env\n');
      fs.writeFileSync(path.join(projectRoot, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
      fs.writeFileSync(path.join(projectRoot, 'tests', 'app.test.js'), 'test placeholder\n');
      fs.writeFileSync(path.join(projectRoot, '.gemini', 'settings.json'), JSON.stringify({ hooks: ['PreToolUse'] }, null, 2));
      fs.writeFileSync(
        path.join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'consumer-project', scripts: { test: 'node tests/app.test.js' } }, null, 2)
      );

      const parsed = JSON.parse(run(['repo', '--format', 'json'], { cwd: projectRoot, homeDir }));

      assert.strictEqual(parsed.target_mode, 'consumer');
      assert.strictEqual(parsed.root_dir, fs.realpathSync(projectRoot));
      assert.ok(parsed.overall_score > 0, 'Consumer project should receive non-zero score when harness signals exist');
      assert.ok(parsed.checks.some(check => check.id === 'consumer-plugin-install' && check.pass));
      assert.ok(parsed.checks.every(check => !check.path.startsWith('agents/') && !check.path.startsWith('skills/')));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('the memory and token checks read the capability, and the memory one is not satisfied by an event name alone', () => {
    const projectRoot = createTempDir('harness-audit-capability-');
    try {
      const hooksDir = path.join(projectRoot, 'hooks');
      const docsDir = path.join(projectRoot, 'docs', 'guides');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.mkdirSync(docsDir, { recursive: true });
      fs.writeFileSync(path.join(docsDir, 'token-optimization.md'), '# Token Optimization\n');
      // The repository checks only run in repo mode, which the package name
      // declares.
      fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'everything-gemini' }, null, 2));

      // The event is named, but nothing under it loads or saves memory.
      const namedOnly = { hooks: { SessionStart: [{ hooks: [{ command: 'node scripts/hooks/prompt-router.js' }] }], PreCompact: [{ hooks: [{ command: 'node scripts/hooks/suggest-compact.js' }] }] } };
      fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify(namedOnly, null, 2));
      const bare = JSON.parse(run(['repo', '--format', 'json', `--root=${projectRoot}`]));
      const memoryOf = (parsed) => parsed.checks.find((check) => check.id === 'memory-hooks-dir');
      const tokenChecks = (parsed) => parsed.checks.filter((check) => check.path === 'docs/token-optimization.md');
      assert.strictEqual(memoryOf(bare).pass, false, 'an event name with no memory hook under it is not the capability');
      assert.ok(tokenChecks(bare).length >= 2, 'both documentation checks should be present');
      assert.ok(tokenChecks(bare).every((check) => check.pass), 'the guide alone answers both documentation checks');

      // Now the events carry the hooks that actually load and save state.
      const withMemory = { hooks: { SessionStart: [{ hooks: [{ command: 'node scripts/hooks/egc-memory-load.js' }] }], PreCompact: [{ hooks: [{ command: 'node scripts/hooks/egc-memory-save.js' }] }] } };
      fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify(withMemory, null, 2));
      const declared = JSON.parse(run(['repo', '--format', 'json', `--root=${projectRoot}`]));
      assert.strictEqual(memoryOf(declared).pass, true, 'the lifecycle hooks of the root file are the capability');
    } finally {
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('scores empty consumer projects without plugin or harness signals as failing checks', () => {
    const homeDir = createTempDir('harness-audit-empty-home-');
    const projectRoot = createTempDir('harness-audit-empty-project-');

    try {
      const parsed = JSON.parse(run(['repo', '--format', 'json'], { cwd: projectRoot, homeDir }));

      assert.strictEqual(parsed.target_mode, 'consumer');
      assert.strictEqual(parsed.overall_score, 0);
      assert.ok(parsed.max_score > 0);
      assert.strictEqual(parsed.top_actions.length, 3);
      assert.ok(parsed.checks.some(check => check.id === 'consumer-plugin-install' && !check.pass));
      assert.ok(parsed.checks.some(check => check.id === 'consumer-project-overrides' && !check.pass));
      assert.ok(parsed.checks.some(check => check.id === 'consumer-secret-hygiene' && !check.pass));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('prints no top actions when consumer checks all pass', () => {
    const homeDir = createTempDir('harness-audit-passing-home-');
    const projectRoot = createTempDir('harness-audit-passing-project-');

    try {
      fs.mkdirSync(path.join(projectRoot, '.gemini', 'plugins', 'egc@egc'), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, '.gemini', 'plugins', 'egc@egc', 'plugin.json'),
        JSON.stringify({ name: 'egc' }, null, 2)
      );
      fs.mkdirSync(path.join(projectRoot, '.gemini'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, '.github', 'workflows', 'nested'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, 'docs', 'adr'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, 'evals'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.gemini', 'hooks.json'), JSON.stringify({ hooks: [] }, null, 2));
      fs.writeFileSync(path.join(projectRoot, '.gemini', 'settings.local.json'), JSON.stringify({ local: true }, null, 2));
      fs.writeFileSync(path.join(projectRoot, 'GEMINI.md'), '# Consumer instructions\n');
      fs.writeFileSync(path.join(projectRoot, 'src', 'app.spec.ts'), 'test placeholder\n');
      fs.writeFileSync(path.join(projectRoot, '.github', 'workflows', 'nested', 'ci.yaml'), 'name: ci\n');
      fs.writeFileSync(path.join(projectRoot, 'docs', 'adr', '001.md'), '# Record\n');
      fs.writeFileSync(path.join(projectRoot, 'evals', 'smoke.json'), '{}\n');
      fs.writeFileSync(path.join(projectRoot, '.github', 'dependabot.yml'), 'version: 2\n');
      fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules\n.env.local\n');
      fs.writeFileSync(
        path.join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'passing-consumer', scripts: {} }, null, 2)
      );

      const parsed = JSON.parse(run(['repo', '--format', 'json'], { cwd: projectRoot, homeDir }));
      assert.strictEqual(parsed.target_mode, 'consumer');
      assert.strictEqual(parsed.overall_score, parsed.max_score);

      const text = run(['repo'], { cwd: projectRoot, homeDir });
      assert.ok(text.includes(`Harness Audit (repo, consumer): ${parsed.max_score}/${parsed.max_score}`));
      assert.ok(text.includes('Checks: 11 total, 0 failing'));
      assert.ok(!text.includes('Top 3 Actions:'));

      const scopedText = run(['agents'], { cwd: projectRoot, homeDir });
      assert.ok(scopedText.includes('Harness Audit (agents, consumer):'));
      assert.ok(scopedText.includes('Checks: 1 total, 0 failing'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('detects marketplace-installed Gemini plugins under home marketplaces/', () => {
    const homeDir = createTempDir('harness-audit-marketplace-home-');
    const projectRoot = createTempDir('harness-audit-marketplace-project-');

    try {
      fs.mkdirSync(path.join(homeDir, '.gemini', 'plugins', 'marketplaces', 'everything-gemini', '.gemini-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, '.gemini', 'plugins', 'marketplaces', 'everything-gemini', '.gemini-plugin', 'plugin.json'),
        JSON.stringify({ name: 'everything-gemini' }, null, 2)
      );

      fs.mkdirSync(path.join(projectRoot, '.github', 'workflows'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, '.gemini'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# Project instructions\n');
      fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
      fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules\n.env\n');
      fs.writeFileSync(path.join(projectRoot, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
      fs.writeFileSync(path.join(projectRoot, 'tests', 'app.test.js'), 'test placeholder\n');
      fs.writeFileSync(path.join(projectRoot, '.gemini', 'settings.json'), JSON.stringify({ hooks: ['PreToolUse'] }, null, 2));
      fs.writeFileSync(
        path.join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'consumer-project', scripts: { test: 'node tests/app.test.js' } }, null, 2)
      );

      const parsed = JSON.parse(run(['repo', '--format', 'json'], { cwd: projectRoot, homeDir }));
      assert.ok(parsed.checks.some(check => check.id === 'consumer-plugin-install' && check.pass));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('detects marketplace-installed Gemini plugins under project marketplaces/', () => {
    const homeDir = createTempDir('harness-audit-marketplace-home-');
    const projectRoot = createTempDir('harness-audit-marketplace-project-');

    try {
      fs.mkdirSync(path.join(projectRoot, '.gemini', 'plugins', 'marketplaces', 'everything-gemini', '.gemini-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, '.gemini', 'plugins', 'marketplaces', 'everything-gemini', '.gemini-plugin', 'plugin.json'),
        JSON.stringify({ name: 'everything-gemini' }, null, 2)
      );

      fs.mkdirSync(path.join(projectRoot, '.github', 'workflows'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, '.gemini'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# Project instructions\n');
      fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
      fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules\n.env\n');
      fs.writeFileSync(path.join(projectRoot, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
      fs.writeFileSync(path.join(projectRoot, 'tests', 'app.test.js'), 'test placeholder\n');
      fs.writeFileSync(path.join(projectRoot, '.gemini', 'settings.json'), JSON.stringify({ hooks: ['PreToolUse'] }, null, 2));
      fs.writeFileSync(
        path.join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'consumer-project', scripts: { test: 'node tests/app.test.js' } }, null, 2)
      );

      const parsed = JSON.parse(run(['repo', '--format', 'json'], { cwd: projectRoot, homeDir }));
      assert.ok(parsed.checks.some(check => check.id === 'consumer-plugin-install' && check.pass));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('detects marketplace-installed Gemini plugins from USERPROFILE fallback on Windows-style setups', () => {
    const homeDir = createTempDir('harness-audit-marketplace-home-');
    const projectRoot = createTempDir('harness-audit-marketplace-project-');

    try {
      fs.mkdirSync(path.join(homeDir, '.gemini', 'plugins', 'marketplaces', 'everything-gemini', '.gemini-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, '.gemini', 'plugins', 'marketplaces', 'everything-gemini', '.gemini-plugin', 'plugin.json'),
        JSON.stringify({ name: 'everything-gemini' }, null, 2)
      );

      fs.mkdirSync(path.join(projectRoot, '.github', 'workflows'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, '.gemini'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# Project instructions\n');
      fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
      fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules\n.env\n');
      fs.writeFileSync(path.join(projectRoot, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
      fs.writeFileSync(path.join(projectRoot, 'tests', 'app.test.js'), 'test placeholder\n');
      fs.writeFileSync(path.join(projectRoot, '.gemini', 'settings.json'), JSON.stringify({ hooks: ['PreToolUse'] }, null, 2));
      fs.writeFileSync(
        path.join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'consumer-project', scripts: { test: 'node tests/app.test.js' } }, null, 2)
      );

      const parsed = JSON.parse(run(['repo', '--format', 'json'], {
        cwd: projectRoot,
        homeDir: '',
        userProfile: homeDir,
      }));
      assert.ok(parsed.checks.some(check => check.id === 'consumer-plugin-install' && check.pass));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
