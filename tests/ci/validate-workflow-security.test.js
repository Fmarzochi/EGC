#!/usr/bin/env node
/**
 * Validate workflow security guardrails for privileged GitHub Actions events.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'ci', 'validate-workflow-security.js');

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

function runValidator(files) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-workflow-security-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, name), contents);
    }

    return spawnSync('node', [SCRIPT_PATH], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ECC_WORKFLOWS_DIR: tempDir,
      },
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function run() {
  console.log('\n=== Testing workflow security validation ===\n');

  let passed = 0;
  let failed = 0;

  if (test('rejects a run: step that splices the pull request title into the shell', () => {
    const result = runValidator({
      'title.yml': 'name: T\non:\n  pull_request:\njobs:\n  echo:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ github.event.pull_request.title }}"\n',
    });
    assert.notStrictEqual(result.status, 0, 'a title inside run: is a violation');
    assert.ok(result.stderr.includes('github.event.pull_request.title'), result.stderr);
    assert.ok(result.stderr.includes('title.yml:8'), result.stderr);
  })) passed++; else failed++;

  if (test('rejects a block-scalar run: with an issue body or a branch name on a later line', () => {
    const result = runValidator({
      'body.yml': 'name: B\non:\n  issues:\n    types: [opened]\njobs:\n  echo:\n    runs-on: ubuntu-latest\n    steps:\n      - name: show\n        run: |\n          echo start\n          echo "${{ github.event.issue.body }}"\n          git checkout "${{ github.head_ref }}"\n',
    });
    assert.notStrictEqual(result.status, 0);
    assert.ok(result.stderr.includes('body.yml:12'), result.stderr);
    assert.ok(result.stderr.includes('body.yml:13'), result.stderr);
  })) passed++; else failed++;

  if (test('rejects a field wrapped in a larger expression, a spaced run key, and committer fields', () => {
    const result = runValidator({
      'wrapped.yml': 'name: W\non:\n  push:\njobs:\n  echo:\n    runs-on: ubuntu-latest\n    steps:\n      - run : echo "${{ github.event.pull_request.title || \'none\' }}"\n      - run: echo "${{ format(\'{0}\', github.event.head_commit.committer.name) }}"\n',
    });
    assert.notStrictEqual(result.status, 0);
    assert.ok(result.stderr.includes('wrapped.yml:8'), result.stderr);
    assert.ok(result.stderr.includes('wrapped.yml:9'), result.stderr);
    assert.ok(result.stderr.includes('committer.name'), result.stderr);
  })) passed++; else failed++;

  if (test('rejects bracket and filter spellings, and a field placed after a string that carries }}', () => {
    const result = runValidator({
      'spelling.yml': 'name: X\non:\n  push:\njobs:\n  echo:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ github.event[\'pull_request\'][\'title\'] }}"\n      - run: echo "${{ format(\'}}\', github.event.issue.body) }}"\n      - run: echo "${{ github.event.commits[3][\'message\'] }}"\n      - run: echo "${{ join(github.event.commits.*.message, \', \') }}"\n',
    });
    assert.notStrictEqual(result.status, 0);
    assert.ok(result.stderr.includes('spelling.yml:8'), result.stderr);
    assert.ok(result.stderr.includes('spelling.yml:9'), result.stderr);
    assert.ok(result.stderr.includes('spelling.yml:10'), result.stderr);
    assert.ok(result.stderr.includes('spelling.yml:11'), result.stderr);

  })) passed++; else failed++;

  if (test('allows an env: sibling that follows a block-scalar run:', () => {
    const result = runValidator({
      'sibling.yml': 'name: S\non:\n  issues:\n    types: [opened]\njobs:\n  echo:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo "$BODY"\n          echo done\n        env:\n          BODY: ${{ github.event.issue.body }}\n',
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  })) passed++; else failed++;

  if (test('allows the same text passed through an env: variable', () => {
    const result = runValidator({
      'env.yml': 'name: E\non:\n  pull_request:\njobs:\n  echo:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          TITLE: ${{ github.event.pull_request.title }}\n        run: echo "$TITLE"\n',
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  })) passed++; else failed++;

  if (test('allows run: steps that use trusted context only', () => {
    const result = runValidator({
      'ok.yml': 'name: O\non:\n  pull_request:\njobs:\n  echo:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo "${{ github.sha }} ${{ github.event.pull_request.number }}"\n          echo "${{ runner.os }}"\n',
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  })) passed++; else failed++;


  if (test('allows safe workflow_run workflow that only checks out the base repository', () => {
    const result = runValidator({
      'safe.yml': `name: Safe\non:\n  workflow_run:\n    workflows: ["CI"]\n    types: [completed]\njobs:\n  repair:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo safe\n`,
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  })) passed++; else failed++;

  if (test('rejects workflow_run checkout using github.event.workflow_run.head_branch', () => {
    const result = runValidator({
      'unsafe-workflow-run.yml': `name: Unsafe\non:\n  workflow_run:\n    workflows: ["CI"]\n    types: [completed]\njobs:\n  repair:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.workflow_run.head_branch }}\n`,
    });
    assert.notStrictEqual(result.status, 0, 'Expected validator to fail');
    assert.match(result.stderr, /workflow_run must not checkout an untrusted workflow_run head ref\/repository/);
    assert.match(result.stderr, /head_branch/);
  })) passed++; else failed++;

  if (test('rejects workflow_run checkout using github.event.workflow_run.head_repository.full_name', () => {
    const result = runValidator({
      'unsafe-repository.yml': `name: Unsafe\non:\n  workflow_run:\n    workflows: ["CI"]\n    types: [completed]\njobs:\n  repair:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          repository: \${{ github.event.workflow_run.head_repository.full_name }}\n`,
    });
    assert.notStrictEqual(result.status, 0, 'Expected validator to fail');
    assert.match(result.stderr, /head_repository\.full_name/);
  })) passed++; else failed++;

  if (test('rejects pull_request_target checkout using github.event.pull_request.head.sha', () => {
    const result = runValidator({
      'unsafe-pr-target.yml': `name: Unsafe\non:\n  pull_request_target:\n    branches: [main]\njobs:\n  inspect:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`,
    });
    assert.notStrictEqual(result.status, 0, 'Expected validator to fail');
    assert.match(result.stderr, /pull_request_target must not checkout an untrusted pull_request head ref\/repository/);
    assert.match(result.stderr, /pull_request\.head\.sha/);
  })) passed++; else failed++;

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

run();
