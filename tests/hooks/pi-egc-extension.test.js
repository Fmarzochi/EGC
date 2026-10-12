'use strict';

const assert = require('node:assert');
const path = require('node:path');

process.env.EGC_GUARDIAN_CLI = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');

const extensionPath = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'pi-egc-extension.js');
const extension = require(extensionPath);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

async function main() {
  console.log('\n=== Testing pi-egc-extension ===\n');

  await test('the extension registers one tool_call handler, as a default export too (#1499)', async () => {
    const handlers = [];
    const pi = { on: (event, handler) => handlers.push([event, handler]) };
    extension(pi);
    assert.deepStrictEqual(handlers.map(([event]) => event), ['tool_call']);
    assert.strictEqual(extension.default, extension, 'jiti loads the default export');
  });

  await test('a destructive bash command is blocked with the Guardian reason (#1499)', async () => {
    const result = extension.handleToolCall({ toolName: 'bash', input: { command: 'rm -rf /' } }, { cwd: '/work' });
    assert.strictEqual(result.block, true);
    assert.match(result.reason, /destructive/);
  });

  await test('an edit or write of a protected path is blocked (#1499)', async () => {
    for (const toolName of ['edit', 'write']) {
      const result = extension.handleToolCall({ toolName, input: { path: '/home/person/.ssh/id_rsa', content: 'x' } }, {});
      assert.strictEqual(result?.block, true, toolName);
    }
  });

  await test('a harmless bash command goes through, and other tools are left alone (#1499)', async () => {
    const event = { toolName: 'bash', input: { command: 'echo hello' } };
    assert.strictEqual(extension.handleToolCall(event, {}), undefined);
    assert.strictEqual(typeof event.input.command, 'string');
    assert.strictEqual(extension.handleToolCall({ toolName: 'read', input: { path: '/home/person/.ssh/id_rsa' } }, {}), undefined);
    assert.strictEqual(extension.handleToolCall({ toolName: 'bash', input: {} }, {}), undefined);
    assert.strictEqual(extension.handleToolCall({}, {}), undefined);
  });

  await test('the handler pi calls returns the same answer (#1499)', async () => {
    let handler;
    extension({ on: (event, fn) => { handler = fn; } });
    const result = await handler({ toolName: 'bash', input: { command: 'rm -rf /' } }, { cwd: '/work' });
    assert.strictEqual(result.block, true);
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
