const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'post-bash-command-log.js');
const { sanitizeCommand } = require(scriptPath);

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    return true;
  } catch (error) {
    console.log(`FAIL: ${name}`);
    console.log(`  ${error.message}`);
    return false;
  }
}

// The harness variables and EGC_DIR would pin the logs' directory whatever
// the synthetic home holds; the hook is exercised on the home alone.
const HARNESS_VARIABLES = ['EGC_DIR', 'GEMINI_PROJECT_DIR', 'GEMINI_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CODEBUDDY_PROJECT_DIR', 'CODEBUDDY_PLUGIN_ROOT', 'VSCODE_AGENT', 'GITHUB_COPILOT_API_TOKEN', 'KIRO_HOOK_FILE', 'KIRO_FILE_PATH', 'TRAE_ENV'];

function runHook(mode, payload, homeDir) {
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  for (const name of HARNESS_VARIABLES) delete env[name];
  return spawnSync('node', [scriptPath, mode], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
}

let passed = 0;
let failed = 0;

if (
  test('sanitizeCommand redacts common secret formats', () => {
    const ghp = `ghp_${'a'.repeat(36)}`;
    const pat = `github_pat_${'x'.repeat(22)}`;
    const input = `gh pr create --token abc123 Authorization: Bearer hello password=swordfish ${ghp} ${pat}`;
    const sanitized = sanitizeCommand(input);
    assert.ok(!sanitized.includes('abc123'));
    assert.ok(!sanitized.includes('swordfish'));
    assert.ok(!sanitized.includes(ghp));
    assert.ok(!sanitized.includes(pat));
    assert.ok(sanitized.includes('--token <REDACTED>'));
    assert.ok(sanitized.includes('Authorization: Bearer <REDACTED>'));
    assert.ok(sanitized.includes('password=<REDACTED>'));
  })
)
  passed++;
else failed++;

if (
  test('audit mode logs sanitized bash commands and preserves stdout', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-bash-log-'));
    const payload = {
      tool_input: {
        command: 'git push --token abc123',
      },
    };

    try {
      const result = runHook('audit', payload, homeDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.strictEqual(result.stdout, JSON.stringify(payload));

      // The EGC directory of a home where no tool is installed: ~/.egc.
      const logFile = path.join(homeDir, '.egc', 'bash-commands.log');
      const logContent = fs.readFileSync(logFile, 'utf8');
      assert.ok(logContent.includes('--token <REDACTED>'));
      assert.ok(!logContent.includes('abc123'));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })
)
  passed++;
else failed++;

if (
  test('cost mode writes command metrics log', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-cost-log-'));
    const payload = {
      tool_input: {
        command: 'npm publish',
      },
    };

    try {
      const result = runHook('cost', payload, homeDir);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);

      const logFile = path.join(homeDir, '.egc', 'cost-tracker.log');
      const logContent = fs.readFileSync(logFile, 'utf8');
      assert.match(logContent, /tool=Bash command=npm publish/);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })
)
  passed++;
else failed++;

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
