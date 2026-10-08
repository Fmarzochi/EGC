'use strict';

/**
 * The cost-tracking skill teaches the files EGC's hooks really write
 * (#1701): metrics/costs.jsonl from scripts/hooks/cost-tracker.js and
 * cost-tracker.log from scripts/hooks/post-bash-command-log.js, never the
 * SQLite database EGC does not have. The fields and the line format are read
 * from the hooks, so the skill fails the suite when a hook changes them.
 *
 * Run with: node tests/docs/cost-tracking-skill.test.js
 */

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

const read = relative => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const skill = read('skills/devops/cost-tracking/SKILL.md');
const costTracker = read('scripts/hooks/cost-tracker.js');
const commandLog = read('scripts/hooks/post-bash-command-log.js');
const skillIndex = JSON.parse(read('scripts/lib/skill-index.json'));

console.log('\n=== Testing the cost-tracking skill against the files EGC writes ===\n');

test('the skill sends the agent to no SQLite database', () => {
  // The prose may warn against a usage.db; no command may query one.
  assert.ok(!skill.includes('.Gemini-cost-tracker'), 'SKILL.md must not point at ~/.Gemini-cost-tracker');
  const codeBlocks = (skill.match(/```[\s\S]*?```/g) || []).join('\n');
  assert.ok(!/\bsqlite3\b/.test(codeBlocks), 'no SKILL.md command may run sqlite3');
});

test('the skill names both files the hooks write', () => {
  assert.ok(/path\.join\(metricsDir, 'costs\.jsonl'\)/.test(costTracker), 'cost-tracker.js must still write metrics/costs.jsonl');
  assert.ok(/path\.join\(getEGCDir\(\), 'metrics'\)/.test(costTracker), 'cost-tracker.js must still write under the EGC directory');
  assert.ok(commandLog.includes("fileName: 'cost-tracker.log'"), 'post-bash-command-log.js must still write cost-tracker.log');
  assert.ok(skill.includes('`metrics/costs.jsonl`'), 'SKILL.md must name metrics/costs.jsonl');
  assert.ok(skill.includes('`cost-tracker.log`'), 'SKILL.md must name cost-tracker.log');
});

test('the skill lists every field cost-tracker.js writes', () => {
  const row = costTracker.match(/const row = \{([\s\S]*?)\};/);
  assert.ok(row, 'cost-tracker.js must build its JSON line in `const row = {...}`');
  const fields = [...row[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[:,]/gm)].map(match => match[1]);
  assert.ok(fields.length >= 5, `expected the row fields, got ${fields.join(', ')}`);
  for (const field of fields) {
    assert.ok(skill.includes(`| \`${field}\` |`), `SKILL.md must document the ${field} field`);
  }
});

test('the skill names every variable cost-tracker.js reads', () => {
  const names = [...new Set([...costTracker.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(match => match[1]))];
  assert.ok(names.length > 0, 'cost-tracker.js must read at least one variable');
  for (const name of names) {
    assert.ok(skill.includes(`\`${name}\``), `SKILL.md must name ${name}, which decides a field`);
  }
});

test('the discovery loop covers every tool directory getEGCDir() can resolve to', () => {
  const utils = read('scripts/lib/utils.js');
  const body = utils.match(/function getKnownHarnessDirs\(home\) \{([\s\S]*?)\n\}/);
  assert.ok(body, 'scripts/lib/utils.js must define getKnownHarnessDirs(home)');
  const dirs = [...body[1].matchAll(/path\.join\(home, ([^)]+)\)/g)]
    .map(match => `~/${[...match[1].matchAll(/'([^']+)'/g)].map(part => part[1]).join('/')}`);
  assert.ok(dirs.length > 5, `expected the known tool directories, got ${dirs.join(', ')}`);
  const loop = skill.match(/for dir in [\s\S]*?; do/);
  assert.ok(loop, 'SKILL.md must keep its discovery loop');
  for (const dir of dirs) {
    assert.ok(new RegExp(`(^|\\s)${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|;)`).test(loop[0]), `the discovery loop must check ${dir}`);
  }
});

test('skill commands reach the protected EGC home only where the Guardian allows it', () => {
  // The Guardian lets the agent read ~/.egc/metrics (buildReadSafePaths in
  // validator.ts) through read-only commands such as test and cat, but
  // refuses jq or a for loop that names a path there, and the rest of ~/.egc.
  const validator = read('mcp/servers/egc-guardian/src/validator.ts');
  assert.ok(
    /function buildReadSafePaths\(\)[\s\S]*?path\.join\(home, '\.egc', 'metrics'\)/.test(validator),
    'the Guardian no longer lists ~/.egc/metrics as readable: revisit the skill'
  );
  guardianSafeCommands(skill, 'SKILL.md');
});

// The commands of a cost document name the EGC home only in a test -f on
// metrics/costs.jsonl, and every jq reads the ledger through cat.
function guardianSafeCommands(markdown, label) {
  const codeLines = (markdown.match(/```[\s\S]*?```/g) || []).join('\n').split(/\r?\n/);
  const egcLines = codeLines.filter(line => line.includes('~/.egc'));
  assert.ok(egcLines.length > 0, `${label} must check ~/.egc/metrics/costs.jsonl`);
  for (const line of egcLines) {
    assert.ok(/^test -f ~\/\.egc\/metrics\/costs\.jsonl /.test(line.trim()), `${label}: only a test -f on ~/.egc/metrics/costs.jsonl may name the EGC home: ${line.trim()}`);
  }
  const jqLines = codeLines.filter(line => /\bjq -r?s\b/.test(line));
  assert.ok(jqLines.length > 0, `${label} must keep its jq examples`);
  for (const line of jqLines) {
    assert.ok(/^cat "\$COSTS" \| jq -r?s/.test(line.trim()), `${label}: jq must read through cat, not name the file: ${line.trim()}`);
  }
}

test('the /cost-report command reads the same ledger, with no SQLite left', () => {
  const command = read('commands/cost-report.md');
  assert.ok(!command.includes('.Gemini-cost-tracker') && !command.includes('usage.db'), 'cost-report.md must not point at a usage.db');
  const codeBlocks = (command.match(/```[\s\S]*?```/g) || []).join('\n');
  assert.ok(!/\bsqlite3\b/.test(codeBlocks), 'no cost-report.md command may run sqlite3');
  assert.ok(command.includes('`metrics/costs.jsonl`'), 'cost-report.md must name metrics/costs.jsonl');
  const row = costTracker.match(/const row = \{([\s\S]*?)\};/);
  for (const field of [...row[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[:,]/gm)].map(match => match[1])) {
    assert.ok(command.includes(`\`${field}\``), `cost-report.md must name the ${field} field`);
  }
  guardianSafeCommands(command, 'cost-report.md');
});

test('the skill shows the cost-tracker.log line format', () => {
  assert.ok(commandLog.includes('tool=Bash command=${command}'), 'post-bash-command-log.js must keep its cost line format');
  assert.ok(skill.includes('tool=Bash command='), 'SKILL.md must show the cost-tracker.log line format');
});

test('the skill index carries the rewritten description', () => {
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, 'SKILL.md must have frontmatter');
  const description = frontmatter[1].match(/^description: (.+)$/m)[1].trim();
  const entry = skillIndex.entries.find(e => e.name === 'cost-tracking');
  assert.ok(entry, 'skill-index.json must list cost-tracking');
  assert.strictEqual(entry.description, description, 'regenerate the index with node scripts/build-skill-index.js');
});

if (failed > 0) {
  console.log(`\nFailed: ${failed}`);
  process.exit(1);
}

console.log(`\nPassed: ${passed}`);
