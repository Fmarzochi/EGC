/**
 * Tests for scripts/hooks/prompt-intuition.js via run-with-flags.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runner = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'run-with-flags.js');
const fakeCli = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');

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

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-intuition-'));
}

function stateFileIn(homeDir) {
  const stateDir = path.join(homeDir, '.egc', 'state');
  if (!fs.existsSync(stateDir)) return null;
  const stack = [stateDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.md')) return full;
    }
  }
  return null;
}

function runHook(input, env = {}) {
  const rawInput = JSON.stringify(input);
  const result = spawnSync('node', [runner, 'prompt:intuition', 'scripts/hooks/prompt-intuition.js', 'standard,strict'], {
    input: rawInput,
    encoding: 'utf8',
    env: {
      ...process.env,
      ECC_HOOK_PROFILE: 'standard',
      EGC_GUARDIAN_CLI: fakeCli,
      ...env
    },
    timeout: 20000,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function runTests() {
  console.log('\n=== Testing prompt-intuition ===\n');

  let passed = 0;
  let failed = 0;

  if (test('stays silent when intent is none and route returns no matches', () => {
    const result = runHook({ prompt: 'implement the oauth login feature' }, { FAKE_GUARDIAN_INTENT: 'none', FAKE_GUARDIAN_ROUTE: 'empty' });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, '', `Expected silence, got: ${result.stdout}`);
  })) passed++; else failed++;

  if (test('injects routing context when intent is none and route matches', () => {
    const result = runHook({ prompt: 'implement the oauth login feature' }, { FAKE_GUARDIAN_INTENT: 'none' });
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('=== EGC Routing ==='), `Expected routing block, got: ${result.stdout}`);
    assert.ok(result.stdout.includes('Agents:'), `Expected agents line, got: ${result.stdout}`);
    assert.ok(result.stdout.includes('Skills:'), `Expected skills line, got: ${result.stdout}`);
  })) passed++; else failed++;

  if (test('session_end saves the state snapshot before the AI responds', () => {
    const home = makeHome();
    try {
      const result = runHook(
        { prompt: 'ok im heading out', cwd: home },
        { FAKE_GUARDIAN_INTENT: 'session_end', FAKE_GUARDIAN_MINE: 'skip', HOME: home, PWD: home }
      );
      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('=== EGC Session ==='), `Expected session block, got: ${result.stdout}`);
      assert.ok(result.stdout.includes('already saved'), `Expected saved confirmation, got: ${result.stdout}`);
      const stateFile = stateFileIn(home);
      assert.ok(stateFile, 'Expected a state file to be written');
      assert.ok(fs.readFileSync(stateFile, 'utf8').includes('## Next Session'), 'Expected snapshot skeleton');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('session_end merges mined memory into the state file', () => {
    const home = makeHome();
    const transcript = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcript, '{"message":{"role":"user","content":"x"}}\n');
    try {
      const result = runHook(
        { prompt: 'good night', cwd: home, transcript_path: transcript },
        { FAKE_GUARDIAN_INTENT: 'session_end', HOME: home, PWD: home }
      );
      assert.strictEqual(result.code, 0);
      const stateFile = stateFileIn(home);
      assert.ok(stateFile, 'Expected a state file');
      const content = fs.readFileSync(stateFile, 'utf8');
      assert.ok(content.includes('Use fixture-driven tests'), `Expected mined decision, got: ${content}`);
      assert.ok(content.includes('Ship the memory miner'), `Expected mined next step, got: ${content}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('remember records the user words verbatim into Active Decisions', () => {
    const home = makeHome();
    try {
      const result = runHook(
        { prompt: 'keep the API split into two endpoints, latency matters here', cwd: home },
        { FAKE_GUARDIAN_INTENT: 'remember', HOME: home, PWD: home }
      );
      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('=== EGC Memory ==='), `Expected memory block, got: ${result.stdout}`);
      const stateFile = stateFileIn(home);
      assert.ok(stateFile, 'Expected a state file');
      const content = fs.readFileSync(stateFile, 'utf8');
      assert.ok(content.includes('keep the API split into two endpoints'), `Expected verbatim decision, got: ${content}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('session_resume injects next steps from existing state', () => {
    const home = makeHome();
    try {
      runHook(
        { prompt: 'remember: finish the miner PR first thing', cwd: home },
        { FAKE_GUARDIAN_INTENT: 'remember', HOME: home, PWD: home }
      );
      const result = runHook(
        { prompt: 'hey, picking this back up', cwd: home },
        { FAKE_GUARDIAN_INTENT: 'session_resume', HOME: home, PWD: home }
      );
      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('=== EGC Resume ==='), `Expected resume block, got: ${result.stdout}`);
      assert.ok(result.stdout.includes('finish the miner PR'), `Expected stored decision in resume, got: ${result.stdout}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('never leaks the raw input JSON into context', () => {
    const result = runHook({ prompt: 'short greeting here' }, { FAKE_GUARDIAN_INTENT: 'none', FAKE_GUARDIAN_ROUTE: 'empty' });
    assert.ok(!result.stdout.includes('"prompt"'), `Raw input leaked: ${result.stdout}`);
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
