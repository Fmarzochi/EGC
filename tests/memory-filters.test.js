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
const { configureMemoryFilters, FILTER_NAME } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'memory-filters.js'));

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

run('configures filter.smudge so required=true does not break checkout (audit EGC-547, smudge regression)', () => {
  const { dir, git } = makeRepo();
  configureMemoryFilters({ projectDir: dir, scriptPath: LEAK_SCRIPT, dryRun: false });
  const smudge = git('config', `filter.${FILTER_NAME}.smudge`).trim();
  assert.strictEqual(smudge, 'cat');

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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
