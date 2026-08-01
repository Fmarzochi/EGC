'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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

  if (await test('upserts egc section in .cursor/rules/egc-context.mdc without destroying user content', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
      const filePath = path.join(dir, '.cursor', 'rules', 'egc-context.mdc');
      fs.writeFileSync(filePath, '---\ndescription: custom\n---\n\nDo not use var.\n', 'utf-8');

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

  if (await test('migrates a pre-fix unmarked egc-context.mdc without duplicating memory', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
      const filePath = path.join(dir, '.cursor', 'rules', 'egc-context.mdc');
      // Exactly what the old writeCursorContext used to write: frontmatter +
      // block, no markers at all.
      const legacyContent = '---\ndescription: EGC project memory (auto-updated by update_state)\nalwaysApply: true\n---\n\n## EGC Project Memory\n\n**Context:** Old stale context from before the fix.\n';
      fs.writeFileSync(filePath, legacyContent, 'utf-8');

      const result = propagateStateToTools({ projectPath: dir, ...args });
      const content = fs.readFileSync(result.cursor, 'utf-8');
      assert.ok(!content.includes('Old stale context from before the fix'), 'legacy unmarked block must not survive as duplicate content');
      assert.ok(content.includes('description: EGC project memory'), 'frontmatter must be preserved');
      assert.strictEqual((content.match(/<!-- egc:start -->/g) || []).length, 1, 'exactly one egc block after migration');
      assert.ok(content.includes('Test project in alpha phase'), 'new context must be present');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('preserves real hand-written content added after the legacy frontmatter', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
      const filePath = path.join(dir, '.cursor', 'rules', 'egc-context.mdc');
      // Same frontmatter the pre-marker writer used to produce, but with a
      // real note a human added below it instead of the auto-generated
      // block -- this must survive, unlike the pure-leftover case above.
      const realContent = '---\ndescription: EGC project memory (auto-updated by update_state)\nalwaysApply: true\n---\n\n## My own rule -- never delete this\n';
      fs.writeFileSync(filePath, realContent, 'utf-8');

      propagateStateToTools({ projectPath: dir, ...args });
      const first = fs.readFileSync(filePath, 'utf-8');
      assert.ok(first.includes('My own rule -- never delete this'), 'real content must survive the first call');

      propagateStateToTools({
        projectPath: dir,
        context: 'Second call context.',
        decisions: [{ what: 'Use ESM' }],
        next: ['Deploy to prod'],
      });
      const second = fs.readFileSync(filePath, 'utf-8');
      assert.ok(second.includes('My own rule -- never delete this'), 'real content must survive a second call too');
      assert.ok(second.includes('Second call context'), 'egc block must still update');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('does not delete real content when the end marker is orphaned (missing)', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
      const filePath = path.join(dir, '.cursor', 'rules', 'egc-context.mdc');
      const REAL = 'REAL CONTENT BEFORE ORPHAN MARKER -- MUST SURVIVE';
      // A stray edit removed <!-- egc:end --> at some point, leaving a lone
      // start marker. This historically made the SECOND call below delete
      // everything between the orphan and the freshly appended block.
      fs.writeFileSync(filePath, `${REAL}\n<!-- egc:start -->\nold block, no end marker\n`, 'utf-8');

      propagateStateToTools({ projectPath: dir, ...args });
      const after1 = fs.readFileSync(filePath, 'utf-8');
      assert.ok(after1.includes(REAL), 'real content must survive the first call');

      propagateStateToTools({ projectPath: dir, ...args });
      const after2 = fs.readFileSync(filePath, 'utf-8');
      assert.ok(after2.includes(REAL), 'real content must survive the second call too');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('collapses duplicated marker pairs to one without losing real content', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'REAL AGENTS CONTENT\n<!-- egc:start -->\nblock A\n<!-- egc:end -->\n<!-- egc:start -->\nblock B\n<!-- egc:end -->\n', 'utf-8');
      const result = propagateStateToTools({ projectPath: dir, ...args });
      const content = fs.readFileSync(result.agents, 'utf-8');
      assert.ok(content.includes('REAL AGENTS CONTENT'), 'real content must survive');
      assert.strictEqual((content.match(/<!-- egc:start -->/g) || []).length, 1, 'exactly one start marker should remain');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('does not delete real content when markers are in inverted order', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'GEMINI.md'), 'REAL GEMINI CONTENT\n<!-- egc:end -->\nstray\n<!-- egc:start -->\n', 'utf-8');
      const result = propagateStateToTools({ projectPath: dir, ...args });
      const content = fs.readFileSync(result.gemini, 'utf-8');
      assert.ok(content.includes('REAL GEMINI CONTENT'), 'real content must survive inverted markers');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('migrates a legacy cursor file saved with CRLF line endings', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
      const filePath = path.join(dir, '.cursor', 'rules', 'egc-context.mdc');
      const crlf = '---\r\ndescription: EGC project memory (auto-updated by update_state)\r\nalwaysApply: true\r\n---\r\n\r\n## EGC Project Memory\r\n\r\n**Context:** old\r\n';
      fs.writeFileSync(filePath, crlf, 'utf-8');

      const result = propagateStateToTools({ projectPath: dir, ...args });
      const content = fs.readFileSync(result.cursor, 'utf-8');
      assert.ok(!content.includes('**Context:** old'), 'old CRLF-saved block must not survive as a duplicate');
      assert.strictEqual((content.match(/<!-- egc:start -->/g) || []).length, 1, 'exactly one start marker after migration');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('upserts egc section in existing local CLAUDE.md', () => {
    const dir = mktemp();
    try {
      const claudePath = path.join(dir, 'CLAUDE.md');
      fs.writeFileSync(claudePath, '# Project instructions\n\nUse strict mode.\n', 'utf-8');
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.ok(result.claude, 'claude path should be returned');
      const content = fs.readFileSync(result.claude, 'utf-8');
      assert.ok(content.includes('Use strict mode'), 'original content preserved');
      assert.ok(content.includes('<!-- egc:start -->'), 'egc block added');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('skips local CLAUDE.md when file does not exist', () => {
    const dir = mktemp();
    try {
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.strictEqual(result.claude, null, 'claude should be null when file absent');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('upserts egc section in .roorules when .roo/rules/ has no content (fallback)', () => {
    const dir = mktemp();
    try {
      const rooPath = path.join(dir, '.roorules');
      fs.writeFileSync(rooPath, '# Roo rules\n', 'utf-8');
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.ok(result.roo, 'roo path should be returned');
      assert.strictEqual(result.roo, rooPath, 'should fall back to flat .roorules when .roo/rules/ is absent');
      const content = fs.readFileSync(result.roo, 'utf-8');
      assert.ok(content.includes('<!-- egc:start -->'), 'egc block added');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('writes .roo/rules/egc-context.md when .roo/ exists and no .roorules', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.roo'));
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.ok(result.roo, 'roo path should be returned');
      assert.ok(result.roo.endsWith(path.join('.roo', 'rules', 'egc-context.md')), 'should write under .roo/rules/');
      const content = fs.readFileSync(result.roo, 'utf-8');
      assert.ok(content.includes('<!-- egc:start -->'), 'egc block added');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('prefers populated .roo/rules/ over legacy .roorules when both exist', () => {
    const dir = mktemp();
    try {
      const rooRulesPath = path.join(dir, '.roorules');
      fs.writeFileSync(rooRulesPath, '# legacy roo rules\n', 'utf-8');
      const rulesDir = path.join(dir, '.roo', 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, 'custom.md'), '# custom rule\n', 'utf-8');

      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.ok(result.roo.endsWith(path.join('.roo', 'rules', 'egc-context.md')), 'should prefer the populated directory');
      const legacyContent = fs.readFileSync(rooRulesPath, 'utf-8');
      assert.ok(!legacyContent.includes('<!-- egc:start -->'), 'legacy .roorules must be left untouched');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('returns null instead of throwing when .roorules is structurally unreadable', () => {
    const dir = mktemp();
    try {
      // .roorules is a directory, not a file: readFileSync on it fails
      // (EISDIR) on every OS. update_state must not crash because Roo
      // Code propagation hit a bad path -- it should just skip it.
      fs.mkdirSync(path.join(dir, '.roorules'));
      assert.doesNotThrow(() => {
        const result = propagateStateToTools({ projectPath: dir, ...args });
        assert.strictEqual(result.roo, null, 'roo should be null, not throw, on a structural read error');
      });
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('skips Roo Code when neither .roorules nor .roo/ exist', () => {
    const dir = mktemp();
    try {
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.strictEqual(result.roo, null, 'roo should be null when nothing exists');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('writes .continue/rules/egc-context.md when .continue/ exists', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.continue'));
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.ok(result.continue, 'continue path should be returned');
      const content = fs.readFileSync(result.continue, 'utf-8');
      assert.ok(content.includes('<!-- egc:start -->'), 'egc block added');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('skips Continue.dev when .continue/ does not exist', () => {
    const dir = mktemp();
    try {
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.strictEqual(result.continue, null, 'continue should be null when dir absent');
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

  if (await test('configures the commit-privacy git filter automatically, without a separate egc init step (audit EGC-547)', () => {
    const dir = mktemp();
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      propagateStateToTools({ projectPath: dir, ...args });
      const attributesPath = path.join(dir, '.git', 'info', 'attributes');
      const attributes = fs.readFileSync(attributesPath, 'utf-8');
      assert.ok(attributes.includes('AGENTS.md filter=egc-memory'), 'AGENTS.md is bound to the filter');
      assert.ok(attributes.includes('CLAUDE.md filter=egc-memory'), 'CLAUDE.md is bound to the filter');
      const filterConfig = execFileSync('git', ['config', '--get', 'filter.egc-memory.clean'], {
        cwd: dir,
        encoding: 'utf-8',
      }).trim();
      assert.ok(filterConfig.includes('check-state-leak.js'), 'clean filter command is configured');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('does not throw when projectPath is not a git repository (audit EGC-547)', () => {
    const dir = mktemp();
    try {
      const result = propagateStateToTools({ projectPath: dir, ...args });
      assert.strictEqual(result.cursor, null, 'propagation still runs normally outside a git repo');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
