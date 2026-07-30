/**
 * Tests for install.ps1 wrapper delegation
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'install.ps1');
const BASH_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'install.sh');
const PACKAGE_JSON = path.join(__dirname, '..', '..', 'package.json');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function resolvePowerShellCommand() {
  const candidates = process.platform === 'win32'
    ? ['powershell.exe', 'pwsh.exe', 'pwsh']
    : ['pwsh'];

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });

    if (!result.error && result.status === 0) {
      return candidate;
    }
  }

  return null;
}

function run(powerShellCommand, args = [], options = {}) {
  const env = {
    ...process.env,
    HOME: options.homeDir || process.env.HOME,
    USERPROFILE: options.homeDir || process.env.USERPROFILE,
  };

  try {
    const stdout = execFileSync(powerShellCommand, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], {
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
  console.log('\n=== Testing install.ps1 ===\n');

  let passed = 0;
  let failed = 0;
  const powerShellCommand = resolvePowerShellCommand();

  if (test('publishes egc-install through the Node installer runtime for cross-platform npm usage', () => {
    const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    assert.strictEqual(packageJson.bin['egc-install'], 'scripts/install-apply.js');
  })) passed++; else failed++;

  const scriptSource = fs.readFileSync(SCRIPT, 'utf8');
  const bashSource = fs.readFileSync(BASH_SCRIPT, 'utf8');

  // Parity checks, not fixed numbers: install.ps1 has drifted from install.sh
  // before (stuck on a Node >= 18 floor and a bare npm install with no
  // lockfile/src guards after install.sh got those fixes). Reading install.sh's
  // actual current value here means the next drift fails CI on its own,
  // instead of silently shipping until someone happens to compare the two
  // files by hand again.
  if (test('Node version floor matches install.sh, not a stale hardcoded value', () => {
    const bashFloor = bashSource.match(/NODE_MAJOR"\s*-lt\s*(\d+)/);
    assert.ok(bashFloor, 'could not read the Node floor out of install.sh');
    const ps1Floor = scriptSource.match(/nodeVersion\s*-lt\s*(\d+)/);
    assert.ok(ps1Floor, 'could not read the Node floor out of install.ps1');
    assert.strictEqual(ps1Floor[1], bashFloor[1], 'install.ps1 Node floor must match install.sh');
  })) passed++; else failed++;

  if (test('installs dependencies via a lockfile-aware helper matching install.sh exactly (no npm install fallback)', () => {
    assert.ok(scriptSource.includes('function Install-Deps'), 'should define the lockfile-aware helper');
    assert.ok(scriptSource.includes('Test-Path "package-lock.json"'));
    assert.ok(scriptSource.includes('npm ci --silent'));
    // install.sh's install_deps has no else branch: a global install has
    // already resolved deps, so the no-lockfile case does nothing at all.
    // A "npm install --silent" fallback here would be a real behavioral
    // drift from install.sh, not a harmless equivalent.
    const bareInstallCalls = scriptSource.match(/npm install --silent/g) || [];
    assert.strictEqual(bareInstallCalls.length, 0, 'install.ps1 must not have any npm install fallback; install.sh has none either');
    const helperCalls = scriptSource.match(/^\s*Install-Deps\s*$/gm) || [];
    assert.strictEqual(helperCalls.length, 3, 'root, egc-guardian and egc-memory should each call Install-Deps');
  })) passed++; else failed++;

  if (test('skips (never overwrites) an existing MCP config that fails to parse as JSON', () => {
    // A pre-existing config with invalid JSON must be left untouched: the
    // default $obj = @{ mcpServers = @{} } falling through to the merge/
    // write path below would overwrite the user's real config with just
    // the two new servers, discarding everything else in the file.
    assert.ok(
      /catch\s*\{[^}]*is not valid JSON[^}]*return[^}]*\}/s.test(scriptSource),
      'the ConvertFrom-Json catch block must warn and return, not fall through to a merge/overwrite'
    );
  })) passed++; else failed++;

  if (test('escapes backslashes and quotes before writing a path into Codex CLI TOML', () => {
    // A raw Windows path (C:\Users\x\...) concatenated into a TOML basic
    // string is corrupted: TOML treats \U as the start of an 8-hex-digit
    // Unicode escape. Must mirror install.sh's tomlEscape.
    assert.ok(scriptSource.includes('tomlEscape'), 'Codex CLI TOML writer must escape paths via a tomlEscape helper');
    assert.ok(scriptSource.includes('tomlEscape(g)') && scriptSource.includes('tomlEscape(m)'), 'both guardian and memory TOML entries must go through tomlEscape');
  })) passed++; else failed++;

  if (test('only builds egc-guardian/egc-memory when src/ is present (published tarball has none)', () => {
    const buildGuards = scriptSource.match(/if \(Test-Path "src"\)/g) || [];
    assert.strictEqual(buildGuards.length, 2, 'both guardian and memory builds should be guarded');
    const bashGuards = bashSource.match(/if \[ -d src \]/g) || [];
    assert.strictEqual(buildGuards.length, bashGuards.length, 'install.ps1 and install.sh should guard the same number of builds');
  })) passed++; else failed++;

  if (test('installs the Token Crusher binary shim as a best-effort, non-fatal step', () => {
    assert.ok(
      scriptSource.includes('$CrusherShim = Join-Path (Join-Path $RootDir "scripts") "crusher-shim.js"'),
      'install.ps1 must invoke crusher-shim.js install so future downloads get the shim automatically'
    );
    assert.ok(
      /try\s*\{\s*node \$CrusherShim install/.test(scriptSource),
      'the crusher-shim install call must be wrapped so a failure never aborts the install'
    );
  })) passed++; else failed++;

  if (!powerShellCommand) {
    console.log('  - skipped delegation test; PowerShell is not available in PATH');
  } else if (test('delegates to the Node installer and preserves dry-run output', () => {
    const homeDir = createTempDir('install-ps1-home-');
    const projectDir = createTempDir('install-ps1-project-');

    try {
      const result = run(powerShellCommand, ['--target', 'cursor', '--dry-run', 'typescript'], {
        cwd: projectDir,
        homeDir,
      });

      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('Dry-run install plan'));
      assert.ok(!fs.existsSync(path.join(projectDir, '.cursor', 'hooks.json')));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (!powerShellCommand) {
    console.log('  - skipped help text test; PowerShell is not available in PATH');
  } else if (test('exposes the corrected Gemini target help text', () => {
    const result = run(powerShellCommand, ['--help']);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(
      result.stdout.includes('egc       (default) - Install EGC into ~/.gemini/'),
      'help text should describe the Gemini target as a full ~/.gemini install surface'
    );
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
