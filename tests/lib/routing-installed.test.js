'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installedComponentSources, splitByInstallation } = require('../../scripts/lib/routing-installed');

const HOME_STATE = ['egc', 'install-state.json'];
const PROJECT_STATE = 'egc-install-state.json';

function test(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

function writeState(file, sources) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 'egc.install.v1',
    operations: sources.map((source) => ({ kind: 'copy-file', moduleId: 'm', sourceRelativePath: source, destinationPath: '/dev/null' })),
  }));
}

let passed = 0;
let failed = 0;

console.log('\n=== routing-installed ===\n');

if (test('reads the home state of the harness named by the environment and its project state under cwd', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-routing-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-routing-project-'));
  try {
    writeState(path.join(homeDir, '.claude', ...HOME_STATE), ['skills/devops/github-ops/SKILL.md', 'agents/code-reviewer.md']);
    writeState(path.join(cwd, '.claude', PROJECT_STATE), ['skills/testing/tdd-workflow/SKILL.md']);
    writeState(path.join(homeDir, '.gemini', ...HOME_STATE), ['skills/ai/deep-research/SKILL.md']);
    const result = installedComponentSources({ environment: { CLAUDE_PROJECT_DIR: cwd }, cwd, homeDir });
    assert.strictEqual(result.known, true);
    assert.strictEqual(result.harnessRoot, path.join(homeDir, '.claude'));
    assert.deepStrictEqual([...result.sources].sort(), ['agents/code-reviewer.md', 'skills/devops/github-ops/SKILL.md', 'skills/testing/tdd-workflow/SKILL.md']);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('without a harness variable every known state counts, and none at all means unknown', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-routing-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-routing-project-'));
  try {
    assert.strictEqual(installedComponentSources({ environment: {}, cwd, homeDir }).known, false);
    writeState(path.join(homeDir, '.gemini', ...HOME_STATE), ['skills/ai/deep-research/SKILL.md']);
    writeState(path.join(cwd, '.cursor', PROJECT_STATE), ['agents/planner.md']);
    const result = installedComponentSources({ environment: {}, cwd, homeDir });
    assert.strictEqual(result.known, true);
    assert.strictEqual(result.harnessRoot, null);
    assert.deepStrictEqual([...result.sources].sort(), ['agents/planner.md', 'skills/ai/deep-research/SKILL.md']);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('splits catalog entries by installation and keeps entries without a source available', () => {
  const entries = [
    { kind: 'skill', name: 'github-ops', source: 'skills/devops/github-ops/SKILL.md' },
    { kind: 'skill', name: 'deep-research', source: 'skills/ai/deep-research/SKILL.md' },
    { kind: 'agent', name: 'legacy-entry' },
  ];
  const installed = { known: true, sources: new Set(['skills/devops/github-ops/SKILL.md']) };
  const split = splitByInstallation(entries, installed);
  assert.deepStrictEqual(split.available.map((e) => e.name), ['github-ops', 'legacy-entry']);
  assert.deepStrictEqual(split.missing.map((e) => e.name), ['deep-research']);
  const unknown = splitByInstallation(entries, { known: false, sources: new Set() });
  assert.strictEqual(unknown.missing.length, 0, 'nothing is called missing when no install state was found');
})) passed++; else failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
