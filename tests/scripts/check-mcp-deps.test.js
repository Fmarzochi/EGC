'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'check-mcp-deps.js');
const { missingDependencies, resolveServerDir } = require('../../scripts/check-mcp-deps');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function writeServer(root, deps) {
  const serverDir = path.join(root, 'mcp', 'servers', 'fake-server');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'package.json'), JSON.stringify({ name: 'fake-server', dependencies: deps }));
  return serverDir;
}

function installFake(nodeModulesDir, name) {
  const dir = path.join(nodeModulesDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
}

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

function runTests() {
  console.log('\n=== Testing check-mcp-deps.js ===\n');
  let passed = 0;
  let failed = 0;

  if (test('accepts dependencies present in an ancestor node_modules (the published-package layout)', () => {
    const root = createTempDir('check-mcp-deps-');
    try {
      const serverDir = writeServer(root, { alpha: '^1.0.0', beta: '^2.0.0' });
      installFake(path.join(root, 'node_modules'), 'alpha');
      installFake(path.join(serverDir, 'node_modules'), 'beta');
      assert.deepStrictEqual(missingDependencies(serverDir), []);
    } finally {
      cleanup(root);
    }
  })) passed++; else failed++;

  if (test('reports each dependency missing from every node_modules on the search path', () => {
    const root = createTempDir('check-mcp-deps-');
    try {
      const serverDir = writeServer(root, { alpha: '^1.0.0', gamma: '^1.0.0' });
      installFake(path.join(root, 'node_modules'), 'alpha');
      assert.deepStrictEqual(missingDependencies(serverDir), ['gamma']);
    } finally {
      cleanup(root);
    }
  })) passed++; else failed++;

  if (test('does not rely on a root export: a package that only exports subpaths still counts as present', () => {
    const root = createTempDir('check-mcp-deps-');
    try {
      const serverDir = writeServer(root, { subpaths: '^1.0.0' });
      const dir = path.join(root, 'node_modules', 'subpaths');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'subpaths', version: '1.0.0', exports: { './client.js': './client.js' } }));
      assert.deepStrictEqual(missingDependencies(serverDir), []);
    } finally {
      cleanup(root);
    }
  })) passed++; else failed++;

  if (test('the CLI confines its argument to the package root and exits 2 otherwise', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    assert.strictEqual(resolveServerDir(path.join(repoRoot, 'mcp', 'servers', 'egc-memory')), path.join(repoRoot, 'mcp', 'servers', 'egc-memory'));
    assert.strictEqual(resolveServerDir(repoRoot), repoRoot);
    assert.strictEqual(resolveServerDir(os.tmpdir()), null);
    // A symlink under the package root that points outside it resolves to
    // its real target and is rejected too.
    const link = path.join(repoRoot, '.tmp-check-mcp-deps-link');
    try { fs.unlinkSync(link); } catch { /* absent */ }
    fs.symlinkSync(os.tmpdir(), link, 'dir');
    try {
      assert.strictEqual(resolveServerDir(link), null);
    } finally {
      fs.unlinkSync(link);
    }
    assert.strictEqual(resolveServerDir(path.join(repoRoot, 'does-not-exist')), null);
    const outside = spawnSync(process.execPath, [SCRIPT, os.tmpdir()], { encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
    assert.strictEqual(outside.status, 2);
    assert.ok(outside.stderr.includes('outside the package root'), outside.stderr);
  })) passed++; else failed++;

  if (test('exits 2 when the directory has no package.json', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const empty = fs.mkdtempSync(path.join(repoRoot, '.tmp-check-mcp-deps-'));
    try {
      const result = spawnSync(process.execPath, [SCRIPT, empty], { encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
      assert.strictEqual(result.status, 2);
    } finally {
      cleanup(empty);
    }
  })) passed++; else failed++;

  if (test('the shipped MCP servers resolve from the package root of this checkout, on the CLI too', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    for (const server of ['egc-guardian', 'egc-memory']) {
      const serverDir = path.join(repoRoot, 'mcp', 'servers', server);
      assert.deepStrictEqual(missingDependencies(serverDir), [], server);
      const result = spawnSync(process.execPath, [SCRIPT, serverDir], { encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
      assert.strictEqual(result.status, 0, result.stderr);
    }
  })) passed++; else failed++;

  if (test('a missing package is reported by name through the CLI', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const sandbox = fs.mkdtempSync(path.join(repoRoot, '.tmp-check-mcp-deps-'));
    try {
      const serverDir = writeServer(sandbox, { 'egc-test-package-that-does-not-exist': '^1.0.0' });
      const result = spawnSync(process.execPath, [SCRIPT, serverDir], { encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes('egc-test-package-that-does-not-exist'), result.stderr);
    } finally {
      cleanup(sandbox);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
