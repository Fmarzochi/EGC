/**
 * Tests for tests/lib/egc-memory-src.js, the resolver the memory suites use
 * to reach a TypeScript compiler and a sqlite driver (#2102).
 *
 * Under yarn's node-modules linker the root copies of both resolve without
 * being runnable: typescript 7 is a native CLI with no JavaScript compiler
 * API, and sqlite3 has no native build because yarn runs no dependency build
 * scripts. The resolver therefore selects by capability and by an actual
 * load, and the messages a SKIP prints have to name what it found.
 */

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  missingTypescriptApi,
  describeTypescriptCandidates,
  describeSqliteCandidates,
  loadTypescriptDetail,
  loadTypescript,
  loadSqliteDriver,
  sqliteCandidates,
  serverDir
} = require('./egc-memory-src');

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

// The shape typescript 7 ships: version metadata and no compiler API.
const NATIVE_SHAPE = { version: '7.0.2' };
const USABLE_SHAPE = { version: '6.0.3', transpileModule: () => ({}), ModuleKind: { CommonJS: 1 } };

// A package body that runs on require, so a case can choose what loading the
// module from one root does without touching the real install.
function fakePackage(root, name, body) {
  const dir = path.join(root, 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), body);
  return root;
}

function withTempRoots(fn) {
  const roots = [];
  const root = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-memory-src-'));
    roots.push(dir);
    return dir;
  };
  try {
    return fn(root);
  } finally {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  }
}

const NATIVE_TS_BODY = `module.exports = { version: '7.0.2' };`;
const USABLE_TS_BODY = `module.exports = { version: '6.0.3', transpileModule: function () { return {}; }, ModuleKind: { CommonJS: 1 } };`;
const UNLOADABLE_SQLITE_BODY = `throw new Error('Could not locate the bindings file. Tried:\\n -> /root/node_sqlite3.node');`;
const LOADABLE_SQLITE_BODY = `module.exports = { Database: class Database {} };`;

function runTests() {
  console.log('\n=== Testing tests/lib/egc-memory-src.js ===\n');

  let passed = 0;
  let failed = 0;
  const check = (name, fn) => (test(name, fn) ? passed++ : failed++);

  check('names both parts of the compiler API a native typescript package lacks', () => {
    assert.deepStrictEqual(missingTypescriptApi(NATIVE_SHAPE), ['transpileModule', 'ModuleKind.CommonJS']);
  });

  check('accepts a module that provides transpileModule and ModuleKind.CommonJS', () => {
    assert.deepStrictEqual(missingTypescriptApi(USABLE_SHAPE), []);
  });

  check('names ModuleKind alone when transpileModule is present, the crash the suites had', () => {
    assert.deepStrictEqual(missingTypescriptApi({ ...USABLE_SHAPE, ModuleKind: undefined }), ['ModuleKind.CommonJS']);
  });

  check('treats a non-object module as lacking the whole API', () => {
    assert.deepStrictEqual(missingTypescriptApi(null), ['transpileModule', 'ModuleKind.CommonJS']);
  });

  check('describes a candidate that resolved but has no compiler API', () => {
    const described = describeTypescriptCandidates([
      { dir: '/repo', resolved: '/repo/node_modules/typescript/lib/typescript.js', loaded: NATIVE_SHAPE, error: null, missing: missingTypescriptApi(NATIVE_SHAPE) }
    ]);
    assert.match(described, /typescript 7\.0\.2/);
    assert.match(described, /no compiler API/);
    assert.match(described, /transpileModule, ModuleKind\.CommonJS/);
  });

  check('describes a candidate that is not installed at all', () => {
    const described = describeTypescriptCandidates([{ dir: '/repo', resolved: null, loaded: null, error: null, missing: [] }]);
    assert.strictEqual(described, 'not installed under /repo');
  });

  check('describes a sqlite3 that resolves but fails to load, instead of reporting the path as usable', () => {
    const described = describeSqliteCandidates([
      {
        dir: '/repo',
        resolved: '/repo/node_modules/sqlite3/lib/sqlite3.js',
        loaded: null,
        error: new Error('Could not locate the bindings file. Tried:\n -> /repo/node_modules/sqlite3/build/node_sqlite3.node')
      },
      { dir: '/repo/mcp/servers/egc-memory', resolved: null, loaded: null, error: null }
    ]);
    assert.match(described, /sqlite3 under \/repo fails to load: Could not locate the bindings file\. Tried:/);
    assert.match(described, /sqlite3 not installed under \/repo\/mcp\/servers\/egc-memory/);
  });

  check('skips a native typescript in front of a usable one instead of stopping at the first candidate', () => {
    withTempRoots(root => {
      const native = fakePackage(root(), 'typescript', NATIVE_TS_BODY);
      const usable = fakePackage(root(), 'typescript', USABLE_TS_BODY);
      const { ts, candidates } = loadTypescriptDetail([native, usable]);
      assert.strictEqual(ts, require(path.join(usable, 'node_modules', 'typescript')));
      assert.deepStrictEqual(candidates[0].missing, ['transpileModule', 'ModuleKind.CommonJS']);
      assert.deepStrictEqual(candidates[1].missing, []);
    });
  });

  check('skips a sqlite3 that resolves but cannot load, the yarn shape, and uses the next root', () => {
    withTempRoots(root => {
      const unloadable = fakePackage(root(), 'sqlite3', UNLOADABLE_SQLITE_BODY);
      const loadable = fakePackage(root(), 'sqlite3', LOADABLE_SQLITE_BODY);
      const driver = loadSqliteDriver([unloadable, loadable]);
      assert.strictEqual(driver.sqlite3, require(path.join(loadable, 'node_modules', 'sqlite3')));
      assert.strictEqual(typeof driver.open, 'function');
    });
  });

  // The two checks below depend on what this checkout installed. A missing
  // toolchain is reported, not failed: the guard above already proves the
  // selection logic, and a developer running the file without an install
  // should not see a red test for an absent optional package.
  const { ts, candidates } = loadTypescriptDetail();
  if (!ts) {
    console.log(`  [SKIP] no usable TypeScript compiler API here: ${describeTypescriptCandidates(candidates)}`);
  } else {
    check('selects a compiler that provides the API the suites call', () => {
      assert.deepStrictEqual(missingTypescriptApi(ts), []);
      assert.strictEqual(loadTypescript(), ts);
    });
  }

  const driver = loadSqliteDriver();
  if (!driver) {
    console.log(`  [SKIP] no loadable sqlite driver here: ${describeSqliteCandidates()}`);
  } else {
    check('selects a sqlite driver that loaded, with an open function', () => {
      assert.strictEqual(typeof driver.open, 'function');
      assert.strictEqual(typeof driver.sqlite3.Database, 'function');
    });

    // The server asks the chooser to resolve sqlite3 from its own package root
    // first, so a suite that holds a store lock must hold it with that copy,
    // not with a root copy that may be another build.
    const fromServer = sqliteCandidates([serverDir])[0];
    if (!fromServer.loaded) {
      console.log(`  [SKIP] the server tree holds no loadable sqlite3 here: ${describeSqliteCandidates([fromServer])}`);
    } else {
      check('uses the sqlite3 the server resolves, not the root copy', () => {
        assert.strictEqual(driver.sqlite3, fromServer.loaded);
      });
    }
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
