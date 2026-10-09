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
const { buildGraph, makeIgnore, readFileWithin, resolveSpecifier, withBuildLock } = require(path.join(buildDir, 'graph-build.js'));
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

  await run('readFileWithin reads a regular file inside the root and nothing else', async () => {
    const root = fs.realpathSync(project({ 'src/a.js': 'export const a = 1;\n', 'big.js': 'x'.repeat(64) }));
    assert.strictEqual(await readFileWithin(root, 'src/a.js', 1024), 'export const a = 1;\n');
    assert.strictEqual(await readFileWithin(root, '../escape.js', 1024), null, 'a path that climbs out of the root');
    assert.strictEqual(await readFileWithin(root, 'src/../../escape.js', 1024), null);
    assert.strictEqual(await readFileWithin(root, path.join(os.tmpdir(), 'anything'), 1024), null, 'an absolute path');
    assert.strictEqual(await readFileWithin(root, 'src', 1024), null, 'a directory');
    assert.strictEqual(await readFileWithin(root, 'missing.js', 1024), null);
    assert.strictEqual(await readFileWithin(root, 'big.js', 63), null, 'a file over the limit');
    assert.strictEqual(await readFileWithin(root, 'big.js', 64), 'x'.repeat(64), 'a file exactly at the limit');
  });

  await run('readFileWithin refuses a symbolic link, to a file or as a directory on the way', async () => {
    const root = fs.realpathSync(project({ 'real/a.js': 'export const a = 1;\n' }));
    const outside = fs.mkdtempSync(path.join(tmp, 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET\n');
    fs.writeFileSync(path.join(outside, 'a.js'), 'export const stolen = 1;\n');
    let fileLinked = true;
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.js'), 'file');
    } catch {
      fileLinked = false;
    }
    if (fileLinked) assert.strictEqual(await readFileWithin(root, 'link.js', 1024), null, 'a file symlink');
    else console.log('    - file symlinks not available here (EPERM); directory link only');
    // A junction needs no privilege on Windows; elsewhere it is a plain directory symlink.
    fs.symlinkSync(outside, path.join(root, 'linked-dir'), 'junction');
    assert.strictEqual(await readFileWithin(root, 'linked-dir/a.js', 1024), null, 'a file reached through a linked directory');
    assert.strictEqual(await readFileWithin(root, 'real/a.js', 1024), 'export const a = 1;\n', 'the real file still reads');
  });

  await run('a build that dies after the file rows but before the edges is repaired by the next build', async () => {
    const root = project({ 'a.js': 'export function a() { return 1; }\n', 'b.js': "import { a } from './a.js';\nexport function b() { return a(); }\n" });
    const real = await open();
    let failEdgesOnce = true;
    const flaky = new Proxy(real, {
      get(target, prop) {
        if (prop === 'replaceEdges') {
          return async edges => {
            if (failEdgesOnce) {
              failEdgesOnce = false;
              throw new Error('disk full');
            }
            return target.replaceEdges(edges);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    await assert.rejects(buildGraph(root, flaky), /disk full/);
    assert.strictEqual((await real.load()).edges.length, 0, 'the files are in, the edges are not');
    assert.strictEqual(await real.edgesDirty(), true, 'the graph says it is not linked');

    const second = await buildGraph(root, real);
    assert.strictEqual(second.refreshed, 0, 'no file changed since the failed build');
    const data = await real.load();
    assert.ok(data.edges.some(e => e.kind === 'import' && e.src === 'f:b.js' && e.dst === 'f:a.js'), 'the next build links what the failed one stored');
    assert.strictEqual(await real.edgesDirty(), false);
    await real.close();
  });

  await run('withBuildLock can wait for its turn and still refuses when the wait runs out', async () => {
    const db = path.join(tmp, `lockwait-${n++}`, 'g.db');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    let release;
    const holder = withBuildLock(db, () => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 50));
    const refused = await withBuildLock(db, async () => 'late', { waitMs: 150 });
    assert.strictEqual(refused.ran, false, 'the holder is still running');
    setTimeout(() => release('done'), 100);
    const waited = await withBuildLock(db, async () => 'second', { waitMs: 2000 });
    assert.deepStrictEqual(waited, { ran: true, value: 'second' });
    assert.deepStrictEqual(await holder, { ran: true, value: 'done' });
  });

  await run('an import of an export alias or a default resolves to the real symbol, not just the file', async () => {
    const root = project({
      'lib.js': 'function foo() { return 1; }\nexport { foo as bar };\nexport default function make() { return 2; }\n',
      'main.js': "import { bar } from './lib.js';\nimport made from './lib.js';\nexport function run() { return bar() + made(); }\n"
    });
    const store = await open();
    await buildGraph(root, store);
    const data = await store.load();
    const id = name => data.symbols.find(s => s.name === name).id;
    const hasRef = (from, to) => data.edges.some(e => e.kind === 'ref' && e.src === `s:${id(from)}` && e.dst === `s:${id(to)}`);
    assert.ok(hasRef('run', 'foo'), 'bar should lead to foo');
    assert.ok(hasRef('run', 'make'), 'the default import should lead to make');
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
