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

  if (test('propagates to .windsurf/rules/egc-context.md when .windsurf/ dir exists', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.windsurf'));
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.ok(result.windsurf, 'windsurf path returned');
      assert.ok(result.windsurf.includes(path.join('.windsurf', 'rules', 'egc-context.md')));
      const content = fs.readFileSync(result.windsurf, 'utf-8');
      assert.ok(content.includes('<!-- egc:start -->'));
      assert.ok(content.includes('EGC Project Memory'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('does not create windsurf context when .windsurf/ dir absent', () => {
    const dir = mktemp();
    try {
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.strictEqual(result.windsurf, null);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('propagates to .trae/rules/egc-context.md when .trae/ dir exists (Trae)', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.trae'));
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.ok(result.trae, 'trae path returned');
      assert.ok(result.trae.includes(path.join('.trae', 'rules', 'egc-context.md')));
      const content = fs.readFileSync(result.trae, 'utf-8');
      assert.ok(content.includes('EGC Project Memory'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('does not create trae context when .trae/ dir absent', () => {
    const dir = mktemp();
    try {
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.strictEqual(result.trae, null);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('propagates to .rules when it exists (Zed)', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, '.rules'), '# Zed rules\n');
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.ok(result.zed, 'zed path returned');
      const content = fs.readFileSync(result.zed, 'utf-8');
      assert.ok(content.includes('# Zed rules'), 'original content preserved');
      assert.ok(content.includes('EGC Project Memory'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('does not create .rules when absent (Zed)', () => {
    const dir = mktemp();
    try {
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.strictEqual(result.zed, null);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('propagates to .clinerules when it exists (Cline/Roo)', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, '.clinerules'), '# Cline rules\n');
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.ok(result.cline, 'cline path returned');
      const content = fs.readFileSync(result.cline, 'utf-8');
      assert.ok(content.includes('# Cline rules'), 'original content preserved');
      assert.ok(content.includes('EGC Project Memory'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('does not create .clinerules when absent', () => {
    const dir = mktemp();
    try {
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.strictEqual(result.cline, null);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('propagates to CONVENTIONS.md when it exists (Aider)', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'CONVENTIONS.md'), '# Conventions\n');
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.ok(result.aider, 'aider path returned');
      const content = fs.readFileSync(result.aider, 'utf-8');
      assert.ok(content.includes('# Conventions'), 'original content preserved');
      assert.ok(content.includes('EGC Project Memory'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('does not create CONVENTIONS.md when absent (Aider)', () => {
    const dir = mktemp();
    try {
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.strictEqual(result.aider, null);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('propagates to .cursorrules when it exists (legacy Cursor)', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, '.cursorrules'), '# Legacy rules\n');
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.ok(result.cursorrules, 'cursorrules path returned');
      const content = fs.readFileSync(result.cursorrules, 'utf-8');
      assert.ok(content.includes('# Legacy rules'), 'original content preserved');
      assert.ok(content.includes('EGC Project Memory'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('does not create .cursorrules when absent', () => {
    const dir = mktemp();
    try {
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.strictEqual(result.cursorrules, null);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('propagates to AGENTS.md when it exists (Codex, OpenCode, Amp, Kiro)', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n\nDo not run tests in watch mode.\n');
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.ok(result.agents, 'agents path returned');
      const content = fs.readFileSync(result.agents, 'utf-8');
      assert.ok(content.includes('Do not run tests in watch mode'), 'original content preserved');
      assert.ok(content.includes('EGC Project Memory'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('does not create AGENTS.md when absent', () => {
    const dir = mktemp();
    try {
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.strictEqual(result.agents, null);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('propagates to llms.txt when it exists', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'llms.txt'), '# Project context\n\nThis is a Node.js CLI tool.\n');
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.ok(result.llms, 'llms path returned');
      const content = fs.readFileSync(result.llms, 'utf-8');
      assert.ok(content.includes('This is a Node.js CLI tool'), 'original content preserved');
      assert.ok(content.includes('EGC Project Memory'));
      assert.ok(content.includes('Fix propagation hooks'), 'next item present');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('does not create llms.txt when absent', () => {
    const dir = mktemp();
    try {
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.strictEqual(result.llms, null);
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
      assert.strictEqual(result.windsurf, null);
      assert.strictEqual(result.trae, null);
      assert.strictEqual(result.zed, null);
      assert.strictEqual(result.cline, null);
      assert.strictEqual(result.aider, null);
      assert.strictEqual(result.cursorrules, null);
      assert.strictEqual(result.agents, null);
      assert.strictEqual(result.llms, null);
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
