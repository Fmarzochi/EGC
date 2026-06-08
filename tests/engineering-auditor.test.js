'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
  }
}

console.log('\n=== Testing engineering-auditor ===\n');

// Agent file
test('agent file exists', () => {
  const p = path.join(ROOT, 'agents', 'engineering-auditor.md');
  assert.ok(fs.existsSync(p), `Missing: ${p}`);
});

test('agent has required frontmatter fields', () => {
  const content = fs.readFileSync(path.join(ROOT, 'agents', 'engineering-auditor.md'), 'utf8');
  assert.ok(content.includes('name: engineering-auditor'), 'Missing name field');
  assert.ok(content.includes('description:'), 'Missing description field');
  assert.ok(content.includes('tools:'), 'Missing tools field');
  assert.ok(content.includes('model:'), 'Missing model field');
});

test('agent documents all 8 scored dimensions', () => {
  const content = fs.readFileSync(path.join(ROOT, 'agents', 'engineering-auditor.md'), 'utf8');
  const dimensions = ['Maintainability', 'Security', 'Testing', 'Architecture', 'Documentation', 'Lint', 'Type Safety', 'Build'];
  for (const d of dimensions) {
    assert.ok(content.includes(d), `Missing dimension: ${d}`);
  }
});

test('agent enforces NEVER modify constraint', () => {
  const content = fs.readFileSync(path.join(ROOT, 'agents', 'engineering-auditor.md'), 'utf8');
  assert.ok(content.includes('NEVER modif'), 'Agent must state it never modifies files');
});

test('agent requires user confirmation before Phase 4', () => {
  const content = fs.readFileSync(path.join(ROOT, 'agents', 'engineering-auditor.md'), 'utf8');
  assert.ok(content.includes('explicit') && content.includes('confirm'), 'Agent must require explicit confirmation');
});

// Command files
test('/engineering-audit command file exists', () => {
  const p = path.join(ROOT, 'commands', 'engineering-audit.md');
  assert.ok(fs.existsSync(p), `Missing: ${p}`);
});

test('/engineering-fix command file exists', () => {
  const p = path.join(ROOT, 'commands', 'engineering-fix.md');
  assert.ok(fs.existsSync(p), `Missing: ${p}`);
});

test('engineering-audit command has description frontmatter', () => {
  const content = fs.readFileSync(path.join(ROOT, 'commands', 'engineering-audit.md'), 'utf8');
  assert.ok(content.startsWith('---'), 'Must start with frontmatter');
  assert.ok(content.includes('description:'), 'Missing description');
});

test('engineering-audit command saves report to .egc/audits/', () => {
  const content = fs.readFileSync(path.join(ROOT, 'commands', 'engineering-audit.md'), 'utf8');
  assert.ok(content.includes('.egc/audits'), 'Must document report output path');
});

test('engineering-fix command requires pre-conditions check', () => {
  const content = fs.readFileSync(path.join(ROOT, 'commands', 'engineering-fix.md'), 'utf8');
  assert.ok(content.includes('Pre-condition') || content.includes('pre-condition'), 'Must document pre-conditions');
});

test('engineering-fix command creates isolated branch', () => {
  const content = fs.readFileSync(path.join(ROOT, 'commands', 'engineering-fix.md'), 'utf8');
  assert.ok(content.includes('engineering-fix/'), 'Must create isolated branch');
});

test('engineering-fix command reverts on failure', () => {
  const content = fs.readFileSync(path.join(ROOT, 'commands', 'engineering-fix.md'), 'utf8');
  assert.ok(content.includes('revert') || content.includes('Revert'), 'Must document revert behavior');
});

test('engineering-fix command requires signed commits', () => {
  const content = fs.readFileSync(path.join(ROOT, 'commands', 'engineering-fix.md'), 'utf8');
  assert.ok(content.includes('-s'), 'Must use signed commits (DCO)');
});

// Skill file
test('skill directory exists', () => {
  const p = path.join(ROOT, 'skills', 'general', 'engineering-audit');
  assert.ok(fs.existsSync(p), `Missing skill directory: ${p}`);
});

test('skill SKILL.md exists', () => {
  const p = path.join(ROOT, 'skills', 'general', 'engineering-audit', 'SKILL.md');
  assert.ok(fs.existsSync(p), `Missing: ${p}`);
});

test('skill has required frontmatter', () => {
  const content = fs.readFileSync(path.join(ROOT, 'skills', 'general', 'engineering-audit', 'SKILL.md'), 'utf8');
  assert.ok(content.includes('name: engineering-audit'), 'Missing name');
  assert.ok(content.includes('description:'), 'Missing description');
  assert.ok(content.includes('origin: EGC'), 'Missing origin');
});

test('skill documents refactoring techniques', () => {
  const content = fs.readFileSync(path.join(ROOT, 'skills', 'general', 'engineering-audit', 'SKILL.md'), 'utf8');
  const techniques = ['Extract Method', 'Early Return', 'Strategy Pattern', 'Type Narrowing'];
  for (const t of techniques) {
    assert.ok(content.includes(t), `Missing technique: ${t}`);
  }
});

test('skill documents scoring thresholds', () => {
  const content = fs.readFileSync(path.join(ROOT, 'skills', 'general', 'engineering-audit', 'SKILL.md'), 'utf8');
  assert.ok(content.includes('Scoring Threshold') || content.includes('scoring threshold'), 'Missing scoring thresholds');
});

// Manifest registration
test('engineering-auditor registered in install-modules.json', () => {
  const modules = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifests', 'install-modules.json'), 'utf8'));
  const found = modules.modules.find(m => m.id === 'engineering-auditor');
  assert.ok(found, 'Module not found in install-modules.json');
});

test('engineering-auditor module has required fields', () => {
  const modules = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifests', 'install-modules.json'), 'utf8'));
  const m = modules.modules.find(m => m.id === 'engineering-auditor');
  assert.ok(m.kind, 'Missing kind');
  assert.ok(Array.isArray(m.paths) && m.paths.length > 0, 'Missing paths');
  assert.ok(Array.isArray(m.targets) && m.targets.length > 0, 'Missing targets');
  assert.ok(typeof m.defaultInstall === 'boolean', 'Missing defaultInstall');
  assert.ok(m.stability, 'Missing stability');
});

test('engineering-auditor registered in install-components.json', () => {
  const components = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifests', 'install-components.json'), 'utf8'));
  const found = components.components.find(c => c.id === 'capability:engineering-auditor');
  assert.ok(found, 'Component not found in install-components.json');
});

test('engineering-auditor module paths all exist', () => {
  const modules = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifests', 'install-modules.json'), 'utf8'));
  const m = modules.modules.find(m => m.id === 'engineering-auditor');
  for (const p of m.paths) {
    const full = path.join(ROOT, p);
    assert.ok(fs.existsSync(full), `Path does not exist: ${p}`);
  }
});

// No AI signatures or co-authorship
test('no AI signatures in agent file', () => {
  const content = fs.readFileSync(path.join(ROOT, 'agents', 'engineering-auditor.md'), 'utf8');
  assert.ok(!content.includes('Co-Authored-By'), 'No AI co-authorship allowed');
  assert.ok(!content.includes('Generated by'), 'No AI generation markers allowed');
});

test('no AI signatures in command files', () => {
  for (const cmd of ['engineering-audit.md', 'engineering-fix.md']) {
    const content = fs.readFileSync(path.join(ROOT, 'commands', cmd), 'utf8');
    assert.ok(!content.includes('Co-Authored-By'), `No AI co-authorship in ${cmd}`);
  }
});

// Summary
console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
