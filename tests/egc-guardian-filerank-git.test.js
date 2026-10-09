'use strict';
/**
 * The git signal reads a local repository only: uncommitted changes, files
 * changed on the branch, recency and co-change of recent commits. Outside a
 * repository, or when git is unavailable, it contributes nothing.
 *
 * Run with: node tests/egc-guardian-filerank-git.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'file-git.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { collectGitContext, matchPath } = require(path.join(buildDir, 'file-git.js'));
const { scoreDocuments, tokenize, registeredSignals } = require(path.join(buildDir, 'file-ranker.js'));

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const gitAvailable = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-filerank-git-'));

(async () => {

await run('outside a repository: no context, signal is zero', async () => {
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  assert.strictEqual(await collectGitContext(plain), null);
});

await run('a missing project path is not a repository', async () => {
  assert.strictEqual(await collectGitContext(path.join(tmp, 'nope')), null);
});

await run('matchPath is suffix-tolerant and normalizes backslashes', async () => {
  const keys = new Set(['src/billing/payments.ts', 'README.md']);
  assert.strictEqual(matchPath('billing/payments.ts', keys), 'src/billing/payments.ts');
  assert.strictEqual(matchPath('src\\billing\\payments.ts', keys), 'src/billing/payments.ts');
  assert.strictEqual(matchPath('other/unknown.ts', keys), undefined);
});

await run('matchPath does not match two different files that only share a name', async () => {
  const keys = new Set(['src/billing/index.ts', 'src/auth/index.ts']);
  assert.strictEqual(matchPath('lib/other/index.ts', keys), undefined);
  assert.strictEqual(matchPath('index.ts', keys), 'src/billing/index.ts', 'a bare name still matches as a path suffix');
});

await run('registers the git signal with weight 1.0', async () => {
  assert.strictEqual(registeredSignals().git, 1.0);
});

if (gitAvailable) {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'billing'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'billing', 'payments.ts'), 'export const pay = 1;\n');
  fs.writeFileSync(path.join(repo, 'billing', 'refunds.ts'), 'export const refund = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(repo, 'billing', 'payments.ts'), 'export const pay = 2;\n');
  git(repo, 'commit', '-qam', 'change payments');
  fs.writeFileSync(path.join(repo, 'billing', 'refunds.ts'), 'export const refund = 2;\n');

  await run('a repository reports uncommitted changes, branch changes and recency', async () => {
    const ctx = await collectGitContext(repo);
    assert.ok(ctx, 'context present');
    assert.ok(ctx.changed.has('billing/refunds.ts'), 'uncommitted file');
    assert.ok(ctx.branch.has('billing/payments.ts'), 'file changed on the branch');
    assert.ok(ctx.recent.get('billing/payments.ts') > 0, 'recent commit file');
  });

  await run('co-change counts files committed together (the init commit holds both)', async () => {
    const ctx = await collectGitContext(repo);
    assert.strictEqual(ctx.cochange.get('billing/payments.ts').get('billing/refunds.ts'), 1);
  });

  await run('the git signal lifts a file with uncommitted changes; without git context it adds nothing', async () => {
    const ctx = await collectGitContext(repo);
    const docs = [
      { path: 'billing/refunds.ts', fields: { path: tokenize('billing/refunds.ts'), symbols: [], keywords: [], summary: [] } },
      { path: 'billing/other.ts', fields: { path: tokenize('billing/other.ts'), symbols: [], keywords: [], summary: [] } }
    ];
    const withGit = scoreDocuments(docs, { query: 'billing', history: '', edges: [], extras: { gitSignal: ctx } }, { signals: ['bm25', 'git'], propagators: [] });
    assert.strictEqual(withGit[0].doc.path, 'billing/refunds.ts');
    const noGit = scoreDocuments(docs, { query: 'billing', history: '', edges: [], extras: {} }, { signals: ['git'], propagators: [] });
    assert.ok(noGit.every(r => r.total === 0));
  });

  await run('a staged rename lists the new path once and no corrupted original path', async () => {
    const moved = path.join(tmp, 'moved');
    fs.mkdirSync(path.join(moved, 'billing'), { recursive: true });
    git(moved, 'init', '-q');
    git(moved, 'config', 'user.email', 't@example.com');
    git(moved, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(moved, 'billing', 'refunds.ts'), 'export const refund = 1;\nexport const more = 2;\n');
    git(moved, 'add', '.');
    git(moved, 'commit', '-q', '-m', 'init');
    git(moved, 'mv', 'billing/refunds.ts', 'billing/returns.ts');
    const ctx = await collectGitContext(moved);
    assert.ok(ctx, 'context present');
    assert.deepStrictEqual([...ctx.changed], ['billing/returns.ts']);
  });

  await run('files inside a new, untracked directory are reported, not just the directory', async () => {
    const fresh = path.join(tmp, 'untracked');
    fs.mkdirSync(fresh, { recursive: true });
    git(fresh, 'init', '-q');
    git(fresh, 'config', 'user.email', 't@example.com');
    git(fresh, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(fresh, 'tracked.ts'), 'export const t = 1;\n');
    git(fresh, 'add', '.');
    git(fresh, 'commit', '-q', '-m', 'init');
    fs.mkdirSync(path.join(fresh, 'feature', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(fresh, 'feature', 'deep', 'new.ts'), 'export const n = 1;\n');
    const ctx = await collectGitContext(fresh);
    assert.ok(ctx.changed.has('feature/deep/new.ts'), [...ctx.changed].join(', '));
  });

  await run('names with spaces and non-ASCII letters arrive unquoted in the branch and recent signals', async () => {
    const names = path.join(tmp, 'names');
    fs.mkdirSync(names, { recursive: true });
    git(names, 'init', '-q');
    git(names, 'config', 'user.email', 't@example.com');
    git(names, 'config', 'user.name', 'test');
    git(names, 'checkout', '-q', '-b', 'main');
    fs.writeFileSync(path.join(names, 'base.ts'), 'export const b = 1;\n');
    git(names, 'add', '.');
    git(names, 'commit', '-q', '-m', 'init');
    git(names, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(names, 'sp ace.ts'), 'export const s = 1;\n');
    fs.writeFileSync(path.join(names, 'ünï.ts'), 'export const u = 1;\n');
    git(names, 'add', '.');
    git(names, 'commit', '-q', '-m', 'names');
    const ctx = await collectGitContext(names);
    for (const name of ['sp ace.ts', 'ünï.ts']) {
      assert.ok(ctx.branch.has(name), `branch: ${[...ctx.branch].join(' | ')}`);
      assert.ok(ctx.recent.has(name), `recent: ${[...ctx.recent.keys()].join(' | ')}`);
    }
    assert.strictEqual(ctx.cochange.get('sp ace.ts').get('ünï.ts'), 1);
  });

  await run('the git key lists are copied once per run, not once per scored file', () => {
    let iterations = 0;
    class Counting extends Set {
      [Symbol.iterator]() {
        iterations++;
        return super[Symbol.iterator]();
      }
    }
    const gitSignal = { changed: new Counting(['a/x.ts']), branch: new Counting(['a/y.ts']), recent: new Map(), cochange: new Map() };
    const docs = Array.from({ length: 60 }, (_, i) => ({ path: `pkg/f${i}.ts`, fields: { path: tokenize(`pkg/f${i}.ts`), symbols: [], keywords: [], summary: [] } }));
    scoreDocuments(docs, { query: 'pkg', history: '', edges: [], extras: { gitSignal } }, { signals: ['git'], propagators: [] });
    assert.ok(iterations <= 2, `the sets were iterated ${iterations} times for ${docs.length} documents`);
  });

  // A repository is not trusted: its own .git/config can name commands that git runs by itself.
  // Each case plants a command that writes a marker file; the marker must never appear.
  function hostileRepo(name, plant) {
    const dir = path.join(tmp, name);
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const marker = path.join(dir, 'RAN.txt');
    const hook = path.join(dir, 'hook.js');
    fs.writeFileSync(hook, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdin.pipe(process.stdout);\n`);
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${hook.replace(/\\/g, '/')}"`;
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    plant(repo, command);
    return { repo, marker };
  }

  await run('a repository that names a core.fsmonitor command does not get it run', async () => {
    const { repo, marker } = hostileRepo('hostile-fsmonitor', (r, command) => {
      git(r, 'config', 'core.fsmonitor', command);
      fs.writeFileSync(path.join(r, 'b.txt'), 'new file');
    });
    const ctx = await collectGitContext(repo);
    assert.ok(!fs.existsSync(marker), 'the repository config ran a command');
    assert.ok(ctx && ctx.recent.has('a.txt'), 'the commit signals are still produced');
  });

  await run('a repository that attaches a clean filter to its files does not get it run', async () => {
    const { repo, marker } = hostileRepo('hostile-filter', (r, command) => {
      fs.writeFileSync(path.join(r, '.gitattributes'), '*.txt filter=probe\n');
      git(r, 'config', 'filter.probe.clean', command);
      // The same size, so git has to read the content to know it changed.
      fs.writeFileSync(path.join(r, 'a.txt'), 'two');
    });
    const ctx = await collectGitContext(repo);
    assert.ok(!fs.existsSync(marker), 'a clean filter from the repository config ran');
    assert.ok(ctx && ctx.recent.has('a.txt'), 'the commit signals are still produced');
    assert.strictEqual(ctx.changed.size, 0, 'the working tree is not read when the repository config carries a filter');
  });

  await run('a repository with ordinary local settings still reports what is uncommitted', async () => {
    const { repo } = hostileRepo('ordinary-config', r => {
      git(r, 'config', 'core.autocrlf', 'false');
      git(r, 'config', 'pull.rebase', 'true');
      fs.writeFileSync(path.join(r, 'c.txt'), 'uncommitted');
    });
    const ctx = await collectGitContext(repo);
    assert.ok(ctx.changed.has('c.txt'), [...ctx.changed].join(', '));
  });

  await run('an unborn or detached HEAD does not throw', async () => {
    const detached = path.join(tmp, 'detached');
    fs.mkdirSync(detached);
    git(detached, 'init', '-q');
    await collectGitContext(detached);
  });
} else {
  console.log('  SKIP repository tests (git not on PATH)');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
})();
