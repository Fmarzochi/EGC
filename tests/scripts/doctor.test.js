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
const { getEGCDir } = require('../../scripts/lib/utils');

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

// getEGCDir() resolves purely from process.env at call time, so swapping
// HOME/USERPROFILE here and calling it in-process reproduces exactly what
// the spawned child (run() below, which sets the same two vars) will resolve.
function computeEGCDirForHome(homeDir) {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    return getEGCDir();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
}

function run(args = [], options = {}) {
  const env = {
    ...process.env,
    HOME: options.homeDir || process.env.HOME,
    USERPROFILE: options.homeDir || process.env.USERPROFILE,
    ...(options.env || {}),
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
      assert.ok(result.stdout.includes('Core runtime: OK. No managed target profile installed'));
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

  if (test('a CRLF-only difference (Windows checkout vs. a rewrite that always emits LF) is not drift (audit issue #1049)', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');
    const altRepoRoot = createTempDir('doctor-altrepo-');

    try {
      fs.cpSync(path.join(REPO_ROOT, 'manifests'), path.join(altRepoRoot, 'manifests'), { recursive: true });
      const altSourcePath = path.join(altRepoRoot, 'hooks', 'hooks.json');
      fs.mkdirSync(path.dirname(altSourcePath), { recursive: true });
      // The repo's own copy is LF, as git stores it (git ls-files --eol).
      fs.writeFileSync(altSourcePath, '{\n  "hooks": {}\n}\n');

      const targetRoot = path.join(homeDir, '.gemini');
      const statePath = path.join(targetRoot, 'egc', 'install-state.json');
      const managedFile = path.join(targetRoot, 'hooks', 'hooks.json');
      fs.mkdirSync(path.dirname(managedFile), { recursive: true });
      // Same content, CRLF line endings -- what a Windows checkout with
      // core.autocrlf=true (no .gitattributes forcing LF) actually produces
      // on disk, or what a rewrite step re-emitting the file via
      // JSON.stringify(...) would differ by in the other direction. Either
      // way this is not a real edit to the managed file.
      fs.writeFileSync(managedFile, '{\r\n  "hooks": {}\r\n}\r\n');

      writeState(statePath, {
        adapter: { id: 'egc-home', target: 'egc', kind: 'home' },
        targetRoot,
        installStatePath: statePath,
        request: { profile: null, modules: [], legacyLanguages: ['typescript'], legacyMode: true },
        resolution: { selectedModules: ['hooks-runtime'], skippedModules: [] },
        operations: [
          {
            kind: 'copy-file',
            moduleId: 'hooks-runtime',
            sourceRelativePath: 'hooks/hooks.json',
            destinationPath: managedFile,
            strategy: 'preserve-relative-path',
            ownership: 'managed',
            scaffoldOnly: false,
          },
        ],
        source: { repoVersion: CURRENT_PACKAGE_VERSION, repoCommit: 'abc123', manifestVersion: CURRENT_MANIFEST_VERSION },
      });

      const result = run(['--target', 'egc', '--repo-root', altRepoRoot, '--json'], { cwd: projectRoot, homeDir });
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(result.code, 0, result.stderr);
      assert.strictEqual(parsed.results[0].status, 'ok', 'a CRLF/LF-only difference must not be reported as drift');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(altRepoRoot);
    }
  })) passed++; else failed++;

  if (test('a real content difference is still reported as drift even when both files use CRLF', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');
    const altRepoRoot = createTempDir('doctor-altrepo-');

    try {
      fs.cpSync(path.join(REPO_ROOT, 'manifests'), path.join(altRepoRoot, 'manifests'), { recursive: true });
      const altSourcePath = path.join(altRepoRoot, 'hooks', 'hooks.json');
      fs.mkdirSync(path.dirname(altSourcePath), { recursive: true });
      fs.writeFileSync(altSourcePath, '{\r\n  "hooks": {}\r\n}\r\n');

      const targetRoot = path.join(homeDir, '.gemini');
      const statePath = path.join(targetRoot, 'egc', 'install-state.json');
      const managedFile = path.join(targetRoot, 'hooks', 'hooks.json');
      fs.mkdirSync(path.dirname(managedFile), { recursive: true });
      // Genuinely different content (not just line endings) -- must still
      // be caught as drift so the CRLF normalization does not mask real edits.
      fs.writeFileSync(managedFile, '{\r\n  "hooks": { "edited": true }\r\n}\r\n');

      writeState(statePath, {
        adapter: { id: 'egc-home', target: 'egc', kind: 'home' },
        targetRoot,
        installStatePath: statePath,
        request: { profile: null, modules: [], legacyLanguages: ['typescript'], legacyMode: true },
        resolution: { selectedModules: ['hooks-runtime'], skippedModules: [] },
        operations: [
          {
            kind: 'copy-file',
            moduleId: 'hooks-runtime',
            sourceRelativePath: 'hooks/hooks.json',
            destinationPath: managedFile,
            strategy: 'preserve-relative-path',
            ownership: 'managed',
            scaffoldOnly: false,
          },
        ],
        source: { repoVersion: CURRENT_PACKAGE_VERSION, repoCommit: 'abc123', manifestVersion: CURRENT_MANIFEST_VERSION },
      });

      const result = run(['--target', 'egc', '--repo-root', altRepoRoot, '--json'], { cwd: projectRoot, homeDir });
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(result.code, 1);
      assert.ok(
        parsed.results[0].issues.some(issue => issue.code === 'drifted-managed-files'),
        'a real content edit must still be reported as drift, CRLF normalization must not mask it'
      );
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

  if (test('--help prints usage and exits 0 without running a diagnosis', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const result = run(['--help'], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('Usage: node scripts/doctor.js'));
      assert.ok(result.stdout.includes('--repo-root <path>'));
      assert.ok(result.stdout.includes('egc auto-update --repo-root'));
      assert.ok(!result.stdout.includes('Doctor report'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('-h prints usage and exits 0', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const result = run(['-h'], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('Usage: node scripts/doctor.js'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('reports a drifted install as WARNING with issue detail in human-readable output', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const targetRoot = path.join(homeDir, '.gemini');
      const statePath = path.join(targetRoot, 'egc', 'install-state.json');
      const managedFile = path.join(targetRoot, 'rules', 'common', 'coding-style.md');
      fs.mkdirSync(path.dirname(managedFile), { recursive: true });
      fs.writeFileSync(managedFile, 'DRIFTED CONTENT, does not match the repo file\n');

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
      assert.strictEqual(result.code, 1, result.stderr);
      assert.ok(result.stdout.includes('Status: WARNING'));
      assert.ok(result.stdout.includes('[warning] drifted-managed-files'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('reports missing managed files as ERROR with issue detail in human-readable output', () => {
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

      const result = run(['--target', 'cursor'], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 1);
      assert.ok(result.stdout.includes('Status: ERROR'));
      assert.ok(result.stdout.includes('[error] missing-managed-files'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('stays quiet when both stores live in the shared ~/.egc (two-store layout is the current design)', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const egcDir = computeEGCDirForHome(homeDir);
      const dbPath = path.join(egcDir, 'egc', 'state.db');
      const memoryDbPath = path.join(egcDir, 'memory', 'state.db');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.mkdirSync(path.dirname(memoryDbPath), { recursive: true });
      fs.writeFileSync(dbPath, '');
      fs.writeFileSync(memoryDbPath, '');

      const result = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(!result.stdout.includes('Divergent database architecture'), 'the healthy two-store layout must not be presented as a defect');
      assert.ok(!result.stdout.includes('State store:'), 'nothing to report means no state-store section at all');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('lists stray state.db fragments with size, last write, and the merge-script pointer', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const egcDir = computeEGCDirForHome(homeDir);
      fs.mkdirSync(path.join(egcDir, 'egc'), { recursive: true });
      fs.mkdirSync(path.join(egcDir, 'memory'), { recursive: true });
      fs.writeFileSync(path.join(egcDir, 'egc', 'state.db'), '');
      fs.writeFileSync(path.join(egcDir, 'memory', 'state.db'), '');
      const strayPath = path.join(homeDir, '.gemini', 'egc', 'state.db');
      fs.mkdirSync(path.dirname(strayPath), { recursive: true });
      fs.writeFileSync(strayPath, 'stale-bytes');

      const result = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('State store:'));
      assert.ok(result.stdout.includes('1 stray state.db copy'));
      assert.ok(result.stdout.includes(strayPath));
      assert.ok(result.stdout.includes('merge-fragmented-state-dbs.js'), 'must point at the consolidation script');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('keeps the egc init guidance when nothing exists but a stray fragment does', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      // ~/.egc exists but holds no store yet, so resolution lands there
      // (tier 4 of getEGCDir) and the harness-dir copy is genuinely a stray.
      fs.mkdirSync(path.join(homeDir, '.egc'), { recursive: true });
      const strayPath = path.join(homeDir, '.claude', 'egc', 'state.db');
      fs.mkdirSync(path.dirname(strayPath), { recursive: true });
      fs.writeFileSync(strayPath, 'stale-bytes');

      const result = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('WARNING: state.db not found'), 'a fragment must not swallow the missing-store guidance');
      assert.ok(result.stdout.includes('Run: egc init'), 'the person still needs to know how to create the store');
      assert.ok(result.stdout.includes(strayPath), 'and the fragment must still be listed');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('warns about a misplaced CLI store without listing the canonical ~/.egc store as a stray', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const harnessDir = path.join(homeDir, '.gemini');
      const misplacedDb = path.join(harnessDir, 'egc', 'state.db');
      const canonicalDb = path.join(homeDir, '.egc', 'egc', 'state.db');
      const memoryDb = path.join(homeDir, '.egc', 'memory', 'state.db');
      for (const file of [misplacedDb, canonicalDb, memoryDb]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
      }

      // EGC_DIR pins resolution to the harness dir, reproducing a CLI whose
      // store landed away from ~/.egc.
      const result = run([], { cwd: projectRoot, homeDir, env: { EGC_DIR: harnessDir } });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('WARNING: the CLI event store landed in a harness directory'));
      assert.ok(result.stdout.includes(misplacedDb));
      assert.ok(!result.stdout.includes(`${canonicalDb} (`), 'the canonical ~/.egc store must never be listed as a stray copy');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('--json always emits the full stateDb shape', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const result = run(['--json'], { cwd: projectRoot, homeDir });
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.stateDb, 'missing stores must still produce a stateDb block');
      for (const key of ['missing', 'dbPath', 'memoryDbPath', 'hasHarnessDb', 'hasMemoryDb', 'cliStoreMisplaced', 'fragments']) {
        assert.ok(Object.hasOwn(parsed.stateDb, key), `stateDb must always carry ${key}`);
      }
      assert.strictEqual(parsed.stateDb.missing, true);
      assert.ok(Array.isArray(parsed.stateDb.fragments));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('notes a not-yet-created memory store as informational, not a warning', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const egcDir = computeEGCDirForHome(homeDir);
      fs.mkdirSync(path.join(egcDir, 'egc'), { recursive: true });
      fs.writeFileSync(path.join(egcDir, 'egc', 'state.db'), '');

      const result = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('OK: the MCP memory store appears after your first session saves state'));
      assert.ok(!result.stdout.includes('WARNING: the CLI event store'), 'a store in the right place must not trigger the misplacement warning');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
