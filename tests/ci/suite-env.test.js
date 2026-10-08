'use strict';

/**
 * The environment tests/run-all.js gives every test file: no variables of the
 * tool session the suite runs inside, and no git automatic maintenance.
 * tests/hooks/hooks.test.js checks that run-all.js hands it to each file.
 *
 * Run with: node tests/ci/suite-env.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suiteEnv } = require('../fixtures/suite-env');
const { removeDirWithRetries } = require('../fixtures/remove-dir');

// Fixed git locations before a PATH lookup.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
  }
}

console.log('\n=== Testing the test suite environment ===\n');

test('drops the variables a tool session sets and keeps the rest', () => {
  const env = suiteEnv({ PATH: '/bin', CLAUDECODE: '1', EGC_DIR: '/somewhere' });
  assert.strictEqual(env.CLAUDECODE, undefined);
  assert.strictEqual(env.EGC_DIR, undefined);
  assert.strictEqual(env.PATH, '/bin');
});

test('turns git automatic maintenance off', () => {
  assert.strictEqual(suiteEnv({}).GIT_CONFIG_PARAMETERS, "'maintenance.auto'='false'");
});

test('keeps the git config parameters already in the environment', () => {
  const env = suiteEnv({ GIT_CONFIG_PARAMETERS: "'user.name'='Someone'" });
  assert.strictEqual(env.GIT_CONFIG_PARAMETERS, "'user.name'='Someone' 'maintenance.auto'='false'");
});

test('a commit under the suite environment starts no automatic maintenance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-suite-env-'));
  const repo = path.join(dir, 'repo');
  const trace = path.join(dir, 'trace2.json');
  const globalConfig = path.join(dir, '.gitconfig');
  try {
    fs.mkdirSync(repo);
    fs.writeFileSync(globalConfig, '');
    const env = {
      ...suiteEnv(process.env),
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_TRACE2_EVENT: trace,
    };
    const git = args => spawnSync(GIT_BIN, args, { cwd: repo, env, encoding: 'utf8' });
    const init = git(['init', '-q']);
    assert.strictEqual(init.status, 0, init.stderr);
    const commit = git(['commit', '-q', '--allow-empty', '-m', 'init']);
    assert.strictEqual(commit.status, 0, commit.stderr);

    const children = fs.readFileSync(trace, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .filter(event => event.event === 'child_start')
      .map(event => event.argv.join(' '));
    assert.ok(!children.some(argv => /\bmaintenance\b/.test(argv)), `maintenance started: ${children.join(' | ')}`);
  } finally {
    removeDirWithRetries(dir);
  }
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
