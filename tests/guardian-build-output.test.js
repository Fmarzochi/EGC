/**
 * Tests that a Guardian build leaves only files with a matching source (#1664).
 */

const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FULL_INSTALL_TIMEOUT_MS } = require('./fixtures/subprocess-timeouts');

const serverRoot = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
    return false;
  }
}

function emittedSuffixes(compilerOptions) {
  return [
    ...(compilerOptions.declarationMap ? ['.d.ts.map'] : []),
    ...(compilerOptions.declaration ? ['.d.ts'] : []),
    ...(compilerOptions.sourceMap ? ['.js.map'] : []),
    '.js',
  ];
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
  });
}

function filesWithoutSource(root) {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
  const { outDir, rootDir } = tsconfig.compilerOptions;
  const suffixes = emittedSuffixes(tsconfig.compilerOptions);
  return listFiles(path.join(root, outDir)).filter(relative => {
    const suffix = suffixes.find(candidate => relative.endsWith(candidate));
    if (!suffix) return true;
    const stem = relative.slice(0, -suffix.length);
    return !fs.existsSync(path.join(root, rootDir, `${stem}.ts`));
  });
}

function copyTrackedServer(target) {
  const tracked = execFileSync('git', ['ls-files'], { cwd: serverRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const file of tracked) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.copyFileSync(path.join(serverRoot, file), path.join(target, file));
  }
  fs.symlinkSync(path.join(serverRoot, 'node_modules'), path.join(target, 'node_modules'), 'junction');
}

function runTests() {
  console.log('\n=== Testing the Guardian build output ===\n');
  if (!fs.existsSync(path.join(serverRoot, 'node_modules', 'typescript'))) {
    console.log('  - skipped: run npm ci in mcp/servers/egc-guardian first');
    console.log('\nResults: Passed: 0, Failed: 0');
    return;
  }
  let passed = 0;
  let failed = 0;
  const tally = ok => { if (ok) passed++; else failed++; };

  tally(test('a build removes outputs whose source is gone, and every file left has a matching source', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-guardian-build-'));
    try {
      copyTrackedServer(sandbox);
      const orphans = [
        path.join('build', 'cache-aligner.js'),
        path.join('build', 'runtime', 'session.js'),
        path.join('build', 'cognitive-orchestrator', 'index.js'),
      ];
      for (const orphan of orphans) {
        fs.mkdirSync(path.dirname(path.join(sandbox, orphan)), { recursive: true });
        fs.writeFileSync(path.join(sandbox, orphan), 'export {};\n');
      }

      const result = spawnSync('npm', ['run', 'build'], {
        cwd: sandbox,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        timeout: FULL_INSTALL_TIMEOUT_MS,
      });
      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);

      for (const orphan of orphans) {
        assert.ok(!fs.existsSync(path.join(sandbox, orphan)), `${orphan} is gone`);
      }
      assert.ok(fs.existsSync(path.join(sandbox, 'build', 'index.js')), 'the entry point is built');
      assert.deepStrictEqual(filesWithoutSource(sandbox), [], 'every built file has a source');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }));

  tally(test('the shapes counted as emitted follow the tsconfig', () => {
    assert.deepStrictEqual(emittedSuffixes({}), ['.js']);
    assert.deepStrictEqual(emittedSuffixes({ declaration: true, sourceMap: true, declarationMap: true }), ['.d.ts.map', '.d.ts', '.js.map', '.js']);
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
