/**
 * Tests for install.sh wrapper delegation
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'install.sh');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function run(args = [], options = {}) {
  const env = {
    ...process.env,
    HOME: options.homeDir || process.env.HOME,
  };

  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
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
  console.log('\n=== Testing install.sh ===\n');

  let passed = 0;
  let failed = 0;

  if (process.platform === 'win32') {
    console.log('  - skipped on Windows; install.ps1 covers the native wrapper path');
    console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
    process.exit(0);
  }

  if (test('delegates to the Node installer and preserves dry-run output', () => {
    const homeDir = createTempDir('install-sh-home-');
    const projectDir = createTempDir('install-sh-project-');

    try {
      const result = run(['--target', 'cursor', '--dry-run', 'typescript'], {
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

  if (test('exposes the corrected Gemini target help text', () => {
    const result = run(['--help']);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(
      result.stdout.includes('egc       (default) - Install EGC into ~/.gemini/'),
      'help text should describe the Gemini target as a full ~/.gemini install surface'
    );
  })) passed++; else failed++;

  if (test('install stays a pinned npm ci with shipped lockfiles (regression #643 + Scorecard #322)', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');
    const repoRoot = path.join(__dirname, '..', '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

    // A clean `npm install -g @egchq/egc` + `egc install` unpacks a tarball where
    // npm has stripped the root package-lock.json (its deps are already resolved by
    // the global install). The sub-package lockfiles travel via package.json
    // "files", so install_deps runs a pinned `npm ci` wherever a lockfile is
    // present and never falls back to an unpinned `npm install` (which tripped
    // Scorecard pinned dependencies and Sonar S6505).
    assert.ok(
      /install_deps\s*\(\)\s*\{/.test(script),
      'install.sh must define an install_deps helper'
    );
    assert.ok(/npm ci/.test(script), 'install_deps must install with npm ci');
    assert.ok(
      !/^\s*npm install\b/m.test(script),
      'install.sh must not run npm install (unpinned): use npm ci so supply-chain pinning checks pass'
    );

    // The published package ships build/ but not src/, so the TypeScript build
    // must be guarded by a src/ presence check.
    assert.ok(
      /if\s+\[\[\s+-d\s+src\s+\]\]/.test(script),
      'npm run build must be guarded by an "if [[ -d src ]]" check'
    );

    // The sub-package lockfiles must be published so `npm ci` finds them post-install.
    for (const f of [
      'mcp/servers/egc-guardian/package-lock.json',
      'mcp/servers/egc-memory/package-lock.json'
    ]) {
      assert.ok(pkg.files.includes(f), `package.json "files" must publish ${f}`);
    }
  })) passed++; else failed++;

  if (test('gates on Node 20 and never fakes a config skip', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');

    // The bash Node gate must match package.json "engines" (>=20) and
    // scripts/preinstall.js, not the old >=18 floor that let 18/19 reach the
    // better-sqlite3 and TypeScript build steps.
    assert.ok(
      /"\$NODE_MAJOR"\s*-lt\s+20/.test(script),
      'install.sh must reject Node < 20 to match package.json engines and preinstall.js'
    );
    assert.ok(
      !/"\$NODE_MAJOR"\s*-lt\s+18/.test(script),
      'install.sh must not still gate on the old Node 18 floor'
    );

    // A pre-existing config that is not valid JSON must be skipped with an
    // honest note, never reported as a successful registration. install.sh
    // delegates that to the registration CLI now, so the behavior is
    // exercised there for real: a broken Cursor config in a throwaway HOME
    // must produce a skip note and come back byte-for-byte unchanged.
    const home = createTempDir('egc-install-badjson-');
    // Hermetic on purpose: an empty PATH means no PATH-gated target can
    // fire, so this never touches a real claude/cursor/kiro/codex on the
    // machine running the suite and the output does not vary by host. The
    // only target that opens is the Cursor config seeded below, which is
    // exactly the one under test. process.execPath runs the CLI directly,
    // so node itself does not need to be on PATH.
    const emptyBin = createTempDir('egc-install-nopath-');
    try {
      const cursorConfig = path.join(home, '.cursor', 'mcp.json');
      const broken = '{ "mcpServers": { oops';
      fs.mkdirSync(path.dirname(cursorConfig), { recursive: true });
      fs.writeFileSync(cursorConfig, broken);

      const out = execFileSync(
        process.execPath,
        [path.join(__dirname, '..', '..', 'scripts', 'lib', 'mcp-register-cli.js'), '/tmp/guardian.js', '/tmp/memory.js'],
        { env: { ...process.env, HOME: home, USERPROFILE: home, PATH: emptyBin }, encoding: 'utf8', cwd: home }
      );

      assert.ok(
        /note: skipped Cursor[\s\S]*is not valid JSON/.test(out),
        `an unparseable config must be reported as skipped, got:\n${out}`
      );
      assert.ok(
        !/registered in Cursor/.test(out),
        `an unparseable config must never be reported as registered, got:\n${out}`
      );
      assert.strictEqual(fs.readFileSync(cursorConfig, 'utf8'), broken, 'the broken file must be left untouched');
    } finally {
      cleanup(home);
      cleanup(emptyBin);
    }
  })) passed++; else failed++;

  if (test('MCP config paths are Windows-native under Git Bash, not the POSIX mount form', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');

    // Under Git Bash/MSYS on Windows, $ROOT_DIR is a POSIX mount path
    // (/c/Users/x/EGC) that bash understands but a native Windows MCP
    // client's own node.exe (Claude Desktop, Cursor, etc. run outside Git
    // Bash) cannot resolve. Any path written into an MCP config JSON must
    // use the Windows-native form (`pwd -W`, MSYS's coreutils extension),
    // detected via `uname -s` so Linux/macOS keep using $ROOT_DIR unchanged.
    assert.ok(
      /MINGW\*\|MSYS\*/.test(script),
      'install.sh must detect Git Bash/MSYS via uname -s'
    );
    assert.ok(
      /pwd -W/.test(script),
      'install.sh must compute the Windows-native root via pwd -W on Git Bash'
    );
    assert.ok(
      script.includes('GUARDIAN_BIN="$MCP_ROOT_DIR'),
      'GUARDIAN_BIN must use the Windows-native root, not the POSIX $ROOT_DIR'
    );
    assert.ok(
      script.includes('MEMORY_BIN="$MCP_ROOT_DIR'),
      'MEMORY_BIN must use the Windows-native root, not the POSIX $ROOT_DIR'
    );
    assert.ok(
      script.includes('"$MCP_ROOT_DIR/mcp/servers/egc-guardian/build/index.js"]') &&
      script.includes('"$MCP_ROOT_DIR/mcp/servers/egc-memory/build/index.js"]'),
      '.mcp.egc.json must write the Windows-native root, not the POSIX $ROOT_DIR'
    );
  })) passed++; else failed++;

  if (test('installs the Token Crusher binary shim as a best-effort, non-fatal step', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');

    assert.ok(
      /node "\$ROOT_DIR\/scripts\/crusher-shim\.js" install/.test(script),
      'install.sh must invoke crusher-shim.js install so future downloads get the shim automatically'
    );
    assert.ok(
      /crusher-shim\.js" install \|\|/.test(script),
      'the crusher-shim install call must be wired with a || fallback so a failure never aborts the install'
    );
  })) passed++; else failed++;

  if (test('skips npm link when running from the global npm install (#1218)', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');

    // `egc install` after `npm install -g @egchq/egc` runs this script from
    // inside the global npm prefix: the egc bin on PATH already points at
    // this tree, so npm link is redundant there, and with a root-owned
    // prefix (distro Node) it fails and prints a note about a checkout the
    // person does not have. The guard must compare the resolved global
    // package dir against ROOT_DIR before ever attempting the link.
    assert.ok(
      /npm root -g/.test(script),
      'install.sh must locate the global npm package root for the guard'
    );
    assert.ok(
      script.includes('@egchq/egc'),
      'the guard must target the published package directory'
    );
    assert.ok(
      script.indexOf('npm root -g') < script.indexOf('npm link --silent'),
      'the global-install guard must run before npm link'
    );
    assert.ok(
      /npm link --silent/.test(script),
      'the git-checkout path must still link the egc command'
    );
    assert.ok(
      script.includes('already provided by the global npm install'),
      'the skip must be announced, not silent'
    );
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
