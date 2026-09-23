'use strict';
/**
 * Tests for scripts/lib/memory-filters.js and the --filter-clean mode of
 * scripts/check-state-leak.js
 *
 * Proves the complementary privacy layer end to end: after egc init
 * configures the clean filter, `git add` on a populated propagation file
 * stages a zeroed blob, with all bindings kept local to .git (nothing the
 * user commits is touched). Idempotency and the non-git fallback are covered.
 *
 * Run with: node tests/memory-filters.test.js
 */
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const LEAK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-state-leak.js');
const { configureMemoryFilters, FILTER_NAME, PROPAGATION_FILES, forgetIndexStat } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'memory-filters.js'));

const POPULATED = [
  '# EGC: Agent Catalog',
  '',
  '<!-- egc:start -->',
  '<!-- egc:state-updated:2026-07-18T05:15:28.038Z -->',
  '## EGC Project Memory',
  '',
  '**Context:** secret local context that must never ship.',
  '',
  '**Active decisions:**',
  '- private decision one',
  '',
  '## EGC Triggers',
  '<!-- egc:end -->',
  '',
].join('\n');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-filter-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  return { dir, git };
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
const run = (name, fn) => { if (test(name, fn)) passed++; else failed++; };

console.log('\n=== Testing memory filters (clean/smudge layer) ===\n');

run('--filter-clean zeroes stdin and preserves structure', () => {
  const res = spawnSync('node', [LEAK_SCRIPT, '--filter-clean'], { input: POPULATED, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('## EGC Project Memory'), 'structure survives');
  assert.ok(!res.stdout.includes('secret local context'), 'context stripped');
  assert.ok(!res.stdout.includes('state-updated'), 'stamp stripped');
});

run('dry run reports the plan without touching the repo', () => {
  const { dir } = makeRepo();
  const plan = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: true });
  assert.strictEqual(plan.configured, true);
  assert.ok(plan.actions.length >= 5, 'filter config plus four bindings');
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'info', 'attributes')), 'nothing written on dry run');
});

run('configure writes local config and attributes only', () => {
  const { dir, git } = makeRepo();
  const result = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  assert.strictEqual(result.configured, true);
  const cleanCmd = git('config', `filter.${FILTER_NAME}.clean`).trim();
  assert.ok(cleanCmd.includes('--filter-clean'));
  const attrs = fs.readFileSync(path.join(dir, '.git', 'info', 'attributes'), 'utf8');
  assert.ok(attrs.includes(`AGENTS.md filter=${FILTER_NAME}`));
  assert.ok(attrs.includes(`.trae/rules/egc-context.md filter=${FILTER_NAME}`));
  assert.strictEqual(fs.readdirSync(dir).filter(f => f !== '.git').length, 0, 'no tracked files created');
});

run('configure is idempotent', () => {
  const { dir } = makeRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  const attrs = fs.readFileSync(path.join(dir, '.git', 'info', 'attributes'), 'utf8');
  const bindings = attrs.split('\n').filter(l => l.includes('AGENTS.md'));
  assert.strictEqual(bindings.length, 1, 'no duplicate bindings');
});

run('git add stages a zeroed blob for a populated propagation file', () => {
  const { dir, git } = makeRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), POPULATED);
  git('add', 'AGENTS.md');
  const staged = git('show', ':0:AGENTS.md');
  assert.ok(!staged.includes('secret local context'), 'staged blob is clean');
  assert.ok(staged.includes('## EGC Project Memory'), 'staged blob keeps the structure');
  const working = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(working.includes('secret local context'), 'working tree keeps the populated memory');
});

run('a configured repo plans no action on the next run', () => {
  const { dir, git } = makeRepo();
  const first = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  assert.strictEqual(first.actions.length, 3 + PROPAGATION_FILES.length, 'first run writes the three keys and every binding');
  const plan = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: true });
  assert.deepStrictEqual(plan.actions, [], 'nothing is planned once the filter is in place');
  const second = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  assert.strictEqual(second.configured, true);
  assert.deepStrictEqual(second.actions, [], 'the second run reports no change');
  assert.strictEqual(git('config', `filter.${FILTER_NAME}.required`).trim(), 'true');
});

run('a key that drifted is the only planned action and is put back', () => {
  const { dir, git } = makeRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  git('config', `filter.${FILTER_NAME}.required`, 'false');
  const plan = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: true });
  assert.strictEqual(plan.actions.length, 1, `only the drifted key is planned: ${JSON.stringify(plan.actions)}`);
  assert.ok(plan.actions[0].startsWith(`git config filter.${FILTER_NAME}.required true`), plan.actions[0]);
  assert.strictEqual(git('config', `filter.${FILTER_NAME}.required`).trim(), 'false', 'a dry run writes nothing');
  const result = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  assert.strictEqual(result.actions.length, 1);
  assert.strictEqual(git('config', `filter.${FILTER_NAME}.required`).trim(), 'true');
});

run('a key that was unset is planned again on its own', () => {
  const { dir, git } = makeRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  git('config', '--unset', `filter.${FILTER_NAME}.smudge`);
  const plan = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: true });
  assert.deepStrictEqual(plan.actions.map(a => a.split(' ')[2]), [`filter.${FILTER_NAME}.smudge`]);
});

run('GIT_CONFIG pointing at another file never moves the filter out of .git/config', () => {
  const { dir, git } = makeRepo();
  const alternate = path.join(dir, 'alternate-config');
  const saved = process.env.GIT_CONFIG;
  process.env.GIT_CONFIG = alternate;
  let first;
  let second;
  try {
    first = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
    second = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: true });
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG; else process.env.GIT_CONFIG = saved;
  }
  assert.strictEqual(first.configured, true);
  assert.ok(first.actions.length >= 3, 'the first run plans the three keys');
  assert.deepStrictEqual(second.actions, [], 'the second run sees the keys it wrote');
  assert.ok(!fs.existsSync(alternate), 'nothing is written to the alternate file');
  assert.strictEqual(git('config', '--local', `filter.${FILTER_NAME}.required`).trim(), 'true', 'the keys live in .git/config');
});

run('hardening a configured driver with the script missing stays in .git/config under GIT_CONFIG', () => {
  const { dir, git } = makeRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  git('config', '--unset', `filter.${FILTER_NAME}.required`);
  const alternate = path.join(dir, 'alternate-config');
  const saved = process.env.GIT_CONFIG;
  process.env.GIT_CONFIG = alternate;
  let plan;
  try {
    plan = configureMemoryFilters({ projectDir: dir, scriptPath: path.join(dir, 'missing.js'), dryRun: false });
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG; else process.env.GIT_CONFIG = saved;
  }
  assert.strictEqual(plan.configured, false, 'a missing script never configures');
  assert.ok(!fs.existsSync(alternate), 'the alternate file is never touched');
  assert.strictEqual(git('config', '--local', `filter.${FILTER_NAME}.required`).trim(), 'true', 'the repo is hardened in .git/config');
});

run('the installer wrapper reports a configured repo instead of zero changes', () => {
  const { dir } = makeRepo();
  const { applyCommitPrivacyFilterCli } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'memory-filters.js'));
  const first = [];
  applyCommitPrivacyFilterCli({ projectDir: dir, scriptPath: LEAK_SCRIPT, log: m => first.push(m) });
  assert.ok(first.some(m => m.includes('git config filter.')), 'the first run lists what it writes');
  assert.ok(first[first.length - 1].includes('change(s)'), 'the first run ends with its count');
  const second = [];
  applyCommitPrivacyFilterCli({ projectDir: dir, scriptPath: LEAK_SCRIPT, log: m => second.push(m) });
  assert.deepStrictEqual(second, ['commit-privacy filter: already configured (local repo only)']);
});

run('non-git directory is skipped with a reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-nongit-'));
  const plan = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: true });
  assert.strictEqual(plan.configured, false);
  assert.ok(plan.reason.includes('not a git repository'));
});

run('fails closed (does not configure) when the clean-filter script is missing (audit EGC-547, P0)', () => {
  const { dir, git } = makeRepo();
  const missingScript = path.join(dir, 'this-script-does-not-exist.js');
  const plan = configureMemoryFilters({ projectDir: dir, scriptPath: missingScript, dryRun: false });
  assert.strictEqual(plan.configured, false, 'must not report success');
  assert.ok(plan.reason.includes('not found'), 'reason explains why');
  let cleanConfigured = true;
  try {
    git('config', `filter.${FILTER_NAME}.clean`);
  } catch {
    cleanConfigured = false;
  }
  assert.strictEqual(cleanConfigured, false, 'filter must never be configured to point at a script that is not on disk');
});

run('sets filter.required=true so git refuses to stage through a broken filter (audit EGC-547, P0)', () => {
  const { dir, git } = makeRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  const required = git('config', `filter.${FILTER_NAME}.required`).trim();
  assert.strictEqual(required, 'true');
});

run('protects a linked worktree by binding the common git dir, not the per-worktree one (audit EGC-547, worktree regression)', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'placeholder.txt'), 'x');
  git('add', 'placeholder.txt');
  git('commit', '-q', '-m', 'init');
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-worktree-'));
  git('worktree', 'add', worktreeDir, '-b', 'egc-worktree-branch');
  configureMemoryFilters({ projectDir: worktreeDir, scriptPath: LEAK_SCRIPT, dryRun: false });
  // git always reads info/attributes from the main worktree's .git, never
  // from .git/worktrees/<name> -- the binding must land there regardless of
  // which worktree configureMemoryFilters was run from.
  const attrs = fs.readFileSync(path.join(dir, '.git', 'info', 'attributes'), 'utf8');
  assert.ok(attrs.includes(`AGENTS.md filter=${FILTER_NAME}`), 'binding lands in the common git dir, not the per-worktree one');
});

run('hardens an already-configured filter to required=true even when the script later goes missing (audit EGC-547, fail-open regression)', () => {
  const { dir, git } = makeRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  // Simulate a pre-required=true install: strip the hardening this same
  // call just applied, as if the repo had been configured by an older
  // version of this code.
  git('config', `filter.${FILTER_NAME}.required`, 'false');

  const missingScript = path.join(dir, 'this-script-does-not-exist.js');
  const plan = configureMemoryFilters({ projectDir: dir, scriptPath: missingScript, dryRun: false });
  assert.strictEqual(plan.configured, false, 'still must not report success without a real clean script');
  const required = git('config', `filter.${FILTER_NAME}.required`).trim();
  assert.strictEqual(required, 'true', 'an already-configured driver must be hardened even when the script goes missing later');
});

run('hardening a pre-smudge-fix install adds smudge=cat, not just required=true (audit EGC-547, checkout regression)', () => {
  const { dir, git } = makeRepo();
  // Simulate an install from before the smudge fix existed: clean is
  // configured, but smudge and required were never set.
  git('config', `filter.${FILTER_NAME}.clean`, `node ${LEAK_SCRIPT} --filter-clean`);

  const missingScript = path.join(dir, 'this-script-does-not-exist.js');
  configureMemoryFilters({ projectDir: dir, scriptPath: missingScript, dryRun: false });

  const required = git('config', `filter.${FILTER_NAME}.required`).trim();
  assert.strictEqual(required, 'true');
  const smudge = git('config', `filter.${FILTER_NAME}.smudge`).trim();
  assert.strictEqual(smudge, 'cat', 'hardening to required=true must not skip smudge, or checkout breaks on this repo');
});

run('no longer binds the Roo Code and Continue.dev files, which nothing writes any more (retired in #1279)', () => {
  const { dir } = makeRepo();
  const plan = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  assert.strictEqual(plan.configured, true);
  const attrs = fs.readFileSync(path.join(dir, '.git', 'info', 'attributes'), 'utf8');
  assert.ok(attrs.includes(`AGENTS.md filter=${FILTER_NAME}`), 'the live propagation files stay bound');
  for (const retired of ['.roorules', '.roo/rules/egc-context.md', '.continue/rules/egc-context.md']) {
    assert.ok(!attrs.includes(`${retired} filter=${FILTER_NAME}`), `${retired} is not written any more and must not be bound`);
  }
});

run('configures filter.smudge so required=true does not break checkout (audit EGC-547, smudge regression)', () => {
  const { dir, git } = makeRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  const smudge = git('config', `filter.${FILTER_NAME}.smudge`).trim();
  assert.strictEqual(smudge, `if command -v node >/dev/null 2>&1 && [ -f '${LEAK_SCRIPT}' ]; then node '${LEAK_SCRIPT}' --filter-smudge %f; else cat; fi`);

  // End-to-end: with required=true and clean configured but no smudge, git
  // treats the undefined smudge side as a failed filter and aborts checkout
  // ("smudge filter egc-memory failed") instead of the passthru it defaults
  // to when a filter driver is missing entirely. Prove the real checkout
  // path (not just the config value) survives once smudge is set.
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), POPULATED);
  git('add', 'AGENTS.md');
  git('commit', '-q', '-m', 'add AGENTS.md');
  assert.doesNotThrow(() => git('checkout', '--', 'AGENTS.md'), 'checkout must not fail through the configured filter');
});

run('does not skip a real binding fooled by a commented-out or non-exact attributes line (audit EGC-547, P1)', () => {
  const { dir } = makeRepo();
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.git', 'info', 'attributes'),
    `# AGENTS.md filter=${FILTER_NAME}\nAGENTS.md filter=${FILTER_NAME}-something-else\n`
  );
  const plan = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  assert.strictEqual(plan.configured, true);
  const attrs = fs.readFileSync(path.join(dir, '.git', 'info', 'attributes'), 'utf8');
  const realBindingCount = attrs.split('\n').filter(l => l.trim() === `AGENTS.md filter=${FILTER_NAME}`).length;
  assert.strictEqual(realBindingCount, 1, 'the real exact binding must be added despite the lookalike lines');
});

run('configures and cleans correctly when the script path itself contains a space and a single quote (audit EGC-547, P2)', () => {
  const { dir, git } = makeRepo();
  const oddDir = path.join(dir, "a path with spaces and a ' quote");
  fs.mkdirSync(oddDir, { recursive: true });
  const oddScriptPath = path.join(oddDir, 'check-state-leak.js');
  fs.copyFileSync(LEAK_SCRIPT, oddScriptPath);

  const plan = configureMemoryFilters({ projectDir: dir, scriptPath: oddScriptPath, dryRun: false });
  assert.strictEqual(plan.configured, true);

  fs.writeFileSync(path.join(dir, 'AGENTS.md'), POPULATED);
  git('add', 'AGENTS.md');
  const staged = git('show', ':0:AGENTS.md');
  assert.ok(!staged.includes('secret local context'), 'filter actually ran despite the odd path and stripped the content');
});

run('tells a repository git cannot open apart from a directory that is no repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-brokengit-'));
  // A .git file whose gitdir does not exist: inside a repository as far as
  // anything that copies working trees can tell, but git cannot open it.
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(dir, 'missing-gitdir').split(path.sep).join('/')}\n`);
  const plan = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: true });
  assert.strictEqual(plan.configured, false);
  assert.notStrictEqual(plan.reason, 'not a git repository', `the reason must not read as the silent case: ${plan.reason}`);
  assert.ok(plan.reason.includes('git could not open'), plan.reason);
});

// Symbolic links need a privilege Windows runners do not grant.
if (process.platform !== 'win32') {
  run('a .git symlink that points nowhere is a repository git cannot open, not a plain directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-danglinggit-'));
    fs.symlinkSync(path.join(dir, 'missing-gitdir'), path.join(dir, '.git'), 'dir');
    const plan = configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: true });
    assert.strictEqual(plan.configured, false);
    assert.ok(plan.reason.includes('git could not open'), plan.reason);
  });
}


// A mirror rewritten with another size reads as modified to git until its
// entry is looked at again; forgetIndexStat makes git look, and only look.
function seedMirrorRepo() {
  const { dir, git } = makeRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), POPULATED);
  git('add', 'AGENTS.md');
  git('commit', '-q', '-m', 'seed');
  return { dir, git, mirror: path.join(dir, 'AGENTS.md') };
}
const LONGER = POPULATED.replace('- private decision one', '- private decision one\n- private decision two, recorded by a later session, that changes the size of the file');

run('forgetIndexStat: a mirror rewritten with another size reads as unmodified again', () => {
  const { dir, git, mirror } = seedMirrorRepo();
  fs.writeFileSync(mirror, LONGER);
  assert.strictEqual(git('status', '--porcelain', '--', 'AGENTS.md'), ' M AGENTS.md\n', 'git reads the rewritten mirror as modified before the refresh');
  forgetIndexStat(dir, [mirror]);
  assert.strictEqual(git('status', '--porcelain', '--', 'AGENTS.md'), '');
});

run('forgetIndexStat: a change of the user\'s own stays unstaged', () => {
  const { dir, git, mirror } = seedMirrorRepo();
  fs.writeFileSync(mirror, `${LONGER}\nA line the user wrote.\n`);
  forgetIndexStat(dir, [mirror]);
  assert.strictEqual(git('status', '--porcelain', '--', 'AGENTS.md'), ' M AGENTS.md\n');
  assert.strictEqual(git('diff', '--cached', '--name-only'), '');
});

run('forgetIndexStat: the skip-worktree and assume-unchanged marks survive', () => {
  const { dir, git, mirror } = seedMirrorRepo();
  const second = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(second, POPULATED);
  git('add', 'CLAUDE.md');
  git('commit', '-q', '-m', 'second');
  git('update-index', '--skip-worktree', 'AGENTS.md');
  git('update-index', '--assume-unchanged', 'CLAUDE.md');
  fs.writeFileSync(mirror, LONGER);
  fs.writeFileSync(second, LONGER);
  forgetIndexStat(dir, [mirror, second]);
  assert.strictEqual(git('ls-files', '-t', '-v', '--', 'AGENTS.md', 'CLAUDE.md'), 'S AGENTS.md\nh CLAUDE.md\n');
});

run('forgetIndexStat: an intent-to-add mirror stays intent-to-add', () => {
  const { dir, git } = makeRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  fs.writeFileSync(path.join(dir, 'README.md'), '# seed\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'seed');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), POPULATED);
  git('add', '-N', 'AGENTS.md');
  forgetIndexStat(dir, [path.join(dir, 'AGENTS.md')]);
  assert.strictEqual(git('status', '--porcelain', '--', 'AGENTS.md'), ' A AGENTS.md\n');
});

run('forgetIndexStat: an index another git holds is said in one line and left alone', () => {
  const { dir, git, mirror } = seedMirrorRepo();
  fs.writeFileSync(mirror, LONGER);
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    forgetIndexStat(dir, [mirror]);
  } finally {
    process.stderr.write = write;
    fs.unlinkSync(path.join(dir, '.git', 'index.lock'));
  }
  assert.strictEqual(lines.length, 1, JSON.stringify(lines));
  assert.ok(lines[0].includes('could not be refreshed'), lines[0]);
  assert.strictEqual(git('status', '--porcelain', '--', 'AGENTS.md'), ' M AGENTS.md\n');
});

run('forgetIndexStat: a mirror committed empty is a real change, refreshed or not', () => {
  const { dir, git } = makeRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '');
  git('add', 'AGENTS.md');
  git('commit', '-q', '-m', 'empty');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), POPULATED);
  forgetIndexStat(dir, [path.join(dir, 'AGENTS.md')]);
  // The clean side keeps the skeleton of the block, so the file differs
  // from the empty blob for real; the entry is left alone and nothing staged.
  assert.strictEqual(git('status', '--porcelain', '--', 'AGENTS.md'), ' M AGENTS.md\n');
  assert.strictEqual(git('diff', '--cached', '--name-only'), '');
});

run('forgetIndexStat: a project directory below the top level refreshes its own entry', () => {
  const { dir, git } = makeRepo();
  const project = path.join(dir, 'pkg');
  fs.mkdirSync(project);
  configureMemoryFilters({ projectDir: project, scriptPath: LEAK_SCRIPT, dryRun: false });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# root\n');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), POPULATED);
  git('add', 'AGENTS.md', 'pkg/AGENTS.md');
  git('commit', '-q', '-m', 'seed');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), LONGER);
  forgetIndexStat(project, [path.join(project, 'AGENTS.md')]);
  assert.strictEqual(git('status', '--porcelain'), '');
  assert.strictEqual(git('ls-files'), 'AGENTS.md\npkg/AGENTS.md\n', 'no entry appears that was not there');
});

run('forgetIndexStat: outside a repository nothing happens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-norepo-'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), POPULATED);
  forgetIndexStat(dir, [path.join(dir, 'AGENTS.md')]);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
