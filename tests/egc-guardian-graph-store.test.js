'use strict';
/**
 * The graph store keeps files, symbols, imports and edges in SQLite, one
 * database per project, and rebuilds itself when the schema or file is bad.
 *
 * Run with: node tests/egc-guardian-graph-store.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'graph-store.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { graphDbPath, openGraphStore, openGraphStoreWithRecovery, isCorruption, GRAPH_SCHEMA_VERSION } = require(path.join(buildDir, 'graph-store.js'));

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.stack || err.message}`);
    failed++;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-graph-store-'));
const extracted = {
  symbols: [{ name: 'foo', kind: 'function', exported: true, startLine: 1, endLine: 3, refs: ['bar', 'ns.x'] }],
  imports: [{ specifier: './b.js', bindings: [{ local: 'bar', imported: 'bar' }], reexport: false }]
};

(async () => {
  await run('graphDbPath is stable per project, differs between projects, honors EGC_DIR', () => {
    const env = { EGC_DIR: tmp };
    const a = graphDbPath('/work/alpha', env);
    assert.strictEqual(a, graphDbPath('/work/alpha', env));
    assert.notStrictEqual(a, graphDbPath('/work/beta', env));
    assert.ok(a.startsWith(path.join(tmp, 'egc', 'graph')), a);
    assert.ok(a.endsWith('.db'));
    assert.ok(path.basename(a).startsWith('alpha-'));
  });

  await run('round trip: replaceFile, load, touchFile, removeFiles', async () => {
    const store = await openGraphStore(path.join(tmp, 'rt', 'g.db'));
    await store.replaceFile({ path: 'a.js', mtimeMs: 1, size: 10, hash: 'h1' }, extracted);
    const data = await store.load();
    assert.deepStrictEqual(data.files, [{ path: 'a.js', mtimeMs: 1, ctimeMs: 0, size: 10, hash: 'h1' }]);
    assert.strictEqual(data.symbols.length, 1);
    assert.deepStrictEqual(
      { ...data.symbols[0], id: 0 },
      { id: 0, file: 'a.js', name: 'foo', kind: 'function', exported: true, startLine: 1, endLine: 3, refs: ['bar', 'ns.x'] }
    );
    assert.deepStrictEqual(data.imports, [{ file: 'a.js', specifier: './b.js', bindings: [{ local: 'bar', imported: 'bar' }], reexport: false }]);

    await store.touchFile({ path: 'a.js', mtimeMs: 2, size: 10, hash: 'h1' });
    assert.strictEqual((await store.getFiles()).get('a.js').mtimeMs, 2);
    assert.strictEqual((await store.load()).symbols.length, 1, 'touch keeps symbols');

    await store.replaceFile({ path: 'a.js', mtimeMs: 3, size: 11, hash: 'h2' }, { symbols: [], imports: [] });
    assert.strictEqual((await store.load()).symbols.length, 0, 'replace drops the old rows');

    await store.replaceEdges([{ src: 'f:a.js', dst: 'f:b.js', kind: 'import' }]);
    assert.strictEqual((await store.load()).edges.length, 1);
    await store.replaceEdges([]);
    assert.strictEqual((await store.load()).edges.length, 0);

    await store.removeFiles(['a.js']);
    assert.strictEqual((await store.getFiles()).size, 0);
    await store.close();
  });

  await run('a database with another schema version is rebuilt empty', async () => {
    const p = path.join(tmp, 'ver', 'g.db');
    const store = await openGraphStore(p);
    await store.replaceFile({ path: 'a.js', mtimeMs: 1, size: 1, hash: 'h' }, extracted);
    await store.close();

    const { openCompatDatabase } = require(path.join(buildDir, 'sqlite-compat.js'));
    const db = await openCompatDatabase(p, 'egc-guardian');
    await db.run("UPDATE meta SET value = ? WHERE key = 'version'", String(GRAPH_SCHEMA_VERSION + 1));
    await db.close();

    const again = await openGraphStore(p);
    assert.strictEqual((await again.getFiles()).size, 0);
    await again.close();
  });

  await run('only a damaged database is recovered; any other failure is rethrown and deletes nothing', async () => {
    assert.strictEqual(isCorruption(new Error('SQLITE_NOTADB: file is not a database')), true);
    assert.strictEqual(isCorruption(new Error('database disk image is malformed')), true);
    assert.strictEqual(isCorruption(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' })), true);
    for (const message of ['SQLITE_BUSY: database is locked', 'EACCES: permission denied', 'SQLITE_FULL: database or disk is full', 'EBUSY: resource busy']) {
      assert.strictEqual(isCorruption(new Error(message)), false, message);
    }
    // A path that cannot be opened as a database file is not a damaged one.
    const dir = path.join(tmp, 'a-directory.db');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'still here');
    await assert.rejects(openGraphStoreWithRecovery(dir));
    assert.ok(fs.existsSync(path.join(dir, 'keep.txt')), 'nothing was deleted');
  });

  await run('the change time is stored with the file and survives a touch', async () => {
    const store = await openGraphStore(path.join(tmp, 'ctime', 'g.db'));
    await store.replaceFile({ path: 'a.js', mtimeMs: 1, ctimeMs: 5, size: 10, hash: 'h1' }, { symbols: [], imports: [] });
    assert.strictEqual((await store.getFiles()).get('a.js').ctimeMs, 5);
    await store.touchFile({ path: 'a.js', mtimeMs: 2, ctimeMs: 9, size: 10, hash: 'h1' });
    assert.strictEqual((await store.getFiles()).get('a.js').ctimeMs, 9);
    await store.close();
  });

  await run('a corrupt database file is replaced by openGraphStoreWithRecovery', async () => {
    const p = path.join(tmp, 'bad', 'g.db');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'this is not a sqlite file at all, just text'.repeat(50));
    const store = await openGraphStoreWithRecovery(p);
    await store.replaceFile({ path: 'a.js', mtimeMs: 1, size: 1, hash: 'h' }, extracted);
    assert.strictEqual((await store.getFiles()).size, 1);
    await store.close();
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
