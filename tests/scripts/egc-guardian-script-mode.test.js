/**
 * The Guardian CLI's script mode judges a script line by line with the
 * command validator and reports only verdicts the Bash hook would block
 * (security audit 2026-08-17, H3). Skips when the server is not built.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const CLI = path.join(__dirname, '../../mcp/servers/egc-guardian/build/guardian-cli.js');
if (!fs.existsSync(CLI)) {
  console.error(`[SKIP] Missing ${CLI}. Run 'npm ci && npm run build' in mcp/servers/egc-guardian first.`);
  process.exit(0);
}

function judge(script) {
  const result = spawnSync(process.execPath, [CLI, 'script'], { input: script, encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
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

function runTests() {
  console.log('\n=== Testing guardian-cli script mode ===\n');
  let passed = 0;
  let failed = 0;
  const home = os.homedir();
  const wipe = ['rm', '-rf'].join(' ');

  if (test('a denied command on any line is reported with its line number', () => {
    const verdict = judge(`#!/bin/bash\nset -euo pipefail\necho start\ncat ${home}/.ssh/id_rsa\n`);
    assert.strictEqual(verdict.allowed, false, JSON.stringify(verdict));
    assert.strictEqual(verdict.line, 4);
    assert.match(verdict.reason, /protected/);
  })) passed++; else failed++;

  if (test('a denied command hidden after && or ; on one line is still found', () => {
    for (const line of ['echo hi && find . -name x -delete', 'true; git push --force origin main', `ls | xargs ${wipe}`]) {
      const verdict = judge(`${line}\n`);
      assert.strictEqual(verdict.allowed, false, `${line}: ${JSON.stringify(verdict)}`);
      assert.strictEqual(verdict.line, 1);
    }
  })) passed++; else failed++;

  if (test('quoted separators do not split a line', () => {
    const verdict = judge(`echo "a; b | c && d"\n`);
    assert.strictEqual(verdict.allowed, true, JSON.stringify(verdict));
  })) passed++; else failed++;

  if (test('lines that are benign, comments, or merely outside the allowlist pass', () => {
    const verdict = judge(`#!/usr/bin/env bash\n# ${wipe} / in a comment is not a command\ncargo build --release\nnpm test 2>&1\necho done\n`);
    assert.strictEqual(verdict.allowed, true, JSON.stringify(verdict));
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
