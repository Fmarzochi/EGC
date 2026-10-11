'use strict';
/**
 * Tokenisation turns text into lowercase identifier tokens, splitting on
 * non-alphanumerics and camelCase, dropping a small stop list, and trimming
 * plural and verb suffixes.
 *
 * Run with: node tests/egc-guardian-filerank-tokenize.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'file-ranker.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { tokenize, stem } = require(buildPath);

let passed = 0;
let failed = 0;
function run(name, fn) {
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

run('splits camelCase, PascalCase, snake_case, and path separators', () => {
  assert.deepStrictEqual(tokenize('AuthMiddleware', { stem: false }), ['auth', 'middleware']);
  assert.deepStrictEqual(tokenize('src/billing/payments_v2.py', { stem: false }), ['billing', 'payments']);
  assert.deepStrictEqual(tokenize('HTTPServer', { stem: false }), ['http', 'server']);
});

run('drops one-character tokens and the stop list (including path words and extensions)', () => {
  assert.deepStrictEqual(tokenize('the a src lib test py md', { stem: false }), []);
});

run('stem trims plural and verb suffixes only above the minimum length', () => {
  assert.strictEqual(stem('charges'), 'charge');
  assert.strictEqual(stem('policies'), 'policy');
  assert.strictEqual(stem('boxes'), 'box');
  assert.strictEqual(stem('authenticating'), 'authenticat');
  assert.strictEqual(stem('authenticated'), 'authenticat');
  assert.strictEqual(stem('bus'), 'bus');
  assert.strictEqual(stem('ring'), 'ring');
  assert.strictEqual(stem('cat'), 'cat');
});

run('tokenize stems by default and keeps duplicates for term frequency', () => {
  assert.deepStrictEqual(tokenize('charges charge'), ['charge', 'charge']);
});

run('empty and nullish input gives no tokens', () => {
  assert.deepStrictEqual(tokenize(''), []);
  assert.deepStrictEqual(tokenize(undefined), []);
});

run('a word that stems to a stop-word is dropped with it, and real words are untouched', () => {
  assert.deepStrictEqual(tokenize('testing tested specs libs'), []);
  assert.deepStrictEqual(tokenize('the billing payments'), ['bill', 'payment']);
  assert.deepStrictEqual(tokenize('testing', { stem: false }), ['testing'], 'without stemming the word is kept');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
