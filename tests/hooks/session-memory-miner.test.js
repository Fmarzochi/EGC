/**
 * Tests for scripts/hooks/session-memory-miner.js via run-with-flags.js
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
  const result = spawnSync('node', [runner, 'session:memory-miner', 'scripts/hooks/session-memory-miner.js', 'standard,strict'], {
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
  console.log('\n=== Testing session-memory-miner ===\n');

  let passed = 0;
  let failed = 0;

  if (test('merges mined memory into all state sections', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-miner-'));
    const transcript = path.join(home, 't.jsonl');
    fs.writeFileSync(transcript, '{"message":{"role":"user","content":"x"}}\n');
    try {
      const result = runHook(
        { transcript_path: transcript, cwd: home },
        { HOME: home, PWD: home }
      );
      assert.strictEqual(result.code, 0);
      const stateFile = stateFileIn(home);
      assert.ok(stateFile, 'Expected a state file');
      const content = fs.readFileSync(stateFile, 'utf8');
      assert.ok(content.includes('Use fixture-driven tests -- CI has no guardian build'), 'Expected decision with why');
      assert.ok(content.includes('Piping CI watchers to tail'), 'Expected avoid entry');
      assert.ok(content.includes('Conventional commits'), 'Expected preference');
      assert.ok(content.includes('Ship the memory miner'), 'Expected next step');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('is idempotent: rerunning adds no duplicate lines', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-miner-'));
    const transcript = path.join(home, 't.jsonl');
    fs.writeFileSync(transcript, '{"message":{"role":"user","content":"x"}}\n');
    try {
      runHook({ transcript_path: transcript, cwd: home }, { HOME: home, PWD: home });
      runHook({ transcript_path: transcript, cwd: home }, { HOME: home, PWD: home });
      const content = fs.readFileSync(stateFileIn(home), 'utf8');
      const occurrences = content.split('Ship the memory miner').length - 1;
      assert.strictEqual(occurrences, 1, `Expected single entry, found ${occurrences}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('does nothing when the miner reports skip', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-miner-'));
    const transcript = path.join(home, 't.jsonl');
    fs.writeFileSync(transcript, '{"message":{"role":"user","content":"x"}}\n');
    try {
      const result = runHook(
        { transcript_path: transcript, cwd: home },
        { HOME: home, PWD: home, FAKE_GUARDIAN_MINE: 'skip' }
      );
      assert.strictEqual(result.code, 0);
      assert.strictEqual(stateFileIn(home), null, 'Expected no state file when miner skips');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('respects EGC_MEMORY_MINER=0', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-miner-'));
    const transcript = path.join(home, 't.jsonl');
    fs.writeFileSync(transcript, '{"message":{"role":"user","content":"x"}}\n');
    try {
      const result = runHook(
        { transcript_path: transcript, cwd: home },
        { HOME: home, PWD: home, EGC_MEMORY_MINER: '0' }
      );
      assert.strictEqual(result.code, 0);
      assert.strictEqual(stateFileIn(home), null, 'Expected no state file when disabled');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('passes through input without a transcript path', () => {
    const rawInput = JSON.stringify({ cwd: '/tmp' });
    const result = runHook({ cwd: '/tmp' });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, rawInput, 'Expected raw passthrough');
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
