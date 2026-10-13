/**
 * Tests for scripts/doctor.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');
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
const { shellQuote } = require('../../scripts/lib/doctor-summary');

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

const HOST_CONFIG_PATH_OVERRIDES = ['XDG_CONFIG_HOME', 'KIMI_CODE_HOME', 'CRUSH_GLOBAL_CONFIG', 'VIBE_HOME', 'CODEX_HOME', 'APPDATA'];

function run(args = [], options = {}) {
  const env = {
    ...process.env,
    HOME: options.homeDir || process.env.HOME,
    USERPROFILE: options.homeDir || process.env.USERPROFILE,
    ...(options.env || {}),
  };
  if (options.homeDir) {
    for (const key of HOST_CONFIG_PATH_OVERRIDES) {
      if (!Object.hasOwn(options.env || {}, key)) delete env[key];
    }
  }

  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      cwd: options.cwd,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS,
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


// Fake MCP servers for the probe: one that answers the handshake and
// tools/list with two tools, one that stays alive without answering, one
// that exits at once. Written next to the fake home so the registered paths
// are real files.
const OK_SERVER_SOURCE = [
  "process.stdin.setEncoding('utf8');",
  "let buffer = '';",
  "process.stdin.on('data', chunk => {",
  "  buffer += chunk;",
  "  let index = buffer.indexOf('\\n');",
  "  while (index >= 0) {",
  "    const line = buffer.slice(0, index);",
  "    buffer = buffer.slice(index + 1);",
  "    index = buffer.indexOf('\\n');",
  "    if (!line.trim()) continue;",
  "    const message = JSON.parse(line);",
  "    if (message.id === undefined) continue;",
  "    const result = message.method === 'tools/list'",
  "      ? { tools: [{ name: 'validate_command' }, { name: 'validate_write' }] }",
  "      : { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } };",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');",
  "  }",
  "});",
].join('\n');
const SILENT_SERVER_SOURCE = "process.stdin.resume();\nsetInterval(() => {}, 1000);\n";
const CRASH_SERVER_SOURCE = "process.stderr.write('boot failed: no state dir');\nprocess.exit(3);\n";

// The probe budget for every case that needs a fake server to answer. It is
// a hang detector, not a speed assertion: a loaded Windows runner took more
// than 1500 ms to start the answering server, and the case that expects one
// server to answer and one to stay silent failed there.
const PROBE_TIMEOUT_MS = 8000;
const PROBE_ENV = Object.freeze({ EGC_DOCTOR_PROBE_TIMEOUT_MS: String(PROBE_TIMEOUT_MS) });

function writeFakeServers(homeDir) {
  const dir = path.join(homeDir, 'fake-servers');
  fs.mkdirSync(dir, { recursive: true });
  const ok = path.join(dir, 'ok-server.js');
  const silent = path.join(dir, 'silent-server.js');
  const crash = path.join(dir, 'crash-server.js');
  fs.writeFileSync(ok, OK_SERVER_SOURCE);
  fs.writeFileSync(silent, SILENT_SERVER_SOURCE);
  fs.writeFileSync(crash, CRASH_SERVER_SOURCE);
  return { ok, silent, crash };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function mcpServersConfig(guardianBin, memoryBin) {
  return { mcpServers: { 'egc-guardian': { command: 'node', args: [guardianBin] }, 'egc-memory': { command: 'node', args: [memoryBin] } } };
}

function runTests() {
  console.log('\n=== Testing doctor.js ===\n');

  let passed = 0;
  let failed = 0;
  const tally = ok => (ok ? passed++ : failed++);

  tally(test('explains that no install-state is expected after a bare install', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const result = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('Core runtime: OK. No managed target profile installed'));
      assert.ok(result.stdout.includes('egc install --target <target> --profile full'));
      assert.ok(result.stdout.includes('Summary: checked=0'), 'the Summary line prints even with no target detected');
      assert.ok(result.stdout.includes('errors=0'), 'the done criterion errors=0 is reachable on a bare install');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('reports a healthy install with exit code 0', () => {
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
  }));

  tally(test('reports issues and exits 1 for unhealthy installs', () => {
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
  }));

  tally(test('--repo-root overrides the default reference repo (dev-checkout sync scenario)', () => {
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
  }));

  tally(test('a CRLF-only difference (Windows checkout vs. a rewrite that always emits LF) is not drift (audit issue #1049)', () => {
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
  }));

  tally(test('a real content difference is still reported as drift even when both files use CRLF', () => {
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
      // Drift is a warning, and warnings are informative: the exit code stays
      // 0. What this test guards is that the drift is still *reported*.
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(
        parsed.results[0].issues.some(issue => issue.code === 'drifted-managed-files'),
        'a real content edit must still be reported as drift, CRLF normalization must not mask it'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(altRepoRoot);
    }
  }));

  tally(test('--repo-root rejects a path that does not exist with a clear error', () => {
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
  }));

  tally(test('--repo-root with no path argument fails loudly instead of silently falling back', () => {
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
  }));

  tally(test('--help prints usage and exits 0 without running a diagnosis', () => {
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
  }));

  tally(test('-h prints usage and exits 0', () => {
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
  }));

  tally(test('a warnings-only run exits 0, an error exits 1 (warnings are informative)', () => {
    // Product decision: drift and version skew are worth reporting but do not
    // mean the install is broken. Exit 1 is reserved for real failures so a
    // script or CI job can branch on it. Both directions are asserted here so
    // neither half can regress on its own.
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

      const warned = run(['--target', 'egc', '--json'], { cwd: projectRoot, homeDir });
      const warnedReport = JSON.parse(warned.stdout);
      assert.ok(warnedReport.summary.warningCount > 0, 'the fixture must produce a warning');
      assert.strictEqual(warnedReport.summary.errorCount, 0, 'and no error');
      assert.strictEqual(warned.code, 0, `a warnings-only run must exit 0: ${warned.stderr}`);

      // Same install, managed file removed: that is a real failure.
      fs.rmSync(managedFile, { force: true });
      const failed = run(['--target', 'egc', '--json'], { cwd: projectRoot, homeDir });
      const failedReport = JSON.parse(failed.stdout);
      assert.ok(failedReport.summary.errorCount > 0, 'a missing managed file must be an error');
      assert.strictEqual(failed.code, 1, 'a run with errors must still exit 1');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('reports a drifted install as WARNING with issue detail in human-readable output', () => {
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
      // Warnings are informative, so a warnings-only run exits 0: exit 1 is
      // reserved for real failures.
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('Status: WARNING'));
      assert.ok(result.stdout.includes('[warning] drifted-managed-files'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('reports missing managed files as ERROR with issue detail in human-readable output', () => {
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
  }));

  tally(test('stays quiet when both stores live in the shared ~/.egc (two-store layout is the current design)', () => {
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
  }));

  tally(test('lists stray state.db fragments with size, last write, and the merge-script pointer', () => {
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
      const consolidateScript = path.join(__dirname, '..', '..', 'scripts', 'maintenance', 'merge-fragmented-state-dbs.js');
      assert.ok(result.stdout.includes(`node ${shellQuote(consolidateScript)}`), 'must point at the consolidation script by absolute path, runnable from any cwd');
      const canonicalDb = path.join(homeDir, '.egc', 'egc', 'state.db');
      assert.ok(
        result.stdout.includes(`node ${shellQuote(consolidateScript)} --canonical ${shellQuote(canonicalDb)} --source ${shellQuote(strayPath)}`),
        'the hint must run as pasted: the script exits with its usage text when no --source is given (#1389)'
      );
      assert.ok(result.stdout.includes('with --apply at the end'), 'the person must learn how to turn the dry run into a write');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('names every stray copy as its own --source when more than one is left behind', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const egcDir = computeEGCDirForHome(homeDir);
      fs.mkdirSync(path.join(egcDir, 'egc'), { recursive: true });
      fs.mkdirSync(path.join(egcDir, 'memory'), { recursive: true });
      fs.writeFileSync(path.join(egcDir, 'egc', 'state.db'), '');
      fs.writeFileSync(path.join(egcDir, 'memory', 'state.db'), '');
      const strays = [
        path.join(homeDir, '.gemini', 'egc', 'state.db'),
        path.join(homeDir, '.config', 'opencode', 'egc', 'state.db'),
        path.join(homeDir, '.codebuddy', 'egc', 'state.db'),
      ];
      for (const stray of strays) {
        fs.mkdirSync(path.dirname(stray), { recursive: true });
        fs.writeFileSync(stray, 'stale-bytes');
      }

      const result = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('3 stray state.db copies'));
      const hint = result.stdout.split('\n').find(line => line.includes('merge-fragmented-state-dbs.js'));
      assert.ok(hint, 'the consolidation hint must be printed');
      for (const stray of strays) {
        assert.ok(hint.includes(`--source ${shellQuote(stray)}`), `the hint must carry --source for ${stray}`);
      }
      assert.strictEqual(hint.split('--source ').length - 1, strays.length, 'one --source per copy, nothing else');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('keeps the egc init guidance when nothing exists but a stray fragment does', () => {
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
  }));

  tally(test('warns about a misplaced CLI store without listing the canonical ~/.egc store as a stray', () => {
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
      assert.ok(
        result.stdout.includes(`--canonical ${shellQuote(canonicalDb)} --source ${shellQuote(misplacedDb)}`),
        'the misplaced store is the source and the shared store the explicit destination, since the default resolution is what misplaced it'
      );
      assert.ok(!result.stdout.includes(`${canonicalDb} (`), 'the canonical ~/.egc store must never be listed as a stray copy');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('keeps the CLI store under .egc when a harness variable is set and lists the harness copy as a stray', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const harnessCopy = path.join(homeDir, '.gemini', 'egc', 'state.db');
      const canonicalDb = path.join(homeDir, '.egc', 'egc', 'state.db');
      const memoryDb = path.join(homeDir, '.egc', 'memory', 'state.db');
      for (const file of [harnessCopy, canonicalDb, memoryDb]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
      }

      // The variable a Gemini-family tool injects used to route the store
      // to ~/.gemini; the shared store must stay the live one regardless.
      const result = run(['--json'], { cwd: projectRoot, homeDir, env: { GEMINI_PROJECT_DIR: projectRoot } });
      assert.strictEqual(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.stateDb.dbPath, canonicalDb);
      assert.strictEqual(parsed.stateDb.cliStoreMisplaced, false);
      assert.deepStrictEqual(parsed.stateDb.fragments.map((fragment) => fragment.path), [harnessCopy]);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('--json always emits the full stateDb shape', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const result = run(['--json'], { cwd: projectRoot, homeDir });
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.stateDb, 'missing stores must still produce a stateDb block');
      for (const key of ['missing', 'dbPath', 'canonicalDbPath', 'memoryDbPath', 'hasHarnessDb', 'hasMemoryDb', 'cliStoreMisplaced', 'fragments']) {
        assert.ok(Object.hasOwn(parsed.stateDb, key), `stateDb must always carry ${key}`);
      }
      assert.strictEqual(parsed.stateDb.missing, true);
      assert.ok(Array.isArray(parsed.stateDb.fragments));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('notes a not-yet-created memory store as informational, not a warning', () => {
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
  }));

  tally(test('warns about plain-text state files and lists them with the encryption guidance', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const stateDir = path.join(homeDir, '.egc', 'state');
      fs.mkdirSync(path.join(stateDir, 'Projetos--demo'), { recursive: true });
      const flatPlain = path.join(stateDir, 'Projetos--demo.md');
      const branchPlain = path.join(stateDir, 'Projetos--demo', 'main.md');
      fs.writeFileSync(flatPlain, '# Project State\nproject: /srv/demo\n');
      fs.writeFileSync(branchPlain, '# Project State\nbranch: main\n');
      fs.writeFileSync(path.join(stateDir, 'Projetos--sealed.md'), Buffer.concat([Buffer.from('EGC1:'), Buffer.alloc(40, 7)]));

      const result = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('State files:'));
      assert.ok(result.stdout.includes(`WARNING: 2 of 3 state files under ${stateDir} are plain text:`));
      assert.ok(result.stdout.includes(flatPlain));
      assert.ok(result.stdout.includes(branchPlain));
      assert.ok(!result.stdout.includes('Projetos--sealed.md'), 'an encrypted file is not a finding');
      assert.ok(result.stdout.includes('run `egc init` in that project'), 'the person must learn what to do about a file a tool wrote by hand');
      assert.ok(!result.stdout.includes('and 0 more'));

      const json = JSON.parse(run(['--json'], { cwd: projectRoot, homeDir }).stdout);
      assert.strictEqual(json.plaintextStateFiles.count, 2);
      assert.strictEqual(json.plaintextStateFiles.checked, 3);
      assert.deepStrictEqual(json.plaintextStateFiles.files.map(file => file.path).sort(), [flatPlain, branchPlain].sort());
      assert.ok(json.plaintextStateFiles.files.every(file => typeof file.modifiedAt === 'string'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('stays silent about state files when every one is encrypted, empty, archived, or behind a link', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');
    const outside = createTempDir('doctor-outside-');

    try {
      const stateDir = path.join(homeDir, '.egc', 'state');
      fs.mkdirSync(path.join(stateDir, 'archive'), { recursive: true });
      fs.mkdirSync(path.join(stateDir, 'Projetos--demo'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'Projetos--demo', 'main.md'), Buffer.concat([Buffer.from('EGC1:'), Buffer.alloc(40, 7)]));
      fs.writeFileSync(path.join(stateDir, 'Projetos--empty.md'), '');
      fs.writeFileSync(path.join(stateDir, 'archive', 'old.md'), '# Project State\narchived copy\n');
      fs.writeFileSync(path.join(stateDir, 'budget-usage.json'), '{}');
      // A project directory this process cannot list is not a crash and
      // not a finding (root and privileged containers can still list it).
      const sealedDir = path.join(stateDir, 'Projetos--sealed-dir');
      fs.mkdirSync(sealedDir);
      fs.writeFileSync(path.join(sealedDir, 'main.md'), '# Project State\nhidden\n');
      if (process.platform !== 'win32') fs.chmodSync(sealedDir, 0o000);
      const plantedTarget = path.join(outside, 'secret.md');
      fs.writeFileSync(plantedTarget, '# not state\n');
      try {
        fs.symlinkSync(plantedTarget, path.join(stateDir, 'planted.md'));
      } catch {
        // Symlink creation needs a privilege on some Windows setups; the
        // rest of the test still proves the archive and empty cases.
      }

      const result = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      const canListSealed = (() => { try { fs.readdirSync(sealedDir); return true; } catch { return false; } })();
      if (canListSealed) {
        assert.ok(result.stdout.includes('Projetos--sealed-dir'), 'a privileged process lists the sealed directory like any other');
      } else {
        assert.ok(!result.stdout.includes('State files:'), 'nothing plain means no section at all');
        const json = JSON.parse(run(['--json'], { cwd: projectRoot, homeDir }).stdout);
        assert.strictEqual(json.plaintextStateFiles, undefined);
      }
    } finally {
      try { fs.chmodSync(path.join(homeDir, '.egc', 'state', 'Projetos--sealed-dir'), 0o700); } catch { /* already gone */ }
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(outside);
    }
  }));

  tally(test('never blocks on a FIFO planted as a state file and skips a file it cannot open', () => {
    if (process.platform === 'win32') return;
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const stateDir = path.join(homeDir, '.egc', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      execFileSync('mkfifo', [path.join(stateDir, 'pipe.md')]);
      const sealedOff = path.join(stateDir, 'sealed-off.md');
      fs.writeFileSync(sealedOff, '# Project State\nunreadable\n');
      fs.chmodSync(sealedOff, 0o000);
      const plain = path.join(stateDir, 'plain.md');
      fs.writeFileSync(plain, '# Project State\nreadable\n');

      const result = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
      const expected = asRoot ? 2 : 1;
      // The pipe is not a regular file, so the listing never counts it; the
      // sealed file is listed but cannot be opened, so it is not a finding.
      assert.ok(result.stdout.includes(`WARNING: ${expected} of 2 state files under ${stateDir} ${expected === 1 ? 'is' : 'are'} plain text:`), `unexpected report: ${result.stdout}`);
      assert.ok(result.stdout.includes(plain));
      assert.ok(!result.stdout.includes('pipe.md'));
    } finally {
      try { fs.chmodSync(path.join(homeDir, '.egc', 'state', 'sealed-off.md'), 0o600); } catch { /* already gone */ }
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('caps the plain-text listing and counts the rest', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const stateDir = path.join(homeDir, '.egc', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      for (let index = 0; index < 7; index++) {
        fs.writeFileSync(path.join(stateDir, `project-${index}.md`), `# Project State ${index}\n`);
      }

      const result = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('WARNING: 7 of 7 state files'));
      assert.ok(result.stdout.includes('    and 2 more'));
      const listed = result.stdout.split('\n').filter(line => /project-\d\.md \(last write /.test(line));
      assert.strictEqual(listed.length, 5, 'five paths shown, the rest summarised');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));


  tally(test('lists every tool whose config carries the EGC servers and probes each registered server (#1713)', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const servers = writeFakeServers(homeDir);
      writeJson(path.join(homeDir, '.cursor', 'mcp.json'), mcpServersConfig(servers.ok, servers.ok));
      fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
      writeJson(path.join(homeDir, '.claude.json'), mcpServersConfig(servers.ok, servers.ok));

      const result = run([], { cwd: projectRoot, homeDir, env: PROBE_ENV });
      assert.strictEqual(result.code, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('MCP registrations:'));
      assert.ok(result.stdout.includes('[OK] Cursor ('), result.stdout);
      assert.ok(result.stdout.includes('[OK] Claude Code (user scope) ('), result.stdout);
      assert.ok(result.stdout.includes('[OK] egc-guardian at ' + servers.ok + ': answers tools/list (2 tools) (registered in Claude Code (user scope), Cursor)'), result.stdout);
      assert.ok(result.stdout.includes('[OK] egc-memory at ' + servers.ok + ': answers tools/list (2 tools)'), result.stdout);
      assert.ok(result.stdout.includes('MCP summary: registrations=2, registered=2, servers=2, answering=2, warnings=0, errors=0'), result.stdout);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('a present tool without the EGC servers in its config, or without the config, is a warning that names egc init (#1713)', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      writeJson(path.join(homeDir, '.kiro', 'settings', 'mcp.json'), { mcpServers: { other: { command: 'x' } } });
      fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });

      const result = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('[WARNING] Kiro ('), result.stdout);
      assert.ok(result.stdout.includes('egc-guardian and egc-memory not registered here (egc init registers them; if they were, the tool rewrote its config)'), result.stdout);
      assert.ok(result.stdout.includes('[WARNING] Codex CLI ('), result.stdout);
      assert.ok(result.stdout.includes('no config with the EGC servers yet (run egc init)'), result.stdout);
      assert.ok(result.stdout.includes('MCP summary: registrations=2, registered=0, servers=0, answering=0, warnings=2, errors=0'), result.stdout);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('a server that exits, one that never answers and one whose path is gone are errors, each named (#1713)', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const servers = writeFakeServers(homeDir);
      const gone = path.join(homeDir, 'fake-servers', 'removed-by-update.js');
      writeJson(path.join(homeDir, '.cursor', 'mcp.json'), mcpServersConfig(servers.crash, servers.silent));
      writeJson(path.join(homeDir, '.augment', 'settings.json'), mcpServersConfig(gone, servers.ok));

      const result = run([], { cwd: projectRoot, homeDir, env: PROBE_ENV });
      assert.strictEqual(result.code, 1, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('[ERROR] egc-guardian at ' + servers.crash + ': exited with code 3 before answering: boot failed: no state dir'), result.stdout);
      assert.ok(result.stdout.includes('[ERROR] egc-memory at ' + servers.silent + ': no answer within ' + PROBE_TIMEOUT_MS + ' ms'), result.stdout);
      assert.ok(result.stdout.includes('[ERROR] egc-guardian at ' + gone + ': registered path does not exist (run egc init after an update)'), result.stdout);
      assert.ok(result.stdout.includes('[OK] egc-memory at ' + servers.ok + ': answers tools/list (2 tools) (registered in Auggie)'), result.stdout);
      assert.ok(result.stdout.includes('MCP summary: registrations=2, registered=2, servers=4, answering=1, warnings=0, errors=3'), result.stdout);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('a server that answers with a non-object line is an error naming the line, not a crash of the doctor (#1713)', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const dir = path.join(homeDir, 'fake-servers');
      fs.mkdirSync(dir, { recursive: true });
      const nullServer = path.join(dir, 'null-server.js');
      fs.writeFileSync(nullServer, "process.stdout.write('null\\n');\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n");
      writeJson(path.join(homeDir, '.cursor', 'mcp.json'), mcpServersConfig(nullServer, nullServer));

      const result = run([], { cwd: projectRoot, homeDir, env: PROBE_ENV });
      assert.strictEqual(result.code, 1, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('answered with an error: not a JSON-RPC message: null'), result.stdout);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('the probe starts a server the way the config registers it: command, arguments and environment (#1713)', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const dir = path.join(homeDir, 'fake-servers');
      fs.mkdirSync(dir, { recursive: true });
      const guarded = path.join(dir, 'guarded-server.js');
      fs.writeFileSync(guarded, "if (process.argv[2] !== 'serve' || process.env.EGC_FAKE_TOKEN !== 'on') {\n  process.stderr.write('launched without its registered arguments or environment');\n  process.exit(4);\n}\n" + OK_SERVER_SOURCE);
      const entry = { command: process.execPath, args: [guarded, 'serve'], env: { EGC_FAKE_TOKEN: 'on' } };
      writeJson(path.join(homeDir, '.cursor', 'mcp.json'), { mcpServers: { 'egc-guardian': entry, 'egc-memory': entry } });

      const result = run([], { cwd: projectRoot, homeDir, env: PROBE_ENV });
      assert.strictEqual(result.code, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('[OK] egc-guardian at ' + guarded + ': answers tools/list (2 tools)'), result.stdout);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('a registration whose first argument is not a script file is launched, not reported as a missing file (#1713)', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const servers = writeFakeServers(homeDir);
      const entry = { command: process.execPath, args: ['--no-warnings', servers.ok] };
      const bare = { command: 'egc-doctor-test-no-such-command' };
      writeJson(path.join(homeDir, '.cursor', 'mcp.json'), { mcpServers: { 'egc-guardian': entry, 'egc-memory': bare } });

      const result = run([], { cwd: projectRoot, homeDir, env: PROBE_ENV });
      assert.strictEqual(result.code, 1, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('[OK] egc-guardian at ' + process.execPath + ': answers tools/list'), result.stdout);
      assert.ok(result.stdout.includes('[ERROR] egc-memory at egc-doctor-test-no-such-command: exited with code none before answering'), result.stdout);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('Zed servers are read in the current flat form and in the legacy nested form (#1713)', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const servers = writeFakeServers(homeDir);
      writeJson(path.join(homeDir, '.config', 'zed', 'settings.json'), {
        context_servers: {
          'egc-guardian': { command: 'node', args: [servers.ok] },
          'egc-memory': { command: { path: 'node', args: [servers.ok] } },
        },
      });

      const result = run([], { cwd: projectRoot, homeDir, env: PROBE_ENV });
      assert.strictEqual(result.code, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('[OK] egc-guardian at ' + servers.ok), result.stdout);
      assert.ok(result.stdout.includes('[OK] egc-memory at ' + servers.ok), result.stdout);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('a config that does not parse is reported as unreadable, and --json carries the whole mcp section (#1713)', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const cursorConfig = path.join(homeDir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(cursorConfig), { recursive: true });
      fs.writeFileSync(cursorConfig, '{ "mcpServers": ');

      const result = run(['--json'], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 1, result.stdout + result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.mcp.registrations.length, 1);
      assert.strictEqual(parsed.mcp.registrations[0].name, 'Cursor');
      assert.strictEqual(parsed.mcp.registrations[0].status, 'unreadable');
      assert.ok(parsed.mcp.registrations[0].reason.includes('not valid JSON'), parsed.mcp.registrations[0].reason);
      assert.deepStrictEqual(parsed.mcp.servers, []);
      assert.strictEqual(parsed.mcp.errorCount, 1);
      assert.strictEqual(parsed.mcp.warningCount, 0);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  tally(test('a hook entry that left the config the tool reads is an error named by event and file, not drift (#1713)', () => {
    const homeDir = createTempDir('doctor-home-');
    const projectRoot = createTempDir('doctor-project-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const statePath = path.join(targetRoot, 'egc', 'install-state.json');
      const settingsPath = path.join(targetRoot, 'settings.json');
      const hookScriptPath = path.join(targetRoot, 'hooks', 'claude-session-start.js');
      fs.mkdirSync(path.dirname(hookScriptPath), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'hooks', 'claude-session-start.js'), hookScriptPath);
      writeJson(settingsPath, { hooks: {} });

      writeState(statePath, {
        adapter: { id: 'claude-home', target: 'claude', kind: 'home' },
        targetRoot,
        installStatePath: statePath,
        request: { profile: null, modules: [], legacyLanguages: [], legacyMode: true },
        resolution: { selectedModules: [], skippedModules: [] },
        operations: [
          {
            kind: 'copy-file',
            moduleId: 'claude-session-state-hook',
            sourceRelativePath: 'scripts/hooks/claude-session-start.js',
            destinationPath: hookScriptPath,
            strategy: 'preserve-relative-path',
            ownership: 'managed',
            scaffoldOnly: false,
          },
          {
            kind: 'merge-claude-settings-hooks',
            moduleId: 'claude-session-state-hook',
            sourceRelativePath: 'scripts/hooks/claude-session-start.js',
            destinationPath: settingsPath,
            strategy: 'merge-claude-settings-hooks',
            ownership: 'managed',
            scaffoldOnly: false,
            hookEvent: 'SessionStart',
            hookScriptPath,
          },
        ],
        source: { repoVersion: CURRENT_PACKAGE_VERSION, repoCommit: 'abc123', manifestVersion: CURRENT_MANIFEST_VERSION },
      });

      const result = run(['--target', 'claude'], { cwd: projectRoot, homeDir });
      assert.strictEqual(result.code, 1, result.stdout + result.stderr);
      assert.ok(result.stdout.includes('Status: ERROR'), result.stdout);
      assert.ok(result.stdout.includes("[error] missing-hook-entries: 1 hook entry EGC installed is absent from the config the tool reads (run 'egc repair' to put it back)"), result.stdout);
      assert.ok(!result.stdout.includes('drifted-managed-files'), 'a lost hook is not file drift');

      const asJson = run(['--target', 'claude', '--json'], { cwd: projectRoot, homeDir });
      const parsed = JSON.parse(asJson.stdout);
      const issue = parsed.results[0].issues.find(entry => entry.code === 'missing-hook-entries');
      assert.ok(issue, JSON.stringify(parsed.results[0].issues));
      assert.deepStrictEqual(issue.paths, ['SessionStart in ' + settingsPath]);
      assert.strictEqual(parsed.results[0].status, 'error');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
