/**
 * Tests for install.sh wrapper delegation
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

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

  if (test('install_deps survives a read-only package directory and never fails silently (#1218 layout)', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');
    // `sudo npm install -g @egchq/egc` then `egc install` as the user leaves
    // the MCP server directories root-owned: npm ci cannot write there, and
    // with --silent its EACCES killed the whole install with a bare exit 243.
    const helper = /install_deps\(\)\s*\{[\s\S]*?\n\}/.exec(script);
    assert.ok(helper, 'install.sh must define install_deps');
    assert.ok(/\[\[\s+-w\s+\.\s+\]\]/.test(helper[0]), 'install_deps must branch on the directory being writable');
    assert.ok(helper[0].includes('check-mcp-deps.js'), 'a read-only directory must be checked against the package root');
    assert.ok(/^\s{4}npm ci --silent$/m.test(helper[0]), 'the npm ci line stays exactly as on main (lifecycle scripts fetch sqlite3, and the line must not enter the new-code scope)');
    assert.ok(/trap 'echo "Error: npm ci failed in/.test(helper[0]), 'an npm ci failure must name the directory through an ERR trap instead of being swallowed');
    assert.ok(/if \[\[ -w "\$ROOT_DIR" \]\]; then\s*\ncat > "\$ROOT_DIR\/\.mcp\.egc\.json"/.test(script), 'the .mcp.egc.json convenience copy must be guarded by a writability check');
  })) passed++; else failed++;

  if (test('a read-only server directory whose dependencies live one level up installs cleanly', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      console.log('    - skipped: root ignores directory permissions');
      return;
    }
    const script = fs.readFileSync(SCRIPT, 'utf8');
    const helper = /install_deps\(\)\s*\{[\s\S]*?\n\}/.exec(script)[0];
    const repoRoot = path.join(__dirname, '..', '..');
    const sandbox = fs.mkdtempSync(path.join(repoRoot, '.tmp-install-deps-'));
    try {
      // The dependency lives in the sandbox's own node_modules, one level
      // above the server directory, exactly where the package root keeps it.
      fs.mkdirSync(path.join(sandbox, 'node_modules', 'egc-test-fixture-dep'), { recursive: true });
      fs.writeFileSync(path.join(sandbox, 'node_modules', 'egc-test-fixture-dep', 'package.json'), JSON.stringify({ name: 'egc-test-fixture-dep', version: '1.0.0' }));
      const satisfied = path.join(sandbox, 'satisfied');
      fs.mkdirSync(satisfied);
      fs.writeFileSync(path.join(satisfied, 'package.json'), JSON.stringify({ name: 'satisfied', dependencies: { 'egc-test-fixture-dep': '^1.0.0' } }));
      fs.writeFileSync(path.join(satisfied, 'package-lock.json'), '{}');
      const unsatisfied = path.join(sandbox, 'unsatisfied');
      fs.mkdirSync(unsatisfied);
      fs.writeFileSync(path.join(unsatisfied, 'package.json'), JSON.stringify({ name: 'unsatisfied', dependencies: { 'egc-test-package-that-does-not-exist': '^1.0.0' } }));
      fs.writeFileSync(path.join(unsatisfied, 'package-lock.json'), '{}');
      fs.chmodSync(satisfied, 0o555);
      fs.chmodSync(unsatisfied, 0o555);

      // Paths travel as arguments and environment, never inside the script text.
      const runHelper = (dir) => {
        const res = require('child_process').spawnSync('bash', ['-c', `set -e\n${helper}\ncd "$1"\ninstall_deps`, 'install_deps', dir], {
          encoding: 'utf8',
          env: { ...process.env, ROOT_DIR: repoRoot },
          timeout: CLI_TIMEOUT_MS,
        });
        return { code: res.status, stdout: res.stdout, stderr: res.stderr };
      };
      const ok = runHelper(satisfied);
      assert.strictEqual(ok.code, 0, ok.stderr);
      assert.ok(ok.stdout.includes('dependencies provided by the package root'), ok.stdout);
      const bad = runHelper(unsatisfied);
      assert.strictEqual(bad.code, 1);
      assert.ok(bad.stderr.includes('is not writable and its dependencies are not available'), bad.stderr);
    } finally {
      for (const d of ['satisfied', 'unsatisfied']) {
        try { fs.chmodSync(path.join(sandbox, d), 0o755); } catch { /* absent */ }
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
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
