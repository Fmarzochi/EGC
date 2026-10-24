#!/usr/bin/env node
/**
 * The steward review request: which stewards a pull request's files call for,
 * the machine-readable twin of docs/governance/stewards.md, and the workflow
 * that asks for the review.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'ci', 'request-steward-review.js');
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';
const STEWARDS_JSON = path.join(ROOT, '.github', 'stewards.json');
const STEWARDS_DOC = path.join(ROOT, 'docs', 'governance', 'stewards.md');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'steward-review.yml');

const { matchesGlob, stewardsFor, readStewards } = require(SCRIPT_PATH);

const FIXTURE = {
  areas: [
    {
      area: 'Windows and OpenCode',
      steward: 'windows-person',
      status: 'accepted',
      paths: ['**/*.ps1', '.opencode/**', '**/*opencode*', 'tests/scripts/install-ps1*'],
    },
    {
      area: 'Session Mesh',
      steward: 'mesh-person',
      status: 'invited',
      paths: ['**/*session-bus*'],
    },
    {
      area: 'Installer',
      steward: null,
      status: 'invited',
      paths: ['scripts/lib/install-targets/**'],
    },
  ],
};

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

// The rows of the stewards table in docs/governance/stewards.md: area, the
// login inside the [@login](url) link and the first word of the status.
function tableRows() {
  const lines = fs.readFileSync(STEWARDS_DOC, 'utf8').split(/\r?\n/);
  return lines
    .filter(line => line.startsWith('| ') && !line.startsWith('| Area') && !line.startsWith('|---'))
    .map(line => {
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
      const login = cells[2].match(/\[@([A-Za-z0-9-]+)\]/);
      return { area: cells[0], steward: login ? login[1] : null, status: cells[3].split(' ')[0] };
    });
}

function runCli(args, input) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8', input });
}

function run() {
  console.log('\n=== Testing the steward review request ===\n');

  let passed = 0;
  let failed = 0;
  const tally = (ok) => { ok ? passed++ : failed++; };

  tally(test('matchesGlob: ** spans directories, * stays inside one segment, the match ignores case', () => {
    assert.ok(matchesGlob('**/*.ps1', 'scripts/install.ps1'));
    assert.ok(matchesGlob('**/*.ps1', 'scripts/hooks/cline-guardian-adapter.ps1'));
    assert.ok(matchesGlob('.opencode/**', '.opencode/plugins/egc-hooks.ts'));
    assert.ok(matchesGlob('**/*opencode*', 'scripts/lib/install-targets/opencode-home.js'));
    assert.ok(matchesGlob('**/*opencode*', 'docs/guides/OpenCode-setup.md'));
    assert.ok(matchesGlob('tests/scripts/install-ps1*', 'tests/scripts/install-ps1.test.js'));
    assert.ok(!matchesGlob('**/*.ps1', 'scripts/install.sh'));
    assert.ok(!matchesGlob('scripts/*.ps1', 'scripts/hooks/x.ps1'));
    assert.ok(!matchesGlob('.opencode/**', 'docs/opencode.md'));
  }));

  tally(test('files inside an accepted steward\'s area name that steward once', () => {
    const files = ['scripts/install.ps1', 'README.md', '.opencode/package.json'];
    assert.deepStrictEqual(stewardsFor(files, FIXTURE, { author: 'someone' }), ['windows-person']);
  }));

  tally(test('the steward is not asked to review their own pull request', () => {
    assert.deepStrictEqual(stewardsFor(['scripts/install.ps1'], FIXTURE, { author: 'windows-person' }), []);
  }));

  tally(test('files outside every area name nobody', () => {
    assert.deepStrictEqual(stewardsFor(['README.md', 'scripts/install.sh'], FIXTURE, { author: 'someone' }), []);
  }));

  tally(test('an invited steward and an area without one are not asked', () => {
    const files = ['mcp/servers/egc-memory/src/memory-session-bus.ts', 'scripts/lib/install-targets/helpers.js'];
    assert.deepStrictEqual(stewardsFor(files, FIXTURE, { author: 'someone' }), []);
  }));

  tally(test('a steward whose review is already requested is not asked again', () => {
    const options = { author: 'someone', alreadyRequested: ['windows-person'] };
    assert.deepStrictEqual(stewardsFor(['scripts/install.ps1'], FIXTURE, options), []);
  }));

  tally(test('the CLI reads the file list and the requested reviewers from files and prints one login per line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-steward-'));
    try {
      const stewards = path.join(dir, 'stewards.json');
      const files = path.join(dir, 'files.txt');
      const requested = path.join(dir, 'requested.txt');
      fs.writeFileSync(stewards, JSON.stringify(FIXTURE));
      fs.writeFileSync(files, 'README.md\nscripts/install.ps1\n');
      fs.writeFileSync(requested, '');
      const result = runCli(['--stewards', stewards, '--files', files, '--requested', requested, '--author', 'someone']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, 'windows-person\n');

      fs.writeFileSync(requested, 'windows-person\n');
      const quiet = runCli(['--stewards', stewards, '--files', files, '--requested', requested, '--author', 'someone']);
      assert.strictEqual(quiet.status, 0, quiet.stderr);
      assert.strictEqual(quiet.stdout, '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  tally(test('the CLI refuses an unknown argument and a flag without its value with the usage', () => {
    const unknown = runCli(['--bogus']);
    assert.strictEqual(unknown.status, 2);
    assert.match(unknown.stderr, /Usage:/);
    const dangling = runCli(['--files']);
    assert.strictEqual(dangling.status, 2);
    assert.match(dangling.stderr, /--files/);
  }));

  tally(test('.github/stewards.json agrees with the table in docs/governance/stewards.md', () => {
    const stewards = readStewards(STEWARDS_JSON);
    const rows = tableRows();
    assert.ok(rows.length > 0, 'the stewards table has no rows');
    assert.deepStrictEqual(
      stewards.areas.map(area => [area.area, area.steward, area.status]),
      rows.map(row => [row.area, row.steward, row.status]),
      'the JSON areas, stewards and statuses must match the table, in the same order',
    );
    for (const area of stewards.areas) {
      assert.ok(Array.isArray(area.paths) && area.paths.length > 0, `${area.area} lists no paths`);
      assert.ok(['accepted', 'invited'].includes(area.status), `${area.area} has status ${area.status}`);
    }
  }));

  tally(test('every accepted area matches at least one tracked file of the repository', () => {
    const stewards = readStewards(STEWARDS_JSON);
    const tracked = spawnSync(GIT_BIN, ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    for (const area of stewards.areas.filter(candidate => candidate.status === 'accepted')) {
      const hits = tracked.filter(file => area.paths.some(pattern => matchesGlob(pattern, file)));
      assert.ok(hits.length > 0, `${area.area}: no tracked file matches ${area.paths.join(', ')}`);
    }
  }));

  tally(test('the workflow runs on pull_request_target when a pull request opens, checks out only the base and can write reviews', () => {
    const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const doc = yaml.load(text);
    const trigger = doc.on || doc[true];
    assert.deepStrictEqual(Object.keys(trigger), ['pull_request_target']);
    assert.deepStrictEqual(trigger.pull_request_target.types, ['opened', 'reopened', 'ready_for_review']);
    const job = Object.values(doc.jobs)[0];
    assert.strictEqual(job.permissions['pull-requests'], 'write');
    assert.strictEqual(job.permissions.contents, 'read');
    const checkout = job.steps.find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
    assert.ok(checkout, 'no checkout step');
    assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
    assert.ok(!checkout.with || (!('ref' in checkout.with) && !('repository' in checkout.with)), 'the checkout must stay on the base');
    assert.ok(text.includes('scripts/ci/request-steward-review.js'), 'the workflow does not run the script');
    assert.ok(text.includes('AUTHOR: ${{ github.event.pull_request.user.login }}'), 'the author must reach the shell through env');
    assert.ok(text.includes('repos/$REPO/issues/$PR/comments'), 'a steward the request cannot reach must be mentioned in a comment');
    assert.ok(text.includes('<!-- steward-review -->'), 'the mention comment needs its marker so it is posted once per pull request');
  }));

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

run();
