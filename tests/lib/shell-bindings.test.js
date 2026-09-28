/**
 * The variables a command fixes and the values a command word taken from an
 * expansion can stand for (scripts/lib/shell-bindings.js), as the Bash hook
 * judges them. Segments are read with the hook's own tokenizer.
 */
'use strict';

const assert = require('assert');
const { mergeBindings, valuesOf, commandWordChoices, quoteField } = require('../../scripts/lib/shell-bindings');
const { bindingsOfSegments } = require('../../scripts/hooks/pre-bash-guardian-validate');

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

const bindingsOf = (...segments) => bindingsOfSegments(segments);
const lookupFrom = table => name => (Object.hasOwn(table, name) ? table[name] : ['']);

function runTests() {
  console.log('\n=== Testing shell bindings and command word values ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => (ok ? passed++ : failed++);

  record(test('an unquoted $X is judged by each value, and an empty one hands the command to the next word', () => {
    const lookup = lookupFrom({ X: ['ls', 'rm -rf', ''] });
    assert.deepStrictEqual(commandWordChoices('$X', lookup).choices, [['ls'], ['rm', '-rf'], []]);
    assert.deepStrictEqual(commandWordChoices('r$X', lookupFrom({ X: ['m'] })).choices, [['rm']]);
    assert.deepStrictEqual(commandWordChoices('x$', lookupFrom({})).choices, [['x$']], 'a lone $ is literal text');
  }));

  record(test('a quoted "$X" is one field, kept even when empty', () => {
    assert.deepStrictEqual(commandWordChoices('"$X"', lookupFrom({ X: ['rm -rf', ''] })).choices, [['rm -rf'], ['']]);
  }));

  record(test('default, alternative and error operators give the values bash gives', () => {
    const unset = lookupFrom({ X: [''] });
    assert.deepStrictEqual(commandWordChoices('${X:-rm}', unset).choices, [['rm']]);
    assert.deepStrictEqual(commandWordChoices('${X-rm}', unset).choices, [['rm'], []]);
    assert.deepStrictEqual(commandWordChoices('${X:+rm}', lookupFrom({ X: ['a'] })).choices, [['rm']]);
    assert.deepStrictEqual(commandWordChoices('${X:?}', lookupFrom({ X: ['ls', ''] })).choices, [['ls']]);
  }));

  record(test('a leading tilde is the home directory HOME holds, expanded before the rest of the word', () => {
    const lookup = lookupFrom({ HOME: ['/h', ''], D: ['x'] });
    assert.deepStrictEqual(commandWordChoices('~/$D/run', lookup).choices, [['/h/x/run']]);
    assert.deepStrictEqual(commandWordChoices('~/"$D"', lookup).choices, [['/h/x']]);
    assert.ok(commandWordChoices('~$D', lookup).unknown, '~$D is no home directory');
    assert.ok(commandWordChoices('~root/$D', lookup).unknown, "another user's home is not looked up");
    assert.ok(commandWordChoices('~/$D', lookupFrom({ HOME: [''], D: ['x'] })).unknown, 'an empty HOME leaves the home unknown');
    assert.ok(commandWordChoices('~/$D', name => (name === 'HOME' ? null : ['x'])).unknown, 'an unreadable HOME leaves the home unknown');
    assert.deepStrictEqual(commandWordChoices('"~"/$D', lookup).choices, [['~/x']], 'a quoted tilde is text');
    assert.deepStrictEqual(commandWordChoices('a~/$D', lookup).choices, [['a~/x']], 'a tilde inside the word is text');
    assert.deepStrictEqual(commandWordChoices('~/$D', lookupFrom({ HOME: ['/my home'], D: ['x'] })).choices, [['/my home/x']], 'the home directory is never split');
  }));

  record(test('a lookup substitution names the program; any other one is unknown unless only a literal name follows it', () => {
    assert.deepStrictEqual(commandWordChoices('$(which rm)', lookupFrom({})).choices, [['rm'], []]);
    assert.deepStrictEqual(commandWordChoices('$(command -v rm)', lookupFrom({})).choices, [['rm'], []]);
    assert.ok(commandWordChoices('$(date)', lookupFrom({})).unknown);
    assert.ok(commandWordChoices('$(npm bin)/eslint', lookupFrom({})).unknown, 'an unquoted substitution can split into other words');
    assert.strictEqual(commandWordChoices('"$(npm bin)"/eslint', lookupFrom({})).keep, true);
    assert.strictEqual(commandWordChoices('"$(git rev-parse --show-toplevel)/scripts/check.sh"', lookupFrom({})).keep, true);
  }));

  record(test('what this hook cannot read is unknown: an unreadable variable, positional and special parameters, transformations, ANSI-C text, an expansion that never closes', () => {
    const lookup = name => (name === 'O' ? null : ['']);
    for (const raw of ['$O', '${O}', '$1', '"$@"', '${X,,}', '${!X}', '${#X}', '$((1+2))', "$'\\x72m'", '`date`', '$(which rm', '${X', '`which rm']) {
      assert.ok(commandWordChoices(raw, lookup).unknown, raw);
    }
  }));

  record(test('a value that splits under a changed IFS or matches file names is unknown, and so is one with too many values', () => {
    assert.ok(commandWordChoices('$X', lookupFrom({ X: ['a'] }), true).unknown);
    assert.ok(commandWordChoices('$X', lookupFrom({ X: ['r*'] })).unknown);
    const many = Array.from({ length: 9 }, (_, i) => `v${i}`);
    assert.ok(commandWordChoices('$A$B', lookupFrom({ A: many, B: many })).unknown);
  }));

  record(test('assignments, loops and builtins fix a name to literals, or leave it unreadable', () => {
    const bindings = bindingsOf(
      'X=rm',
      'for L in ls cat',
      'for O in $(ls) rm',
      'read -rp "Name: " N',
      'read -p P',
      'printf -v F %s rm',
      'mapfile -t M',
      'A=r',
      'A+=m',
      'Y=(rm)',
      'Z[0]=rm',
      ': ${D:=rm}',
      'declare -n R=X',
      'select S in a b',
    );
    const values = name => valuesOf(bindings, name, {});
    assert.deepStrictEqual(values('X'), ['rm', '']);
    assert.deepStrictEqual(values('L'), ['ls', 'cat', '']);
    assert.strictEqual(values('N'), null, 'a read target');
    assert.deepStrictEqual(values('P'), [''], 'the value of read -p is a prompt, not a target');
    assert.strictEqual(values('REPLY'), null, 'read with no name fills REPLY');
    for (const name of ['O', 'F', 'M', 'A', 'Y', 'Z', 'D', 'R', 'S']) assert.strictEqual(values(name), null, name);
    assert.deepStrictEqual(values('U'), [''], 'a name the line never fixes can still be unset');
  }));

  record(test('the environment value counts, and a sourced script or a name built at run time leaves every other name unreadable', () => {
    assert.deepStrictEqual(valuesOf(bindingsOf(), 'EDITOR', { EDITOR: 'vi' }), ['vi', '']);
    assert.strictEqual(valuesOf(bindingsOf('. ./vars.sh'), 'EDITOR', {}), null);
    assert.strictEqual(valuesOf(bindingsOf('export $(cat vars)'), 'X', {}), null);
    // A name the line already fixes is no safer once it sources a script or
    // sets a name it builds at run time: either can set that name too.
    for (const late of ['printf -v "$VAR" rm', 'read "$VAR"', 'mapfile "$VAR"', 'source ./x.sh']) {
      assert.strictEqual(valuesOf(bindingsOf('X=echo', late), 'X', {}), null, late);
    }
  }));

  record(test('IFS set as a prefix of one command does not change how the line splits; set on its own it does', () => {
    assert.strictEqual(bindingsOf('IFS=, read -r a').ifs, false);
    assert.strictEqual(bindingsOf('IFS=,').ifs, true);
    assert.strictEqual(bindingsOf('export IFS=,').ifs, true);
    const merged = mergeBindings(bindingsOf('X=ls'), bindingsOf('X=rm'));
    assert.deepStrictEqual(valuesOf(merged, 'X', {}), ['ls', 'rm', '']);
  }));

  record(test('a field the validator must read back as one word is quoted', () => {
    assert.strictEqual(quoteField('rm'), 'rm');
    assert.strictEqual(quoteField('/usr/bin/rm'), '/usr/bin/rm');
    assert.strictEqual(quoteField('ls;rm'), "'ls;rm'");
    assert.strictEqual(quoteField("it's"), String.raw`'it'\''s'`);
    assert.strictEqual(quoteField(''), "''");
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
