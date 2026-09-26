'use strict';
/**
 * The Bash guardian hook, the fact-forcing gate and the PreCompact memory
 * save are copied into each target on their own, next to the helpers they
 * require when they load. A helper left out of a target's copy list fails
 * the hook with MODULE_NOT_FOUND on that user's machine only. This plans
 * every target with no modules selected (the copies each target makes by
 * itself) and with the minimal profile, lays those copies out in a scratch
 * home and loads each hook from there in a process of its own.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { listInstallTargetAdapters, planInstallTargetScaffold } = require('../../scripts/lib/install-targets/registry');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const REPO_ROOT = path.join(__dirname, '..', '..');
const HOOKS = new Set([
  'scripts/hooks/pre-bash-guardian-validate.js',
  'scripts/hooks/gateguard-fact-force.js',
  'scripts/hooks/egc-memory-save.js',
]);
// Scripts that only run from the package itself (egc auto-update runs the
// package's own copy), so a target never receives one.
const PACKAGE_ONLY_SCRIPTS = new Set(['scripts/auto-update.js']);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifests', 'install-modules.json'), 'utf8'));
const PROFILES = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifests', 'install-profiles.json'), 'utf8'));

// The minimal profile's modules that apply to a target, as the installer
// resolves them.
function minimalModulesFor(target) {
  const ids = new Set(PROFILES.profiles.minimal.modules);
  return MANIFEST.modules.filter(module => ids.has(module.id) && (module.targets || []).includes(target));
}

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

// Every file or directory the target copies, laid out where it would land.
function layOut(plan) {
  for (const operation of plan.operations) {
    if (operation.kind !== 'copy-path' || !operation.sourceRelativePath || !operation.destinationPath) continue;
    const source = path.join(REPO_ROOT, operation.sourceRelativePath);
    fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });
    fs.cpSync(source, operation.destinationPath, { recursive: true });
  }
}

function loadFailure(hookPath, home) {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(hookPath)})`], {
    cwd: home,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  if (result.status === 0) return null;
  return (result.stderr || result.error?.message || `exit ${result.status}`).split('\n').find(line => line.trim()) || 'failed to load';
}

console.log('\n=== Testing the helpers copied with the Bash guardian hook and the fact-forcing gate ===\n');

const targets = [...new Set(listInstallTargetAdapters().map(adapter => adapter.target))];
let loaded = 0;
run('the targets are listed', () => assert.ok(targets.length > 10, targets.join(' ')));
for (const target of targets) {
  for (const [label, modules] of [['its own copies', []], ['the minimal profile', minimalModulesFor(target)]]) {
    run(`${target}, ${label}: each hook it copies loads with the helpers copied next to it`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), `egc-hook-helpers-${target}-`));
      try {
        const plan = planInstallTargetScaffold({ target, repoRoot: REPO_ROOT, projectRoot: home, homeDir: home, modules });
        layOut(plan);
        const copies = plan.operations.filter(op => op.kind === 'copy-path');
        const hooks = copies.filter(op => HOOKS.has(op.sourceRelativePath));
        const failures = hooks.map(op => [op.sourceRelativePath, loadFailure(op.destinationPath, home)]).filter(([, failure]) => failure);
        loaded += hooks.length;
        assert.deepStrictEqual(failures, []);
        assert.deepStrictEqual(copies.filter(op => PACKAGE_ONLY_SCRIPTS.has(op.sourceRelativePath)).map(op => op.sourceRelativePath), []);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
}

run('the hooks were loaded from the laid-out targets, not skipped', () => {
  assert.ok(loaded >= 40, `only ${loaded} hook copies were loaded`);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
