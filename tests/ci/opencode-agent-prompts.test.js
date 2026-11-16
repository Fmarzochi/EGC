'use strict';
/**
 * Every agent under agents/ has its OpenCode prompt under
 * .opencode/prompts/agents, and that prompt is the body of the definition:
 * a new agent without a prompt, or a prompt edited away from its source,
 * fails here until node scripts/opencode-agent-prompts.js runs (#2141).
 *
 * Run with: node tests/ci/opencode-agent-prompts.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { agentPromptBody, driftReport, writePrompts } = require('../../scripts/opencode-agent-prompts');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('\n=== OpenCode agent prompts in step with agents/ ===\n');

test('the prompt is the agent body without the frontmatter, with one final newline', () => {
  assert.strictEqual(agentPromptBody('---\nname: x\ntools: ["Read"]\n---\n\nYou are x.\n\n## Role\n- a\n'), 'You are x.\n\n## Role\n- a\n');
  assert.strictEqual(agentPromptBody('---\r\nname: x\r\n---\r\nYou are x.\r\n'), 'You are x.\n');
  assert.strictEqual(agentPromptBody('No frontmatter at all'), 'No frontmatter at all\n');
  assert.strictEqual(agentPromptBody(String.fromCharCode(0xFEFF) + '---\nname: x\n---\nYou are x.\n'), 'You are x.\n', 'a BOM before the dashes is still frontmatter');
  assert.strictEqual(agentPromptBody('---\nname: x\n---'), '\n', 'a frontmatter that ends with the file leaves an empty prompt, not the YAML');
});

test('every agent has a prompt, no prompt drifted and no prompt is without an agent', () => {
  const report = driftReport(ROOT);
  assert.ok(report.total >= 60, `expected the agent library, found ${report.total}`);
  assert.deepStrictEqual(report.missing, [], `agents without a prompt: ${report.missing.join(', ')}`);
  assert.deepStrictEqual(report.drifted, [], `prompts drifted from agents/: ${report.drifted.join(', ')}`);
  assert.deepStrictEqual(report.orphans, [], `prompts without an agent: ${report.orphans.join(', ')}`);
});

test('writePrompts creates a missing prompt and rewrites a drifted one, and leaves the rest untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-opencode-prompts-'));
  try {
    fs.mkdirSync(path.join(root, 'agents'));
    fs.writeFileSync(path.join(root, 'agents', 'one.md'), '---\nname: one\n---\nYou are one.\n');
    fs.writeFileSync(path.join(root, 'agents', 'two.md'), '---\nname: two\n---\nYou are two.\n');
    const promptsDir = path.join(root, '.opencode', 'prompts', 'agents');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'two.txt'), 'edited by hand\n');
    fs.writeFileSync(path.join(promptsDir, 'stray.txt'), 'no agent\n');

    const before = driftReport(root);
    assert.deepStrictEqual(before, { missing: ['one'], drifted: ['two'], orphans: ['stray'], total: 2 });

    assert.deepStrictEqual(writePrompts(root), { written: 2, total: 2 });
    assert.strictEqual(fs.readFileSync(path.join(promptsDir, 'one.txt'), 'utf8'), 'You are one.\n');
    assert.strictEqual(fs.readFileSync(path.join(promptsDir, 'two.txt'), 'utf8'), 'You are two.\n');
    assert.deepStrictEqual(writePrompts(root), { written: 0, total: 2 }, 'a second run writes nothing');
    assert.deepStrictEqual(driftReport(root).orphans, ['stray'], 'a stray prompt is reported, never deleted');

    fs.writeFileSync(path.join(promptsDir, 'one.txt'), 'You are one.\r\n');
    assert.deepStrictEqual(driftReport(root).drifted, [], 'a checkout that converted the line endings is not a drift');
    assert.deepStrictEqual(writePrompts(root), { written: 0, total: 2 }, 'and nothing is rewritten for it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
