/**
 * Install plan of the engineering-auditor module on Kiro, Trae, Warp and Aider (#1679).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createManifestInstallPlan } = require('../../scripts/lib/install-executor');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MODULE_ID = 'engineering-auditor';
const SOURCES = ['agents/engineering-auditor.md', 'commands/engineering-audit.md', 'commands/engineering-fix.md'];

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.message}`);
    return false;
  }
}

function auditorModule() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifests', 'install-modules.json'), 'utf8'));
  return manifest.modules.find(module => module.id === MODULE_ID);
}

function planFor(target) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-auditor-project-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-auditor-home-'));
  try {
    const plan = createManifestInstallPlan({ sourceRoot: REPO_ROOT, projectRoot, homeDir, target, moduleIds: [MODULE_ID] });
    const destinations = plan.operations
      .filter(operation => SOURCES.includes(String(operation.sourceRelativePath).replaceAll('\\', '/')))
      .map(operation => ({ source: String(operation.sourceRelativePath).replaceAll('\\', '/'), destination: operation.destinationPath }))
      .sort((a, b) => a.source.localeCompare(b.source));
    return { plan, destinations, projectRoot, homeDir };
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function expected(root, folder) {
  return [
    { source: 'agents/engineering-auditor.md', destination: path.join(root, folder, 'agents', 'engineering-auditor.md') },
    { source: 'commands/engineering-audit.md', destination: path.join(root, folder, 'commands', 'engineering-audit.md') },
    { source: 'commands/engineering-fix.md', destination: path.join(root, folder, 'commands', 'engineering-fix.md') },
  ];
}

let passed = 0;
let failed = 0;
const tally = ok => { if (ok) passed++; else failed++; };

console.log('\n=== engineering-auditor install targets (#1679) ===\n');

tally(test('kiro: the plan selects the module and writes the agent and both commands under ~/.kiro', () => {
  const { plan, destinations, homeDir } = planFor('kiro');
  assert.ok(plan.statePreview.resolution.selectedModules.includes(MODULE_ID));
  assert.deepStrictEqual(destinations, expected(homeDir, '.kiro'));
}));

tally(test('trae: the plan selects the module and writes the agent and both commands under the project .trae', () => {
  const { plan, destinations, projectRoot } = planFor('trae');
  assert.ok(plan.statePreview.resolution.selectedModules.includes(MODULE_ID));
  assert.deepStrictEqual(destinations, expected(projectRoot, '.trae'));
}));

for (const target of ['warp', 'aider']) {
  tally(test(`${target}: the plan skips the module, and the manifest records why with a docs link and the date it was read`, () => {
    const { plan, destinations } = planFor(target);
    assert.ok(plan.statePreview.resolution.skippedModules.includes(MODULE_ID), 'the module is reported as skipped');
    assert.deepStrictEqual(destinations, [], 'nothing of the module is planned');
    const reason = auditorModule().unsupportedTargets[target];
    assert.ok(/https:\/\/\S+/.test(reason), `the reason links the tool's docs: ${reason}`);
    assert.ok(/read on \d{4}-\d{2}-\d{2}/.test(reason), `the reason carries the date it was read: ${reason}`);
  }));
}

tally(test('every install target either receives the module or has a recorded reason', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'install-modules.schema.json'), 'utf8'));
  const allTargets = schema.properties.modules.items.properties.targets.items.enum;
  const module = auditorModule();
  const missing = allTargets.filter(target => !module.targets.includes(target) && !(target in module.unsupportedTargets));
  assert.deepStrictEqual(missing, []);
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
