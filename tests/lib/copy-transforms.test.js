/**
 * Tests for scripts/lib/install/copy-transforms.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CLAUDE_AGENT_FRONTMATTER_TRANSFORM,
  plannedFileContent,
  toClaudeAgentFrontmatter,
  transformContent,
} = require('../../scripts/lib/install/copy-transforms');

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

const AGENT = [
  '---',
  'name: Code-Reviewer',
  'description: Expert code review specialist. MUST BE USED for all code changes.',
  'tools: ["Read", "Grep", "Glob", "Bash"]',
  'model: gemini-3.1-pro',
  'stack: ["*"]',
  'color: blue',
  '---',
  '',
  '# Code Reviewer',
  '',
  'tools: ["not", "frontmatter"]',
  '',
].join('\n');

function runTests() {
  console.log('\n=== Testing copy-transforms.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('rewrites the tools list as the comma-separated string Claude Code reads', () => {
    const output = toClaudeAgentFrontmatter(AGENT);
    assert.ok(output.includes('\ntools: Read, Grep, Glob, Bash\n'), output);
    assert.ok(!output.includes('tools: ["Read"'), 'the flow sequence must be gone from the frontmatter');
  })) passed++; else failed++;

  if (test('drops a model Claude Code cannot run and keeps one it can', () => {
    const output = toClaudeAgentFrontmatter(AGENT);
    assert.ok(!output.includes('gemini-3.1-pro'), 'a Gemini model id must not reach ~/.claude/agents');
    const kept = toClaudeAgentFrontmatter(AGENT.replace('model: gemini-3.1-pro', 'model: sonnet'));
    assert.ok(kept.includes('\nmodel: sonnet\n'), kept);
  })) passed++; else failed++;

  if (test('drops the catalog-only stack field, keeps color, lowercases the name', () => {
    const output = toClaudeAgentFrontmatter(AGENT);
    assert.ok(!output.includes('stack:'), 'stack is EGC catalog metadata');
    assert.ok(output.includes('\ncolor: blue\n'), 'color is a Claude Code field');
    assert.ok(output.includes('\nname: code-reviewer\n'), output);
  })) passed++; else failed++;

  if (test('leaves the body untouched, including a tools line in prose', () => {
    const output = toClaudeAgentFrontmatter(AGENT);
    assert.ok(output.endsWith('\n# Code Reviewer\n\ntools: ["not", "frontmatter"]\n'), output);
  })) passed++; else failed++;

  if (test('accepts an unquoted flow sequence', () => {
    const output = toClaudeAgentFrontmatter(AGENT.replace('tools: ["Read", "Grep", "Glob", "Bash"]', 'tools: [Read, Grep]'));
    assert.ok(output.includes('\ntools: Read, Grep\n'), output);
  })) passed++; else failed++;

  if (test('recognizes the frontmatter through a byte order mark and CRLF line endings', () => {
    const windowsAgent = '\uFEFF' + AGENT.replaceAll('\n', '\r\n');
    const output = toClaudeAgentFrontmatter(windowsAgent);
    assert.ok(output.includes('\ntools: Read, Grep, Glob, Bash\n'), output);
    assert.ok(!output.includes('gemini-3.1-pro') && !output.includes('stack:'), output);
    assert.ok(!output.includes('\uFEFF') && !output.includes('\r'), 'the transformed file is written with LF and no mark');
  })) passed++; else failed++;

  if (test('returns text without frontmatter unchanged', () => {
    const plain = '# No frontmatter\n\ntools: [x]\n';
    assert.strictEqual(toClaudeAgentFrontmatter(plain), plain);
  })) passed++; else failed++;

  if (test('transformContent applies a named transform and refuses an unknown one', () => {
    const output = transformContent(Buffer.from(AGENT, 'utf8'), CLAUDE_AGENT_FRONTMATTER_TRANSFORM);
    assert.ok(Buffer.isBuffer(output));
    assert.ok(output.toString('utf8').includes('tools: Read, Grep, Glob, Bash'));
    assert.throws(() => transformContent(Buffer.from('x'), 'no-such-transform'), /Unknown copy transform/);
  })) passed++; else failed++;

  if (test('plannedFileContent reads the source and applies the transform, or none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-transforms-'));
    try {
      const source = path.join(dir, 'agent.md');
      fs.writeFileSync(source, AGENT);
      assert.strictEqual(plannedFileContent(source).toString('utf8'), AGENT);
      assert.ok(plannedFileContent(source, CLAUDE_AGENT_FRONTMATTER_TRANSFORM).toString('utf8').includes('tools: Read, Grep, Glob, Bash'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
