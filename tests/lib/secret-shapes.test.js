'use strict';
/**
 * The credential shapes egc import refuses (#2138): the AWS key ids in both
 * forms, the credential assignment contract (every name, a quoted value of
 * eight characters or more, a bare one of twelve or more, nothing shorter),
 * and a match that names the shape and never the value.
 *
 * Run with: node tests/lib/secret-shapes.test.js
 */
const assert = require('node:assert');
const { findSecretShapes, hasCredentialAssignment, CREDENTIAL_NAMES } = require('../../scripts/lib/secret-shapes');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('\n=== secret shapes ===\n');

// The documented example key id of AWS, assembled at run time: written whole,
// the temporary form trips the secret scanning of the repository host.
const EXAMPLE_KEY_TAIL = 'IOSFODNN7EXAMPLE';

test('an AWS access key id is found in its long-lived and its temporary form', () => {
  assert.deepStrictEqual(findSecretShapes(`the key is AKIA${EXAMPLE_KEY_TAIL} for now`), ['an AWS access key id']);
  assert.deepStrictEqual(findSecretShapes(`the key is ASIA${EXAMPLE_KEY_TAIL} for now`), ['an AWS access key id']);
  assert.deepStrictEqual(findSecretShapes('AKIA alone is a word'), []);
});

test('a credential assignment is one of the names, a separator and a value of the contract length', () => {
  assert.strictEqual(CREDENTIAL_NAMES.length, 8, 'the eight names of the contract');
  const names = [
    'password', 'passwd', 'secret', 'token',
    'api_key', 'api-key', 'apikey',
    'access_token', 'access-token',
    'private_key', 'private-key',
    'client_secret', 'client-secret', 'CLIENT-SECRET',
  ];
  for (const name of names) {
    assert.ok(hasCredentialAssignment(`${name} = "eightchr"`), `${name} with a quoted value of eight`);
    assert.ok(hasCredentialAssignment(`${name}: 'eightchr'`), `${name} with a single-quoted value of eight`);
    assert.ok(hasCredentialAssignment(`${name}=abc!def/ghi?`), `${name} with a bare value of exactly twelve, punctuation included`);
  }
  assert.ok(!hasCredentialAssignment('password = "seven77"'), 'a quoted value of seven is not one');
  assert.ok(!hasCredentialAssignment('token=elevenchars'), 'a bare value of eleven is not one');
  assert.ok(!hasCredentialAssignment('the token count is 123456789012'), 'no separator, no assignment');
  assert.ok(!hasCredentialAssignment('secretary: Jane Doe of the board, since 2024'), 'a word that only starts with a name is not one');
  assert.deepStrictEqual(findSecretShapes('client_secret: abcdefghijklmnop'), ['a credential assignment']);
});

test('ordinary prose about credentials passes, and a match names the shape without the value', () => {
  assert.deepStrictEqual(findSecretShapes('The deploy token rotates monthly and the password policy asks for twelve characters.'), []);
  const names = findSecretShapes('password: "hunter2hunter2"');
  assert.deepStrictEqual(names, ['a credential assignment']);
  assert.ok(names.every(name => !name.includes('hunter2')), 'the value never travels with the name');
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
