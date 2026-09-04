'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DISPATCHER = path.join(REPO_ROOT, 'scripts', 'egc.js');

function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: CLI_TIMEOUT_MS,
    input: options.input,
    env: { ...process.env, ...(options.env || {}) },
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function hasMarker(output, marker) {
  return (Array.isArray(marker) ? marker : [marker]).some(m => output.includes(m));
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

// Every subcommand `egc help <name>` reaches must answer --help with exit 0
// and a usage text. These four used to exit 1 (or start a REPL, or die on a
// missing Python virtualenv) when asked for help.
const CASES = [
  { command: 'crusher-shim', script: 'crusher-shim.js', marker: 'Usage: egc crusher-shim' },
  { command: 'session-inspect', script: 'session-inspect.js', marker: 'Usage:' },
  // With the Python virtualenv present, prompt --help is answered by the
  // Python entry point (usage: prompt.py); without it, by the bridge itself.
  { command: 'prompt', script: 'gemini.js', marker: ['Usage: egc prompt', 'usage: prompt.py'] },
  { command: 'claw', script: 'claw.js', marker: 'Usage: egc claw' },
];

function runTests() {
  console.log('\n=== Testing help exit codes ===\n');
  let passed = 0;
  let failed = 0;

  for (const c of CASES) {
    if (test(`${c.script} --help exits 0 with its usage`, () => {
      for (const flag of ['--help', '-h']) {
        const result = runNode([path.join(REPO_ROOT, 'scripts', c.script), flag], { input: 'exit\n' });
        assert.strictEqual(result.code, 0, `${flag}: ${result.stderr}`);
        assert.ok(hasMarker(result.stdout, c.marker), `${flag}: expected ${JSON.stringify(c.marker)} in: ${result.stdout.slice(0, 200)}`);
      }
    })) passed++; else failed++;

    if (test(`egc help ${c.command} exits 0 through the dispatcher`, () => {
      const result = runNode([DISPATCHER, 'help', c.command], { input: 'exit\n' });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(hasMarker(result.stdout, c.marker), result.stdout.slice(0, 200));
    })) passed++; else failed++;
  }

  if (test('a real usage error still exits 1', () => {
    const shim = runNode([path.join(REPO_ROOT, 'scripts', 'crusher-shim.js'), 'bogus']);
    assert.strictEqual(shim.code, 1);
    const inspect = runNode([path.join(REPO_ROOT, 'scripts', 'session-inspect.js')]);
    assert.strictEqual(inspect.code, 1);
    assert.ok(inspect.stdout.includes('Usage:'));
  })) passed++; else failed++;

  if (test('claw --help does not open the REPL', () => {
    const result = runNode([path.join(REPO_ROOT, 'scripts', 'claw.js'), '--help'], { input: 'exit\n' });
    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(!result.stdout.includes('claw>'), 'the REPL prompt must not appear');
    assert.ok(!result.stdout.includes('NanoClaw v2: Session'), 'no session banner for a help request');
  })) passed++; else failed++;

  if (test('the prompt bridge names the missing virtualenv instead of a bare spawn error', () => {
    const result = runNode([path.join(REPO_ROOT, 'scripts', 'gemini.js'), '--prompt', 'hi']);
    if (result.code === 0) {
      console.log('    - a virtualenv is present on this machine; the missing-venv message is not exercised');
      return;
    }
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('Python bridge not available'), result.stderr);
    assert.ok(!result.stderr.includes('ENOENT'), result.stderr);
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
