'use strict';

/**
 * The installation guide says what auto-intuition and egc watch need, and
 * those statements follow the code (#1666): the intent classifier only runs
 * with one of the provider keys intuition.ts checks and stops on
 * EGC_INTUITION_LLM, and egc watch watches one project, the current
 * directory unless a path or --project is given.
 *
 * Run with: node tests/docs/installation-intuition-watch.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

console.log('\n=== Testing the installation guide on auto-intuition and egc watch ===\n');

const guide = fs.readFileSync(path.join(repoRoot, 'docs/installation.md'), 'utf8');
const intuition = fs.readFileSync(path.join(repoRoot, 'mcp/servers/egc-guardian/src/intuition.ts'), 'utf8');
const watch = fs.readFileSync(path.join(repoRoot, 'scripts/watch.js'), 'utf8');

// The provider keys hasProviderKey() reads, taken from the code itself so a
// new key fails this test until the guide names it too.
function providerKeys() {
  const body = intuition.match(/function hasProviderKey\(\)[\s\S]*?\n}/);
  assert.ok(body, 'intuition.ts must define hasProviderKey()');
  const keys = [...body[0].matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(match => match[1]);
  assert.ok(keys.length > 0, 'hasProviderKey() must read at least one provider key');
  return keys;
}

test('the guide names every provider key the intent classifier accepts', () => {
  for (const key of providerKeys()) {
    assert.ok(guide.includes(`\`${key}\``), `docs/installation.md must name ${key}`);
  }
});

test('the guide names the switch that turns the classifier off', () => {
  assert.ok(intuition.includes('EGC_INTUITION_LLM'), 'intuition.ts must still read EGC_INTUITION_LLM');
  assert.ok(guide.includes('EGC_INTUITION_LLM=0'), 'docs/installation.md must document EGC_INTUITION_LLM=0');
});

test('the egc watch row says it watches one project and how to pick it', () => {
  assert.ok(/projectPath: process\.cwd\(\)/.test(watch), 'watch.js must default to the current directory');
  assert.ok(watch.includes("'--project'"), 'watch.js must accept --project');
  const row = guide.split('\n').find(line => line.startsWith('| `egc watch` |'));
  assert.ok(row, 'docs/installation.md must list egc watch in the command reference');
  assert.ok(/current directory/.test(row), 'the egc watch row must say it watches the current directory');
  assert.ok(row.includes('`--project`'), 'the egc watch row must mention --project');
});

if (failed > 0) {
  console.log(`\nFailed: ${failed}`);
  process.exit(1);
}

console.log(`\nPassed: ${passed}`);
