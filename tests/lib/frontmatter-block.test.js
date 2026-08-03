/**
 * Tests for scripts/lib/frontmatter-block.js -- the shared frontmatter-block
 * delimiter detector extracted from validate-agents.js,
 * validate-skill-frontmatter.js, and validate-commands.js (EGC-539 audit,
 * Finding 5).
 */

const assert = require('assert');

const { extractFrontmatterBlock } = require('../../scripts/lib/frontmatter-block');

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

function runTests() {
  console.log('\n=== Testing scripts/lib/frontmatter-block.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('returns { error: "missing" } when content does not start with ---', () => {
    assert.deepStrictEqual(extractFrontmatterBlock('# No frontmatter here\n'), { error: 'missing' });
  })) passed++; else failed++;

  if (test('returns { error: "unterminated" } when the closing --- is absent', () => {
    assert.deepStrictEqual(extractFrontmatterBlock('---\nname: x\ndescription: x\n'), { error: 'unterminated' });
  })) passed++; else failed++;

  if (test('returns the raw block text between the delimiters on success', () => {
    const result = extractFrontmatterBlock('---\nname: x\ndescription: y\n---\nbody');
    assert.deepStrictEqual(result, { raw: 'name: x\ndescription: y' });
  })) passed++; else failed++;

  if (test('supports CRLF line endings', () => {
    const result = extractFrontmatterBlock('---\r\nname: x\r\n---\r\nbody');
    assert.deepStrictEqual(result, { raw: 'name: x' });
  })) passed++; else failed++;

  if (test('strips a leading UTF-8 BOM before detecting the opening delimiter', () => {
    const result = extractFrontmatterBlock('﻿---\nname: x\n---\nbody');
    assert.deepStrictEqual(result, { raw: 'name: x' });
  })) passed++; else failed++;

  if (test('treats an empty block (--- immediately followed by ---) as a valid empty raw string', () => {
    const result = extractFrontmatterBlock('---\n\n---\nbody');
    assert.deepStrictEqual(result, { raw: '' });
  })) passed++; else failed++;

  if (test('does not require trailing content after the closing --- (EOF right after)', () => {
    const result = extractFrontmatterBlock('---\nname: x\n---');
    assert.deepStrictEqual(result, { raw: 'name: x' });
  })) passed++; else failed++;

  if (test('matches the first closing --- non-greedily, not a later one', () => {
    const result = extractFrontmatterBlock('---\nname: x\n---\nbody\n\n---\nnot part of frontmatter\n---');
    assert.deepStrictEqual(result, { raw: 'name: x' });
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
