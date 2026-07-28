'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'bootstrap-cognitive.js');
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');

function mktempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-bootstrap-cognitive-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function run(homeDir) {
  return execFileSync('node', [SCRIPT_PATH], {
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: 'utf8',
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

async function runTests() {
  console.log('\n=== Testing scripts/bootstrap-cognitive.js ===\n');
  let passed = 0;
  let failed = 0;

  if (await test('BLOCK advertises all 9 session bus commands', () => {
    for (const cmd of [
      'session_announce',
      'session_peers',
      'session_events',
      'session_send',
      'claim_path',
      'release_path',
      'working_memory_get',
      'working_memory_set',
      'working_memory_list',
    ]) {
      assert.ok(SCRIPT_SOURCE.includes(cmd), `BLOCK must reference ${cmd}`);
    }
  })) passed++; else failed++;

  if (await test('BLOCK advertises all 5 core protocol commands (Guardian Protocol + reduce_context)', () => {
    for (const cmd of ['orchestrate_task', 'validate_command', 'validate_write', 'reduce_context', 'auto_learn']) {
      assert.ok(SCRIPT_SOURCE.includes(cmd), `BLOCK must reference ${cmd}`);
    }
  })) passed++; else failed++;

  if (await test('writes Windsurf global_rules.md when ~/.codeium exists', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codeium'));
      const output = run(home);
      assert.ok(/Windsurf: memory protocol installed/.test(output), 'should report install');
      const target = path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md');
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(content.includes('<!-- egc-memory-protocol -->'), 'marker must be present');
      assert.ok(content.includes('EGC Session Memory'), 'protocol block must be present');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('skips Windsurf when ~/.codeium does not exist', () => {
    const home = mktempHome();
    try {
      const output = run(home);
      assert.ok(!/\[cognitive\] Windsurf:/.test(output), 'should not mention Windsurf at all');
      assert.ok(!fs.existsSync(path.join(home, '.codeium')), 'must not create ~/.codeium');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('Windsurf install is idempotent (no duplicate marker on rerun)', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codeium'));
      run(home);
      const second = run(home);
      assert.ok(/Windsurf: already configured/.test(second), 'second run should detect existing config');
      const target = path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md');
      const content = fs.readFileSync(target, 'utf8');
      assert.strictEqual(
        (content.match(/<!-- egc-memory-protocol -->/g) || []).length,
        1,
        'only one protocol marker after two runs'
      );
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('writes Zed AGENTS.md when ~/.config/zed exists', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.config', 'zed'), { recursive: true });
      const output = run(home);
      assert.ok(/Zed: memory protocol installed/.test(output), 'should report install');
      const target = path.join(home, '.config', 'zed', 'AGENTS.md');
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(content.includes('<!-- egc-memory-protocol -->'), 'marker must be present');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('skips Zed when ~/.config/zed does not exist', () => {
    const home = mktempHome();
    try {
      const output = run(home);
      assert.ok(!/\[cognitive\] Zed:/.test(output), 'should not mention Zed at all');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('logs an error instead of crashing when the Windsurf target path is structurally broken', () => {
    const home = mktempHome();
    try {
      fs.mkdirSync(path.join(home, '.codeium'));
      // 'windsurf' is a file, not a directory: mkdirSync('.codeium/windsurf/memories', {recursive:true})
      // fails structurally (ENOTDIR) on every OS, unlike a permission-based failure.
      fs.writeFileSync(path.join(home, '.codeium', 'windsurf'), 'not a directory', 'utf8');
      const output = run(home);
      assert.ok(/Windsurf: unexpected error:/.test(output), 'should report the error, not crash');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('logs an error instead of crashing when the Zed AGENTS.md path is structurally broken', () => {
    const home = mktempHome();
    try {
      const zedDir = path.join(home, '.config', 'zed');
      fs.mkdirSync(zedDir, { recursive: true });
      // AGENTS.md is a directory, not a file: readFileSync on it fails structurally
      // (EISDIR) on every OS, unlike a permission-based failure.
      fs.mkdirSync(path.join(zedDir, 'AGENTS.md'));
      const output = run(home);
      assert.ok(/Zed: unexpected error:/.test(output), 'should report the error, not crash');
    } finally {
      cleanup(home);
    }
  })) passed++; else failed++;

  if (await test('does not target a home-level file for Cline or Aider (project-only harnesses)', () => {
    assert.ok(
      !SCRIPT_SOURCE.includes("'.clinerules'"),
      'Cline has no home target per docs/spec/integration-tiers.md -- must not be added here'
    );
    assert.ok(
      !SCRIPT_SOURCE.includes('.aider.conf.yml'),
      'Aider has no home target per docs/spec/integration-tiers.md -- must not be added here'
    );
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
