/**
 * Locks the clean-environment detection contract proven by hand on
 * 2026-08-19 (synthetic-HOME matrix plus a virgin docker container):
 * EGC only ever touches harnesses that actually exist on the machine.
 *
 * - The cognitive bootstrap creates NOTHING in an empty home, and only the
 *   detected harness's context file when exactly one tool is present.
 * - An explicit install for an absent tool warns loudly instead of
 *   installing silently (adapter.validate() detection warning).
 *
 * PATH is pinned to /usr/bin:/bin in every subprocess so commandExists()
 * probes cannot see tools installed on the developer machine: the gates
 * must decide from the synthetic HOME alone (on Windows the pinned POSIX
 * PATH simply resolves nothing, which is exactly the point).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { FULL_INSTALL_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const REPO_ROOT = path.join(__dirname, '..', '..');
const BOOTSTRAP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'bootstrap-cognitive.js');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'install-apply.js');
const RESTRICTED_PATH = '/usr/bin:/bin';

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function runWithSyntheticHome(scriptPath, args, homeDir, cwd) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: cwd || homeDir,
    encoding: 'utf8',
    timeout: FULL_INSTALL_TIMEOUT_MS,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      PATH: RESTRICTED_PATH,
    },
  });
  // A timed-out subprocess has a null status and (usually) an empty stderr;
  // folding that into a bare exit 1 would make the assertion failure mute,
  // the exact failure shape that hid today's CI flake. Name the hang.
  const timedOut = result.error?.code === 'ETIMEDOUT'
    || (result.status === null && result.signal !== null);
  const stderr = timedOut
    ? `subprocess timed out after ${FULL_INSTALL_TIMEOUT_MS}ms (${result.signal || result.error?.code})\n${result.stderr || ''}`
    : (result.stderr || '');
  return {
    code: result.status ?? 1,
    stdout: result.stdout || '',
    stderr,
  };
}

function listHomeEntries(homeDir) {
  return fs.readdirSync(homeDir).sort((a, b) => a.localeCompare(b));
}

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
  console.log('\n=== Testing clean-environment detection gating ===\n');

  let passed = 0;
  let failed = 0;

  if (test('cognitive bootstrap creates nothing in an empty home', () => {
    const homeDir = createTempDir('clean-env-empty-');

    try {
      const result = runWithSyntheticHome(BOOTSTRAP_SCRIPT, [], homeDir);

      assert.strictEqual(result.code, 0, result.stderr);
      assert.deepStrictEqual(
        listHomeEntries(homeDir),
        [],
        'an empty home must stay empty: no harness may be conjured'
      );
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('cognitive bootstrap touches only the one detected harness', () => {
    const homeDir = createTempDir('clean-env-claude-');

    try {
      fs.mkdirSync(path.join(homeDir, '.claude'));
      const result = runWithSyntheticHome(BOOTSTRAP_SCRIPT, [], homeDir);

      assert.strictEqual(result.code, 0, result.stderr);
      assert.deepStrictEqual(
        listHomeEntries(homeDir),
        ['.claude'],
        'only the detected harness directory may exist afterwards'
      );
      const protocolFile = path.join(homeDir, '.claude', 'CLAUDE.md');
      assert.ok(fs.existsSync(protocolFile), 'the detected harness receives its protocol file');
      assert.ok(
        fs.readFileSync(protocolFile, 'utf8').includes('egc-memory-protocol'),
        'the written file carries the versioned protocol marker'
      );
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('--require-detected fails fast for an absent tool and writes nothing', () => {
    const homeDir = createTempDir('clean-env-require-');
    const projectRoot = createTempDir('clean-env-require-project-');

    try {
      const result = runWithSyntheticHome(
        INSTALL_SCRIPT,
        ['--target', 'kiro', '--profile', 'core', '--require-detected'],
        homeDir,
        projectRoot
      );

      assert.strictEqual(result.code, 1, 'strict automation must refuse an undetected target');
      assert.ok(
        result.stderr.includes('--require-detected'),
        `the refusal must name the flag: ${result.stderr}`
      );
      assert.deepStrictEqual(
        listHomeEntries(homeDir),
        [],
        'a refused install must not write anything into the home'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('--allow-undetected proceeds without the detection warning', () => {
    const homeDir = createTempDir('clean-env-allow-');
    const projectRoot = createTempDir('clean-env-allow-project-');

    try {
      const result = runWithSyntheticHome(
        INSTALL_SCRIPT,
        ['--target', 'kiro', '--profile', 'core', '--dry-run', '--allow-undetected'],
        homeDir,
        projectRoot
      );

      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('Dry-run install plan'), 'the plan must still print');
      assert.ok(
        !result.stdout.includes('does not appear to be installed'),
        'deliberate provisioning must not carry the detection warning'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('--allow-undetected --json omits the issue from machine-readable output too', () => {
    const homeDir = createTempDir('clean-env-allow-json-');
    const projectRoot = createTempDir('clean-env-allow-json-project-');

    try {
      const result = runWithSyntheticHome(
        INSTALL_SCRIPT,
        ['--target', 'kiro', '--profile', 'core', '--dry-run', '--json', '--allow-undetected'],
        homeDir,
        projectRoot
      );

      assert.strictEqual(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      const rawJson = JSON.stringify(parsed);
      assert.ok(
        !rawJson.includes('ide-not-detected') && !rawJson.includes('does not appear to be installed'),
        `structured plan.validationIssues must be silenced too, not just the flattened warnings: ${rawJson}`
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('an explicit install for an absent tool warns instead of installing silently', () => {
    const homeDir = createTempDir('clean-env-absent-tool-');
    const projectRoot = createTempDir('clean-env-project-');

    try {
      const result = runWithSyntheticHome(
        INSTALL_SCRIPT,
        ['--target', 'kiro', '--profile', 'core', '--dry-run'],
        homeDir,
        projectRoot
      );

      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(
        result.stdout.includes('does not appear to be installed'),
        'the plan must carry the tool-not-detected warning'
      );
      assert.deepStrictEqual(
        listHomeEntries(homeDir),
        [],
        'a dry-run plan must not write anything into the home'
      );
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
