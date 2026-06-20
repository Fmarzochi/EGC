'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractEgcBlock, parseBlockToStateContent, StateWatcher } = require('../../scripts/lib/watch-state');

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-watch-state-'));
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

const SAMPLE_BLOCK = `## EGC Project Memory

**Context:** EGC v1.1.1 stable on npm.

**Active decisions:**
- Use sql.js instead of better-sqlite3: Pure JS, no native module required
- DCO sign-off mandatory: Legal requirement

**Next session:**
- Implement bidirectional sync
- Fix propagation hooks`;

const SAMPLE_MDC = `---
description: EGC project memory (auto-updated)
alwaysApply: true
---

<!-- egc:start -->
${SAMPLE_BLOCK}
<!-- egc:end -->
`;

async function runTests() {
  console.log('\n=== Testing scripts/lib/watch-state.js ===\n');
  let passed = 0;
  let failed = 0;

  if (await test('extractEgcBlock returns block between markers', () => {
    const content = `# Header\n\n${SAMPLE_MDC}`;
    const block = extractEgcBlock(content);
    assert.ok(block, 'block should be returned');
    assert.ok(block.includes('EGC Project Memory'), 'should include heading');
    assert.ok(block.includes('sql.js'), 'should include decision');
  })) passed++; else failed++;

  if (await test('extractEgcBlock returns null when no markers', () => {
    const block = extractEgcBlock('# Just a plain file\n\nNo EGC markers here.');
    assert.strictEqual(block, null);
  })) passed++; else failed++;

  if (await test('extractEgcBlock returns null when only start marker present', () => {
    const block = extractEgcBlock('<!-- egc:start -->\nSome content');
    assert.strictEqual(block, null);
  })) passed++; else failed++;

  if (await test('parseBlockToStateContent produces parseable state content', () => {
    const state = parseBlockToStateContent(SAMPLE_BLOCK);
    assert.ok(state.includes('## Context'), 'should have Context section');
    assert.ok(state.includes('EGC v1.1.1'), 'should include context text');
  })) passed++; else failed++;

  if (await test('parseBlockToStateContent handles empty block gracefully', () => {
    const state = parseBlockToStateContent('');
    assert.ok(typeof state === 'string', 'should return string');
  })) passed++; else failed++;

  if (await test('StateWatcher.start returns 0 when no tool files exist', () => {
    const dir = mktemp();
    try {
      const watcher = new StateWatcher(dir);
      const count = watcher.start();
      assert.strictEqual(count, 0, 'no files to watch in empty dir');
      watcher.stop();
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('StateWatcher.start returns count of discovered tool files', () => {
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.cursor', 'rules', 'egc-context.mdc'),
        SAMPLE_MDC
      );
      fs.writeFileSync(path.join(dir, 'GEMINI.md'), `# Gemini\n\n${SAMPLE_MDC}`);

      const watcher = new StateWatcher(dir);
      const count = watcher.start();
      assert.ok(count >= 2, `expected at least 2 watched files, got ${count}`);
      watcher.stop();
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('StateWatcher fires onSync and propagates when watched file changes', () => {
    return new Promise((resolve, reject) => {
      const dir = mktemp();
      let watcher;

      try {
        fs.writeFileSync(path.join(dir, 'GEMINI.md'), `# Gemini\n\n${SAMPLE_MDC}`);
        fs.writeFileSync(path.join(dir, 'CONVENTIONS.md'), '# Conventions\n');

        watcher = new StateWatcher(dir, {
          onSync({ sourceTool, syncedTools }) {
            try {
              assert.strictEqual(sourceTool, 'gemini', 'source tool should be gemini');
              assert.ok(syncedTools.includes('aider'), 'should sync to aider (CONVENTIONS.md)');
              watcher.stop();
              cleanup(dir);
              resolve();
            } catch (err) {
              watcher.stop();
              cleanup(dir);
              reject(err);
            }
          },
        });
        watcher.start();

        setTimeout(() => {
          const updated = `# Gemini\n\n<!-- egc:start -->\n${SAMPLE_BLOCK}\n- New next item\n<!-- egc:end -->\n`;
          fs.writeFileSync(path.join(dir, 'GEMINI.md'), updated);
        }, 50);

        // Timeout guard in case the event never fires
        setTimeout(() => {
          watcher.stop();
          cleanup(dir);
          reject(new Error('onSync did not fire within 2s after file change'));
        }, 2000);
      } catch (err) {
        if (watcher) watcher.stop();
        cleanup(dir);
        reject(err);
      }
    });
  })) passed++; else failed++;

  if (await test('StateWatcher.stop closes all watchers cleanly', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'GEMINI.md'), SAMPLE_MDC);
      const watcher = new StateWatcher(dir);
      watcher.start();
      assert.doesNotThrow(() => watcher.stop(), 'stop should not throw');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
