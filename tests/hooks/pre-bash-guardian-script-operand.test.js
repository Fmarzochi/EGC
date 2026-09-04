/**
 * A script handed to a shell interpreter (bash x.sh, sh notes.txt, source
 * env.sh) is judged with the same validator as typed commands, so writing a
 * denied command to a file first does not change the verdict (security
 * audit 2026-08-17, H3). Runs the hook in-process against the fake CLI.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.EGC_GUARDIAN_CLI = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');
const { run } = require('../../scripts/hooks/pre-bash-guardian-validate');

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
  console.log('\n=== Testing scripts run by an interpreter ===\n');
  let passed = 0;
  let failed = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-script-operand-'));
  const wipe = ['rm', '-rf'].join(' ');
  try {
    const denied = path.join(dir, 'notes.txt');
    fs.writeFileSync(denied, `echo start\n${wipe} /tmp/egc-victim\n`);
    const benign = path.join(dir, 'build.sh');
    fs.writeFileSync(benign, '#!/bin/bash\ncargo build\necho done\n');

    if (test('bash <file> is blocked when the file runs a denied command, whatever its name', () => {
      for (const command of [`bash ${denied}`, `sh notes.txt`, `source ${denied}`, `. notes.txt`, `bash -x notes.txt`]) {
        const result = run({ tool_name: 'Bash', tool_input: { command }, cwd: dir });
        assert.strictEqual(result.exitCode, 2, `${command}: ${JSON.stringify(result)}`);
        assert.ok(result.stderr.includes('BLOCKED'), result.stderr);
      }
    })) passed++; else failed++;

    if (test('bash <file> passes when the script is benign, and a missing file changes nothing', () => {
      for (const command of [`bash ${benign}`, 'bash does-not-exist.sh', 'bash']) {
        const result = run({ tool_name: 'Bash', tool_input: { command }, cwd: dir });
        assert.strictEqual(result.exitCode, 0, `${command}: ${JSON.stringify(result)}`);
      }
    })) passed++; else failed++;

    if (test('a non-interpreter command with a script operand is not read', () => {
      const result = run({ tool_name: 'Bash', tool_input: { command: `cat ${denied}` }, cwd: dir });
      assert.strictEqual(result.exitCode, 0, JSON.stringify(result));
    })) passed++; else failed++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
