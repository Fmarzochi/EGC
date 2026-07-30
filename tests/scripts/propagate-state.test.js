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

  if (test('does not create cursor context when .cursor/ absent', () => {
    const dir = mktemp();
    try {
      const result = propagateStateContent(dir, SAMPLE_STATE);
      assert.strictEqual(result.cursor, null);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('preserves real hand-written content added after the legacy cursor frontmatter', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
      const filePath = path.join(dir, '.cursor', 'rules', 'egc-context.mdc');
      // Same frontmatter this writer used to produce unconditionally before
      // this fix, but with a real note a human added below it -- must survive.
      const realContent = '---\ndescription: EGC project memory (auto-updated)\nalwaysApply: true\n---\n\n## My own rule -- never delete this\n';
      fs.writeFileSync(filePath, realContent, 'utf-8');

      propagateStateContent(dir, SAMPLE_STATE);
      const first = fs.readFileSync(filePath, 'utf-8');
      assert.ok(first.includes('My own rule -- never delete this'), 'real content must survive the first call');

      const newerState = SAMPLE_STATE.replace('updated: 2026-06-20T00:00:00.000Z', 'updated: 2026-07-01T00:00:00.000Z');
      propagateStateContent(dir, newerState);
      const second = fs.readFileSync(filePath, 'utf-8');
      assert.ok(second.includes('My own rule -- never delete this'), 'real content must survive a second call too');
      assert.ok(second.includes('<!-- egc:start -->'), 'egc block must be present');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('migrates a pre-fix unmarked cursor context without duplicating memory', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
      const filePath = path.join(dir, '.cursor', 'rules', 'egc-context.mdc');
      // Exactly what this writer used to produce before this fix: frontmatter
      // + block, no markers at all.
      const legacyContent = '---\ndescription: EGC project memory (auto-updated)\nalwaysApply: true\n---\n\n## EGC Project Memory\n\n**Context:** Old stale context from before the fix.\n';
      fs.writeFileSync(filePath, legacyContent, 'utf-8');

      const result = propagateStateContent(dir, SAMPLE_STATE);
      const content = fs.readFileSync(result.cursor, 'utf-8');
      assert.ok(!content.includes('Old stale context from before the fix'), 'legacy unmarked block must not survive as duplicate content');
      assert.ok(content.includes('description: EGC project memory'), 'frontmatter must be preserved');
      assert.strictEqual((content.match(/<!-- egc:start -->/g) || []).length, 1, 'exactly one egc block after migration');
      assert.ok(content.includes('EGC v1.1.1 stable'), 'new context must be present');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('does not delete real content when the end marker is orphaned (missing)', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
      const filePath = path.join(dir, '.cursor', 'rules', 'egc-context.mdc');
      const REAL = 'REAL CONTENT BEFORE ORPHAN MARKER -- MUST SURVIVE';
      fs.writeFileSync(filePath, `${REAL}\n<!-- egc:start -->\nold block, no end marker\n`, 'utf-8');

      propagateStateContent(dir, SAMPLE_STATE);
      const after1 = fs.readFileSync(filePath, 'utf-8');
      assert.ok(after1.includes(REAL), 'real content must survive the first call');

      const newerState = SAMPLE_STATE.replace('updated: 2026-06-20T00:00:00.000Z', 'updated: 2026-07-01T00:00:00.000Z');
      propagateStateContent(dir, newerState);
      const after2 = fs.readFileSync(filePath, 'utf-8');
      assert.ok(after2.includes(REAL), 'real content must survive the second call too');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('collapses duplicated marker pairs to one without losing real content', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'REAL AGENTS CONTENT\n<!-- egc:start -->\nblock A\n<!-- egc:end -->\n<!-- egc:start -->\nblock B\n<!-- egc:end -->\n', 'utf-8');
      const result = propagateStateContent(dir, SAMPLE_STATE);
      const content = fs.readFileSync(result.agents, 'utf-8');
      assert.ok(content.includes('REAL AGENTS CONTENT'), 'real content must survive');
      assert.strictEqual((content.match(/<!-- egc:start -->/g) || []).length, 1, 'exactly one start marker should remain');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('does not delete real content when markers are in inverted order', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'GEMINI.md'), 'REAL GEMINI CONTENT\n<!-- egc:end -->\nstray\n<!-- egc:start -->\n', 'utf-8');
      const result = propagateStateContent(dir, SAMPLE_STATE);
      const content = fs.readFileSync(result.gemini, 'utf-8');
      assert.ok(content.includes('REAL GEMINI CONTENT'), 'real content must survive inverted markers');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('migrates a legacy cursor file saved with CRLF line endings', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
      const filePath = path.join(dir, '.cursor', 'rules', 'egc-context.mdc');
      const crlf = '---\r\ndescription: EGC project memory (auto-updated)\r\nalwaysApply: true\r\n---\r\n\r\n## EGC Project Memory\r\n\r\n**Context:** old\r\n';
      fs.writeFileSync(filePath, crlf, 'utf-8');

      const result = propagateStateContent(dir, SAMPLE_STATE);
      const content = fs.readFileSync(result.cursor, 'utf-8');
      assert.ok(!content.includes('**Context:** old'), 'old CRLF-saved block must not survive as a duplicate');
      assert.strictEqual((content.match(/<!-- egc:start -->/g) || []).length, 1, 'exactly one start marker after migration');
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

  const freshness = runFreshnessGuardTests();
  passed += freshness.passed;
  failed += freshness.failed;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

function runFreshnessGuardTests() {
  let passed = 0;
  let failed = 0;

  if (test('stamps mirrors with the state updated timestamp', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
      propagateStateContent(dir, SAMPLE_STATE);
      const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
      assert.ok(
        content.includes('<!-- egc:state-updated:2026-06-20T00:00:00.000Z -->'),
        'freshness stamp missing'
      );
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('older state does not overwrite a mirror stamped by a newer one', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
      const newerState = SAMPLE_STATE
        .replace('updated: 2026-06-20T00:00:00.000Z', 'updated: 2026-07-01T00:00:00.000Z')
        .replace('EGC v1.1.1 stable on npm.', 'EGC v1.2.0 fresh context.');
      propagateStateContent(dir, newerState);

      const result = propagateStateContent(dir, SAMPLE_STATE);

      assert.ok(result.agents, 'mirror still reported as managed');
      const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
      assert.ok(content.includes('EGC v1.2.0 fresh context.'), 'newer content preserved');
      assert.ok(!content.includes('EGC v1.1.1 stable'), 'stale content must not roll the mirror back');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('unstamped state does not downgrade a stamped mirror', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
      propagateStateContent(dir, SAMPLE_STATE);
      const unstamped = SAMPLE_STATE
        .replace('updated: 2026-06-20T00:00:00.000Z\n', '')
        .replace('EGC v1.1.1 stable on npm.', 'anonymous rollback content');

      propagateStateContent(dir, unstamped);

      const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
      assert.ok(content.includes('EGC v1.1.1 stable'), 'stamped content preserved');
      assert.ok(!content.includes('anonymous rollback content'), 'undated source must not win');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('newer state overwrites an older stamped mirror', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
      propagateStateContent(dir, SAMPLE_STATE);
      const newerState = SAMPLE_STATE
        .replace('updated: 2026-06-20T00:00:00.000Z', 'updated: 2026-07-01T00:00:00.000Z')
        .replace('EGC v1.1.1 stable on npm.', 'EGC v1.2.0 fresh context.');

      propagateStateContent(dir, newerState);

      const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
      assert.ok(content.includes('EGC v1.2.0 fresh context.'), 'newer content applied');
      assert.ok(
        content.includes('<!-- egc:state-updated:2026-07-01T00:00:00.000Z -->'),
        'stamp advanced to the newer timestamp'
      );
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  return { passed, failed };
}

runTests();
