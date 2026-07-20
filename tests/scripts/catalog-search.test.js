/**
 * Tests for scripts/lib/catalog-search.js and the `egc catalog search` command.
 */

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { searchEntries, loadIndexEntries } = require('../../scripts/lib/catalog-search');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'catalog.js');

function run(args = []) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status || 1,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || '',
    };
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

const FIXTURE = [
  { kind: 'skill', name: 'memory-keeper', description: 'Persists project memory across sessions' },
  { kind: 'agent', name: 'reviewer', description: 'Reviews pull requests for quality' },
  { kind: 'rule', name: 'memory', description: 'Session memory conventions' },
  { kind: 'skill', name: 'dashboards', description: 'Builds dashboards from metrics' },
];

function runTests() {
  console.log('\n=== Testing catalog search ===\n');

  let passed = 0;
  let failed = 0;

  if (test('exact name match outranks partial and description matches', () => {
    const results = searchEntries(FIXTURE, ['memory']);
    assert.strictEqual(results[0].name, 'memory');
    assert.strictEqual(results.length, 2);
    assert.ok(results[0].score > results[1].score);
  })) passed++; else failed++;

  if (test('multiple terms require every term to match', () => {
    const results = searchEntries(FIXTURE, ['memory', 'sessions']);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'memory-keeper');
  })) passed++; else failed++;

  if (test('empty or blank terms return no results', () => {
    assert.deepStrictEqual(searchEntries(FIXTURE, []), []);
    assert.deepStrictEqual(searchEntries(FIXTURE, ['  ']), []);
    assert.deepStrictEqual(searchEntries(FIXTURE, null), []);
  })) passed++; else failed++;

  if (test('single-character terms are ignored as noise', () => {
    assert.deepStrictEqual(searchEntries(FIXTURE, ['e']), []);
    const results = searchEntries(FIXTURE, ['e', 'memory']);
    assert.ok(results.length > 0, 'longer term should still match after noise is dropped');
  })) passed++; else failed++;

  if (test('matching is case-insensitive', () => {
    const results = searchEntries(FIXTURE, ['MeMoRy']);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].name, 'memory');
  })) passed++; else failed++;

  if (test('description-only matches score and rank below name matches', () => {
    const results = searchEntries(FIXTURE, ['metrics']);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'dashboards');
    assert.strictEqual(results[0].score, 1);
  })) passed++; else failed++;

  if (test('equal scores tie-break alphabetically', () => {
    const tied = [
      { kind: 'skill', name: 'zeta-tool', description: 'shared keyword here' },
      { kind: 'skill', name: 'alpha-tool', description: 'shared keyword here' },
    ];
    const results = searchEntries(tied, ['keyword']);
    assert.strictEqual(results[0].name, 'alpha-tool');
    assert.strictEqual(results[1].name, 'zeta-tool');
  })) passed++; else failed++;

  if (test('limit caps the result list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      kind: 'skill',
      name: `tool-${i}`,
      description: 'common description',
    }));
    assert.strictEqual(searchEntries(many, ['common'], 5).length, 5);
  })) passed++; else failed++;

  if (test('missing index file degrades to an empty list', () => {
    assert.deepStrictEqual(loadIndexEntries('/nonexistent/skill-index.json'), []);
  })) passed++; else failed++;

  if (test('shipped index loads with entries', () => {
    const entries = loadIndexEntries();
    assert.ok(entries.length > 0, 'expected the committed skill-index.json to have entries');
    assert.ok(entries[0].name && entries[0].description && entries[0].kind);
  })) passed++; else failed++;

  if (test('CLI search returns ranked JSON results', () => {
    const result = run(['search', 'memory', '--json']);
    assert.strictEqual(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(Array.isArray(payload.results));
    assert.ok(payload.results.length > 0);
    assert.ok(payload.results[0].score >= payload.results[payload.results.length - 1].score);
  })) passed++; else failed++;

  if (test('CLI search without terms fails with guidance', () => {
    const result = run(['search']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('requires at least one term'));
  })) passed++; else failed++;

  if (test('CLI search reports when nothing matches', () => {
    const result = run(['search', 'zzzznomatchzzz']);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes('No catalog entries match'));
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
