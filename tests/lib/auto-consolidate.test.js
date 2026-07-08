/**
 * Tests for scripts/lib/auto-consolidate.js and the SessionStart state load.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { autoConsolidateStateFile } = require('../../scripts/lib/auto-consolidate');

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

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function bigStateDocument(projectPath) {
  const decisions = [];
  for (let index = 0; index < 30; index += 1) {
    decisions.push(`- old decision ${index} recorded 2026-01-0${(index % 9) + 1}: rationale ${index}`);
  }
  return [
    '# Project State',
    `project: ${projectPath}`,
    'branch: main',
    'updated: 2026-07-07T00:00:00.000Z',
    '',
    '## Context',
    'Big project context line.',
    '',
    '## Active Decisions',
    ...decisions,
    '',
    '## Next Session',
    '- keep this actionable item verbatim',
    '',
  ].join('\n');
}

function withEnv(env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function main() {
  let passed = 0;
  let failed = 0;

  console.log('Testing auto-consolidate and session-start state load...\n');

  if (test('consolidates an oversized state file with backup', () => {
    const homeDir = createTempDir('egc-autocons-home-');
    try {
      const stateDir = path.join(homeDir, '.egc', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      const filePath = path.join(stateDir, 'Projetos--demo.md');
      fs.writeFileSync(filePath, bigStateDocument('/home/user/Projetos/demo'));
      const linesBefore = fs.readFileSync(filePath, 'utf8').split('\n').length;

      const result = withEnv({ EGC_AUTO_CONSOLIDATE: undefined }, () =>
        autoConsolidateStateFile(filePath, { homeDir, now: new Date('2026-07-07T12:00:00Z') })
      );

      assert.strictEqual(result.consolidated, true);
      assert.ok(result.linesAfter < linesBefore);
      assert.ok(fs.existsSync(result.backupPath));
      const rewritten = fs.readFileSync(filePath, 'utf8');
      assert.ok(rewritten.includes('keep this actionable item verbatim'));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('leaves small files alone and respects the disable flag', () => {
    const homeDir = createTempDir('egc-autocons-home-');
    try {
      const stateDir = path.join(homeDir, '.egc', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      const small = path.join(stateDir, 'small.md');
      fs.writeFileSync(small, '# Project State\n\n## Context\nshort\n');

      const below = autoConsolidateStateFile(small, { homeDir });
      assert.strictEqual(below.consolidated, false);
      assert.strictEqual(below.reason, 'below-threshold');

      const big = path.join(stateDir, 'big.md');
      fs.writeFileSync(big, bigStateDocument('/home/user/big'));
      const disabled = withEnv({ EGC_AUTO_CONSOLIDATE: '0' }, () =>
        autoConsolidateStateFile(big, { homeDir })
      );
      assert.strictEqual(disabled.consolidated, false);
      assert.strictEqual(disabled.reason, 'disabled');

      const missing = autoConsolidateStateFile(path.join(stateDir, 'nope.md'), { homeDir });
      assert.strictEqual(missing.reason, 'missing');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('session-start hook loads branch-layout state and consolidates it', () => {
    const homeDir = createTempDir('egc-autocons-home-');
    const projectDir = createTempDir('egc-autocons-project-');
    try {
      const init = spawnSync('git', ['init', '-b', 'main', '--quiet'], { cwd: projectDir, encoding: 'utf8' });
      assert.strictEqual(init.status, 0, init.stderr);
      const projectSlugValue = projectDir.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_');
      const projectStateDir = path.join(homeDir, '.egc', 'state', projectSlugValue);
      fs.mkdirSync(projectStateDir, { recursive: true });
      const stateFile = path.join(projectStateDir, 'main.md');
      fs.writeFileSync(stateFile, bigStateDocument(projectDir));
      const linesBefore = fs.readFileSync(stateFile, 'utf8').split('\n').length;

      const hookPath = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'claude-session-start.js');
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({ cwd: projectDir }),
        encoding: 'utf8',
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('EGC persistent memory'), 'state not injected: ' + result.stdout.slice(0, 200));
      assert.ok(result.stdout.includes('keep this actionable item verbatim'));

      const linesAfter = fs.readFileSync(stateFile, 'utf8').split('\n').length;
      assert.ok(linesAfter < linesBefore, `expected consolidation (${linesAfter} vs ${linesBefore})`);
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('session-start hook falls back to the flat double-hyphen layout', () => {
    const homeDir = createTempDir('egc-autocons-home-');
    const projectDir = createTempDir('egc-autocons-project-');
    try {
      const projectSlugValue = projectDir.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_');
      const stateDir = path.join(homeDir, '.egc', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, `${projectSlugValue}.md`),
        '# Project State\n\n## Context\nflat layout memory line\n'
      );

      const hookPath = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'claude-session-start.js');
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({ cwd: projectDir }),
        encoding: 'utf8',
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('flat layout memory line'), 'flat state not injected: ' + result.stdout.slice(0, 200));
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
