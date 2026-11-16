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

const {
  missingTypescriptApi,
  describeTypescriptCandidates,
  describeSqliteCandidates,
  loadTypescriptDetail,
  loadTypescript,
  loadSqliteDriver,
  resolvePaths
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

    check('falls through when an earlier resolution path cannot load sqlite', () => {
      const fallback = loadSqliteDriver(['/nonexistent-root-path', ...resolvePaths]);
      assert.strictEqual(fallback !== null, true);
      assert.strictEqual(typeof fallback.open, 'function');
    });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
