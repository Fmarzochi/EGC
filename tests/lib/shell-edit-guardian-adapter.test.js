'use strict';

const assert = require('node:assert');
const { createShellEditGuardianAdapter } = require('../../scripts/lib/shell-edit-guardian-adapter');

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

const { buildGuardianInput } = createShellEditGuardianAdapter({
  shellToolRe: /^bash$/i,
  writeToolRe: /^(write|edit)$/i,
  pathKeys: ['path', 'file_path'],
});

let passed = 0;
let failed = 0;
function tally(ok) {
  if (ok) passed += 1;
  else failed += 1;
}

tally(test('maps a shell call to the Bash validator and keeps the cwd', () => {
  const target = buildGuardianInput({ tool_name: 'bash', tool_input: { command: 'ls' }, cwd: '/work' });
  assert.deepStrictEqual(target, { kind: 'bash', input: { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/work' } });
}));

tally(test('maps an edit call to the write validator with the first configured path key', () => {
  const target = buildGuardianInput({ tool_name: 'Edit', tool_input: { file_path: '/b', path: '/a' } });
  assert.strictEqual(target.kind, 'write');
  assert.strictEqual(target.input.tool_name, 'Edit');
  assert.strictEqual(target.input.tool_input.file_path, '/a');
  assert.strictEqual(target.input.tool_input.path, '/a');
  assert.strictEqual('cwd' in target.input, false);
}));

tally(test('ignores tools it does not judge and malformed payloads', () => {
  assert.strictEqual(buildGuardianInput({ tool_name: 'Read', tool_input: { path: '/a' } }), null);
  assert.strictEqual(buildGuardianInput({ tool_name: 'bash', tool_input: {} }), null);
  assert.strictEqual(buildGuardianInput({ tool_name: 'Write', tool_input: { content: 'x' } }), null);
  assert.strictEqual(buildGuardianInput(null), null);
  assert.strictEqual(buildGuardianInput([]), null);
  assert.strictEqual(buildGuardianInput({ tool_input: {} }), null);
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
