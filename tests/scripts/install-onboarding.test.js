/**
 * Regression checks for first-install guidance.
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const INSTALL_APPLY = path.join(REPO_ROOT, 'scripts', 'install-apply.js');
const INSTALL_SH = path.join(REPO_ROOT, 'scripts', 'install.sh');
const INSTALL_PS1 = path.join(REPO_ROOT, 'scripts', 'install.ps1');
const INSTALLATION_GUIDE = path.join(REPO_ROOT, 'docs', 'installation.md');
const INSTALL_TIMEOUT_MS = 2000;

const UV_MESSAGES = [
  'Optional dependency not found: uv',
  'Required only for Jira and omega-memory MCP servers.',
  'Core EGC installation is unaffected.',
];
// The README promises a live dashboard right after installation, so the
// bare-install contract is now: interactive terminals launch it through
// scripts/lib/dashboard-launch-cli.js, and headless runs (CI, pipes) print
// this honest line instead of pretending nothing was supposed to happen.
const DASHBOARD_MESSAGES = [
  "Dashboard not started (headless environment). Run 'egc dashboard' to start it.",
];
const DASHBOARD_LAUNCHER_REF = 'scripts/lib/dashboard-launch-cli.js';

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

function findExecutable(command) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) {
      // Keep searching PATH.
    }
  }
  return null;
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function createInstallerFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-install-onboarding-'));
  const scriptsDir = path.join(root, 'scripts');
  const binDir = path.join(root, 'bin');
  const homeDir = path.join(root, 'home');
  const installScript = path.join(scriptsDir, 'install.sh');

  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(INSTALL_SH, installScript);
  fs.chmodSync(installScript, 0o755);

  for (const server of ['egc-guardian', 'egc-memory']) {
    const buildDir = path.join(root, 'mcp', 'servers', server, 'build');
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, 'index.js'), '');
  }

  for (const command of ['cat', 'dirname', 'grep', 'uname']) {
    const executable = findExecutable(command);
    assert.ok(executable, `required test command not found: ${command}`);
    fs.symlinkSync(executable, path.join(binDir, command));
  }

  writeExecutable(path.join(binDir, 'node'), `#!/bin/sh
case "$1" in
  -e) printf '20' ;;
  --version) printf 'v20.0.0\\n' ;;
esac
exit 0
`);
  writeExecutable(path.join(binDir, 'npm'), `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '10.0.0\\n'
fi
exit 0
`);
  writeExecutable(path.join(binDir, 'npx'), '#!/bin/sh\nexit 0\n');

  const bash = findExecutable('bash');
  assert.ok(bash, 'bash is required for install.sh execution coverage');

  return { root, binDir, homeDir, installScript, bash };
}

function runBashInstaller(args = []) {
  const fixture = createInstallerFixture();
  const result = spawnSync(fixture.bash, [fixture.installScript, ...args], {
    cwd: fixture.root,
    env: {
      ...process.env,
      CI: '1',
      HOME: fixture.homeDir,
      USERPROFILE: fixture.homeDir,
      PATH: fixture.binDir,
    },
    encoding: 'utf8',
    timeout: INSTALL_TIMEOUT_MS,
  });

  return {
    result,
    cleanup: () => fs.rmSync(fixture.root, { recursive: true, force: true }),
  };
}

function assertSuccessfulRun(result) {
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, `installer failed:\n${result.stderr}\n${result.stdout}`);
  assert.ok(result.stdout.includes('Installation complete.'), 'installer did not reach completion');
}

function runTests() {
  console.log('\n=== Testing install onboarding guidance ===\n');

  let passed = 0;
  let failed = 0;
  let sources;

  if (test('loads installer onboarding contract sources', () => {
    sources = {
      installApply: fs.readFileSync(INSTALL_APPLY, 'utf8'),
      bash: fs.readFileSync(INSTALL_SH, 'utf8'),
      powerShell: fs.readFileSync(INSTALL_PS1, 'utf8'),
      guide: fs.readFileSync(INSTALLATION_GUIDE, 'utf8'),
    };
  })) passed++; else failed++;

  if (!sources) {
    console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
    process.exit(1);
  }

  if (test('bash and PowerShell label uv as optional and scoped', () => {
    for (const message of UV_MESSAGES) {
      assert.ok(sources.bash.includes(message), `install.sh missing: ${message}`);
      assert.ok(sources.powerShell.includes(message), `install.ps1 missing: ${message}`);
    }
  })) passed++; else failed++;

  if (test('bash and PowerShell explain dashboard startup after bare installs only', () => {
    for (const message of DASHBOARD_MESSAGES) {
      assert.ok(sources.bash.includes(message), `install.sh missing: ${message}`);
      assert.ok(sources.powerShell.includes(message), `install.ps1 missing: ${message}`);
    }
    assert.ok(sources.bash.includes(DASHBOARD_LAUNCHER_REF), 'install.sh must launch the dashboard through the shared CLI wrapper');
    assert.ok(sources.powerShell.includes('scripts/lib/dashboard-launch-cli.js'), 'install.ps1 must launch the dashboard through the shared CLI wrapper');
    assert.ok(sources.bash.includes('if [ "$_has_install_args" = false ]; then'));
    assert.ok(sources.powerShell.includes('if (-not $hasInstallArgs)'));
  })) passed++; else failed++;

  if (test('bare Bash install emits onboarding notices at runtime', () => {
    if (process.platform === 'win32') return;

    const { result, cleanup } = runBashInstaller();
    try {
      assertSuccessfulRun(result);
      for (const message of [...UV_MESSAGES, ...DASHBOARD_MESSAGES]) {
        assert.ok(result.stdout.includes(message), `bare install output missing: ${message}`);
      }
    } finally {
      cleanup();
    }
  })) passed++; else failed++;

  if (test('Bash install arguments suppress the bare-install dashboard notice', () => {
    if (process.platform === 'win32') return;

    const { result, cleanup } = runBashInstaller(['--target', 'codex']);
    try {
      assertSuccessfulRun(result);
      for (const message of DASHBOARD_MESSAGES) {
        assert.ok(!result.stdout.includes(message), `argument install should omit: ${message}`);
      }
    } finally {
      cleanup();
    }
  })) passed++; else failed++;

  if (test('delegating installer does not duplicate wrapper guidance', () => {
    for (const message of [...UV_MESSAGES, ...DASHBOARD_MESSAGES]) {
      assert.ok(!sources.installApply.includes(message), `install-apply.js should not repeat: ${message}`);
    }
  })) passed++; else failed++;

  if (test('installation guide explains the three setup stages', () => {
    assert.ok(sources.guide.includes('## Installation lifecycle'));
    assert.ok(sources.guide.includes('### 1. Bare install'));
    assert.ok(sources.guide.includes('### 2. Project setup'));
    assert.ok(sources.guide.includes('### 3. Full profile'));
    assert.ok(sources.guide.includes('egc install --target <target> --profile full'));
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();