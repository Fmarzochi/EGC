/**
 * The Bash and write hooks turn a program they cannot read into a refusal
 * with its reason, and let any other error through untouched, so a bug in
 * the reading is never mistaken for a verdict. The helpers are replaced in
 * this process's require.cache and the hooks loaded fresh, keeping the
 * coverage on the real files.
 */
'use strict';

const assert = require('assert');
const path = require('path');

process.env.EGC_GUARDIAN_CLI = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');

const hooks = path.join(__dirname, '..', '..', 'scripts', 'hooks');
const bashHookPath = require.resolve(path.join(hooks, 'pre-bash-guardian-validate.js'));
const writeHookPath = require.resolve(path.join(hooks, 'pre-write-guardian-validate.js'));
const bindingsPath = require.resolve(path.join(__dirname, '..', '..', 'scripts', 'lib', 'shell-bindings.js'));

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

// Loads `target` fresh with `stubs` ({ path: exports }) in place, runs
// `use` on it, and puts every cache entry back as it was.
function withStubs(target, stubs, use) {
  const saved = new Map([target, ...Object.keys(stubs)].map(key => [key, require.cache[key]]));
  try {
    delete require.cache[target];
    for (const [key, exports] of Object.entries(stubs)) {
      require.cache[key] = { id: key, filename: key, loaded: true, exports };
    }
    return use(require(target));
  } finally {
    for (const [key, entry] of saved) {
      if (entry) require.cache[key] = entry;
      else delete require.cache[key];
    }
  }
}

const boom = () => {
  throw new TypeError('boom');
};

function runTests() {
  console.log('\n=== Testing how the guardian hooks treat an unexpected error ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => (ok ? passed++ : failed++);

  record(test('the Bash hook lets an error that is not an unreadable program through', () => {
    const bindings = require(bindingsPath);
    withStubs(bashHookPath, { [bindingsPath]: { ...bindings, collectBindings: boom } }, ({ run }) => {
      assert.throws(() => run({ tool_name: 'Bash', tool_input: { command: 'ls' } }), /boom/);
    });
  }));

  record(test('the write hook lets an error that is not an unreadable program through', () => {
    const bashHook = { extractSegments: boom, isAdvisory: () => false };
    withStubs(writeHookPath, { [bashHookPath]: bashHook }, ({ run }) => {
      const input = { tool_name: 'Write', tool_input: { file_path: 'build.sh', content: 'echo hi\n' }, cwd: __dirname };
      assert.throws(() => run(input), /boom/);
    });
  }));

  record(test('the write hook refuses a script whose program it cannot read, with the reason', () => {
    const unreadable = () => {
      const error = new Error('sh reads the program it runs from a pipe this hook cannot read');
      error.name = 'ProgramUnreadable';
      throw error;
    };
    withStubs(writeHookPath, { [bashHookPath]: { extractSegments: unreadable, isAdvisory: () => false } }, ({ run }) => {
      const result = run({ tool_name: 'Write', tool_input: { file_path: 'build.sh', content: 'echo hi\n' }, cwd: __dirname });
      assert.strictEqual(result.exitCode, 2, JSON.stringify(result));
      assert.match(result.stderr, /pipe this hook cannot read\./);
    });
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
