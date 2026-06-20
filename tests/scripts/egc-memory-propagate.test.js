'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '../../mcp/servers/egc-memory');
const PROPAGATE_PATH = path.join(SERVER_ROOT, 'build', 'propagate.js');

if (!fs.existsSync(PROPAGATE_PATH)) {
  console.error(
    `[SKIP] Missing ${PROPAGATE_PATH}. Run 'npm ci && npm run build' in mcp/servers/egc-memory first.`
  );
  process.exit(0);
}

const { propagateStateToTools } = require(PROPAGATE_PATH);

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-propagate-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
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
  console.log('\n=== Testing egc-memory propagate.ts ===\n');
  let passed = 0;
  let failed = 0;

  const args = {
    context: 'Test project in alpha phase.',
    decisions: [{ what: 'Use TypeScript', why: 'Type safety' }],
    next: ['Add rate limiting', 'Write integration tests'],
  };

  if (await test('returns null for all tools when no config dirs exist', () => {
    const dir = mktemp();
    try {
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.strictEqual(result.cursor, null, 'cursor should be null');
      assert.strictEqual(result.copilot, null, 'copilot should be null');
      assert.strictEqual(result.gemini, null, 'gemini should be null');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('writes egc-context.mdc when .cursor/ exists', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor'));
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.ok(result.cursor, 'cursor path should be returned');
      const mdc = fs.readFileSync(result.cursor, 'utf-8');
      assert.ok(mdc.includes('alwaysApply: true'), 'should have frontmatter');
      assert.ok(mdc.includes('EGC Project Memory'), 'should have section header');
      assert.ok(mdc.includes('Test project in alpha phase'), 'should have context');
      assert.ok(mdc.includes('Use TypeScript'), 'should have decision');
      assert.ok(mdc.includes('Add rate limiting'), 'should have next item');
      assert.strictEqual(result.copilot, null, 'copilot should still be null');
      assert.strictEqual(result.gemini, null, 'gemini should still be null');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('does NOT create copilot-instructions.md when only .github/ exists (bug fix)', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.github'));
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.strictEqual(result.copilot, null, 'copilot should be null when file does not exist');
      assert.ok(
        !fs.existsSync(path.join(dir, '.github', 'copilot-instructions.md')),
        'file must not be created'
      );
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('writes to copilot-instructions.md only when file already exists', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.github'));
      const filePath = path.join(dir, '.github', 'copilot-instructions.md');
      fs.writeFileSync(filePath, '# My Copilot rules\n', 'utf-8');
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.ok(result.copilot, 'copilot path should be returned');
      const content = fs.readFileSync(result.copilot, 'utf-8');
      assert.ok(content.includes('<!-- egc:start -->'), 'should have egc sentinel start');
      assert.ok(content.includes('EGC Project Memory'), 'should have section header');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('upserts egc section in copilot-instructions.md without destroying user content', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.github'));
      const filePath = path.join(dir, '.github', 'copilot-instructions.md');
      fs.writeFileSync(filePath, '# User instructions\n\nDo not use var.\n', 'utf-8');


      propagateStateToTools({ projectPath: dir, ...args });
      const first = fs.readFileSync(filePath, 'utf-8');
      assert.ok(first.includes('Do not use var'), 'original content must be preserved');
      assert.ok(first.includes('<!-- egc:start -->'), 'egc block must be present');

      propagateStateToTools({
        projectPath: dir,
        context: 'Updated context.',
        decisions: [{ what: 'Use ESM' }],
        next: ['Deploy to prod'],
      });
      const second = fs.readFileSync(filePath, 'utf-8');
      assert.ok(second.includes('Do not use var'), 'original content preserved after update');
      assert.ok(second.includes('Updated context'), 'context should be updated');
      assert.ok(!second.includes('Test project in alpha phase'), 'old context should be gone');
      assert.strictEqual(
        (second.match(/<!-- egc:start -->/g) || []).length,
        1,
        'only one egc block'
      );
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('upserts egc section in existing GEMINI.md', () => {
    const dir = mktemp();
    try {
      const geminiPath = path.join(dir, 'GEMINI.md');
      fs.writeFileSync(geminiPath, '# Gemini instructions\n\nFollow the style guide.\n', 'utf-8');
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.ok(result.gemini, 'gemini path should be returned');
      const content = fs.readFileSync(result.gemini, 'utf-8');
      assert.ok(content.includes('Follow the style guide'), 'original content preserved');
      assert.ok(content.includes('<!-- egc:start -->'), 'egc block added');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('skips GEMINI.md when file does not exist', () => {
    const dir = mktemp();
    try {
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.strictEqual(result.gemini, null, 'gemini should be null when file absent');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('handles missing context and next gracefully', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor'));
      const result = propagateStateToTools({ projectPath: dir });
      assert.ok(result.cursor, 'cursor path should be returned');
      const mdc = fs.readFileSync(result.cursor, 'utf-8');
      assert.ok(mdc.includes('EGC Project Memory'), 'header present');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
