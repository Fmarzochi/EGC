/**
 * Tests for scripts/lib/verify-receipt.js and the verification gate hook.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  computeTreeFingerprint,
  evaluateReceipt,
  readReceipt,
  writeReceipt,
} = require('../../scripts/lib/verify-receipt');
const { run: runGate } = require('../../scripts/hooks/pre-bash-verification-gate');

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

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function createGitProject() {
  const projectPath = createTempDir('egc-verify-repo-');
  git(projectPath, ['init', '--quiet']);
  git(projectPath, ['config', 'user.email', 'test@example.com']);
  git(projectPath, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(projectPath, 'index.js'), 'module.exports = 1;\n');
  git(projectPath, ['add', '.']);
  git(projectPath, ['commit', '--quiet', '-m', 'init']);
  return projectPath;
}

function gateInput(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

function withCwdAndEnv(cwd, env, fn) {
  const previousCwd = process.cwd();
  const previousValues = {};
  for (const [key, value] of Object.entries(env)) {
    previousValues[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function main() {
  let passed = 0;
  let failed = 0;

  console.log('Testing verify-receipt and verification gate...\n');

  if (test('fingerprint changes when tracked content changes', () => {
    const projectPath = createGitProject();
    try {
      const before = computeTreeFingerprint(projectPath);
      assert.ok(before);
      fs.writeFileSync(path.join(projectPath, 'index.js'), 'module.exports = 2;\n');
      const after = computeTreeFingerprint(projectPath);
      assert.ok(after);
      assert.notStrictEqual(after, before);
    } finally {
      cleanup(projectPath);
    }
  })) passed++; else failed++;

  if (test('fingerprint is null outside a git repository', () => {
    const plainDir = createTempDir('egc-verify-plain-');
    try {
      assert.strictEqual(computeTreeFingerprint(plainDir), null);
    } finally {
      cleanup(plainDir);
    }
  })) passed++; else failed++;

  if (test('write and read receipt roundtrip with custom base dir', () => {
    const projectPath = createGitProject();
    const baseDir = createTempDir('egc-verify-store-');
    try {
      const written = writeReceipt(projectPath, { command: 'npm test', exitCode: 0 }, { baseDir });
      assert.strictEqual(written.exitCode, 0);
      assert.ok(written.fingerprint);
      const read = readReceipt(projectPath, { baseDir });
      assert.strictEqual(read.command, 'npm test');
      assert.strictEqual(read.fingerprint, written.fingerprint);
    } finally {
      cleanup(projectPath);
      cleanup(baseDir);
    }
  })) passed++; else failed++;

  if (test('evaluateReceipt reports missing, ok, stale, and failed', () => {
    const projectPath = createGitProject();
    const baseDir = createTempDir('egc-verify-store-');
    try {
      assert.strictEqual(evaluateReceipt(projectPath, { baseDir }).status, 'missing');

      writeReceipt(projectPath, { command: 'npm test', exitCode: 0 }, { baseDir });
      assert.strictEqual(evaluateReceipt(projectPath, { baseDir }).status, 'ok');

      fs.writeFileSync(path.join(projectPath, 'index.js'), 'module.exports = 3;\n');
      assert.strictEqual(evaluateReceipt(projectPath, { baseDir }).status, 'stale');

      writeReceipt(projectPath, { command: 'npm test', exitCode: 1, logTail: 'boom' }, { baseDir });
      const evaluation = evaluateReceipt(projectPath, { baseDir });
      assert.strictEqual(evaluation.status, 'failed');
      assert.strictEqual(evaluation.receipt.logTail, 'boom');
    } finally {
      cleanup(projectPath);
      cleanup(baseDir);
    }
  })) passed++; else failed++;

  if (test('evaluateReceipt is unbound outside git', () => {
    const plainDir = createTempDir('egc-verify-plain-');
    try {
      assert.strictEqual(evaluateReceipt(plainDir).status, 'unbound');
    } finally {
      cleanup(plainDir);
    }
  })) passed++; else failed++;

  if (test('gate passes through non-git-commit commands and off mode', () => {
    const projectPath = createGitProject();
    try {
      withCwdAndEnv(projectPath, { EGC_VERIFY_GATE: undefined, EGC_VERIFY_DIR: createTempDir('egc-verify-store-') }, () => {
        const listing = runGate(gateInput('ls -la'));
        assert.strictEqual(listing.exitCode, 0);
        assert.strictEqual(listing.stderr, '');
      });
      withCwdAndEnv(projectPath, { EGC_VERIFY_GATE: 'off' }, () => {
        const commit = runGate(gateInput('git commit -m "x"'));
        assert.strictEqual(commit.exitCode, 0);
        assert.strictEqual(commit.stderr, '');
      });
    } finally {
      cleanup(projectPath);
    }
  })) passed++; else failed++;

  if (test('gate warns on missing receipt by default and blocks in block mode', () => {
    const projectPath = createGitProject();
    const baseDir = createTempDir('egc-verify-store-');
    try {
      withCwdAndEnv(projectPath, { EGC_VERIFY_GATE: undefined, EGC_VERIFY_DIR: baseDir }, () => {
        const warn = runGate(gateInput('git commit -m "feat: x"'));
        assert.strictEqual(warn.exitCode, 0);
        assert.ok(warn.stderr.includes('no verification receipt'));
      });
      withCwdAndEnv(projectPath, { EGC_VERIFY_GATE: 'block', EGC_VERIFY_DIR: baseDir }, () => {
        const block = runGate(gateInput('git push origin main'));
        assert.strictEqual(block.exitCode, 2);
        assert.ok(block.stderr.includes('BLOCKED'));
      });
    } finally {
      cleanup(projectPath);
      cleanup(baseDir);
    }
  })) passed++; else failed++;

  if (test('gate passes with a fresh ok receipt and reinjects failing log output', () => {
    const projectPath = createGitProject();
    const baseDir = createTempDir('egc-verify-store-');
    try {
      writeReceipt(projectPath, { command: 'npm test', exitCode: 0 }, { baseDir });
      withCwdAndEnv(projectPath, { EGC_VERIFY_GATE: 'block', EGC_VERIFY_DIR: baseDir }, () => {
        const pass = runGate(gateInput('git commit -m "feat: x"'));
        assert.strictEqual(pass.exitCode, 0);
        assert.strictEqual(pass.stderr, '');
      });

      writeReceipt(projectPath, { command: 'npm test', exitCode: 1, logTail: '3 tests failed: auth.spec' }, { baseDir });
      withCwdAndEnv(projectPath, { EGC_VERIFY_GATE: 'block', EGC_VERIFY_DIR: baseDir }, () => {
        const blocked = runGate(gateInput('git commit -m "feat: x"'));
        assert.strictEqual(blocked.exitCode, 2);
        assert.ok(blocked.stderr.includes('FAILED'));
        assert.ok(blocked.stderr.includes('3 tests failed: auth.spec'));
      });
    } finally {
      cleanup(projectPath);
      cleanup(baseDir);
    }
  })) passed++; else failed++;

  if (test('verify CLI writes a receipt for an explicit command', () => {
    const projectPath = createGitProject();
    const baseDir = createTempDir('egc-verify-store-');
    try {
      const cliPath = path.join(__dirname, '..', '..', 'scripts', 'verify.js');
      const result = spawnSync(process.execPath, [cliPath, '--', process.execPath, '-e', 'process.exit(0)'], {
        cwd: projectPath,
        encoding: 'utf8',
        env: { ...process.env, EGC_VERIFY_DIR: baseDir },
      });
      assert.strictEqual(result.status, 0, result.stderr);
      const receipt = readReceipt(projectPath, { baseDir });
      assert.ok(receipt);
      assert.strictEqual(receipt.exitCode, 0);
      assert.strictEqual(evaluateReceipt(projectPath, { baseDir }).status, 'ok');
    } finally {
      cleanup(projectPath);
      cleanup(baseDir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
