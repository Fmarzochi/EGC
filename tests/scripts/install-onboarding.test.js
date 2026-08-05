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
const DASHBOARD_LAUNCHER = path.join(REPO_ROOT, 'scripts', 'lib', 'dashboard-launch-cli.js');

function test(name, fn) {
  try {
    const returned = fn();
    // A promise returned into this synchronous harness would be reported as
    // a pass before its assertions ran; async cases must use testAsync.
    assert.ok(!(returned && typeof returned.then === 'function'), 'async test body must be run through testAsync');
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
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

  // The fake node also stands in for the dashboard wrapper: the installer
  // now delegates the whole launch decision to it, so the fixture emulates
  // what the real wrapper prints in a headless environment (the CI=1 the
  // runner sets is exactly the case shouldAutoLaunch() declines).
  writeExecutable(path.join(binDir, 'node'), `#!/bin/sh
case "$1" in
  -e) printf '20' ;;
  --version) printf 'v20.0.0\\n' ;;
  *dashboard-launch-cli.js) printf "Dashboard not started (headless environment). Run 'egc dashboard' to start it.\\n" ;;
  *mcp-register-cli.js) printf "MCP-CLI-CWD:%s\\n" "$(pwd -P)" ;;
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
  // Without this stand-in, a machine that really has Claude Code on PATH
  // would have the suite register MCP servers into its own user scope.
  // Exit 0 means "already registered", so the installer performs no
  // mutation at all.
  writeExecutable(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');

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

async function runTests() {
  console.log('\n=== Testing install onboarding guidance ===\n');

  let passed = 0;
  let failed = 0;
  let sources;

  if (test('loads installer onboarding contract sources', () => {
    sources = {
      installApply: fs.readFileSync(INSTALL_APPLY, 'utf8'),
      bash: fs.readFileSync(INSTALL_SH, 'utf8'),
      powerShell: fs.readFileSync(INSTALL_PS1, 'utf8'),
      dashboardWrapper: fs.readFileSync(DASHBOARD_LAUNCHER, 'utf8'),
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

  if (test('bash and PowerShell delegate dashboard startup to the shared wrapper, after bare installs only', () => {
    // The launch/skip decision and its wording live in exactly one place;
    // the shells must not re-implement either.
    for (const message of DASHBOARD_MESSAGES) {
      assert.ok(sources.dashboardWrapper.includes(message), `dashboard-launch-cli.js missing: ${message}`);
      assert.ok(!sources.bash.includes(message), 'install.sh must not duplicate the wrapper wording');
      assert.ok(!sources.powerShell.includes(message), 'install.ps1 must not duplicate the wrapper wording');
    }
    assert.ok(sources.bash.includes(DASHBOARD_LAUNCHER_REF), 'install.sh must launch the dashboard through the shared CLI wrapper');
    assert.ok(sources.powerShell.includes(DASHBOARD_LAUNCHER_REF), 'install.ps1 must launch the dashboard through the shared CLI wrapper');
    assert.ok(sources.dashboardWrapper.includes('shouldAutoLaunch'), 'the wrapper owns the launch decision');
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

  if (test('bare Bash install merges an existing project .mcp.json from the invoking directory', () => {
    if (process.platform === 'win32') return;

    // The installer cd's to the package root early, so this only works when
    // the invoking directory is captured before that cd - the exact
    // regression this test pins.
    const fixture = createInstallerFixture();
    const projectDir = path.join(fixture.root, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
    const result = spawnSync(fixture.bash, [fixture.installScript], {
      cwd: projectDir,
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
    try {
      assertSuccessfulRun(result);
      // The shell's job is to hand the registration CLI the directory the
      // person invoked it from; the merge itself is covered by the
      // mcp-register unit tests.
      // realpath, because the installer captures the invoking directory
      // with `pwd -P`: on macOS a temp dir under /var is physically
      // /private/var, and comparing the two spellings would fail there
      // while passing on Linux.
      assert.ok(
        result.stdout.includes(`MCP-CLI-CWD:${fs.realpathSync(projectDir)}`),
        `the registration CLI must run from the invoking directory, got:\n${result.stdout}`
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('shouldAutoLaunch says yes exactly for an interactive, non-CI terminal', () => {
    // The interactive branch cannot be driven end to end without a pty (and
    // spawning a real dashboard plus a browser mid-test would be a side
    // effect no suite should have), so the decision itself is exercised
    // directly - this is the predicate install.sh and install.ps1 now
    // delegate to entirely.
    const { shouldAutoLaunch } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'dashboard-launch'));
    const savedTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const savedCI = process.env.CI;
    const withStdout = (isTTY, ci, assertion) => {
      Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
      if (ci === undefined) delete process.env.CI; else process.env.CI = ci;
      assertion();
    };
    try {
      withStdout(true, undefined, () => assert.strictEqual(shouldAutoLaunch(), true, 'a person at a terminal must get the dashboard'));
      withStdout(true, '1', () => assert.strictEqual(shouldAutoLaunch(), false, 'CI must stay headless even on a TTY'));
      withStdout(false, undefined, () => assert.strictEqual(shouldAutoLaunch(), false, 'piped output must stay headless'));
    } finally {
      if (savedTTY) Object.defineProperty(process.stdout, 'isTTY', savedTTY);
      if (savedCI === undefined) delete process.env.CI; else process.env.CI = savedCI;
    }
  })) passed++; else failed++;

  if (await testAsync('launchDashboard declines without spawning anything when the dashboard script is absent', async () => {
    const { launchDashboard } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'dashboard-launch'));
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-dashboard-root-'));
    const logged = [];
    try {
      const launched = await launchDashboard({ rootDir: emptyRoot, log: (line) => logged.push(line) });
      assert.strictEqual(launched, false, 'a missing dashboard script must not be treated as a launch');
      assert.deepStrictEqual(logged, [], 'nothing to say when there is nothing to launch');
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('the dashboard wrapper itself declines and explains in a headless environment', () => {
    // Runs the real wrapper (not a fixture stand-in) with stdout piped and
    // CI set: the branch every headless install takes, end to end.
    const wrapper = path.join(REPO_ROOT, 'scripts', 'lib', 'dashboard-launch-cli.js');
    const result = spawnSync(process.execPath, [wrapper, REPO_ROOT], {
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
      timeout: INSTALL_TIMEOUT_MS,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(
      result.stdout.trim(),
      "Dashboard not started (headless environment). Run 'egc dashboard' to start it.",
      'the wrapper owns the launch decision and must explain itself when it declines'
    );
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

runTests().catch((error) => {
  console.log(`  ✗ harness failure\n    ${error.stack || error.message}`);
  process.exit(1);
});