'use strict';

// Scrubber hooks: the Write/Edit content cleaner and the commit-message
// co-authorship stripper, exercised through their run() entry points.
// Non-ASCII fixtures use String.fromCodePoint to keep this source pure ASCII.

const assert = require('node:assert');
const { run: runWriteHook } = require('../../scripts/hooks/scrubber-hook');
const { run: runPrecommit } = require('../../scripts/hooks/scrubber-precommit');

const ZWSP = String.fromCodePoint(0x200b);
const EM_DASH = String.fromCodePoint(0x2014);

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.catch(() => {}); // an accidental async test's rejection is handled, not fatal
      throw new Error('async test cases are not supported by this harness');
    }
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    Error: ${err.stack}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  if (test(name, fn)) passed += 1;
  else failed += 1;
}

const parse = out => JSON.parse(out);

check('cleans invisible Unicode in a Write content', () => {
  const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/a.js', content: `const x = 1;${ZWSP}\n` } });
  const out = parse(runWriteHook(input));
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(out.hookSpecificOutput.updatedInput.content, 'const x = 1;\n');
});

check('normalizes an em dash in a Write content', () => {
  const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'notes.md', content: `this ${EM_DASH} that` } });
  const out = parse(runWriteHook(input));
  assert.strictEqual(out.hookSpecificOutput.updatedInput.content, 'this, that');
});

check('passes clean content through unchanged', () => {
  const raw = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/a.js', content: 'const x = 1;\n' } });
  assert.strictEqual(runWriteHook(raw), raw);
});

check('leaves binary-extension files untouched', () => {
  const raw = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'logo.png', content: `PK${ZWSP}not really` } });
  assert.strictEqual(runWriteHook(raw), raw);
});

check('cleans an Edit new_string', () => {
  const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'a.ts', old_string: 'x', new_string: `y${ZWSP}z` } });
  const out = parse(runWriteHook(input));
  assert.strictEqual(out.hookSpecificOutput.updatedInput.new_string, 'yz');
});

check('cleans each edit in a MultiEdit', () => {
  const input = JSON.stringify({
    tool_name: 'MultiEdit',
    tool_input: { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: `b${ZWSP}` }, { old_string: 'c', new_string: 'd' }] },
  });
  const out = parse(runWriteHook(input));
  assert.strictEqual(out.hookSpecificOutput.updatedInput.edits[0].new_string, 'b');
  assert.strictEqual(out.hookSpecificOutput.updatedInput.edits[1].new_string, 'd');
});

check('ignores non-write tools', () => {
  const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } });
  assert.strictEqual(runWriteHook(raw), raw);
});

check('fails open on malformed JSON', () => {
  const raw = 'not json {';
  assert.strictEqual(runWriteHook(raw), raw);
});

check('precommit strips an AI co-author trailer', () => {
  const r = runPrecommit('feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
  assert.strictEqual(r.removed.length, 1);
  assert.ok(!/Claude/.test(r.message));
});

check('precommit keeps a plain message', () => {
  const r = runPrecommit('fix: y\n');
  assert.strictEqual(r.removed.length, 0);
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
