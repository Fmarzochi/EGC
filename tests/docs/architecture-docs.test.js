'use strict';

/**
 * The architecture docs describe only what exists (#1703): every path the
 * index names is in the tree, and the "EGC 2.0" pages say plainly that they
 * are an unimplemented proposal instead of pointing at a Rust scaffold the
 * repository does not have.
 *
 * Run with: node tests/docs/architecture-docs.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const archDir = path.join(repoRoot, 'docs', 'architecture');

// Named on purpose although they are not tracked: generated at runtime.
const GENERATED = new Set(['internal/registry/runtime-map.json']);

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

const read = name => fs.readFileSync(path.join(archDir, name), 'utf8');

// Backticked tokens that look like repository paths: a slash or a file
// extension, no spaces, not a home path.
function namedPaths(markdown) {
  return [...new Set([...markdown.matchAll(/`([^`\s]+)`/g)].map(match => match[1]))]
    .filter(token => !token.startsWith('~'))
    .filter(token => token.includes('/') || /\.(md|js|py|json|ya?ml|sh|ps1|ts)$/.test(token));
}

// A glob such as scripts/hooks/* or manifests/install-*.json is checked by
// its directory; a bare file name by the architecture folder.
function existsInTree(token) {
  const candidate = token.includes('*') ? path.dirname(token) : token;
  return fs.existsSync(path.join(repoRoot, candidate)) || fs.existsSync(path.join(archDir, candidate));
}

console.log('\n=== Testing docs/architecture against the tree ===\n');

test('every path the architecture index names exists', () => {
  const missing = namedPaths(read('README.md')).filter(token => !GENERATED.has(token) && !existsInTree(token));
  assert.deepStrictEqual(missing, [], `docs/architecture/README.md names paths that do not exist: ${missing.join(', ')}`);
});

test('the EGC 2.0 pages say they are an unimplemented proposal', () => {
  for (const page of ['EGC_2.0_BLUEPRINT.md', 'EGC_2.0_TECHNICAL_DESIGN.md']) {
    const text = read(page);
    assert.ok(text.includes('**Status: unimplemented proposal.**'), `${page} must open with the unimplemented-proposal note`);
    assert.ok(!/existing `egc\/`/.test(text), `${page} must not call a Rust scaffold existing`);
  }
});

test('the proposal note still holds: no Rust kernel in the tree', () => {
  assert.ok(
    !fs.existsSync(path.join(repoRoot, 'egc', 'Cargo.toml')),
    'a Rust kernel landed: update docs/architecture and the EGC 2.0 status notes'
  );
});

if (failed > 0) {
  console.log(`\nFailed: ${failed}`);
  process.exit(1);
}

console.log(`\nPassed: ${passed}`);
