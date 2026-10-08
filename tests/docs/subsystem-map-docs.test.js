'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const runtimeDir = path.join(repoRoot, 'scripts', 'runtime');
const MAP = 'docs/governance/SUBSYSTEM-MAP.md';
const RUNTIME_README = 'scripts/runtime/README.md';
const GENERATED = new Set(['internal/', 'internal/registry/runtime-map.json', '.opencode/dist/', 'node_modules/']);

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

const read = relative => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

function namedPaths(markdown) {
  return [...new Set([...markdown.matchAll(/`([^`\s]+)`/g)].map(match => match[1]))]
    .filter(token => !token.startsWith('~') && !token.includes('://'))
    .filter(token => token.includes('/') || /\.(md|js|py|json|ya?ml|sh|ps1|ts)$/.test(token));
}

function globMatches(token) {
  const dir = path.join(repoRoot, path.dirname(token));
  if (!fs.existsSync(dir)) return false;
  const pattern = new RegExp(`^${path.basename(token).split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return fs.readdirSync(dir, { withFileTypes: true }).some(entry => entry.isFile() && pattern.test(entry.name));
}

function exists(token, bareNameDir) {
  if (GENERATED.has(token)) return true;
  if (token.includes('*')) return token.includes('/') ? globMatches(token) : true;
  if (!token.includes('/')) return fs.existsSync(path.join(repoRoot, token)) || fs.existsSync(path.join(bareNameDir, token));
  return fs.existsSync(path.join(repoRoot, token));
}

const runtimeFiles = () => fs.readdirSync(runtimeDir, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name !== 'README.md')
  .map(entry => entry.name);

console.log('\n=== Testing the subsystem map and scripts/runtime/README.md against the tree ===\n');

test('every path the subsystem map names exists', () => {
  const missing = namedPaths(read(MAP)).filter(token => !exists(token, runtimeDir));
  assert.deepStrictEqual(missing, [], `${MAP} names paths that do not exist: ${missing.join(', ')}`);
});

test('every path the runtime README names exists', () => {
  const missing = namedPaths(read(RUNTIME_README)).filter(token => !exists(token, runtimeDir));
  assert.deepStrictEqual(missing, [], `${RUNTIME_README} names paths that do not exist: ${missing.join(', ')}`);
});

test('the runtime README names every file in scripts/runtime', () => {
  const text = read(RUNTIME_README);
  const unnamed = runtimeFiles().filter(name => !text.includes(`\`${name}\``));
  assert.deepStrictEqual(unnamed, [], `${RUNTIME_README} does not name: ${unnamed.join(', ')}`);
});

test('the subsystem map agrees with CI on pytest', () => {
  const ci = read('.github/workflows/ci.yml');
  const map = read(MAP);
  assert.ok(/python -m pytest tests\//.test(ci), 'ci.yml no longer runs pytest tests/: update the subsystem map');
  assert.ok(!/runs no pytest/i.test(map), `${MAP} must not say CI runs no pytest`);
  assert.ok(map.includes('`pytest tests/`'), `${MAP} must say the Python tests run in the pytest tests/ step`);
});

test('the subsystem map lists only workflows that exist', () => {
  const workflows = [...read(MAP).matchAll(/\.github\/workflows\/[\w.-]+\.ya?ml/g)].map(match => match[0]);
  const missing = workflows.filter(workflow => !fs.existsSync(path.join(repoRoot, workflow)));
  assert.deepStrictEqual(missing, [], `${MAP} names workflows that do not exist: ${missing.join(', ')}`);
});

if (failed > 0) {
  console.log(`\nFailed: ${failed}`);
  process.exit(1);
}

console.log(`\nPassed: ${passed}`);
