/**
 * hooks/memory-persistence/hooks.json is a verbatim subset of hooks/hooks.json:
 * the lifecycle entries that load and save project memory. This test keeps the
 * slice from drifting: every hook in the slice must exist, byte for byte, under
 * the same event and matcher in the root file, and the slice must carry every
 * root hook that runs a memory script.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT_HOOKS = path.join(__dirname, '..', '..', 'hooks', 'hooks.json');
const SLICE_HOOKS = path.join(__dirname, '..', '..', 'hooks', 'memory-persistence', 'hooks.json');
const MEMORY_EVENTS = ['SessionStart', 'PreCompact', 'Stop', 'SessionEnd'];
const MEMORY_SCRIPT_RE = /egc-memory-load|egc-memory-save|pre-compact\.js|session-memory-miner|session-end-marker|session-auto-learn|session-end\.js/;

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${error.message}`);
    failed++;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function commandsByEvent(hooksDocument, events) {
  const result = {};
  for (const event of events) {
    const groups = hooksDocument.hooks[event] || [];
    result[event] = groups.flatMap(group => group.hooks.map(hook => `${group.matcher || ''} ${hook.command}`));
  }
  return result;
}

console.log('\n=== hooks/memory-persistence parity ===');

const root = readJson(ROOT_HOOKS);
const slice = readJson(SLICE_HOOKS);

test('the slice declares the same schema as the root file', () => {
  assert.strictEqual(slice.$schema, root.$schema);
});

test('the slice only carries the four memory lifecycle events', () => {
  assert.deepStrictEqual(Object.keys(slice.hooks).sort(), [...MEMORY_EVENTS].sort());
});

const rootCommands = commandsByEvent(root, MEMORY_EVENTS);
const sliceCommands = commandsByEvent(slice, MEMORY_EVENTS);

for (const event of MEMORY_EVENTS) {
  test(`every ${event} hook in the slice exists verbatim in hooks/hooks.json`, () => {
    for (const entry of sliceCommands[event]) {
      assert.ok(rootCommands[event].includes(entry), `slice entry missing from root ${event}: ${entry.split(' ')[1].slice(0, 120)}`);
    }
  });

  test(`every ${event} hook that runs a memory script is in the slice`, () => {
    const expected = rootCommands[event].filter(entry => MEMORY_SCRIPT_RE.test(entry));
    assert.ok(expected.length > 0, `root ${event} has no memory hook`);
    for (const entry of expected) {
      assert.ok(sliceCommands[event].includes(entry), `root memory hook missing from slice ${event}: ${entry.split(' ')[1].slice(0, 120)}`);
    }
  });

  test(`no ${event} hook in the slice is unrelated to memory`, () => {
    for (const entry of sliceCommands[event]) {
      assert.ok(MEMORY_SCRIPT_RE.test(entry), `non-memory hook in slice ${event}: ${entry.split(' ')[1].slice(0, 120)}`);
    }
  });
}

console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) process.exit(1);
