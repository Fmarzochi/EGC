'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { propagateStateContent } = require('../../scripts/lib/propagate-state');

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-propagate-state-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const SAMPLE_STATE = `# Project State
project: /home/user/myproject
updated: 2026-06-20T00:00:00.000Z

## Context
EGC v1.1.1 stable on npm.

## Active Decisions
- Use sql.js instead of better-sqlite3: Pure JS, no native module required
- DCO sign-off mandatory: Legal requirement

## Do Not Repeat
- Bump version without authorization: Breaks release flow

## Preferences
- Delete branch after merge

## Next Session
- Fix propagation hooks
- Open issue for bidirectional sync
`;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing scripts/lib/propagate-state.js ===\n');
  let passed = 0;
  let failed = 0;

  if (test('propagates to cursor when .cursor/ exists', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor'));
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.ok(result.cursor, 'cursor path should be returned');
      const mdc = fs.readFileSync(result.cursor, 'utf-8');
      assert.ok(mdc.includes('alwaysApply: true'), 'frontmatter present');
      assert.ok(mdc.includes('EGC v1.1.1 stable'), 'context included');
      assert.ok(mdc.includes('sql.js'), 'decision included');
      assert.ok(mdc.includes('Fix propagation hooks'), 'next item included');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('does not create copilot-instructions.md when only .github/ exists', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.github'));
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.strictEqual(result.copilot, null);
      assert.ok(!fs.existsSync(path.join(dir, '.github', 'copilot-instructions.md')));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('updates copilot-instructions.md when it already exists', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.github'));
      fs.writeFileSync(path.join(dir, '.github', 'copilot-instructions.md'), '# Rules\n');
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.ok(result.copilot, 'copilot path returned');
      const content = fs.readFileSync(result.copilot, 'utf-8');
      assert.ok(content.includes('# Rules'), 'user content preserved');
      assert.ok(content.includes('<!-- egc:start -->'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('propagates to GEMINI.md when it exists', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'GEMINI.md'), '# Gemini config\n');
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.ok(result.gemini);
      const content = fs.readFileSync(result.gemini, 'utf-8');
      assert.ok(content.includes('# Gemini config'));
      assert.ok(content.includes('EGC Project Memory'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('returns all null when no tool configs exist', () => {
    const dir = mktemp();
    try {
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.strictEqual(result.cursor, null);
      assert.strictEqual(result.copilot, null);
      assert.strictEqual(result.gemini, null);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('handles empty state content gracefully', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor'));
      const result = propagateStateContent(dir, '');
      assert.ok(result.cursor, 'cursor still written');
      const mdc = fs.readFileSync(result.cursor, 'utf-8');
      assert.ok(mdc.includes('EGC Project Memory'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
