'use strict';

const assert = require('node:assert');
const path = require('node:path');

const { resolveHomeOverride } = require('../../scripts/lib/home-override');

const VARIABLE = 'EGC_TEST_HOME_OVERRIDE';
const home = path.resolve('/home/person');

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

function withEnv(value, platform, fn) {
  const saved = process.env[VARIABLE];
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (value === undefined) delete process.env[VARIABLE]; else process.env[VARIABLE] = value;
  if (platform) Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    if (saved === undefined) delete process.env[VARIABLE]; else process.env[VARIABLE] = saved;
  }
}

console.log('\n=== Testing home-override ===\n');

test('without the variable the default sits under the home directory', () => {
  withEnv(undefined, null, () => {
    assert.strictEqual(resolveHomeOverride({ homeDir: home }, VARIABLE, ['.tool', 'agent']), path.join(home, '.tool', 'agent'));
    assert.strictEqual(resolveHomeOverride(home, VARIABLE, ['.tool']), path.join(home, '.tool'));
  });
});

test('a leading tilde is the home directory', () => {
  withEnv('~', null, () => assert.strictEqual(resolveHomeOverride({ homeDir: home }, VARIABLE, ['.tool']), home));
  withEnv('~/data', null, () => assert.strictEqual(resolveHomeOverride({ homeDir: home }, VARIABLE, ['.tool']), path.join(home, 'data')));
});

test('a tilde followed by a backslash is the home directory on Windows only', () => {
  withEnv('~\\data', 'win32', () => assert.strictEqual(resolveHomeOverride({ homeDir: home }, VARIABLE, ['.tool']), path.join(home, '\\data')));
  withEnv('~\\data', 'linux', () => assert.strictEqual(resolveHomeOverride({ homeDir: home }, VARIABLE, ['.tool']), path.resolve('~\\data')));
});

test('any other value resolves to an absolute path', () => {
  const absolute = path.resolve('/opt/tool');
  withEnv(absolute, null, () => assert.strictEqual(resolveHomeOverride({ homeDir: home }, VARIABLE, ['.tool']), absolute));
  withEnv('relative/tool', null, () => assert.strictEqual(resolveHomeOverride({ homeDir: home }, VARIABLE, ['.tool']), path.resolve('relative/tool')));
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
