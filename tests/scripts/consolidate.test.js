/**
 * Tests for scripts/consolidate.js and scripts/lib/state-consolidate.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'consolidate.js');
const {
  stateFilePath,
  archiveDir,
  weekStart,
  extractEntryDate,
  classifyEntry,
  coreFact,
} = require('../../scripts/lib/state-consolidate');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function weekLabel(isoDate) {
  return weekStart(new Date(`${isoDate}T00:00:00Z`)).toISOString().slice(0, 10);
}

function writeState(homeDir, projectDir, content) {
  const filePath = stateFilePath(homeDir, projectDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function sampleState(projectDir) {
  const recent = daysAgo(2);
  const episodic = daysAgo(15);
  const old = daysAgo(60);

  return [
    '# Project State',
    `project: ${projectDir}`,
    'updated: 2026-06-12T10:00:00.000Z',
    '',
    '## Context',
    'EGC memory pipeline, stabilization phase.',
    '',
    '## Active Decisions',
    `- Adopted layered consolidation (${recent}): keeps state under control`,
    `- Adopted SQLite WAL journaling mode (${episodic}): avoids lock errors`,
    `- Standardized error logging format (${episodic}): JSON lines on stderr`,
    `- Chose Node 20 as minimum runtime baseline (${old}): matches LTS schedule`,
    '- Project uses CommonJS modules everywhere',
    '- Project uses CommonJS modules everywhere',
    '',
    '## Do Not Repeat',
    `- Editing install-state by hand corrupted doctor output (${old})`,
    '- Running npm install without ci flag drifted the lockfile',
    '',
    '## Preferences',
    '- Conventional commit messages',
    '',
    '## Next Session',
    '- Review consolidation output with real state files',
    '',
  ].join('\n');
}

function run(args = [], options = {}) {
  const env = {
    ...process.env,
    HOME: options.homeDir || process.env.HOME,
    USERPROFILE: options.homeDir || process.env.USERPROFILE || process.env.HOME,
  };
  delete env.EGC_CONSOLIDATE_THRESHOLD;
  Object.assign(env, options.env || {});

  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      cwd: options.cwd,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: process.platform === 'win32' ? 30000 : 10000,
    });

    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status || 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

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

function runTests() {
  console.log('\n=== Testing consolidate.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('extracts ISO and BR dates, ignores invalid ones', () => {
    assert.strictEqual(extractEntryDate('done (2026-06-01)').toISOString().slice(0, 10), '2026-06-01');
    assert.strictEqual(extractEntryDate('done em 01/06/2026').toISOString().slice(0, 10), '2026-06-01');
    assert.strictEqual(extractEntryDate('checked 2026-13-40 invalid'), null);
    assert.strictEqual(extractEntryDate('no date here'), null);
  })) passed++; else failed++;

  if (test('classifies entries into working, episodic, and semantic layers', () => {
    const now = new Date();
    assert.strictEqual(classifyEntry(`x (${daysAgo(2)})`, now).layer, 'working');
    assert.strictEqual(classifyEntry(`x (${daysAgo(15)})`, now).layer, 'episodic');
    assert.strictEqual(classifyEntry(`x (${daysAgo(60)})`, now).layer, 'semantic');
    assert.strictEqual(classifyEntry('x without date', now).layer, 'semantic');
  })) passed++; else failed++;

  if (test('coreFact drops the rationale but keeps short prefixes whole', () => {
    assert.strictEqual(coreFact('Adopted SQLite WAL journaling (2026-05-01): avoids lock errors'), 'Adopted SQLite WAL journaling');
    assert.strictEqual(coreFact('fix: lint errors'), 'fix: lint errors');
  })) passed++; else failed++;

  if (test('skips files below the threshold', () => {
    const homeDir = createTempDir('consolidate-home-');
    const projectDir = createTempDir('consolidate-project-');

    try {
      const filePath = writeState(homeDir, projectDir, sampleState(projectDir));
      const before = fs.readFileSync(filePath, 'utf8');

      const result = run(['--project', projectDir], { homeDir, cwd: projectDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('SKIPPED'));
      assert.strictEqual(fs.readFileSync(filePath, 'utf8'), before);
      assert.ok(!fs.existsSync(archiveDir(homeDir)));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('dry-run previews without touching the state file', () => {
    const homeDir = createTempDir('consolidate-home-');
    const projectDir = createTempDir('consolidate-project-');

    try {
      const filePath = writeState(homeDir, projectDir, sampleState(projectDir));
      const before = fs.readFileSync(filePath, 'utf8');

      const result = run(['--project', projectDir, '--threshold', '10', '--dry-run'], { homeDir, cwd: projectDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('DRY-RUN'));
      assert.ok(result.stdout.includes('Preview of consolidated state'));
      assert.ok(result.stdout.includes('## Active Decisions'));
      assert.strictEqual(fs.readFileSync(filePath, 'utf8'), before);
      assert.ok(!fs.existsSync(archiveDir(homeDir)));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('consolidates oversized state with backup and layered output', () => {
    const homeDir = createTempDir('consolidate-home-');
    const projectDir = createTempDir('consolidate-project-');

    try {
      const filePath = writeState(homeDir, projectDir, sampleState(projectDir));
      const before = fs.readFileSync(filePath, 'utf8');

      const result = run(['--project', projectDir, '--threshold', '10'], { homeDir, cwd: projectDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('CONSOLIDATED'));

      const backups = fs.readdirSync(archiveDir(homeDir));
      assert.strictEqual(backups.length, 1);
      const backupContent = fs.readFileSync(path.join(archiveDir(homeDir), backups[0]), 'utf8');
      assert.strictEqual(backupContent, before);

      const after = fs.readFileSync(filePath, 'utf8');

      for (const heading of ['## Context', '## Active Decisions', '## Do Not Repeat', '## Preferences', '## Next Session']) {
        assert.ok(after.includes(heading), `missing heading ${heading}`);
      }

      assert.ok(after.includes(`- Adopted layered consolidation (${daysAgo(2)}): keeps state under control`));

      const expectedWeek = weekLabel(daysAgo(15));
      assert.ok(after.includes(`- Week of ${expectedWeek}: Adopted SQLite WAL journaling mode; Standardized error logging format`));
      assert.ok(!after.includes('avoids lock errors'));

      assert.ok(after.includes('Chose Node 20 as minimum runtime baseline'));
      assert.ok(!after.includes('matches LTS schedule'));
      assert.ok(after.includes('Project uses CommonJS modules everywhere'));

      assert.ok(after.includes('- Review consolidation output with real state files'));

      assert.ok(after.split('\n').length < before.split('\n').length);
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('emits a JSON report with stats and backup path', () => {
    const homeDir = createTempDir('consolidate-home-');
    const projectDir = createTempDir('consolidate-project-');

    try {
      writeState(homeDir, projectDir, sampleState(projectDir));

      const result = run(['--project', projectDir, '--threshold', '10', '--json'], { homeDir, cwd: projectDir });
      assert.strictEqual(result.code, 0, result.stderr);

      const report = JSON.parse(result.stdout);
      assert.strictEqual(report.status, 'consolidated');
      assert.ok(report.linesBefore > report.linesAfter);
      assert.strictEqual(report.stats.workingKept, 1);
      assert.strictEqual(report.stats.episodicWeeks, 1);
      assert.ok(report.stats.semanticFacts >= 3);
      assert.ok(report.stats.duplicatesRemoved >= 1);
      assert.ok(fs.existsSync(report.backup));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('force consolidates a file below the threshold', () => {
    const homeDir = createTempDir('consolidate-home-');
    const projectDir = createTempDir('consolidate-project-');

    try {
      const filePath = writeState(homeDir, projectDir, sampleState(projectDir));

      const result = run(['--project', projectDir, '--force'], { homeDir, cwd: projectDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('CONSOLIDATED'));
      assert.strictEqual(fs.readdirSync(archiveDir(homeDir)).length, 1);
      assert.ok(fs.readFileSync(filePath, 'utf8').includes('## Active Decisions'));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('reports missing state file without failing', () => {
    const homeDir = createTempDir('consolidate-home-');
    const projectDir = createTempDir('consolidate-project-');

    try {
      const result = run(['--project', projectDir], { homeDir, cwd: projectDir });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('MISSING'));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('honors the EGC_CONSOLIDATE_THRESHOLD environment variable', () => {
    const homeDir = createTempDir('consolidate-home-');
    const projectDir = createTempDir('consolidate-project-');

    try {
      writeState(homeDir, projectDir, sampleState(projectDir));

      const result = run(['--project', projectDir], {
        homeDir,
        cwd: projectDir,
        env: { EGC_CONSOLIDATE_THRESHOLD: '10' },
      });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('CONSOLIDATED'));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('rejects unknown arguments', () => {
    const result = run(['--bogus']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('Unknown argument'));
  })) passed++; else failed++;

  if (test('rejects an invalid threshold', () => {
    const result = run(['--threshold', 'abc']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('Invalid threshold'));
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
