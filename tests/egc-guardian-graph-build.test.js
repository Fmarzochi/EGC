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
const { execSync } = require('node:child_process');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'graph-build.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { buildGraph, compileRuleGlob, compileRuleRegex, makeIgnore, readFileWithin, resolveSpecifier, withBuildLock } = require(path.join(buildDir, 'graph-build.js'));
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
// Every store a test opens is tracked until it is closed. Windows refuses to
// delete a database file that is still open, so a store left open fails only
// the final cleanup there; the check at the end of the run fails it everywhere.
const openStores = new Set();
const open = async () => {
  const store = await openGraphStore(path.join(tmp, `db${n++}`, 'g.db'));
  openStores.add(store);
  const close = store.close.bind(store);
  store.close = async () => {
    openStores.delete(store);
    await close();
  };
  return store;
};
// The 8.3 short form of a Windows path (RUNNER~1), as os.tmpdir() returns it on
// the GitHub runners, or null where there is none to be had.
function shortPathOf(p) {
  if (process.platform !== 'win32') return null;
  try {
    const cmd = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    const short = execSync(`"${cmd}" /d /c for %I in ("${p}") do @echo %~sI`, { encoding: 'utf8' }).trim();
    return short && short.toLowerCase() !== p.toLowerCase() ? short : null;
  } catch {
    return null;
  }
}
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

  await run('a root given by its Windows 8.3 short name is indexed and read like the long one', async () => {
    const root = project({ 'a.js': "import { b } from './b.js';\nexport function a() { return b(); }\n", 'b.js': 'export function b() { return 1; }\n' });
    const short = shortPathOf(root);
    if (short === null) {
      console.log('  SKIP no 8.3 short name for the temp directory on this platform or volume');
      return;
    }
    const store = await open();
    const res = await buildGraph(short, store);
    assert.strictEqual(res.files, 2, `nothing indexed through ${short}`);
    assert.strictEqual(await readFileWithin(short, 'b.js', 1024), 'export function b() { return 1; }\n');
    // A file that exists beside the root: null must mean "outside the root", not "no such file".
    const outside = path.join(path.dirname(root), 'outside-short-root.js');
    fs.writeFileSync(outside, 'export const secret = 1;\n');
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'export const secret = 1;\n', 'the file outside the root is really there');
    assert.strictEqual(await readFileWithin(short, '../outside-short-root.js', 1024), null, 'a short root is still a root');
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

  await run('readFileWithin refuses a file that shrank while it was being read', async () => {
    const root = fs.realpathSync(project({ 'a.js': 'export const a = 1;\n' }));
    const realOpen = fs.promises.open;
    // The size taken at open says 5 bytes more than the file turns out to hold.
    fs.promises.open = async (...args) => {
      const handle = await realOpen.apply(fs.promises, args);
      const realStat = handle.stat.bind(handle);
      handle.stat = async () => {
        const st = await realStat();
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: st.size + 5 });
      };
      return handle;
    };
    try {
      assert.strictEqual(await readFileWithin(root, 'a.js', 1024), null, 'a part of a file was returned as the whole');
    } finally {
      fs.promises.open = realOpen;
    }
    assert.strictEqual(await readFileWithin(root, 'a.js', 1024), 'export const a = 1;\n', 'and the unchanged file still reads');
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
    let dirLinked = true;
    try {
      fs.symlinkSync(outside, path.join(root, 'linked-dir'), 'junction');
    } catch {
      dirLinked = false;
    }
    if (dirLinked) assert.strictEqual(await readFileWithin(root, 'linked-dir/a.js', 1024), null, 'a file reached through a linked directory');
    else console.log('    - directory links not available here (EPERM); the regular file only');
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

  await run('makeIgnore: ** also matches at the root, and a later ! rule re-includes a file', () => {
    const globs = makeIgnore('**/*.gen.js\ndocs/**\nsrc/**/skip.js\n');
    assert.ok(globs('a.gen.js', false), '**/ matches no directory at all');
    assert.ok(globs('deep/er/a.gen.js', false));
    assert.ok(globs('docs/a/b.md', false), 'a trailing /** matches everything below');
    assert.ok(globs('src/skip.js', false), '/**/ matches zero directories');
    assert.ok(globs('src/x/y/skip.js', false));
    assert.ok(!globs('src/keep.js', false));
    const negated = makeIgnore('*.js\n!keep.js\n');
    assert.ok(negated('a.js', false));
    assert.ok(!negated('keep.js', false), 'the exception stays in');
    assert.ok(!negated('lib/keep.js', false), 'the exception is not anchored');
    const reIgnored = makeIgnore('*.js\n!keep.js\nkeep.js\n');
    assert.ok(reIgnored('keep.js', false), 'the last matching rule decides');
    assert.ok(!makeIgnore('!\n#c\n').call(null, 'x', false), 'an empty negation and a comment ignore nothing');
  });

  await run('a replacement with the same size and the same modification time is still re-indexed', async () => {
    const root = project({ 'a.js': 'export const aa = 1;\n' });
    const file = path.join(root, 'a.js');
    const pinned = Math.floor(Date.now() / 1000) - 100;
    fs.utimesSync(file, pinned, pinned);
    const store = await open();
    await buildGraph(root, store);
    const before = fs.statSync(file);
    await new Promise(resolve => setTimeout(resolve, 30));
    fs.writeFileSync(file, 'export const bb = 1;\n');
    fs.utimesSync(file, pinned, pinned);
    assert.strictEqual(fs.statSync(file).size, before.size);
    assert.strictEqual(fs.statSync(file).mtimeMs, before.mtimeMs, 'the test keeps the modification time');
    assert.strictEqual((await buildGraph(root, store)).refreshed, 1, 'the content changed, so the file is read again');
    assert.deepStrictEqual((await store.load()).symbols.map(s => s.name), ['bb']);
    await store.close();
  });

  await run('withBuildLock removes its own lock on the way out and never a lock another owner has taken', async () => {
    const db = path.join(tmp, `release-${n++}`, 'g.db');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    const lock = `${db}.lock`;
    const first = await withBuildLock(db, async () => {
      assert.ok(fs.existsSync(lock), 'held while running');
      return 'ok';
    });
    assert.deepStrictEqual(first, { ran: true, value: 'ok' });
    assert.ok(!fs.existsSync(lock), 'released after the work');

    const second = await withBuildLock(db, async () => {
      fs.writeFileSync(lock, 'another-owner-token');
      return 'ok';
    });
    assert.strictEqual(second.ran, true);
    assert.strictEqual(fs.readFileSync(lock, 'utf8'), 'another-owner-token', 'a lock with a different token is left alone');
    fs.rmSync(lock, { force: true });
  });

  await run('a fresh lock moved aside by a stale-lock breaker is put back even where hard links do not work', async () => {
    const db = path.join(tmp, `restore-${n++}`, 'g.db');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    const lock = `${db}.lock`;
    fs.writeFileSync(lock, 'TOKEN-A');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    const realRead = fs.readFileSync;
    const realLink = fs.linkSync;
    // The file the breaker moved aside reads as a different, fresh owner's lock; hard links fail as on FAT/exFAT.
    fs.readFileSync = (file, ...rest) => (String(file).startsWith(`${lock}.break-`) ? 'TOKEN-FRESH' : realRead(file, ...rest));
    fs.linkSync = () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    let result;
    try {
      result = await withBuildLock(db, async () => 'never');
    } finally {
      fs.readFileSync = realRead;
      fs.linkSync = realLink;
    }
    assert.strictEqual(result.ran, false, 'the lock was not stale after all');
    assert.ok(fs.existsSync(lock), 'the lock is back');
    assert.strictEqual(fs.readFileSync(lock, 'utf8'), 'TOKEN-A');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(db)).filter(f => f.includes('.break-')), [], 'nothing left behind');
    fs.rmSync(lock, { force: true });
  });

  await run('the non-backtracking matcher agrees with the regex on thousands of generated rules and paths', () => {
    let seed = 20261009;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pick = list => list[Math.floor(rnd() * list.length)];
    const atoms = ['a', 'b', 'src', 'x.js', 'lib', '*', '**', '**/', '?', '*.js', '/', 'a/', '/a', '.git'];
    const segments = ['a', 'b', 'src', 'x.js', 'lib', 'c.js', 'a.js', '.git'];
    const disagreements = [];
    let compared = 0;
    for (let n = 0; n < 4000; n++) {
      const pattern = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(atoms)).join('');
      if (!pattern.replace(/\//g, '')) continue;
      const regexRule = compileRuleRegex(pattern);
      const globRule = compileRuleGlob(pattern);
      for (let k = 0; k < 8; k++) {
        const candidate = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(segments)).join('/');
        const isDir = rnd() < 0.5;
        compared++;
        if (regexRule(candidate, isDir) !== globRule(candidate, isDir) && disagreements.length < 5) {
          disagreements.push(`${JSON.stringify(pattern)} on ${JSON.stringify(candidate)} (dir ${isDir}): regex ${regexRule(candidate, isDir)}, matcher ${globRule(candidate, isDir)}`);
        }
      }
    }
    assert.ok(compared > 20000, `only ${compared} comparisons`);
    assert.deepStrictEqual(disagreements, [], `the two disagree: ${disagreements.join('; ')}`);
  });

  await run('a hostile .gitignore rule is judged in a blink and an oversized rule is dropped', () => {
    const started = Date.now();
    const nested = makeIgnore(`${'**/'.repeat(12)}x`);
    const stars = makeIgnore(`${'*a'.repeat(14)}*b`);
    const slashes = makeIgnore(`${'*/'.repeat(16)}z`);
    assert.strictEqual(nested('a/'.repeat(30) + 'y', false), false);
    assert.strictEqual(stars('a'.repeat(60), false), false);
    assert.strictEqual(slashes('a/'.repeat(40) + 'y', false), false);
    assert.strictEqual(nested('p/q/x', false), true, 'and it still matches what it should');
    const ms = Date.now() - started;
    // One such rule took seconds to judge one path with the regex, and some never finished.
    assert.ok(ms < 3000, `the hostile rules took ${ms} ms`);
    assert.strictEqual(makeIgnore(`${'a'.repeat(2000)}`)('a'.repeat(2000), false), false, 'a rule over the length limit is dropped');
  });

  await run('a .gitignore that is not a plain file is not read, and the project is still indexed', async () => {
    const root = project({ 'a.js': 'export const a = 1;\n' });
    fs.mkdirSync(path.join(root, '.gitignore'));
    const store = await open();
    const result = await buildGraph(root, store);
    assert.strictEqual(result.files, 1);
    const outside = fs.mkdtempSync(path.join(tmp, 'ignore-outside-'));
    fs.writeFileSync(path.join(outside, 'rules'), 'a.js\n');
    const linked = project({ 'a.js': 'export const a = 1;\n' });
    let canLink = true;
    try {
      fs.symlinkSync(path.join(outside, 'rules'), path.join(linked, '.gitignore'), 'file');
    } catch {
      canLink = false;
    }
    if (canLink) {
      const linkedStore = await open();
      try {
        assert.strictEqual((await buildGraph(linked, linkedStore)).files, 1, 'a linked .gitignore is not followed');
      } finally {
        await linkedStore.close();
      }
    } else {
      console.log('    - file symlinks not available here (EPERM); the directory case only');
    }
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

  if (openStores.size > 0) {
    console.log(`  FAIL ${openStores.size} graph store(s) opened by the tests were never closed`);
    failed++;
    for (const store of [...openStores]) await store.close().catch(() => undefined);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
