'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { harnessDirFromClientName, installedComponentSources, splitByInstallation } = require('../../scripts/lib/routing-installed');

const HOME_STATE = ['egc', 'install-state.json'];
const CODEX_STATE = ['egc', 'codex-install-state.json'];
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

if (test('tool-specific state names under a shared root count, and an unreadable state fails closed', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-routing-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-routing-project-'));
  try {
    writeState(path.join(homeDir, '.agents', ...CODEX_STATE), ['skills/devops/github-ops/SKILL.md']);
    const codex = installedComponentSources({ environment: {}, cwd, homeDir });
    assert.strictEqual(codex.known, true, 'the Codex state under .agents is found');
    assert.ok(codex.sources.has('skills/devops/github-ops/SKILL.md'));
    const corrupt = path.join(homeDir, '.claude', ...HOME_STATE);
    fs.mkdirSync(path.dirname(corrupt), { recursive: true });
    fs.writeFileSync(corrupt, '{not json');
    const result = installedComponentSources({ environment: { CLAUDE_PROJECT_DIR: cwd }, cwd, homeDir });
    assert.strictEqual(result.known, true, 'an unreadable state is a found state');
    assert.strictEqual(result.unreadable, 1);
    assert.strictEqual(result.sources.size, 0, 'and it contributes no source');
    const split = splitByInstallation([{ name: 'x', source: 'skills/devops/github-ops/SKILL.md' }], result);
    assert.strictEqual(split.available.length, 0, 'nothing is offered on an unreadable state');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('a harness named by the environment with no install state at all has nothing installed', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-routing-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-routing-project-'));
  try {
    const result = installedComponentSources({ environment: { CLAUDE_PROJECT_DIR: cwd }, cwd, homeDir });
    assert.strictEqual(result.known, true, 'a bare install of a known tool is a known, empty installation');
    assert.strictEqual(result.harnessRoot, path.join(homeDir, '.claude'));
    assert.strictEqual(result.sources.size, 0);
    const split = splitByInstallation([{ name: 'code-reviewer', source: 'agents/code-reviewer.md' }, { name: 'legacy-entry' }], result);
    assert.deepStrictEqual(split.available.map((e) => e.name), ['legacy-entry'], 'nothing with a recorded source is offered');
    assert.deepStrictEqual(split.missing.map((e) => e.name), ['code-reviewer']);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('the MCP client name identifies the tool when the environment says nothing, so another tool\'s library is not offered', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-routing-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-routing-project-'));
  try {
    writeState(path.join(homeDir, '.gemini', ...HOME_STATE), ['agents/code-reviewer.md']);
    const windsurf = installedComponentSources({ environment: {}, cwd, homeDir, clientName: 'windsurf-mcp-client' });
    assert.strictEqual(windsurf.harnessRoot, path.join(homeDir, '.codeium', 'windsurf'));
    assert.strictEqual(windsurf.known, true, 'Windsurf is identified and has no state: a known, empty installation');
    assert.strictEqual(windsurf.sources.size, 0, 'the Gemini library is not offered to Windsurf');
    const gemini = installedComponentSources({ environment: {}, cwd, homeDir, clientName: 'gemini-cli' });
    assert.ok(gemini.sources.has('agents/code-reviewer.md'));
    const unknown = installedComponentSources({ environment: {}, cwd, homeDir, clientName: 'some-new-tool' });
    assert.strictEqual(unknown.harnessRoot, null, 'an unrecognized client name leaves the harness unknown');
    assert.ok(unknown.sources.has('agents/code-reviewer.md'), 'and every known state still counts, as before');
    assert.strictEqual(harnessDirFromClientName('Claude Code', '/h'), path.join('/h', '.claude'));
    assert.strictEqual(harnessDirFromClientName('cursor-vscode', '/h'), path.join('/h', '.cursor'));
    assert.strictEqual(harnessDirFromClientName('', '/h'), null);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
})) passed++; else failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
