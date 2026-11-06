/**
 * Tests for scripts/orchestration-status.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'orchestration-status.js');

function run(args = [], options = {}) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS,
      cwd: options.cwd || process.cwd(),
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    // A killed script has no exit status. Only a kill at the budget is a
    // timeout; any other signal (a crash, an OOM kill) is named as a kill.
    let killed = '';
    if (error.code === 'ETIMEDOUT') killed = `killed by ${error.signal} after the ${CLI_TIMEOUT_MS} ms budget`;
    else if (error.signal) killed = `killed by ${error.signal}`;
    return {
      code: error.status || 1,
      stdout: error.stdout || '',
      stderr: error.stderr || killed,
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
  console.log('\n=== Testing orchestration-status.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('emits canonical dmux snapshots for plan files', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-orch-status-repo-'));

    try {
      const planPath = path.join(repoRoot, 'workflow.json');
      fs.writeFileSync(planPath, JSON.stringify({
        sessionName: 'workflow-visual-proof',
        repoRoot,
        coordinationRoot: path.join(repoRoot, '.gemini', 'orchestration')
      }));

      const result = run([planPath], { cwd: repoRoot });
      assert.strictEqual(result.code, 0, result.stderr);

      const payload = JSON.parse(result.stdout);
      assert.strictEqual(payload.adapterId, 'dmux-tmux');
      assert.strictEqual(payload.session.id, 'workflow-visual-proof');
      assert.strictEqual(payload.session.sourceTarget.type, 'plan');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
