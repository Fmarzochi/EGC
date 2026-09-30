/**
 * Tests for scripts/list-installed.js
 */

const assert = require('assert');
const { maybeSkipBaselineAbsent } = require('../lib/baseline-absent');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'list-installed.js');
const REPO_ROOT = path.join(__dirname, '..', '..');
const CURRENT_PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
).version;
const CURRENT_MANIFEST_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'manifests', 'install-modules.json'), 'utf8')
).version;
const {
  createInstallState,
  writeInstallState,
} = require('../../scripts/lib/install-state');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function writeState(filePath, options) {
  const state = createInstallState(options);
  writeInstallState(filePath, state);
}

function run(args = [], options = {}) {
  const env = {
    ...process.env,
    HOME: options.homeDir || process.env.HOME,
  };

  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      cwd: options.cwd,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });

    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status || 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    if (maybeSkipBaselineAbsent(error, name)) return true;
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing list-installed.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('lists every target as not installed when no install-state file is present', () => {
    const homeDir = createTempDir('list-installed-home-');
    const projectRoot = createTempDir('list-installed-project-');

    try {
      const result = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('Status: not installed'), `expected every target reported as not installed, got:\n${result.stdout}`);
      assert.ok(!/Status: (installed|healthy)/.test(result.stdout), 'nothing may be reported as installed in an empty home and project');
      assert.ok(result.stdout.includes(homeDir), 'the install-state paths must be looked up under the given home');

      const json = run(['--json'], { cwd: projectRoot, homeDir });
      assert.strictEqual(json.code, 0, json.stderr);
      assert.deepStrictEqual(JSON.parse(json.stdout).records, [], 'no record may be discovered in an empty home and project');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('emits JSON for discovered install-state records', () => {
    const homeDir = createTempDir('list-installed-home-');
    const projectRoot = createTempDir('list-installed-project-');

    try {
      const statePath = path.join(projectRoot, '.cursor', 'egc-install-state.json');
      writeState(statePath, {
        adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
        targetRoot: path.join(projectRoot, '.cursor'),
        installStatePath: statePath,
        request: {
          profile: 'core',
          modules: [],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: ['rules-core', 'platform-configs'],
          skippedModules: [],
        },
        operations: [],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const result = run(['--json'], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.records.length, 1);
      assert.strictEqual(parsed.records[0].state.target.id, 'cursor-project');
      assert.strictEqual(parsed.records[0].state.request.profile, 'core');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
