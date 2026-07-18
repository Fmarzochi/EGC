'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractEgcBlock, parseBlockToStateContent, StateWatcher, mergeBlockIntoStateFile, resolveStateFilePath } = require('../../scripts/lib/watch-state');

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

  if (await test('StateWatcher fires onSync after atomic rename (editor save)', () => {
    return new Promise((resolve, reject) => {
      const dir = mktemp();
      let watcher;

      try {
        const targetPath = path.join(dir, 'GEMINI.md');
        fs.writeFileSync(targetPath, `# Gemini\n\n${SAMPLE_MDC}`);

        watcher = new StateWatcher(dir, {
          onSync({ sourceTool }) {
            try {
              assert.strictEqual(sourceTool, 'gemini');
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
          const tmpPath = targetPath + '.tmp';
          const updated = `# Gemini\n\n<!-- egc:start -->\n${SAMPLE_BLOCK}\n- Atomic save item\n<!-- egc:end -->\n`;
          fs.writeFileSync(tmpPath, updated);
          fs.renameSync(tmpPath, targetPath);
        }, 50);

        setTimeout(() => {
          watcher.stop();
          cleanup(dir);
          reject(new Error('onSync did not fire within 2s after atomic rename'));
        }, 2000);
      } catch (err) {
        if (watcher) watcher.stop();
        cleanup(dir);
        reject(err);
      }
    });
  })) passed++; else failed++;

  if (await test('mergeBlockIntoStateFile replaces multi-line Context correctly', () => {
    const dir = mktemp();
    try {
      const stateFilePath = path.join(dir, 'state.md');
      const initial = '# Project State\n\n## Context\nOld line one\nOld line two\nOld line three\n\n## Active Decisions\n- Some decision\n';
      fs.writeFileSync(stateFilePath, initial);

      const block = `**Context:** New single-line context\n\n**Active decisions:**\n- Some decision`;
      mergeBlockIntoStateFile(stateFilePath, block);

      const result = fs.readFileSync(stateFilePath, 'utf-8');
      assert.ok(result.includes('New single-line context'), 'should contain new context');
      assert.ok(!result.includes('Old line one'), 'should not contain old context first line');
      assert.ok(!result.includes('Old line two'), 'should not contain old context second line');
      assert.ok(!result.includes('Old line three'), 'should not contain old context third line');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('resolveStateFilePath prefers hashed branch state and falls back to legacy', () => {
    const projectDir = mktemp();
    const homeDir = mktemp();
    const originalHomedir = os.homedir;
    const {
      branchStateFile,
      legacyBranchStateFile,
    } = require('../../scripts/lib/branch-state');

    try {
      os.homedir = () => homeDir;
      const gitDir = path.join(projectDir, '.git');
      fs.mkdirSync(gitDir);
      fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature/auth\n');

      const stateDir = path.join(homeDir, '.egc', 'state');
      const legacyFile = legacyBranchStateFile(stateDir, projectDir, 'feature/auth');
      const currentFile = branchStateFile(stateDir, projectDir, 'feature/auth');
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, '# Legacy state\n');
      assert.strictEqual(resolveStateFilePath(projectDir), legacyFile);

      fs.writeFileSync(currentFile, '# Current state\n');
      assert.strictEqual(resolveStateFilePath(projectDir), currentFile);
    } finally {
      os.homedir = originalHomedir;
      cleanup(projectDir);
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (await test('resolveStateFilePath without branch finds main.md', () => {
    const projectDir = mktemp();
    const homeDir = mktemp();
    const originalHomedir = os.homedir;
    const stateDir = path.join(homeDir, '.egc', 'state');
    const slug = require('../../scripts/lib/branch-state').projectSlug(projectDir);
    const slugDir = path.join(stateDir, slug);
    const mainMd = path.join(slugDir, 'main.md');

    try {
      os.homedir = () => homeDir;
      fs.mkdirSync(slugDir, { recursive: true });
      fs.writeFileSync(mainMd, '# State\n');
      const result = resolveStateFilePath(projectDir);
      assert.strictEqual(result, mainMd, 'should resolve to main.md when no branch (detached HEAD or non-git dir)');
    } finally {
      os.homedir = originalHomedir;
      cleanup(projectDir);
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (await test('StateWatcher.start returns count of successful watchers only', () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, 'GEMINI.md'), SAMPLE_MDC);
      const watcher = new StateWatcher(dir);
      const count = watcher.start();
      assert.strictEqual(count, 1, 'only GEMINI.md exists and should be watched');
      watcher.stop();
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('_handleChange skips empty egc block without propagating', () => {
    return new Promise((resolve, reject) => {
      const dir = mktemp();
      let watcher;

      try {
        const emptyBlock = `<!-- egc:start -->\n   \n<!-- egc:end -->\n`;
        fs.writeFileSync(path.join(dir, 'GEMINI.md'), `# Gemini\n\n${emptyBlock}`);

        let synced = false;
        watcher = new StateWatcher(dir, {
          onSync() { synced = true; },
        });
        watcher.start();

        setTimeout(() => {
          const emptyContent = `# Gemini\n\n<!-- egc:start -->\n   \n<!-- egc:end -->\n`;
          fs.writeFileSync(path.join(dir, 'GEMINI.md'), emptyContent);
        }, 50);

        setTimeout(() => {
          watcher.stop();
          cleanup(dir);
          if (synced) {
            reject(new Error('onSync should not fire for empty block'));
          } else {
            resolve();
          }
        }, 800);
      } catch (err) {
        if (watcher) watcher.stop();
        cleanup(dir);
        reject(err);
      }
    });
  })) passed++; else failed++;

  if (await test('parseBlockToStateContent stamps updated when provided', () => {
    const state = parseBlockToStateContent(SAMPLE_BLOCK, '2026-07-08T12:00:00.000Z');
    assert.ok(state.includes('updated: 2026-07-08T12:00:00.000Z'), 'updated line missing');
    assert.ok(state.includes('## Context'), 'sections still parsed');
  })) passed++; else failed++;

  if (await test('parseBlockToStateContent ignores marker comments', () => {
    const stamped = `<!-- egc:state-updated:2026-07-01T00:00:00.000Z -->\n${SAMPLE_BLOCK}`;
    const state = parseBlockToStateContent(stamped);
    assert.ok(!state.includes('egc:state-updated'), 'marker must not leak into state');
    assert.ok(state.includes('EGC v1.1.1'), 'content still parsed');
  })) passed++; else failed++;

  if (await test('mergeBlockIntoStateFile refuses encrypted state files', () => {
    const dir = mktemp();
    try {
      const stateFile = path.join(dir, 'main.md');
      const payload = Buffer.concat([Buffer.from('EGC1:', 'utf-8'), Buffer.from('opaque-bytes')]);
      fs.writeFileSync(stateFile, payload);

      const changed = mergeBlockIntoStateFile(stateFile, SAMPLE_BLOCK);

      assert.strictEqual(changed, false);
      assert.ok(fs.readFileSync(stateFile).equals(payload), 'ciphertext must remain untouched');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
