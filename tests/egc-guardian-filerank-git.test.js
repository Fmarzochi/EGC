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
function run(name, fn) {
  try {
    fn();
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

run('outside a repository: no context, signal is zero', () => {
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  assert.strictEqual(collectGitContext(plain), null);
});

run('a missing project path is not a repository', () => {
  assert.strictEqual(collectGitContext(path.join(tmp, 'nope')), null);
});

run('matchPath is suffix-tolerant and normalizes backslashes', () => {
  const keys = new Set(['src/billing/payments.ts', 'README.md']);
  assert.strictEqual(matchPath('billing/payments.ts', keys), 'src/billing/payments.ts');
  assert.strictEqual(matchPath('src\\billing\\payments.ts', keys), 'src/billing/payments.ts');
  assert.strictEqual(matchPath('other/unknown.ts', keys), undefined);
});

run('registers the git signal with weight 1.0', () => {
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

  run('a repository reports uncommitted changes, branch changes and recency', () => {
    const ctx = collectGitContext(repo);
    assert.ok(ctx, 'context present');
    assert.ok(ctx.changed.has('billing/refunds.ts'), 'uncommitted file');
    assert.ok(ctx.branch.has('billing/payments.ts'), 'file changed on the branch');
    assert.ok(ctx.recent.get('billing/payments.ts') > 0, 'recent commit file');
  });

  run('co-change counts files committed together (the init commit holds both)', () => {
    const ctx = collectGitContext(repo);
    assert.strictEqual(ctx.cochange.get('billing/payments.ts').get('billing/refunds.ts'), 1);
  });

  run('the git signal lifts a file with uncommitted changes; without git context it adds nothing', () => {
    const ctx = collectGitContext(repo);
    const docs = [
      { path: 'billing/refunds.ts', fields: { path: tokenize('billing/refunds.ts'), symbols: [], keywords: [], summary: [] } },
      { path: 'billing/other.ts', fields: { path: tokenize('billing/other.ts'), symbols: [], keywords: [], summary: [] } }
    ];
    const withGit = scoreDocuments(docs, { query: 'billing', history: '', edges: [], extras: { gitSignal: ctx } }, { signals: ['bm25', 'git'], propagators: [] });
    assert.strictEqual(withGit[0].doc.path, 'billing/refunds.ts');
    const noGit = scoreDocuments(docs, { query: 'billing', history: '', edges: [], extras: {} }, { signals: ['git'], propagators: [] });
    assert.ok(noGit.every(r => r.total === 0));
  });

  run('an unborn or detached HEAD does not throw', () => {
    const detached = path.join(tmp, 'detached');
    fs.mkdirSync(detached);
    git(detached, 'init', '-q');
    assert.doesNotThrow(() => collectGitContext(detached));
  });
} else {
  console.log('  SKIP repository tests (git not on PATH)');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
