/**
 * The shell scripts of the skills resolve the EGC directory in use the way
 * scripts/lib/utils.js getEGCDir does (EGC_DIR, then the tool the hook runs
 * inside, then the folder the script was installed under, then ~/.egc, then
 * the first tool folder present in the home) instead of a fixed ~/.gemini:
 * the continuous-learning evaluator, the skill-stocktake scan and quick diff,
 * and the rules-distill scans. Each script runs against a temporary home.
 * Needs bash and jq, so the file is skipped on Windows.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { HARNESS_VARIABLES, CONFIG_HOME_VARIABLES } = require('../fixtures/harness-variables');
const { removeDirWithRetries } = require('../fixtures/remove-dir');

const BASH = '/bin/bash';
const ROOT = path.join(__dirname, '..', '..');
const EVALUATE = path.join(ROOT, 'skills', 'ai', 'continuous-learning', 'evaluate-session.sh');
const SCAN = path.join(ROOT, 'skills', 'workflows', 'skill-stocktake', 'scripts', 'scan.sh');
const QUICK_DIFF = path.join(ROOT, 'skills', 'workflows', 'skill-stocktake', 'scripts', 'quick-diff.sh');
const SCAN_RULES = path.join(ROOT, 'skills', 'general_part2', 'rules-distill', 'scripts', 'scan-rules.sh');
const SCAN_SKILLS = path.join(ROOT, 'skills', 'general_part2', 'rules-distill', 'scripts', 'scan-skills.sh');

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-skill-paths-'));
  const project = path.join(home, 'work', 'app');
  fs.mkdirSync(project, { recursive: true });
  return { home, project };
}

function cleanEnv(home, extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (HARNESS_VARIABLES.includes(key) || CONFIG_HOME_VARIABLES.includes(key)) continue;
    env[key] = value;
  }
  return { ...env, HOME: home, ...extra };
}

function run(script, args, { home, cwd, env = {}, input = '' }) {
  return spawnSync(BASH, [script, ...args], {
    cwd: cwd || home,
    env: cleanEnv(home, env),
    input,
    encoding: 'utf8',
    timeout: 30000,
  });
}

function writeSkill(dir, name) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  const file = path.join(dir, name, 'SKILL.md');
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: The ${name} skill\n---\n# ${name}\n`);
  return file;
}

function writeTranscript(dir, count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({ type: 'user', content: `Message ${i + 1}` }));
    lines.push(JSON.stringify({ type: 'assistant', content: `Response ${i + 1}` }));
  }
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function parseJson(result, label) {
  assert.strictEqual(result.status, 0, `${label} exits 0. stderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function skillPaths(output) {
  return output.skills.map(skill => skill.path);
}

function toolsPresent() {
  if (!fs.existsSync(BASH)) return false;
  const probe = spawnSync(BASH, ['-c', 'command -v jq'], { encoding: 'utf8' });
  return probe.status === 0;
}

function tallied(name, fn) {
  const ok = test(name, fn);
  return { passed: ok ? 1 : 0, failed: ok ? 0 : 1 };
}

function addOutcome(totals, outcome) {
  totals.passed += outcome.passed;
  totals.failed += outcome.failed;
}

function runContinuousLearningCases() {
  console.log('\nThe continuous-learning evaluator:');
  const totals = { passed: 0, failed: 0 };

  addOutcome(totals, tallied('saves the learned skills under EGC_DIR when it is set, and never under a fixed ~/.gemini', () => {
    const { home } = makeHome();
    try {
      const egcDir = path.join(home, 'egc-dir');
      const transcript = writeTranscript(home, 12);
      const result = run(EVALUATE, [], { home, env: { EGC_DIR: egcDir }, input: JSON.stringify({ transcript_path: transcript }) });
      assert.strictEqual(result.status, 0, `exits 0. stderr: ${result.stderr}`);
      assert.ok(result.stderr.includes(path.join(egcDir, 'skills', 'learned')), `names the EGC_DIR folder. Got: ${result.stderr}`);
      assert.ok(fs.existsSync(path.join(egcDir, 'skills', 'learned')), 'creates the folder under EGC_DIR');
      assert.ok(!fs.existsSync(path.join(home, '.gemini')), 'writes nothing under ~/.gemini');
    } finally {
      removeDirWithRetries(home);
    }
  }));

  addOutcome(totals, tallied('saves the learned skills under the folder of the tool the hook runs inside', () => {
    const { home } = makeHome();
    try {
      const transcript = writeTranscript(home, 12);
      const result = run(EVALUATE, [], { home, env: { CLAUDECODE: '1' }, input: JSON.stringify({ transcript_path: transcript }) });
      assert.strictEqual(result.status, 0, `exits 0. stderr: ${result.stderr}`);
      assert.ok(result.stderr.includes(path.join(home, '.claude', 'skills', 'learned')), `names the Claude Code folder. Got: ${result.stderr}`);
      assert.ok(!fs.existsSync(path.join(home, '.gemini')), 'writes nothing under ~/.gemini');
    } finally {
      removeDirWithRetries(home);
    }
  }));

  return totals;
}

function runStocktakeScanCases() {
  console.log('\nThe skill-stocktake scan:');
  const totals = { passed: 0, failed: 0 };

  addOutcome(totals, tallied('scans the global skills of the tool the session runs inside and the project skills under .agents', () => {
    const { home, project } = makeHome();
    try {
      const alpha = writeSkill(path.join(home, '.claude', 'skills'), 'alpha');
      writeSkill(path.join(project, '.agents', 'skills'), 'beta');
      const result = run(SCAN, [], { home, cwd: project, env: { CLAUDECODE: '1' } });
      const output = parseJson(result, 'scan.sh');
      assert.strictEqual(output.scan_summary.global.found, true, 'finds the global folder');
      assert.strictEqual(output.scan_summary.project.path, path.join(project, '.agents', 'skills'));
      assert.deepStrictEqual(skillPaths(output).sort(), ['~/.claude/skills/alpha/SKILL.md', '~/work/app/.agents/skills/beta/SKILL.md'].sort());
      assert.ok(!result.stderr.includes('Warning'), `no warning about the project folder. Got: ${result.stderr}`);
      assert.ok(fs.existsSync(alpha));
    } finally {
      removeDirWithRetries(home);
    }
  }));

  addOutcome(totals, tallied('scans the Antigravity skills under config/skills', () => {
    const { home, project } = makeHome();
    try {
      writeSkill(path.join(home, '.gemini', 'config', 'skills'), 'delta');
      const result = run(SCAN, [], { home, cwd: project, env: { GEMINI_PROJECT_DIR: project } });
      const output = parseJson(result, 'scan.sh');
      assert.deepStrictEqual(skillPaths(output), ['~/.gemini/config/skills/delta/SKILL.md']);
    } finally {
      removeDirWithRetries(home);
    }
  }));

  addOutcome(totals, tallied('scans the folder it was installed under when no tool is in the environment', () => {
    const { home, project } = makeHome();
    try {
      const installed = path.join(home, '.cursor', 'skills', 'skill-stocktake', 'scripts', 'scan.sh');
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      fs.copyFileSync(SCAN, installed);
      fs.copyFileSync(path.join(path.dirname(SCAN), 'egc-paths.sh'), path.join(path.dirname(installed), 'egc-paths.sh'));
      writeSkill(path.join(home, '.cursor', 'skills'), 'gamma');
      const result = run(installed, [], { home, cwd: project });
      const output = parseJson(result, 'scan.sh');
      assert.ok(skillPaths(output).includes('~/.cursor/skills/gamma/SKILL.md'), `lists the Cursor skill. Got: ${skillPaths(output)}`);
    } finally {
      removeDirWithRetries(home);
    }
  }));

  addOutcome(totals, tallied('counts the observations of every project in the learning store', () => {
    const { home, project } = makeHome();
    try {
      const alpha = writeSkill(path.join(home, '.claude', 'skills'), 'alpha');
      const observations = path.join(home, '.egc-learning', 'projects', 'abc123', 'observations.jsonl');
      fs.mkdirSync(path.dirname(observations), { recursive: true });
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      fs.writeFileSync(observations, JSON.stringify({ tool: 'Read', path: alpha, timestamp: now }) + '\n');
      const result = run(SCAN, [], { home, cwd: project, env: { CLAUDECODE: '1' } });
      const output = parseJson(result, 'scan.sh');
      assert.strictEqual(output.skills[0].use_7d, 1, `counts the read of the skill. Got: ${JSON.stringify(output.skills[0])}`);
    } finally {
      removeDirWithRetries(home);
    }
  }));

  return totals;
}

function runQuickDiffCases() {
  console.log('\nThe skill-stocktake quick diff:');
  const totals = { passed: 0, failed: 0 };

  addOutcome(totals, tallied('reports a new skill in the global folder of the tool the session runs inside', () => {
    const { home, project } = makeHome();
    try {
      writeSkill(path.join(home, '.claude', 'skills'), 'alpha');
      const results = path.join(home, 'results.json');
      fs.writeFileSync(results, JSON.stringify({ evaluated_at: '2020-01-01T00:00:00Z', skills: {} }));
      const result = run(QUICK_DIFF, [results], { home, cwd: project, env: { CLAUDECODE: '1' } });
      const output = parseJson(result, 'quick-diff.sh');
      assert.deepStrictEqual(output.map(entry => entry.path), ['~/.claude/skills/alpha/SKILL.md']);
      assert.strictEqual(output[0].is_new, true);
    } finally {
      removeDirWithRetries(home);
    }
  }));

  return totals;
}

function runRulesDistillCases() {
  console.log('\nThe rules-distill scans:');
  const totals = { passed: 0, failed: 0 };

  addOutcome(totals, tallied('scan-rules reads the rules of the EGC directory in use, EGC_DIR first', () => {
    const { home } = makeHome();
    try {
      const claudeRules = path.join(home, '.claude', 'rules');
      fs.mkdirSync(claudeRules, { recursive: true });
      fs.writeFileSync(path.join(claudeRules, 'style.md'), '# Style\n\n## Naming\n');
      const fromTool = parseJson(run(SCAN_RULES, [], { home, env: { CLAUDECODE: '1' } }), 'scan-rules.sh');
      assert.strictEqual(fromTool.rules_dir, claudeRules);
      assert.strictEqual(fromTool.total, 1);
      assert.deepStrictEqual(fromTool.rules[0].headings, ['Naming']);

      const egcRules = path.join(home, 'egc-dir', 'rules');
      fs.mkdirSync(egcRules, { recursive: true });
      fs.writeFileSync(path.join(egcRules, 'other.md'), '# Other\n');
      const fromEgcDir = parseJson(run(SCAN_RULES, [], { home, env: { CLAUDECODE: '1', EGC_DIR: path.join(home, 'egc-dir') } }), 'scan-rules.sh');
      assert.strictEqual(fromEgcDir.rules_dir, egcRules);
    } finally {
      removeDirWithRetries(home);
    }
  }));

  addOutcome(totals, tallied('scan-skills reads the global skills of the tool and the project skills under .agents', () => {
    const { home, project } = makeHome();
    try {
      writeSkill(path.join(home, '.claude', 'skills'), 'alpha');
      writeSkill(path.join(project, '.agents', 'skills'), 'beta');
      const result = run(SCAN_SKILLS, [], { home, cwd: project, env: { CLAUDECODE: '1' } });
      assert.strictEqual(result.status, 0, `exits 0. stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('alpha'), `lists the global skill. Got: ${result.stdout}`);
      assert.ok(result.stdout.includes('beta'), `lists the project skill. Got: ${result.stdout}`);
      assert.ok(!result.stderr.includes('Warning'), `no warning about the project folder. Got: ${result.stderr}`);
    } finally {
      removeDirWithRetries(home);
    }
  }));

  return totals;
}

function runTests() {
  if (process.platform === 'win32' || !toolsPresent()) {
    console.log(`  - skipped: the skill scripts need ${BASH} and jq`);
    process.exit(0);
  }

  const totals = { passed: 0, failed: 0 };
  addOutcome(totals, runContinuousLearningCases());
  addOutcome(totals, runStocktakeScanCases());
  addOutcome(totals, runQuickDiffCases());
  addOutcome(totals, runRulesDistillCases());

  console.log(`\nResults: Passed: ${totals.passed}, Failed: ${totals.failed}`);
  process.exit(totals.failed > 0 ? 1 : 0);
}

runTests();
