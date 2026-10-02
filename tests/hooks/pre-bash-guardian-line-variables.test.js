'use strict';
/**
 * The Bash hook hands the Guardian the variables the command line sets, so
 * a target that only the shell would spell out (`D=<file>; echo x > "$D"`)
 * is judged by the file it names. Runs the real Guardian CLI.
 *
 * Run with: node tests/hooks/pre-bash-guardian-line-variables.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cliPath = path.join(__dirname, '..', '..', 'mcp', 'servers', 'egc-guardian', 'build', 'guardian-cli.js');

if (!fs.existsSync(cliPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

process.env.EGC_GUARDIAN_CLI = cliPath;
const { run } = require('../../scripts/hooks/pre-bash-guardian-validate');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-hook-line-variables-'));

function judge(command) {
  return run({ tool_input: { command }, cwd });
}

function assertBlocked(command, pattern) {
  const result = judge(command);
  assert.strictEqual(result.exitCode, 2, `${command} must be blocked, got ${JSON.stringify(result)}`);
  if (pattern) assert.match(result.stderr, pattern);
}

function assertPasses(command) {
  const result = judge(command);
  assert.strictEqual(result.exitCode, 0, `${command} must pass, got ${JSON.stringify(result)}`);
}

console.log('\n=== Testing the variables the command line sets ===\n');

test('a redirection onto a variable the line sets to a protected file is blocked', () => {
  assertBlocked('D=~/.ssh/id_rsa; echo x > "$D"', /protected/);
  assertBlocked('D="$HOME/.ssh/id_rsa"; echo x > "$D"', /protected/);
});

test('an exported variable and a chained one are followed to the file', () => {
  assertBlocked('export D=~/.ssh/id_rsa && cat "$D"');
  assertBlocked('D=~/.ssh; T=$D/id_rsa; cat "${T}"');
});

test('a script written through a variable the line sets is blocked', () => {
  assertBlocked('S=deploy.sh; echo x > "$S"', /Write or Edit/);
});

test('a script the line runs has its own variables followed too', () => {
  const script = path.join(cwd, 'run.sh');
  fs.writeFileSync(script, 'D=~/.ssh/id_rsa\necho x > "$D"\n');
  assertBlocked('bash run.sh', /protected/);
});

test('a variable set to an ordinary file passes as before', () => {
  assertPasses('D=notes.txt; echo x > "$D"');
  assertPasses('echo x > "$UNSET"');
});

fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
