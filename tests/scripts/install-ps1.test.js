/**
 * Tests for install.ps1 wrapper delegation
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { CLI_TIMEOUT_MS, FULL_INSTALL_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

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
      timeout: CLI_TIMEOUT_MS,
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
      // Full-install budget from the shared fixture: a PowerShell dry-run
      // spawns the whole Node planning pipeline, and 30s starved slow
      // Windows runners (the tag-run failure of v1.1.19: pwsh killed by
      // timeout, exit 1 with empty stderr).
      timeout: FULL_INSTALL_TIMEOUT_MS,
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

  if (test('prompt-library counts match install.sh and the README catalog numbers', () => {
    const countsOf = (source, label) => {
      const m = source.match(/Install prompt library\? \((\d+) agents, (\d+) skills, (\d+) commands\)/);
      assert.ok(m, `could not read the prompt-library counts out of ${label}`);
      return m.slice(1, 4);
    };
    const ps1Counts = countsOf(scriptSource, 'install.ps1');
    const bashCounts = countsOf(bashSource, 'install.sh');
    assert.deepStrictEqual(ps1Counts, bashCounts, 'install.ps1 counts must match install.sh');
    const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
    const readmeCounts = readme.match(/(\d+) agents, (\d+) skills, and (\d+) commands/);
    assert.ok(readmeCounts, 'could not read the catalog counts out of README.md');
    assert.deepStrictEqual(ps1Counts, readmeCounts.slice(1, 4), 'installer counts must match the README; they sat at 62/228/74 while the README shipped 61/230/77');
  })) passed++; else failed++;

  if (test('prompt-library gate treats redirected stdin as non-interactive and survives a null Read-Host', () => {
    // Through `egc install`, stdin reaches this script as a pipe:
    // [Environment]::UserInteractive stays true there, Read-Host returns
    // $null immediately, and `$null -eq ''` is false in PowerShell, so the
    // ecosystem block used to vanish without a word (Windows report in
    // #1217 left install-state at the previous version).
    const gateLine = scriptSource.match(/\$isInteractive\s*=.*/);
    assert.ok(gateLine, 'could not find the interactivity gate in install.ps1');
    assert.ok(gateLine[0].includes('[Console]::IsInputRedirected'), 'the gate must test IsInputRedirected; UserInteractive alone cannot see a piped stdin');
    assert.ok(scriptSource.includes('[string]::IsNullOrEmpty($ans)'), 'the default-Y branch must accept a null Read-Host result, not just the empty string');
    assert.ok(scriptSource.includes('skipping the prompt-library step'), 'install.ps1 must announce the skip instead of vanishing silently');
    assert.ok(bashSource.includes('skipping the prompt-library step'), 'install.sh must announce the skip too');
  })) passed++; else failed++;

  if (test('probes the native sqlite3 binary EGC actually depends on, as a note rather than a warning', () => {
    assert.ok(!scriptSource.includes('better-sqlite3 native module unavailable'), 'install.ps1 must not warn about better-sqlite3, which EGC no longer uses');
    assert.ok(!/require\('better-sqlite3'\)/.test(scriptSource), 'install.ps1 must not probe better-sqlite3');
    assert.ok(scriptSource.includes('check-native-sqlite.js'), 'install.ps1 must probe sqlite3 through scripts/check-native-sqlite.js');
    assert.ok(bashSource.includes('check-native-sqlite.js'), 'install.sh must run the same probe');
    for (const source of [scriptSource, bashSource]) {
      assert.ok(source.includes('native sqlite3 unavailable on this machine; EGC uses its portable engine'), 'both installers print the same portable-engine note');
    }
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

  if (test('handles a read-only package directory the way install.sh does (dependency check, loud npm ci failure, guarded convenience copy)', () => {
    assert.ok(scriptSource.includes('function Test-DirectoryWritable'), 'install.ps1 must probe directory writability');
    assert.ok(scriptSource.includes('check-mcp-deps.js'), 'a read-only directory must be checked against the package root');
    assert.ok(bashSource.includes('check-mcp-deps.js'), 'install.sh must run the same check');
    assert.ok(/npm ci --silent\s*\n\s*if \(\$LASTEXITCODE -ne 0\)/.test(scriptSource), 'an npm ci failure must be reported, not swallowed');
    assert.ok(scriptSource.includes('dependencies provided by the package root'), 'the read-only note must match install.sh');
    assert.ok(bashSource.includes('dependencies provided by the package root'));
    assert.ok(/if \(Test-DirectoryWritable \$RootDir\) \{\s*\n\s*\$mcpConfig \| Set-Content/.test(scriptSource), 'the .mcp.egc.json copy must be guarded by a writability check');
    assert.ok(scriptSource.includes('skipping the .mcp.egc.json convenience copy'));
    assert.ok(bashSource.includes('skipping the .mcp.egc.json convenience copy'));
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

  if (test('delegates MCP registration to the shared CLI instead of keeping its own copy of the list', () => {
    // Both installers and `egc init` now read one list, so Continue.dev and
    // Zed cannot silently go unregistered on the shell path again, and the
    // Codex TOML escaping this test used to police lives with the writer
    // itself (registerToml/tomlEscape in scripts/lib/mcp-register.js,
    // covered by tests/lib/mcp-register.test.js).
    assert.ok(
      scriptSource.includes('scripts/lib/mcp-register-cli.js'),
      'install.ps1 must register MCP servers through the shared CLI'
    );
    assert.ok(
      !scriptSource.includes('[[mcp_servers]]'),
      'install.ps1 must not carry its own TOML writer any more'
    );
    assert.ok(
      !bashSource.includes('[[mcp_servers]]'),
      'install.sh must not carry its own TOML writer any more'
    );
  })) passed++; else failed++;

  if (test('only builds egc-guardian/egc-memory when src/ is present (published tarball has none)', () => {
    const buildGuards = scriptSource.match(/if \(Test-Path "src"\)/g) || [];
    assert.strictEqual(buildGuards.length, 2, 'both guardian and memory builds should be guarded');
    const bashGuards = bashSource.match(/if \[\[ -d src \]\]/g) || [];
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

  if (test('skips npm link from the global npm install, matching install.sh (#1218)', () => {
    // Same guard as install.sh: running `egc install` from the globally
    // installed package must not attempt npm link (redundant there, and it
    // fails with a note about a nonexistent checkout when the prefix is not
    // writable). Parity-checked so the two installers cannot drift.
    for (const [label, source] of [['install.ps1', scriptSource], ['install.sh', bashSource]]) {
      assert.ok(/npm root -g/.test(source), `${label} must locate the global npm package root`);
      assert.ok(
        source.includes('already provided by the global npm install'),
        `${label} must announce the skip instead of linking`
      );
      assert.ok(
        source.indexOf('npm root -g') < source.indexOf('npm link --silent'),
        `${label} must guard before attempting npm link`
      );
      assert.ok(/npm link --silent/.test(source), `${label} must still link on the checkout path`);
    }
    assert.ok(
      scriptSource.includes('(Resolve-Path $GlobalPkgDir).Path -eq (Resolve-Path $RootDir).Path'),
      'install.ps1 must compare resolved paths, not raw strings'
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
