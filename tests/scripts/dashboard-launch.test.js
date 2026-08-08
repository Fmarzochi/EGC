/**
 * Tests for the dashboard first-launch honesty (#1233)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const LAUNCHER = path.join(__dirname, '..', '..', 'scripts', 'lib', 'dashboard-launch.js');
const DASHBOARD_CLI = path.join(__dirname, '..', '..', 'scripts', 'dashboard.js');
const DEPS_HELPER = path.join(__dirname, '..', '..', 'scripts', 'lib', 'dashboard-deps.js');
const ROOT_PACKAGE = path.join(__dirname, '..', '..', 'package.json');
const DASHBOARD_PACKAGE = path.join(__dirname, '..', '..', 'dashboard', 'package.json');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function runTests() {
  console.log('\n=== Testing dashboard first-launch honesty ===\n');

  let passed = 0;
  let failed = 0;

  if (test('root package.json ships every dashboard dependency (#1233)', () => {
    const rootPkg = JSON.parse(fs.readFileSync(ROOT_PACKAGE, 'utf8'));
    const dashPkg = JSON.parse(fs.readFileSync(DASHBOARD_PACKAGE, 'utf8'));

    // A global `npm install -g @egchq/egc` installs only the root
    // dependencies, and dashboard/server.js resolves its requires walking
    // up from dashboard/. Any dashboard dependency missing at the root
    // forces the first launch into an on-demand npm install inside the
    // package directory, which dies with EACCES on a root-owned prefix.
    for (const dep of Object.keys(dashPkg.dependencies || {})) {
      assert.ok(
        rootPkg.dependencies && rootPkg.dependencies[dep],
        `root package.json must ship dashboard dependency ${dep}`
      );
    }
  })) passed++; else failed++;

  if (test('both the CLI and the launcher gate through the shared dependency helper', () => {
    const launcherSource = fs.readFileSync(LAUNCHER, 'utf8');
    const cliSource = fs.readFileSync(DASHBOARD_CLI, 'utf8');
    const helperSource = fs.readFileSync(DEPS_HELPER, 'utf8');

    // One source of truth: the dependency list comes from
    // dashboard/package.json via scripts/lib/dashboard-deps.js, never a
    // hardcoded array that can drift from the manifest, and the
    // writability probe lives in the helper so both callers see it.
    assert.ok(cliSource.includes("require(path.join(__dirname, 'lib', 'dashboard-deps'))"), 'dashboard.js must use the shared deps helper');
    assert.ok(launcherSource.includes("require(path.join(__dirname, 'dashboard-deps'))"), 'dashboard-launch.js must use the shared deps helper');
    assert.ok(!/\[\s*'express'\s*,\s*'ws'\s*\]/.test(cliSource), 'no hardcoded dependency list may remain');
    assert.ok(/W_OK/.test(helperSource), 'the writability probe must live in the shared helper');
    assert.ok(cliSource.includes('not writable'), 'the unwritable case must be reported honestly');
    assert.ok(cliSource.includes('manifest missing or unreadable'), 'a broken manifest must produce a clear message, not a raw stack trace');
  })) passed++; else failed++;

  if (test('launcher widens the poll budget only when an install can actually run', () => {
    const source = fs.readFileSync(LAUNCHER, 'utf8');

    assert.ok(/waitForDashboard\(/.test(source), 'launcher must poll the server after the detached spawn');
    assert.ok(source.includes('did not respond within'), 'a dead server must be reported without claiming a false verdict');
    assert.ok(source.includes('See the startup error with:'), 'the failure line must point at the foreground command');
    assert.ok(!/setTimeout\(openBrowser/.test(source), 'the browser must only open after readiness, not on a blind timer');
    // The 60s budget exists for a real on-demand install (writable
    // checkout). In the unwritable #1233 scenario the child refuses within
    // a second, so the launcher must keep the short budget there instead
    // of stalling a minute before the honest failure line.
    assert.ok(/missing\.length > 0 && depsReport\.writable/.test(source), 'the long budget must require the directory to be writable');
    assert.ok(/60000/.test(source) && /4000/.test(source), 'both budgets must exist');
  })) passed++; else failed++;

  if (test('checkDashboardDeps reports resolvable, missing, broken-manifest, and writability states', () => {
    const { checkDashboardDeps } = require(DEPS_HELPER);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-dash-deps-'));
    try {
      // Broken manifest: no package.json at all.
      const broken = checkDashboardDeps(tmp);
      assert.ok(broken.manifestError, 'a missing manifest must surface as manifestError');
      assert.deepStrictEqual(broken.deps, [], 'no deps can be known without a manifest');
      assert.strictEqual(broken.writable, true, 'a fresh tmpdir must probe as writable');

      // Unresolvable dependency.
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        dependencies: { 'egc-test-dep-that-cannot-exist': '1.0.0' },
      }));
      const missing = checkDashboardDeps(tmp);
      assert.strictEqual(missing.manifestError, null);
      assert.deepStrictEqual(missing.missing, ['egc-test-dep-that-cannot-exist']);

      // Empty dependencies resolve trivially.
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ dependencies: {} }));
      const clean = checkDashboardDeps(tmp);
      assert.deepStrictEqual(clean.missing, []);

      // Unwritable directory (POSIX only: chmod cannot revoke directory
      // write access on Windows, matching how install-sh.test.js skips;
      // also skipped as root, which bypasses the W_OK probe entirely, so
      // the case would fail in root-running Docker/CI).
      if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
        fs.chmodSync(tmp, 0o555);
        try {
          const readonly = checkDashboardDeps(tmp);
          assert.strictEqual(readonly.writable, false, 'a read-only directory must probe as not writable');
        } finally {
          fs.chmodSync(tmp, 0o755);
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // Behavioral coverage of the poll itself (PR #1234 review): the positive
  // case binds port 0 and keeps that server ALIVE while waitForDashboard
  // runs against it (no release-and-rebind race); the negative case then
  // reuses the port only after the server is closed.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ts":0}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const livePort = server.address().port;

  process.env.EGC_PORT = String(livePort);
  delete require.cache[require.resolve(LAUNCHER)];
  delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'dashboard', 'port'))];
  const { waitForDashboard } = require(LAUNCHER);

  if (await asyncTest('waitForDashboard resolves true while the server answers /ping', async () => {
    assert.strictEqual(await waitForDashboard(2000), true);
  })) passed++; else failed++;

  await new Promise(resolve => server.close(resolve));

  if (await asyncTest('waitForDashboard resolves false once nothing listens within the budget', async () => {
    const started = Date.now();
    assert.strictEqual(await waitForDashboard(700), false);
    assert.ok(Date.now() - started >= 600, 'the poll must keep trying until the budget is spent');
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
