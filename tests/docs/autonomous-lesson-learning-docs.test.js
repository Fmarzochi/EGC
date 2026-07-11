'use strict';

const assert = require('assert');

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

console.log('\n=== Testing autonomous-lesson-learning skill surface ===\n');

const skillPath = path.join(repoRoot, 'skills/ai/autonomous-lesson-learning/SKILL.md');
const commandPath = path.join(repoRoot, 'commands/autonomous-lesson-learning.md');
const agentYamlPath = path.join(repoRoot, 'agent.yaml');

const skill = fs.readFileSync(skillPath, 'utf8');
const command = fs.readFileSync(commandPath, 'utf8');
const agentYaml = fs.readFileSync(agentYamlPath, 'utf8');

test('skill frontmatter declares name and description', () => {
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, 'SKILL.md is missing YAML frontmatter');
  assert.ok(/^name: autonomous-lesson-learning$/m.test(frontmatter[1]), 'frontmatter name must be autonomous-lesson-learning');
  assert.ok(/^description: /m.test(frontmatter[1]), 'frontmatter must include a description');
});

test('skill orchestrates all three egc-memory lesson tools', () => {
  for (const tool of ['lesson_recall', 'lesson_save', 'lesson_reinforce']) {
    assert.ok(skill.includes(tool), `SKILL.md must reference ${tool}`);
  }
});

test('skill requires recall before save so duplicates are reinforced instead', () => {
  assert.ok(
    skill.includes('recall first, reinforce on match, save only on miss'),
    'SKILL.md must state the recall-before-save rule'
  );
});

test('skill defers loop mechanics to continuous-agent-loop instead of reimplementing them', () => {
  assert.ok(skill.includes('continuous-agent-loop'), 'SKILL.md must reference continuous-agent-loop');
  assert.ok(
    skill.includes('continuous-learning-v2'),
    'SKILL.md must position itself relative to continuous-learning-v2'
  );
});

test('command file exists with description frontmatter and lesson flow', () => {
  assert.ok(/^---\r?\ndescription: /.test(command), 'command must start with description frontmatter');
  for (const tool of ['lesson_recall', 'lesson_save', 'lesson_reinforce']) {
    assert.ok(command.includes(tool), `command must reference ${tool}`);
  }
});

test('agent.yaml exports the autonomous-lesson-learning skill and command', () => {
  const matches = agentYaml.match(/^ {2}- autonomous-lesson-learning$/gm) || [];
  assert.strictEqual(matches.length, 2, 'autonomous-lesson-learning must be listed under both skills and commands');
});

if (failed > 0) {
  console.log(`\nFailed: ${failed}`);
  process.exit(1);
}

console.log(`\nPassed: ${passed}`);
