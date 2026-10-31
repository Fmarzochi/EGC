#!/usr/bin/env node
/**
 * The scheduled dependency audit: the verdict over every lockfile and the
 * Python requirements, the report the workflow turns into an issue, and the
 * workflow that runs it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'ci', 'dependency-audit.js');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'dependency-audit.yml');
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

const { AUDITS, runAudits, renderReport, parseArgs, main } = require(SCRIPT_PATH);

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

function fakeRunner(verdicts) {
  const calls = [];
  const run = audit => {
    calls.push(audit);
    const verdict = verdicts[audit.label] || { status: 0, output: 'found 0 vulnerabilities' };
    return verdict;
  };
  run.calls = calls;
  return run;
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-dependency-audit-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let passed = 0;
let failed = 0;
const tally = ok => { if (ok) passed += 1; else failed += 1; };

console.log('\n=== Testing scripts/ci/dependency-audit.js ===\n');

tally(test('audits every tracked npm lockfile from its own directory, and the Python requirements', () => {
  const npm = AUDITS.filter(audit => audit.command === 'npm');
  const lockfiles = ['.', 'mcp/servers/egc-guardian', 'mcp/servers/egc-memory', '.opencode', 'dashboard', 'docker', 'fuzz'];
  assert.deepStrictEqual(npm.map(audit => audit.cwd).sort(), [...lockfiles].sort());
  for (const cwd of lockfiles) assert.ok(fs.existsSync(path.join(ROOT, cwd, 'package-lock.json')), `${cwd}/package-lock.json must exist`);
  for (const audit of npm) {
    const expected = audit.cwd === 'fuzz' ? ['audit', '--audit-level=high'] : ['audit'];
    assert.deepStrictEqual(audit.args, expected, `${audit.cwd}: every severity counts, except the fuzz harness held to high`);
    assert.ok(audit.label.endsWith('package-lock.json'), audit.label);
  }
  const pip = AUDITS.filter(audit => audit.command === 'pip-audit');
  assert.strictEqual(pip.length, 1);
  assert.deepStrictEqual(pip[0].args, ['-r', 'tests/requirements.txt']);
}));

tally(test('every lockfile git tracks is audited, so a new lockfile cannot slip past the audit', () => {
  const listed = spawnSync(GIT_BIN, ['ls-files', '--', 'package-lock.json', '**/package-lock.json'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(listed.status, 0, listed.stderr);
  const tracked = listed.stdout.split(/\r?\n/).filter(Boolean).map(file => path.posix.dirname(file)).sort();
  assert.ok(tracked.length >= 7, `git lists ${tracked.length} lockfiles`);
  const audited = AUDITS.filter(audit => audit.command === 'npm').map(audit => audit.cwd).sort();
  assert.deepStrictEqual(audited, tracked);
}));

tally(test('a clean run is not red and runs every audit once', () => {
  const run = fakeRunner({});
  const verdict = runAudits(run);
  assert.strictEqual(verdict.red, false);
  assert.strictEqual(run.calls.length, AUDITS.length);
  assert.ok(verdict.results.every(result => result.ok));
}));

tally(test('one red audit makes the run red and keeps the other results', () => {
  const run = fakeRunner({
    'pip-audit: tests/requirements.txt': { status: 1, output: 'pyasn1 0.6.4 CVE-2026-119196 0.6.5' },
  });
  const verdict = runAudits(run);
  assert.strictEqual(verdict.red, true);
  const red = verdict.results.filter(result => !result.ok);
  assert.strictEqual(red.length, 1);
  assert.strictEqual(red[0].label, 'pip-audit: tests/requirements.txt');
  assert.ok(red[0].output.includes('CVE-2026-119196'));
}));

tally(test('an auditor that cannot run counts as red, not as clean', () => {
  const run = fakeRunner({
    'npm audit: package-lock.json': { status: null, output: 'spawn npm ENOENT' },
  });
  const verdict = runAudits(run);
  assert.strictEqual(verdict.red, true);
  assert.ok(verdict.results.find(result => result.label === 'npm audit: package-lock.json').output.includes('ENOENT'));
}));

tally(test('the report names the commit, the verdict and the output of each red audit only', () => {
  const run = fakeRunner({
    'npm audit: mcp/servers/egc-memory/package-lock.json': { status: 1, output: '@hono/node-server  1.19.10 - 2.1.2\nSeverity: moderate' },
  });
  const report = renderReport(runAudits(run), 'abc1234');
  assert.ok(report.startsWith('## Dependency audit on abc1234: RED'));
  assert.ok(report.includes('### RED: npm audit: mcp/servers/egc-memory/package-lock.json'));
  assert.ok(report.includes('@hono/node-server  1.19.10 - 2.1.2'));
  assert.ok(report.includes('### clean: pip-audit: tests/requirements.txt'));
  assert.ok(!report.includes('found 0 vulnerabilities'), 'clean audits keep their output out of the report');
  const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
  assert.ok(!dashes.test(report), 'no dashes in the report');
}));

tally(test('a clean report says so in the heading and lists every audit as clean', () => {
  const report = renderReport(runAudits(fakeRunner({})), 'def5678');
  assert.ok(report.startsWith('## Dependency audit on def5678: clean'));
  assert.strictEqual((report.match(/^### clean: /gm) || []).length, AUDITS.length);
  assert.ok(!report.includes('```'));
}));

tally(test('the report fences red output with more backticks than the output carries, so advisory text cannot close the block', () => {
  const output = 'before\n```\n@everyone see #1\n```\nafter';
  const verdict = { red: true, results: [{ label: 'npm audit: package-lock.json', ok: false, status: 1, output }] };
  const report = renderReport(verdict, 'abc');
  assert.ok(report.includes(`\n\`\`\`\`text\n${output}\n\`\`\`\`\n`), report);
  const plain = renderReport({ red: true, results: [{ label: 'x', ok: false, status: 1, output: 'no fences here' }] }, 'abc');
  assert.ok(plain.includes('\n```text\nno fences here\n```\n'), plain);
}));

tally(test('parseArgs reads --report and --sha and refuses anything else', () => {
  assert.deepStrictEqual(parseArgs([]), { report: null, sha: '' });
  assert.deepStrictEqual(parseArgs(['--report', 'reports/audit.md', '--sha', 'abc']), { report: 'reports/audit.md', sha: 'abc' });
  assert.throws(() => parseArgs(['--bogus']), /unknown argument --bogus/);
  assert.throws(() => parseArgs(['--report']), /missing value for --report/);
}));

tally(test('main writes the report, the step summary and red=1 to the workflow files, and exits 1 when red', () => {
  withTempDir(dir => {
    const report = path.join(dir, 'report.md');
    const summary = path.join(dir, 'summary.md');
    const output = path.join(dir, 'output.txt');
    const run = fakeRunner({ 'pip-audit: tests/requirements.txt': { status: 1, output: 'msgpack 1.2.1 CVE-2026-114613 1.2.3' } });
    const code = main(['--report', report, '--sha', 'c97eac6b'], { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output }, run);
    assert.strictEqual(code, 1);
    const written = fs.readFileSync(report, 'utf8');
    assert.ok(written.startsWith('## Dependency audit on c97eac6b: RED'));
    assert.strictEqual(fs.readFileSync(summary, 'utf8'), written);
    assert.strictEqual(fs.readFileSync(output, 'utf8').trim(), 'red=1');
  });
}));

tally(test('main exits 0 and records red=0 when every audit is clean, and the sha falls back to GITHUB_SHA', () => {
  withTempDir(dir => {
    const output = path.join(dir, 'output.txt');
    const summary = path.join(dir, 'summary.md');
    const code = main([], { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, GITHUB_SHA: '36dea894' }, fakeRunner({}));
    assert.strictEqual(code, 0);
    assert.strictEqual(fs.readFileSync(output, 'utf8').trim(), 'red=0');
    assert.ok(fs.readFileSync(summary, 'utf8').startsWith('## Dependency audit on 36dea894: clean'));
  });
}));

tally(test('main returns 2 on a usage error without running any audit', () => {
  const run = fakeRunner({});
  const code = main(['--nope'], {}, run);
  assert.strictEqual(code, 2);
  assert.strictEqual(run.calls.length, 0);
}));

console.log('\n=== Testing .github/workflows/dependency-audit.yml ===\n');

const workflow = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const job = workflow.jobs.audit;
const steps = job.steps;

tally(test('the workflow runs on a schedule and by hand, with read-only contents at the top', () => {
  assert.ok(Array.isArray(workflow.on.schedule) && workflow.on.schedule.length === 1, 'one cron entry');
  assert.match(workflow.on.schedule[0].cron, /^\d+ \*\/\d+ \* \* \*$/, 'the cron runs several times a day');
  assert.ok('workflow_dispatch' in workflow.on, 'workflow_dispatch so a run can be forced');
  assert.deepStrictEqual(workflow.permissions, { contents: 'read' });
  assert.deepStrictEqual(workflow.concurrency, { group: 'dependency-audit', 'cancel-in-progress': false }, 'runs never overlap, so two runs cannot open two issues');
}));

tally(test('the audit job can write issues and nothing else, and has a timeout', () => {
  assert.deepStrictEqual(job.permissions, { contents: 'read', issues: 'write' });
  assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] <= 20);
}));

tally(test('every action is pinned to a commit with its version beside it', () => {
  const source = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const uses = source.match(/uses: .+/g) || [];
  assert.ok(uses.length >= 3, 'checkout, node and python at least');
  for (const line of uses) assert.match(line, /@[0-9a-f]{40} # v\d+/, `${line} must be pinned to a commit with a version comment`);
}));

tally(test('the job installs the hashed Python requirements (they carry pip-audit) and runs the script with a report', () => {
  const install = steps.find(step => /pip install --require-hashes -r tests\/requirements\.txt/.test(step.run || ''));
  assert.ok(install, 'the pinned Python requirements are installed');
  const audit = steps.find(step => step.id === 'audit');
  assert.ok(audit, 'a step with id audit');
  assert.match(audit.run, /node scripts\/ci\/dependency-audit\.js --report /);
  assert.strictEqual(audit['continue-on-error'], true, 'the issue step must still run when the audit is red');
}));

tally(test('a red audit opens or updates one issue, a clean one closes it, and the job ends red unless the audit reported clean', () => {
  const issueStep = steps.find(step => /gh issue (create|comment)/.test(step.run || ''));
  assert.ok(issueStep, 'a step that opens or comments on the issue');
  assert.match(issueStep.if, /steps\.audit\.outputs\.red == '1'/);
  assert.ok(/gh issue list/.test(issueStep.run), 'the step looks for the open issue before creating another');
  assert.ok(/--jq '\.\[0\]\.number \/\/ empty'/.test(issueStep.run), 'an empty list yields an empty number, never the string null');
  const closeStep = steps.find(step => /gh issue close/.test(step.run || ''));
  assert.ok(closeStep, 'a step that closes the issue once the audit is clean');
  assert.match(closeStep.if, /steps\.audit\.outputs\.red == '0'/);
  assert.ok(/--jq '\.\[0\]\.number \/\/ empty'/.test(closeStep.run), 'an empty list yields an empty number, never the string null');
  const fail = steps[steps.length - 1];
  assert.match(fail.if, /steps\.audit\.outputs\.red != '0'/, 'a script that stopped before writing red fails the run too');
  assert.match(fail.run, /exit 1/);
}));

tally(test('the steps run in the only order that works: install, audit, issue, close, fail', () => {
  const order = [
    steps.findIndex(step => /pip install --require-hashes/.test(step.run || '')),
    steps.findIndex(step => step.id === 'audit'),
    steps.findIndex(step => /gh issue (create|comment)/.test(step.run || '')),
    steps.findIndex(step => /gh issue close/.test(step.run || '')),
    steps.length - 1,
  ];
  assert.ok(order.every(index => index >= 0), `every step is present: ${order.join(', ')}`);
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, `steps are out of order: ${order.join(', ')}`);
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
