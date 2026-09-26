'use strict';
/**
 * The hooks read a wrapper's options through scripts/lib/wrapper-options.js,
 * a CommonJS copy of the egc-guardian validator's tables and rules
 * (validator.ts, parallel-options.ts) that the hooks cannot require. This
 * keeps the two in step: same wrappers, same option tables, same parallel
 * specs, and the same number of words for every option word tried.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'validator.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

const validator = require(path.join(buildDir, 'validator.js'));
const parallelOptions = require(path.join(buildDir, 'parallel-options.js'));
const localWrappers = require(path.join(buildDir, 'local-wrappers.js'));
const lib = require('../../scripts/lib/wrapper-options');

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

const sorted = values => [...(values || [])].sort();

console.log('\n=== Testing the hooks\' wrapper options against the validator ===\n');

run('both know the same wrappers', () => {
  assert.deepStrictEqual(Object.keys(lib.WRAPPER_SPECS).sort(), Object.keys(validator.WRAPPER_SPECS).sort());
});

run('every wrapper has the same option tables', () => {
  for (const [name, spec] of Object.entries(validator.WRAPPER_SPECS)) {
    const mirror = lib.WRAPPER_SPECS[name];
    assert.deepStrictEqual(sorted(mirror.valueFlags), sorted(spec.valueFlags), `${name} value options`);
    assert.deepStrictEqual(sorted(mirror.optionalValueFlags), sorted(spec.optionalValueFlags), `${name} optional values`);
    assert.deepStrictEqual(sorted(mirror.exactLongFlags), sorted(spec.exactLongFlags), `${name} exact names`);
    assert.strictEqual(mirror.leadingPositionals ?? 0, spec.leadingPositionals ?? 0, `${name} positionals`);
    assert.strictEqual(String(mirror.positionalWhen ?? ''), String(spec.positionalWhen ?? ''), `${name} optional positional`);
    assert.strictEqual(Boolean(mirror.reader), Boolean(spec.readOption), `${name} reader`);
  }
});

run('parallel\'s specs are the same list', () => {
  assert.deepStrictEqual(lib.PARALLEL_SPECS, parallelOptions.PARALLEL_SPECS);
});

// Every option word worth trying for a getopt wrapper: each option, each long
// option cut to every prefix, and each pair of short options bundled.
function getoptWords(spec) {
  const words = new Set(['--', '-', '--=x']);
  const all = [...spec.valueFlags, ...(spec.optionalValueFlags || []), ...(spec.exactLongFlags || [])];
  for (const flag of all) {
    words.add(flag);
    words.add(`${flag}=v`);
    if (flag.startsWith('--')) for (let end = 3; end < flag.length; end++) words.add(flag.slice(0, end));
  }
  const letters = all.filter(flag => /^-[^-]$/.test(flag)).map(flag => flag[1]).concat(['x', 'v']);
  for (const a of letters) for (const b of letters) words.add(`-${a}${b}`);
  for (const a of letters) words.add(`-${a}value`);
  return [...words];
}

run('every option word of a getopt wrapper spans the same words', () => {
  for (const [name, spec] of Object.entries(validator.WRAPPER_SPECS)) {
    if (spec.readOption) continue;
    for (const word of getoptWords(spec)) {
      const expected = validator.readWrapperOption(word, spec).width;
      assert.strictEqual(lib.readWrapperOption(name, word, 'next').width, expected, `${name} ${word}`);
    }
  }
});

run('every parallel option word spans the same words', () => {
  const names = parallelOptions.PARALLEL_SPECS.flatMap(entry => entry.split(/[=:]/)[0].split('|'));
  const words = new Set(['--', '-', '--=x', '-wd', '-kj4', '-kj']);
  for (const name of names) {
    if (name.length === 1) {
      words.add(`-${name}`);
      words.add(`-k${name}`);
      words.add(`-${name}4`);
    }
    words.add(`--${name}`);
    words.add(`--${name.toUpperCase()}`);
    words.add(`--${name}=v`);
    for (let end = 1; end < name.length; end++) words.add(`--${name.slice(0, end)}`);
  }
  for (const word of words) {
    for (const next of ['rm', '-x', '4', '.5', undefined]) {
      const expected = parallelOptions.readParallelOption(word, next).width;
      assert.strictEqual(lib.readWrapperOption('parallel', word, next).width, expected, `parallel ${word} ${next}`);
    }
  }
});

run('the hook copy names the option and the value it takes, for the chdir and chroot a wrapper carries', () => {
  const read = (name, word, next) => {
    const option = lib.readWrapperOption(name, word, next);
    return [option.valueName, option.value, option.width];
  };
  assert.deepStrictEqual(read('sudo', '-D', '/x'), ['-D', '/x', 2]);
  assert.deepStrictEqual(read('sudo', '-D/x', 'rm'), ['-D', '/x', 1]);
  assert.deepStrictEqual(read('sudo', '-nD', '/x'), ['-D', '/x', 2]);
  assert.deepStrictEqual(read('sudo', '--chdir=/x', 'rm'), ['--chdir', '/x', 1]);
  assert.deepStrictEqual(read('sudo', '--chd', '/x'), ['--chdir', '/x', 2]);
  assert.deepStrictEqual(read('sudo', '-R', '/root'), ['-R', '/root', 2]);
  assert.deepStrictEqual(read('env', '-iC', '/x'), ['-C', '/x', 2]);
  assert.deepStrictEqual(read('systemd-run', '--working-directory', '/x'), ['--working-directory', '/x', 2]);
  assert.deepStrictEqual(read('sudo', '-n', 'rm'), [null, undefined, 1]);
  assert.deepStrictEqual(read('xargs', '-i{}', 'rm'), ['-i', '{}', 1]);
  assert.strictEqual(lib.readWrapperOption('not-a-wrapper', '-x', 'rm'), null);
});

run('every bwrap option word spans the same words', () => {
  const words = ['--', '-', '--bind', '--ro-bind', '--overlay', '--setenv', '--chdir', '--unshare-all', '--new-session', '--unknown', '--bin', '--debug-opt=x'];
  for (const word of words) {
    const expected = localWrappers.readBwrapOption(word).width;
    assert.strictEqual(lib.readWrapperOption('bwrap', word, 'next').width, expected, `bwrap ${word}`);
  }
  assert.deepStrictEqual([lib.readWrapperOption('bwrap', '--chdir', '/x').valueName, lib.readWrapperOption('bwrap', '--chdir', '/x').value], ['--chdir', '/x']);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
