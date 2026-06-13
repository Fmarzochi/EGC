/**
 * Tests for `compress_observations` ruleBasedCompress logic.
 *
 * Run with: node tests/compress.test.js
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.stack}`);
    return false;
  }
}

let passed = 0;
let failed = 0;

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'compress.js');

if (!fs.existsSync(buildPath)) {
  console.log(`[SKIP] ${buildPath} not found. Run 'npm run build' in mcp/servers/egc-memory first.`);
  process.exit(0);
}

const { ruleBasedCompress } = require(buildPath);

if (
  test('detects tool_failure with exact patterns', () => {
    const result = ruleBasedCompress({
      id: 'obs-1',
      tool: 'bash',
      output: 'Error: expect(token).toBeDefined() - received undefined\n  at auth/login.test.ts:42',
    });
    assert.strictEqual(result.type, 'tool_failure');
    assert.ok(result.importance >= 0.7, 'Importance should be high for failure');
    assert.ok(result.facts.length > 0, 'Should extract facts');
    assert.ok(result.title.includes('Error: expect'), 'Title should extract error snippet');
  })
) passed++; else failed++;

if (
  test('detects tool_success with exact patterns', () => {
    const result = ruleBasedCompress({
      tool: 'bash',
      output: '✓ All 42 tests passed successfully',
    });
    assert.strictEqual(result.type, 'tool_success');
    assert.ok(result.importance < 0.7, 'Importance should be low for success');
    assert.strictEqual(result.facts[0], '✓ All 42 tests passed successfully');
  })
) passed++; else failed++;

if (
  test('detects file_edit for file operations', () => {
    const result = ruleBasedCompress({
      tool: 'write_file',
      output: 'written',
      path: 'src/auth.ts',
    });
    assert.strictEqual(result.type, 'file_edit');
    assert.ok(result.facts.includes('Tool: write_file'));
    assert.ok(result.facts.includes('File: src/auth.ts'));
  })
) passed++; else failed++;

if (
  test('always returns required fields', () => {
    const result = ruleBasedCompress({
      tool: 'bash',
      output: '',
    });
    assert.ok(result.type);
    assert.ok(result.title);
    assert.ok(Array.isArray(result.facts));
    assert.ok(typeof result.importance === 'number');
    assert.ok(Array.isArray(result.concepts));
    assert.ok(result.compressed_at);
  })
) passed++; else failed++;

if (
  test('caps facts at 6 for long outputs', () => {
    const longOutput = new Array(20).fill('Error: something went wrong at line X').join('\n');
    const result = ruleBasedCompress({
      tool: 'bash',
      output: longOutput,
    });
    assert.ok(result.facts.length <= 6, 'Facts should be capped at 6');
  })
) passed++; else failed++;

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
