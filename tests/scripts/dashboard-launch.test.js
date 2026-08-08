/**
 * Tests for the dashboard first-launch honesty (#1233)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LAUNCHER = path.join(__dirname, '..', '..', 'scripts', 'lib', 'dashboard-launch.js');
const DASHBOARD_CLI = path.join(__dirname, '..', '..', 'scripts', 'dashboard.js');
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

function runTests() {
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

  if (test('launcher polls for readiness and reports a dead server honestly', () => {
    const source = fs.readFileSync(LAUNCHER, 'utf8');

    // The init/install path spawns the dashboard detached with its output
    // discarded; without a readiness poll, a server that dies during
    // startup leaves the success line as the last word while the port
    // refuses connections.
    assert.ok(/waitForDashboard\(/.test(source), 'launcher must poll the server after the detached spawn');
    assert.ok(
      source.includes('EGC Dashboard did not start.'),
      'a dead server must be reported, never implied running'
    );
    assert.ok(
      source.includes('See the startup error with:'),
      'the failure line must point at the foreground command that shows the real error'
    );
    assert.ok(
      !/setTimeout\(openBrowser/.test(source),
      'the browser must only open after readiness, not on a blind timer'
    );
  })) passed++; else failed++;

  if (test('dashboard CLI gates on dependency resolution and never npm-installs into an unwritable package dir', () => {
    const source = fs.readFileSync(DASHBOARD_CLI, 'utf8');

    assert.ok(
      /require\.resolve\(dep, \{ paths: \[DASHBOARD_DIR\] \}\)/.test(source),
      'deps must be checked by resolution (dashboard/ or package root), not by a node_modules directory existing'
    );
    assert.ok(
      !/existsSync\(nmDir\)/.test(source),
      'the old node_modules existence gate must be gone'
    );
    assert.ok(/W_OK/.test(source), 'the on-demand install must be gated on the directory being writable');
    assert.ok(
      source.includes('not writable'),
      'the unwritable case must be reported honestly instead of letting npm die with EACCES'
    );
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
