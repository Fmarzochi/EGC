/**
 * The variables a command fixes and the values a command word taken from an
 * expansion can stand for (scripts/lib/shell-bindings.js), as the Bash hook
 * judges them.
 */
'use strict';

const assert = require('assert');
const { collectBindings, mergeBindings, valuesOf, commandWordChoices, quoteField } = require('../../scripts/lib/shell-bindings');

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

// Minimal shell words: whitespace-separated, with the flags the hook's
// tokenizer sets on an expanding word.
function entry(segment, commandIndex = 0) {
  const words = [];
  const re = /\S+/g;
  let match;
  while ((match = re.exec(segment)) !== null) {
    const value = match[0].replaceAll(/["']/g, '');
    words.push({ value, expands: /[$`]/.test(match[0]), globbed: false, start: match.index, end: match.index + match[0].length });
  }
  return { segment, words, commandIndex };
}

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

  record(test('a lookup substitution names the program; any other one is unknown unless only a literal name follows it', () => {
    assert.deepStrictEqual(commandWordChoices('$(which rm)', lookupFrom({})).choices, [['rm'], []]);
    assert.deepStrictEqual(commandWordChoices('$(command -v rm)', lookupFrom({})).choices, [['rm'], []]);
    assert.ok(commandWordChoices('$(date)', lookupFrom({})).unknown);
    assert.ok(commandWordChoices('$(npm bin)/eslint', lookupFrom({})).unknown, 'an unquoted substitution can split into other words');
    assert.strictEqual(commandWordChoices('"$(npm bin)"/eslint', lookupFrom({})).keep, true);
    assert.strictEqual(commandWordChoices('"$(git rev-parse --show-toplevel)/scripts/check.sh"', lookupFrom({})).keep, true);
  }));

  record(test('what this hook cannot read is unknown: an unreadable variable, positional and special parameters, transformations, ANSI-C text', () => {
    const lookup = name => (name === 'O' ? null : ['']);
    for (const raw of ['$O', '${O}', '$1', '"$@"', '${X,,}', '${!X}', '${#X}', '$((1+2))', "$'\\x72m'", '`date`']) {
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
    const bindings = collectBindings([
      entry('X=rm'),
      entry('for L in ls cat', 0),
      entry('read -rp Name: N', 0),
      entry('read -p P', 0),
      entry('printf -v F %s rm', 0),
      entry('mapfile -t M', 0),
      entry('A=r'),
      entry('A+=m'),
      entry(': ${D:=rm}', 0),
      entry('declare -n R=X', 0),
      entry('select S in a b', 0),
    ]);
    const values = name => valuesOf(bindings, name, {});
    assert.deepStrictEqual(values('X'), ['rm', '']);
    assert.deepStrictEqual(values('L'), ['ls', 'cat', '']);
    assert.strictEqual(values('N'), null, 'a read target');
    assert.deepStrictEqual(values('P'), [''], 'the value of read -p is a prompt, not a target');
    assert.strictEqual(values('REPLY'), null, 'read with no name fills REPLY');
    for (const name of ['F', 'M', 'A', 'D', 'R', 'S']) assert.strictEqual(values(name), null, name);
    assert.deepStrictEqual(values('U'), [''], 'a name the line never fixes can still be unset');
  }));

  record(test('the environment value counts, and a sourced script or a name built at run time leaves every other name unreadable', () => {
    assert.deepStrictEqual(valuesOf(collectBindings([]), 'EDITOR', { EDITOR: 'vi' }), ['vi', '']);
    const sourced = collectBindings([entry('. ./vars.sh', 0)]);
    assert.strictEqual(valuesOf(sourced, 'EDITOR', {}), null);
    const dynamic = collectBindings([entry('export $(cat vars)', 0)]);
    assert.strictEqual(valuesOf(dynamic, 'X', {}), null);
    // A name the line already fixes is no safer once it sources a script or
    // sets a name it builds at run time: either can set that name too.
    for (const late of ['printf -v $VAR rm', 'read $VAR', 'mapfile $VAR', 'source ./x.sh']) {
      assert.strictEqual(valuesOf(collectBindings([entry('X=echo'), entry(late, 0)]), 'X', {}), null, late);
    }
  }));

  record(test('IFS set as a prefix of one command does not change how the line splits; set on its own it does', () => {
    assert.strictEqual(collectBindings([entry('IFS=, read -r a', 1)]).ifs, false);
    assert.strictEqual(collectBindings([entry('IFS=,', 1)]).ifs, true);
    assert.strictEqual(collectBindings([entry('export IFS=,', 0)]).ifs, true);
    const merged = mergeBindings(collectBindings([entry('X=ls')]), collectBindings([entry('X=rm')]));
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
