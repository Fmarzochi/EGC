/**
 * hooks/memory-persistence/hooks.json is a verbatim subset of hooks/hooks.json:
 * the lifecycle entries that load and save project memory. This test keeps the
 * slice from drifting in either direction: every hook in the slice, with the
 * fields of its group (id, matcher, description) and its own fields (command,
 * timeout, async), must exist byte for byte under the same event in the root
 * file, and the slice must carry every root hook that runs a memory script.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT_HOOKS = path.join(__dirname, '..', '..', 'hooks', 'hooks.json');
const SLICE_HOOKS = path.join(__dirname, '..', '..', 'hooks', 'memory-persistence', 'hooks.json');
const MEMORY_EVENTS = ['SessionStart', 'PreCompact', 'Stop', 'SessionEnd'];
const MEMORY_SCRIPT_RE = /session-start-bootstrap|egc-memory-load|egc-memory-save|pre-compact\.js|session-memory-miner|session-end-marker|session-auto-learn|session-end\.js/;

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

// One string per hook: the group's own fields plus the hook, so a changed
// timeout, matcher, id or description shows up as a missing entry.
function entriesByEvent(hooksDocument, events) {
  const result = {};
  for (const event of events) {
    const groups = hooksDocument.hooks[event] || [];
    result[event] = groups.flatMap(group => {
      const { hooks, ...meta } = group;
      return hooks.map(hook => JSON.stringify({ meta, hook }));
    });
  }
  return result;
}

function commandOf(entry) {
  return JSON.parse(entry).hook.command;
}

function label(entry) {
  return commandOf(entry).slice(0, 120);
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

const rootEntries = entriesByEvent(root, MEMORY_EVENTS);
const sliceEntries = entriesByEvent(slice, MEMORY_EVENTS);

for (const event of MEMORY_EVENTS) {
  test(`every ${event} hook in the slice exists verbatim, group fields included, in hooks/hooks.json`, () => {
    for (const entry of sliceEntries[event]) {
      assert.ok(rootEntries[event].includes(entry), `slice entry missing from root ${event}: ${label(entry)}`);
    }
  });

  test(`every ${event} hook that runs a memory script is in the slice`, () => {
    const expected = rootEntries[event].filter(entry => MEMORY_SCRIPT_RE.test(commandOf(entry)));
    assert.ok(expected.length > 0, `root ${event} has no memory hook`);
    for (const entry of expected) {
      assert.ok(sliceEntries[event].includes(entry), `root memory hook missing from slice ${event}: ${label(entry)}`);
    }
  });

  test(`no ${event} hook in the slice is unrelated to memory`, () => {
    for (const entry of sliceEntries[event]) {
      assert.ok(MEMORY_SCRIPT_RE.test(commandOf(entry)), `non-memory hook in slice ${event}: ${label(entry)}`);
    }
  });
}

test('no two groups of the slice share an id', () => {
  const ids = MEMORY_EVENTS.flatMap(event => (slice.hooks[event] || []).map(group => `${event}:${group.id}`));
  assert.strictEqual(new Set(ids).size, ids.length, `duplicated group id in the slice: ${ids.join(', ')}`);
});

console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) process.exit(1);
