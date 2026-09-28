/**
 * The ck skill's session-start hook: what it injects for a registered
 * project, for a folder that is not one, and what it records as the current
 * session. Runs the hook against a temporary home directory.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hook = path.join(__dirname, '..', '..', 'skills', 'general', 'ck', 'hooks', 'session-start.mjs');

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

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-ck-home-'));
  const project = path.join(home, 'work', 'app');
  fs.mkdirSync(project, { recursive: true });
  return { home, project, ck: path.join(home, '.gemini', 'ck') };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

function registerProject(ck, projectPath, name, context) {
  const projectsFile = path.join(ck, 'projects.json');
  const projects = fs.existsSync(projectsFile) ? JSON.parse(fs.readFileSync(projectsFile, 'utf8')) : {};
  projects[projectPath] = { name, contextDir: name };
  writeJson(projectsFile, projects);
  writeJson(path.join(ck, 'contexts', name, 'context.json'), context);
}

function runHook({ home, project }, sessionId) {
  const result = spawnSync(process.execPath, [hook], {
    cwd: project,
    input: JSON.stringify({ session_id: sessionId }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, PWD: project },
    timeout: 20000,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout).additionalContext : '';
}

function commitIn(dir) {
  const git = args => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(['add', 'a.txt']);
  return git(['commit', '-q', '-m', 'first']).status === 0;
}

function runTests() {
  console.log('\n=== Testing the ck session-start hook ===\n');
  let passed = 0;
  let failed = 0;
  const tally = ok => (ok ? passed++ : failed++);

  tally(test('injects nothing when no project is registered and there is no skill file', () => {
    const dirs = makeHome();
    try {
      assert.strictEqual(runHook(dirs, 'new'), '');
    } finally {
      fs.rmSync(dirs.home, { recursive: true, force: true });
    }
  }));

  tally(test('a registered project gets its summary, an unsaved-session warning, its git activity and a goal mismatch', () => {
    const dirs = makeHome();
    try {
      const hasCommit = commitIn(dirs.project);
      fs.writeFileSync(path.join(dirs.project, 'GEMINI.md'), '# App\n\n## Current Goal\nShip the importer\n\n## Notes\nx\n');
      registerProject(dirs.ck, dirs.project, 'app', {
        name: 'app',
        displayName: 'The App',
        goal: 'Ship the exporter',
        sessions: [
          { id: 'saved-1', date: '2026-01-01', leftOff: 'old' },
          { id: 'saved-2', date: '2026-01-02', leftOff: 'wired the parser\nsecond line', nextSteps: ['tests', 'docs', 'release'] },
        ],
      });
      writeJson(path.join(dirs.ck, 'current-session.json'), { sessionId: 'lost-session' });
      const context = runHook(dirs, 'now-1');
      assert.match(context, /## ck: The App\n\nck: The App \| \d+ days ago \| 2 sessions\nGoal: Ship the exporter\nLeft off: wired the parser\nNext: tests \u00b7 docs\n/);
      assert.ok(context.includes("WARNING Last session wasn't saved"), context);
      if (hasCommit) assert.ok(context.includes('Git: 1 commit since last session'), context);
      assert.ok(context.includes('WARNING Goal mismatch \u2014 ck: "Ship the exporter" \u00b7 GEMINI.md: "Ship the importer"'), context);
      assert.ok(context.includes('## ck: SESSION START'), context);
      assert.ok(context.includes('"Ready \u2014 what are we working on?"'), context);
      const recorded = JSON.parse(fs.readFileSync(path.join(dirs.ck, 'current-session.json'), 'utf8'));
      assert.deepStrictEqual({ ...recorded, startedAt: typeof recorded.startedAt }, { sessionId: 'now-1', projectPath: dirs.project, projectName: 'app', startedAt: 'string' });
    } finally {
      fs.rmSync(dirs.home, { recursive: true, force: true });
    }
  }));

  tally(test('no warning when the previous session was saved or is this one, and none when the goals agree', () => {
    const dirs = makeHome();
    try {
      fs.writeFileSync(path.join(dirs.project, 'GEMINI.md'), '## Current Goal\n  ship THE exporter  \n');
      registerProject(dirs.ck, dirs.project, 'app', { name: 'app', goal: 'Ship the exporter', sessions: [{ id: 'saved-1', date: '2026-01-01' }] });
      writeJson(path.join(dirs.ck, 'current-session.json'), { sessionId: 'saved-1' });
      assert.doesNotMatch(runHook(dirs, 'now-2'), /^WARNING /m);
      assert.doesNotMatch(runHook(dirs, 'now-2'), /^WARNING /m, 'the same session twice');
      const lone = runHook(dirs, 'now-3');
      assert.match(lone, /ck: app \| \d+ days ago \| 1 session\nGoal: Ship the exporter/);
    } finally {
      fs.rmSync(dirs.home, { recursive: true, force: true });
    }
  }));

  tally(test('an unregistered folder lists the three most recent projects, and the skill file comes first', () => {
    const dirs = makeHome();
    try {
      const skillDir = path.join(dirs.home, '.gemini', 'skills', 'ck');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'CK SKILL BODY');
      for (const [name, date] of [['alpha', '2026-01-01'], ['beta', '2026-03-01'], ['gamma', '2026-02-01'], ['delta', '2025-12-01']]) {
        registerProject(dirs.ck, path.join(dirs.home, name), name, { name, sessions: [{ date, summary: `${name} work` }] });
      }
      const context = runHook(dirs, 'now-4');
      assert.ok(context.startsWith('CK SKILL BODY'), context);
      assert.ok(context.includes('ck \u2014 recent projects:'), context);
      const rows = context.split('\n').filter(line => /^ {2}(alpha|beta|gamma|delta) /.test(line)).map(line => line.trim().split(/\s+/)[0]);
      assert.deepStrictEqual(rows, ['beta', 'gamma', 'alpha']);
      const recorded = JSON.parse(fs.readFileSync(path.join(dirs.ck, 'current-session.json'), 'utf8'));
      assert.strictEqual(recorded.projectName, null);
    } finally {
      fs.rmSync(dirs.home, { recursive: true, force: true });
    }
  }));

  tally(test('a registered folder whose context file is missing falls back to the recent list', () => {
    const dirs = makeHome();
    try {
      writeJson(path.join(dirs.ck, 'projects.json'), { [dirs.project]: { name: 'app', contextDir: 'gone' } });
      const context = runHook(dirs, 'now-5');
      assert.ok(context.includes('ck \u2014 recent projects:'), context);
      assert.ok(context.includes('  app '), context);
    } finally {
      fs.rmSync(dirs.home, { recursive: true, force: true });
    }
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
