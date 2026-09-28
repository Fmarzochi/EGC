#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'doc-file-warning.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function runScript(input) {
  const result = spawnSync('node', [script], {
    encoding: 'utf8',
    input: JSON.stringify(input),
    timeout: 10000,
  });
  return { code: result.status || 0, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function runTests() {
  console.log('\n=== Testing doc-file-warning.js (denylist policy) ===\n');
  let passed = 0;
  let failed = 0;
  const tally = ok => (ok ? passed++ : failed++);

  // 1. Standard doc filenames - never on denylist, no warning
  const standardFiles = [
    'README.md',
    'GEMINI.md',
    'AGENTS.md',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    'LICENSE.md',
    'SKILL.md',
    'MEMORY.md',
    'WORKLOG.md',
  ];
  for (const file of standardFiles) {
    (tally(test(`allows standard doc file: ${file}`, () => {
      const { code, stderr } = runScript({ tool_input: { file_path: file } });
      assert.strictEqual(code, 0, `expected exit code 0, got ${code}`);
      assert.strictEqual(stderr, '', `expected no warning for ${file}, got: ${stderr}`);
    })));
  }

  // 2. Structured directory paths - no warning even for ad-hoc names
  const structuredDirPaths = [
    'docs/foo.md',
    'docs/guide/setup.md',
    'docs/TODO.md',
    'docs/specs/NOTES.md',
    'skills/bar.md',
    'skills/testing/tdd.md',
    '.history/session.md',
    'memory/patterns.md',
    '.gemini/commands/deploy.md',
    '.gemini/plans/roadmap.md',
    '.gemini/projects/myproject.md',
    '.github/ISSUE_TEMPLATE/bug.md',
    'commands/triage.md',
    'benchmarks/test.md',
    'templates/DRAFT.md',
  ];
  for (const file of structuredDirPaths) {
    (tally(test(`allows structured directory path: ${file}`, () => {
      const { code, stderr } = runScript({ tool_input: { file_path: file } });
      assert.strictEqual(code, 0, `expected exit code 0, got ${code}`);
      assert.strictEqual(stderr, '', `expected no warning for ${file}, got: ${stderr}`);
    })));
  }

  // 3. Allowed .plan.md files - no warning
  (tally(test('allows .plan.md files', () => {
    const { code, stderr } = runScript({ tool_input: { file_path: 'feature.plan.md' } });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '', `expected no warning for .plan.md, got: ${stderr}`);
  })));

  (tally(test('allows nested .plan.md files', () => {
    const { code, stderr } = runScript({ tool_input: { file_path: 'src/refactor.plan.md' } });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '', `expected no warning for nested .plan.md, got: ${stderr}`);
  })));

  // 4. Non-md/txt files always pass - no warning
  const nonDocFiles = ['foo.js', 'app.py', 'styles.css', 'data.json', 'image.png'];
  for (const file of nonDocFiles) {
    (tally(test(`allows non-doc file: ${file}`, () => {
      const { code, stderr } = runScript({ tool_input: { file_path: file } });
      assert.strictEqual(code, 0);
      assert.strictEqual(stderr, '', `expected no warning for ${file}, got: ${stderr}`);
    })));
  }

  // 5. Lowercase, partial-match, and non-standard extension case - NOT on denylist
  const allowedNonDenylist = [
    'random-notes.md',
    'notes.txt',
    'scratch.md',
    'ideas.txt',
    'todo-list.md',
    'my-draft.md',
    'meeting-notes.txt',
    'TODO.MD',
    'NOTES.TXT',
  ];
  for (const file of allowedNonDenylist) {
    (tally(test(`allows non-denylist doc file: ${file}`, () => {
      const { code, stderr } = runScript({ tool_input: { file_path: file } });
      assert.strictEqual(code, 0);
      assert.strictEqual(stderr, '', `expected no warning for ${file}, got: ${stderr}`);
    })));
  }

  // 6. Ad-hoc denylist filenames at root/non-structured paths - SHOULD warn
  const deniedFiles = [
    'NOTES.md',
    'TODO.md',
    'SCRATCH.md',
    'TEMP.md',
    'DRAFT.txt',
    'BRAINSTORM.md',
    'SPIKE.md',
    'DEBUG.md',
    'WIP.txt',
    'src/NOTES.md',
    'lib/TODO.txt',
  ];
  for (const file of deniedFiles) {
    (tally(test(`warns on ad-hoc denylist file: ${file}`, () => {
      const { code, stderr } = runScript({ tool_input: { file_path: file } });
      assert.strictEqual(code, 0, 'should still exit 0 (warn only)');
      assert.ok(stderr.includes('WARNING'), `expected warning in stderr for ${file}, got: ${stderr}`);
      assert.ok(stderr.includes(file), `expected file path in stderr for ${file}`);
    })));
  }

  // 7. Windows backslash paths - normalized correctly
  (tally(test('allows ad-hoc name in structured dir with backslash path', () => {
    const { code, stderr } = runScript({ tool_input: { file_path: 'docs\\specs\\NOTES.md' } });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '', 'expected no warning for structured dir with backslash');
  })));

  (tally(test('warns on ad-hoc name with backslash in non-structured dir', () => {
    const { code, stderr } = runScript({ tool_input: { file_path: 'src\\SCRATCH.md' } });
    assert.strictEqual(code, 0, 'should still exit 0');
    assert.ok(stderr.includes('WARNING'), 'expected warning for non-structured backslash path');
  })));

  // 8. Invalid/empty input - passes through without error
  (tally(test('handles empty object input without error', () => {
    const { code, stderr } = runScript({});
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '', `expected no warning for empty input, got: ${stderr}`);
  })));

  (tally(test('handles missing file_path without error', () => {
    const { code, stderr } = runScript({ tool_input: {} });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '', `expected no warning for missing file_path, got: ${stderr}`);
  })));

  (tally(test('handles empty file_path without error', () => {
    const { code, stderr } = runScript({ tool_input: { file_path: '' } });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '', `expected no warning for empty file_path, got: ${stderr}`);
  })));

  // 9. Malformed input - passes through without error
  (tally(test('handles non-JSON input without error', () => {
    const result = spawnSync('node', [script], {
      encoding: 'utf8',
      input: 'not-json',
      timeout: 10000,
    });
    assert.strictEqual(result.status || 0, 0);
    assert.strictEqual(result.stderr || '', '');
    assert.strictEqual(result.stdout, 'not-json');
  })));

  // 10. Stdout always contains the original input (pass-through)
  (tally(test('passes through input to stdout for allowed file', () => {
    const input = { tool_input: { file_path: 'README.md' } };
    const { stdout } = runScript(input);
    assert.strictEqual(stdout, JSON.stringify(input));
  })));

  (tally(test('passes through input to stdout for warned file', () => {
    const input = { tool_input: { file_path: 'TODO.md' } };
    const { stdout } = runScript(input);
    assert.strictEqual(stdout, JSON.stringify(input));
  })));

  (tally(test('passes through input to stdout for empty input', () => {
    const input = {};
    const { stdout } = runScript(input);
    assert.strictEqual(stdout, JSON.stringify(input));
  })));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
