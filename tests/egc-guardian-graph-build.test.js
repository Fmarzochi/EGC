'use strict';
/**
 * The graph builder walks a project, indexes only changed files on a later
 * run, resolves relative imports, links symbols to the symbols they use, and
 * never reads outside the project or the files it must not index.
 *
 * Run with: node tests/egc-guardian-graph-build.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'graph-build.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { buildGraph, makeIgnore, resolveSpecifier, withBuildLock } = require(path.join(buildDir, 'graph-build.js'));
const { openGraphStore } = require(path.join(buildDir, 'graph-store.js'));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-graph-build-'));
let n = 0;
function project(files) {
  const root = path.join(tmp, `p${n++}`);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}
const open = () => openGraphStore(path.join(tmp, `db${n++}`, 'g.db'));
const bump = file => {
  const t = new Date(Date.now() + 5000 * ++n);
  fs.utimesSync(file, t, t);
};

(async () => {
  await run('makeIgnore: names, rooted paths, directories, globs, comments', () => {
    const ig = makeIgnore('# c\nlogs/\n/rooted.js\n*.gen.js\nsrc/skip\n');
    assert.ok(ig('logs', true));
    assert.ok(ig('a/logs', true));
    assert.ok(!ig('logs', false), 'a trailing slash matches directories only');
    assert.ok(ig('rooted.js', false));
    assert.ok(!ig('sub/rooted.js', false));
    assert.ok(ig('x/y/z.gen.js', false));
    assert.ok(ig('src/skip/a.js', false));
    assert.ok(!ig('lib/src/skip', false), 'a rule with a slash is anchored at the root');
    assert.ok(!ig('src/keep.js', false));
  });

  await run('resolveSpecifier: extension probing, index files, ts swap, bare and escaping specifiers', () => {
    const set = new Set(['lib/a.ts', 'lib/dir/index.js', 'top.js', 'b.js']);
    assert.strictEqual(resolveSpecifier('lib/x.ts', './a.js', set), 'lib/a.ts');
    assert.strictEqual(resolveSpecifier('lib/x.ts', './a', set), 'lib/a.ts');
    assert.strictEqual(resolveSpecifier('lib/x.ts', './dir', set), 'lib/dir/index.js');
    assert.strictEqual(resolveSpecifier('lib/x.ts', '../top.js', set), 'top.js');
    assert.strictEqual(resolveSpecifier('a.js', './b', set), 'b.js');
    assert.strictEqual(resolveSpecifier('lib/x.ts', 'lodash', set), null);
    assert.strictEqual(resolveSpecifier('x.js', '../../etc/passwd', set), null);
    assert.strictEqual(resolveSpecifier('x.js', './missing', set), null);
  });

  await run('first build indexes sources, honors ignores and links symbols', async () => {
    const root = project({
      'a.js': "import { b } from './b.js';\nexport function a() { return b(); }\n",
      'b.js': 'export function b() { return 1; }\n',
      'node_modules/x/i.js': 'export const nm = 1;\n',
      'dist/o.js': 'export const out = 1;\n',
      'ignored/z.js': 'export const z = 1;\n',
      '.gitignore': 'ignored/\n',
      'readme.md': '# not source\n'
    });
    const store = await open();
    const res = await buildGraph(root, store);
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(res.files, 2);
    assert.strictEqual(res.refreshed, 2);
    const data = await store.load();
    assert.deepStrictEqual(data.files.map(f => f.path), ['a.js', 'b.js']);
    assert.ok(data.edges.some(e => e.kind === 'import' && e.src === 'f:a.js' && e.dst === 'f:b.js'));
    const a = data.symbols.find(s => s.name === 'a');
    const b = data.symbols.find(s => s.name === 'b');
    assert.ok(data.edges.some(e => e.kind === 'ref' && e.src === `s:${a.id}` && e.dst === `s:${b.id}`), JSON.stringify(data.edges));
    await store.close();
  });

  await run('a second build refreshes nothing; a change refreshes one file and re-links', async () => {
    const root = project({
      'a.js': "import { b } from './b.js';\nexport function a() { return b(); }\n",
      'b.js': 'export function b() { return 1; }\n'
    });
    const store = await open();
    await buildGraph(root, store);
    assert.strictEqual((await buildGraph(root, store)).refreshed, 0);

    fs.appendFileSync(path.join(root, 'b.js'), 'export function c() { return b(); }\n');
    bump(path.join(root, 'b.js'));
    const res = await buildGraph(root, store);
    assert.strictEqual(res.refreshed, 1);
    const data = await store.load();
    const a = data.symbols.find(s => s.name === 'a');
    const b = data.symbols.find(s => s.name === 'b');
    assert.ok(data.edges.some(e => e.kind === 'ref' && e.src === `s:${a.id}` && e.dst === `s:${b.id}`), 'a edge into a re-extracted file is rebuilt');
    await store.close();
  });

  await run('a touched file with identical content is not re-extracted', async () => {
    const root = project({ 'a.js': 'export const a = 1;\n' });
    const store = await open();
    await buildGraph(root, store);
    bump(path.join(root, 'a.js'));
    assert.strictEqual((await buildGraph(root, store)).refreshed, 0);
    await store.close();
  });

  await run('file content is fingerprinted with SHA-256, not SHA-1', async () => {
    const text = 'export const a = 1;\n';
    const root = project({ 'a.js': text });
    const store = await open();
    await buildGraph(root, store);
    const row = (await store.getFiles()).get('a.js');
    assert.strictEqual(row.hash, require('node:crypto').createHash('sha256').update(text).digest('hex'));
    assert.strictEqual(row.hash.length, 64);
    await store.close();
  });

  await run('deleting a file removes its rows and edges', async () => {
    const root = project({
      'a.js': "import { b } from './b.js';\nexport function a() { return b(); }\n",
      'b.js': 'export function b() { return 1; }\n'
    });
    const store = await open();
    await buildGraph(root, store);
    fs.rmSync(path.join(root, 'b.js'));
    const res = await buildGraph(root, store);
    assert.strictEqual(res.removed, 1);
    const data = await store.load();
    assert.deepStrictEqual(data.files.map(f => f.path), ['a.js']);
    assert.strictEqual(data.edges.length, 0);
    await store.close();
  });

  await run('caps: maxFiles gives a partial graph, oversize and protected files are skipped', async () => {
    const root = project({ 'a.js': 'export const a = 1;\n', 'b.js': 'export const b = 1;\n', 'big.js': 'export const big = "' + 'x'.repeat(500) + '";\n', 'secret.js': 'export const s = 1;\n' });
    const s1 = await open();
    const partial = await buildGraph(root, s1, { maxFiles: 2 });
    assert.strictEqual(partial.status, 'partial');
    assert.ok(partial.files <= 2);
    await s1.close();

    const s2 = await open();
    const res = await buildGraph(root, s2, { maxFileBytes: 100, isProtectedPath: p => path.basename(p) === 'secret.js' });
    assert.deepStrictEqual((await s2.load()).files.map(f => f.path), ['a.js', 'b.js']);
    assert.strictEqual(res.status, 'ok');
    await s2.close();
  });

  await run('symlinks are never followed', async () => {
    const outside = project({ 'leak.js': 'export const leak = 1;\n' });
    const root = project({ 'a.js': 'export const a = 1;\n' });
    try {
      fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
      fs.symlinkSync(path.join(outside, 'leak.js'), path.join(root, 'leak-link.js'), 'file');
    } catch {
      console.log('    (symlinks not permitted here, partial check only)');
    }
    const store = await open();
    await buildGraph(root, store);
    assert.deepStrictEqual((await store.load()).files.map(f => f.path), ['a.js']);
    await store.close();
  });

  await run('a file that is not valid source does not stop the build', async () => {
    const root = project({ 'junk.js': '}}}} export function (( {{ `', 'ok.js': 'export const ok = 1;\n' });
    const store = await open();
    const res = await buildGraph(root, store);
    assert.strictEqual(res.status, 'ok');
    assert.ok((await store.load()).symbols.some(s => s.name === 'ok'));
    await store.close();
  });

  await run('withBuildLock: a second caller is refused while the first runs', async () => {
    const db = path.join(tmp, 'lock', 'g.db');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    let inner;
    const outer = await withBuildLock(db, async () => {
      inner = await withBuildLock(db, async () => 'never');
      return 'outer';
    });
    assert.deepStrictEqual(inner, { ran: false });
    assert.deepStrictEqual(outer, { ran: true, value: 'outer' });
    const again = await withBuildLock(db, async () => 'again');
    assert.deepStrictEqual(again, { ran: true, value: 'again' }, 'the lock is released');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
