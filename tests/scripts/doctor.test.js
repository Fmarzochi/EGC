/**
 * Tests for scripts/doctor.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'doctor.js');
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
    USERPROFILE: options.homeDir || process.env.USERPROFILE,
  };

  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      cwd: options.cwd,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: process.platform === 'win32' ? 30000 : 10000,
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
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing doctor.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('explains that no install-state is expected after a bare install', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const result = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('This is expected after a bare `egc install`'));
      assert.ok(result.stdout.includes('egc install --target <target> --profile full'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('reports a healthy install with exit code 0', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const targetRoot = path.join(homeDir, '.gemini');
      const statePath = path.join(targetRoot, 'egc', 'install-state.json');
      const managedFile = path.join(targetRoot, 'rules', 'common', 'coding-style.md');
      const sourceContent = fs.readFileSync(path.join(REPO_ROOT, 'rules', 'common', 'coding-style.md'), 'utf8');
      fs.mkdirSync(path.dirname(managedFile), { recursive: true });
      fs.writeFileSync(managedFile, sourceContent);

      writeState(statePath, {
        adapter: { id: 'egc-home', target: 'egc', kind: 'home' },
        targetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: [],
          legacyLanguages: ['typescript'],
          legacyMode: true,
        },
        resolution: {
          selectedModules: ['legacy-egc-rules'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'copy-file',
            moduleId: 'legacy-egc-rules',
            sourceRelativePath: 'rules/common/coding-style.md',
            destinationPath: managedFile,
            strategy: 'preserve-relative-path',
            ownership: 'managed',
            scaffoldOnly: false,
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const result = run(['--target', 'egc'], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('Doctor report'));
      assert.ok(result.stdout.includes('Status: OK'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('reports issues and exits 1 for unhealthy installs', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const targetRoot = path.join(projectRoot, '.cursor');
      const statePath = path.join(targetRoot, 'egc-install-state.json');
      fs.mkdirSync(targetRoot, { recursive: true });

      writeState(statePath, {
        adapter: { id: 'cursor-project', target: 'cursor', kind: 'project' },
        targetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: ['platform-configs'],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: ['platform-configs'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'copy-file',
            moduleId: 'platform-configs',
            sourceRelativePath: '.cursor/hooks.json',
            destinationPath: path.join(targetRoot, 'hooks.json'),
            strategy: 'sync-root-children',
            ownership: 'managed',
            scaffoldOnly: false,
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const result = run(['--target', 'cursor', '--json'], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.summary.errorCount, 1);
      assert.ok(parsed.results[0].issues.some(issue => issue.code === 'missing-managed-files'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('--repo-root overrides the default reference repo (dev-checkout sync scenario)', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');
    const altRepoRoot = createTempDir('doctor-altrepo-');

    try {
      fs.cpSync(path.join(REPO_ROOT, 'manifests'), path.join(altRepoRoot, 'manifests'), { recursive: true });
      const altSourcePath = path.join(altRepoRoot, 'rules', 'common', 'coding-style.md');
      fs.mkdirSync(path.dirname(altSourcePath), { recursive: true });
      fs.writeFileSync(altSourcePath, 'ALT REPO CONTENT, not the real repo file\n');

      const targetRoot = path.join(homeDir, '.gemini');
      const statePath = path.join(targetRoot, 'egc', 'install-state.json');
      const managedFile = path.join(targetRoot, 'rules', 'common', 'coding-style.md');
      fs.mkdirSync(path.dirname(managedFile), { recursive: true });
      fs.writeFileSync(managedFile, 'ALT REPO CONTENT, not the real repo file\n');

      writeState(statePath, {
        adapter: { id: 'egc-home', target: 'egc', kind: 'home' },
        targetRoot,
        installStatePath: statePath,
        request: { profile: null, modules: [], legacyLanguages: ['typescript'], legacyMode: true },
        resolution: { selectedModules: ['legacy-egc-rules'], skippedModules: [] },
        operations: [
          {
            kind: 'copy-file',
            moduleId: 'legacy-egc-rules',
            sourceRelativePath: 'rules/common/coding-style.md',
            destinationPath: managedFile,
            strategy: 'preserve-relative-path',
            ownership: 'managed',
            scaffoldOnly: false,
          },
        ],
        source: { repoVersion: CURRENT_PACKAGE_VERSION, repoCommit: 'abc123', manifestVersion: CURRENT_MANIFEST_VERSION },
      });

      // Without --repo-root: compares against THIS repo's real coding-style.md,
      // which does not match the installed "ALT REPO CONTENT" -- drifted.
      const withoutOverride = run(['--target', 'egc', '--json'], { cwd: projectRoot, homeDir });
      const withoutParsed = JSON.parse(withoutOverride.stdout);
      assert.ok(
        withoutParsed.results[0].issues.some(issue => issue.code === 'drifted-managed-files'),
        'expected drift when comparing against the real repo, not the alt one the file actually came from'
      );

      // With --repo-root pointed at the alt repo: the installed file DOES
      // match that repo's copy -- healthy.
      const withOverride = run(['--target', 'egc', '--repo-root', altRepoRoot, '--json'], { cwd: projectRoot, homeDir });
      const withParsed = JSON.parse(withOverride.stdout);
      assert.strictEqual(withOverride.code, 0, withOverride.stderr);
      assert.strictEqual(withParsed.results[0].status, 'ok');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(altRepoRoot);
    }
  })) passed++; else failed++;

  if (test('--repo-root rejects a path that does not exist with a clear error', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const missingPath = path.join(projectRoot, 'does-not-exist');
      const result = run(['--repo-root', missingPath, '--json'], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 1);
      assert.ok(result.stderr.includes('--repo-root path does not exist'));
      assert.ok(result.stderr.includes(missingPath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('--repo-root with no path argument fails loudly instead of silently falling back', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const result = run(['--repo-root'], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 1);
      assert.ok(result.stderr.includes('--repo-root requires a path argument'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
