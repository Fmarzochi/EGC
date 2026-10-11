'use strict';

// An install from the npm tarball must plan exactly what an install from a
// checkout plans, for every target: the installer drops a source the
// package lacks without a word, so a file missing from the "files" list
// (the .cursor tree until #1670) only showed up as a quieter install.
// This packs the repository, extracts it and compares the two plans.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { listInstallTargetAdapters } = require('../../scripts/lib/install-targets/registry');
const { createManifestInstallPlan } = require('../../scripts/lib/install-executor');
const { GENERATE_CONTEXT_FILE_KIND, isGeneratedContextSource } = require('../../scripts/lib/generated-context-files');

const REPO_ROOT = path.join(__dirname, '..', '..');

// S4036: fixed locations before a PATH lookup. npm runs as its own CLI
// script under the node that runs this test (npm_execpath under npm test,
// else the layouts of the official installers); tar from its system
// location. The bare name is the last resort for layouts like nix.
const NODE_DIR = path.dirname(process.execPath);
const NPM_CLI = [
  process.env.npm_execpath,
  path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(NODE_DIR, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find(candidate => candidate && /npm-cli\.js$/.test(candidate) && fs.existsSync(candidate)) || null;
const NPM_BIN = [
  path.join(NODE_DIR, process.platform === 'win32' ? 'npm.cmd' : 'npm'),
  '/usr/bin/npm',
  '/usr/local/bin/npm',
].find(candidate => fs.existsSync(candidate)) || 'npm';
const TAR_BIN = [
  '/usr/bin/tar',
  '/bin/tar',
  String.raw`C:\Windows\System32\tar.exe`,
].find(candidate => fs.existsSync(candidate)) || 'tar';

function runNpm(args, options) {
  if (NPM_CLI) {
    return spawnSync(process.execPath, [NPM_CLI, ...args], options);
  }
  return spawnSync(NPM_BIN, args, { ...options, shell: process.platform === 'win32' });
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed += 1;
  }
}

function createTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// --ignore-scripts: the contract under test is the files whitelist, not the
// prepack pipeline, which builds the MCP servers and refuses to pack while
// a local propagation file holds populated memory.
function packRepository(destination) {
  const pack = runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.strictEqual(pack.status, 0, pack.error?.message || pack.stderr);
  const filename = JSON.parse(pack.stdout)[0]?.filename;
  assert.ok(filename, 'npm pack names the tarball');
  const extract = spawnSync(TAR_BIN, ['-xzf', path.join(destination, filename), '-C', destination], { encoding: 'utf8' });
  assert.strictEqual(extract.status, 0, extract.error?.message || extract.stderr);
  return path.join(destination, 'package');
}

function normalize(value) {
  return String(value || '').replaceAll('\\', '/');
}

function planOf(sourceRoot, target, homeDir, projectRoot) {
  return createManifestInstallPlan({ sourceRoot, projectRoot, homeDir, target, profileId: 'full' }).operations;
}

function keysOf(operations) {
  return operations
    .map(operation => [
      operation.kind,
      normalize(operation.sourceRelativePath),
      normalize(operation.destinationPath),
      operation.transform || '',
      operation.hookEvent || '',
    ].join('|'))
    .sort();
}

function main() {
  console.log('\n=== Testing packed install parity ===\n');

  const workDir = createTempDir('egc-packed-parity-');
  const homeDir = createTempDir('egc-packed-parity-home-');
  const projectRoot = createTempDir('egc-packed-parity-project-');
  const targets = [...new Set(listInstallTargetAdapters().map(adapter => adapter.target))];

  try {
    const packageRoot = packRepository(workDir);

    test('every target plans the same operations from the packed tarball and from the checkout', () => {
      assert.ok(targets.length > 0, 'the registry lists targets');
      for (const target of targets) {
        const fromCheckout = keysOf(planOf(REPO_ROOT, target, homeDir, projectRoot));
        const fromPackage = keysOf(planOf(packageRoot, target, homeDir, projectRoot));
        assert.ok(fromCheckout.length > 0, `${target}: the checkout plans something`);
        assert.deepStrictEqual(fromPackage, fromCheckout, `${target}: the tarball plans what the checkout plans`);
      }
    });

    test('the propagation-filled context files are generated on both sides and copied on neither', () => {
      const expectations = [
        ['cursor', path.join(projectRoot, '.cursor', 'rules', 'egc-context.mdc')],
        ['egc', path.join(homeDir, '.gemini', 'AGENTS.md')],
      ];
      for (const [target, destinationPath] of expectations) {
        for (const [label, sourceRoot] of [['checkout', REPO_ROOT], ['tarball', packageRoot]]) {
          const operations = planOf(sourceRoot, target, homeDir, projectRoot);
          const generated = operations.filter(operation => operation.kind === GENERATE_CONTEXT_FILE_KIND && operation.destinationPath === destinationPath);
          assert.strictEqual(generated.length, 1, `${target} from the ${label}: one generated operation for ${destinationPath}`);
          const copied = operations.filter(operation => operation.kind === 'copy-file' && isGeneratedContextSource(operation.sourceRelativePath));
          assert.deepStrictEqual(copied, [], `${target} from the ${label}: no copy of a propagation-filled source`);
        }
      }
    });

    test('the tarball ships the Cursor tree but not the Cursor rule the propagation fills', () => {
      assert.ok(fs.existsSync(path.join(packageRoot, '.cursor', 'hooks', 'adapter.js')), '.cursor/hooks/adapter.js ships');
      assert.ok(fs.existsSync(path.join(packageRoot, '.cursor', 'hooks.json')), '.cursor/hooks.json ships');
      assert.ok(!fs.existsSync(path.join(packageRoot, '.cursor', 'rules', 'egc-context.mdc')), '.cursor/rules/egc-context.mdc never ships');
      assert.ok(!fs.existsSync(path.join(packageRoot, 'AGENTS.md')), 'the root AGENTS.md never ships');
    });
  } finally {
    for (const dir of [workDir, homeDir, projectRoot]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
