'use strict';
/**
 * Tests for mcp/servers/egc-memory/src/global-state.ts
 *
 * Covers the global memory appendix merged into get_state: section caps,
 * deduplication against project state (project/branch entries win), empty
 * results collapsing to null, and non-array sections being ignored.
 *
 * Run with: node tests/egc-memory-global-state.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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

let passed = 0;
let failed = 0;

const buildPath = path.join(
  __dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'global-state.js'
);

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-memory first.');
  process.exit(0);
}

const { buildGlobalAppendix, globalStateFilePath } = require(buildPath);

console.log('\n=== Testing egc-memory global state ===\n');

const run = (name, fn) => { if (test(name, fn)) passed++; else failed++; };

run('returns null for an empty global doc', () => {
  assert.strictEqual(buildGlobalAppendix({}, ''), null);
});

run('returns null when all global entries already exist in project state', () => {
  const doc = { Preferences: ['Use yarn', 'No em dashes'] };
  const project = '## Preferences\n- Use yarn\n- No em dashes\n';
  assert.strictEqual(buildGlobalAppendix(doc, project), null);
});

run('renders known sections with heading and bullets', () => {
  const doc = { Preferences: ['Use yarn'], 'Active Decisions': ['Ship weekly'] };
  const out = buildGlobalAppendix(doc, '');
  assert.ok(out.includes('## Global Memory (all projects)'));
  assert.ok(out.includes('### Preferences'));
  assert.ok(out.includes('- Use yarn'));
  assert.ok(out.includes('### Active Decisions'));
  assert.ok(out.includes('- Ship weekly'));
});

run('caps each section at 5 entries', () => {
  const doc = { Preferences: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] };
  const out = buildGlobalAppendix(doc, '');
  assert.ok(out.includes('- p5'));
  assert.ok(!out.includes('- p6'));
});

run('dedup happens before the cap so project overlap does not starve the section', () => {
  const doc = { Preferences: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] };
  const project = '## Preferences\n- p1\n- p2\n';
  const out = buildGlobalAppendix(doc, project);
  assert.ok(!out.includes('- p1'));
  assert.ok(out.includes('- p3'));
  assert.ok(out.includes('- p6'));
});

run('ignores scalar sections and unknown headings', () => {
  const doc = { Context: 'a scalar context', Unknown: ['x'], 'Do Not Repeat': ['never force push main'] };
  const out = buildGlobalAppendix(doc, '');
  assert.ok(!out.includes('scalar'));
  assert.ok(!out.includes('- x'));
  assert.ok(out.includes('### Do Not Repeat'));
});

run('skips blank entries', () => {
  const doc = { Preferences: ['  ', ''] };
  assert.strictEqual(buildGlobalAppendix(doc, ''), null);
});

run('globalStateFilePath points inside ~/.egc/global', () => {
  const p = globalStateFilePath();
  assert.ok(p.endsWith(path.join('.egc', 'global', 'state.md')));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
