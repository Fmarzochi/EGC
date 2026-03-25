/**
 * Tests for Codex shell helpers.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');
const installScript = path.join(repoRoot, 'scripts', 'codex', 'install-global-git-hooks.sh');
const installSource = fs.readFileSync(installScript, 'utf8');

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

function runBash(scriptPath, args = [], env = {}, cwd = repoRoot) {
  return spawnSync('bash', [scriptPath, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env
    },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

let passed = 0;
let failed = 0;

if (
  test('install-global-git-hooks.sh does not use eval and executes argv directly', () => {
    assert.ok(!installSource.includes('eval "$*"'), 'Expected installer to avoid eval');
    assert.ok(installSource.includes('    "$@"'), 'Expected installer to execute argv directly');
    assert.ok(installSource.includes(`printf ' %q' "$@"`), 'Expected dry-run logging to shell-escape argv');
  })
)
  passed++;
else failed++;

if (
  test('install-global-git-hooks.sh handles quoted hook paths without shell injection', () => {
    const homeDir = createTempDir('codex-hooks-home-');
    const weirdHooksDir = path.join(homeDir, 'git-hooks "quoted"');

    try {
      const result = runBash(installScript, [], {
        HOME: homeDir,
        ECC_GLOBAL_HOOKS_DIR: weirdHooksDir
      });

      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.ok(fs.existsSync(path.join(weirdHooksDir, 'pre-commit')));
      assert.ok(fs.existsSync(path.join(weirdHooksDir, 'pre-push')));
    } finally {
      cleanup(homeDir);
    }
  })
)
  passed++;
else failed++;

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
