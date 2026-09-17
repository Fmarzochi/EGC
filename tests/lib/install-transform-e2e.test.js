/**
 * A transformed copy through the whole pipeline: installed, verified by
 * doctor, flagged when edited, restored by repair.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createManifestInstallPlan } = require('../../scripts/lib/install-executor');
const { applyInstallPlan } = require('../../scripts/lib/install/apply');
const { buildDoctorReport, repairInstalledStates } = require('../../scripts/lib/install-lifecycle');

const REPO_ROOT = path.join(__dirname, '..', '..');

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function claudeIssues(homeDir, projectRoot) {
  const report = buildDoctorReport({ repoRoot: REPO_ROOT, homeDir, projectRoot, targets: ['claude'] });
  const result = report.results.find(entry => entry.adapter && entry.adapter.id === 'claude-home');
  assert.ok(result, 'the claude-home state must be discovered');
  return result.issues;
}

async function runTests() {
  console.log('\n=== Testing the copy transform end to end ===\n');

  let passed = 0;
  let failed = 0;

  if (await test('a transformed agent is installed, verified, flagged when edited and restored by repair', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transform-e2e-home-'));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transform-e2e-project-'));
    try {
      const plan = createManifestInstallPlan({
        sourceRoot: REPO_ROOT,
        projectRoot,
        homeDir,
        target: 'claude',
        moduleIds: ['agents-core'],
      });
      // The install-state also syncs to the SQLite store in the background;
      // the temporary home must outlive that write.
      await applyInstallPlan(plan, { homeDir }).syncPromise;

      const installed = path.join(homeDir, '.claude', 'agents', 'code-reviewer.md');
      const text = fs.readFileSync(installed, 'utf8');
      assert.ok(text.includes('\ntools: Read, Grep, Glob, Bash\n'), text.slice(0, 300));
      assert.ok(!text.includes('gemini') && !text.includes('stack:'), 'the Gemini model and the catalog stack must not land');
      const source = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'code-reviewer.md'), 'utf8');
      assert.ok(source.includes('gemini') || source.includes('model:'), 'the repository source keeps its own frontmatter');

      let issues = claudeIssues(homeDir, projectRoot);
      assert.ok(!issues.some(issue => issue.code === 'drifted-managed-files'), `fresh install must not drift: ${issues.map(issue => issue.code).join(', ')}`);
      assert.ok(!issues.some(issue => issue.code === 'missing-managed-files'), 'fresh install must be complete');

      fs.writeFileSync(installed, `${text}\nedited by the person\n`);
      issues = claudeIssues(homeDir, projectRoot);
      const drifted = issues.find(issue => issue.code === 'drifted-managed-files');
      assert.ok(drifted && drifted.paths.includes(installed), 'an edited transformed file is drift');

      const repair = repairInstalledStates({ repoRoot: REPO_ROOT, homeDir, projectRoot, targets: ['claude'] });
      assert.ok(repair.results.some(entry => entry.repairedPaths && entry.repairedPaths.includes(installed)), JSON.stringify(repair.summary));
      assert.strictEqual(fs.readFileSync(installed, 'utf8'), text, 'repair rewrites the transformed text, not the raw source');

      issues = claudeIssues(homeDir, projectRoot);
      assert.ok(!issues.some(issue => issue.code === 'drifted-managed-files'), 'repaired file is in sync again');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await test('a transformed destination that turned into a directory is drift, not a crash', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transform-e2e-home-'));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transform-e2e-project-'));
    try {
      const plan = createManifestInstallPlan({ sourceRoot: REPO_ROOT, projectRoot, homeDir, target: 'claude', moduleIds: ['agents-core'] });
      await applyInstallPlan(plan, { homeDir }).syncPromise;
      const installed = path.join(homeDir, '.claude', 'agents', 'code-reviewer.md');
      fs.rmSync(installed);
      fs.mkdirSync(installed);
      const issues = claudeIssues(homeDir, projectRoot);
      const drifted = issues.find(issue => issue.code === 'drifted-managed-files');
      assert.ok(drifted && drifted.paths.includes(installed), issues.map(issue => issue.code).join(', '));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runTests().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { runTests };
