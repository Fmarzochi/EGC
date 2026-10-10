/**
 * Contract between the install targets and manifests/tool-paths.json (#1714).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const { listInstallTargetAdapters } = require('../../scripts/lib/install-targets/registry');
const {
  DOC_RELATIVE_PATH,
  checkToolPathsContract,
  findRow,
  loadToolPaths,
  renderToolPathsMarkdown,
} = require('../../scripts/lib/tool-paths');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
const tally = ok => { if (ok) passed++; else failed++; };
const table = loadToolPaths(REPO_ROOT);
const describeEntries = entries => entries.map(entry => `${entry.adapter} [${entry.variant || 'default'}] ${entry.path}`).join('\n      ');

console.log('\n=== Install paths contract (#1714) ===\n');

tally(test('manifests/tool-paths.json matches its schema', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'tool-paths.schema.json'), 'utf8'));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  assert.ok(validate(table), JSON.stringify(validate.errors, null, 2));
  const firstDocumented = table.rows.findIndex(row => row.status === 'documented');
  const badSource = { ...table, rows: table.rows.map((row, index) => (index === firstDocumented ? { ...row, source: 'https://?' } : row)) };
  assert.ok(!validate(badSource), 'a source that is not an https URL fails');
  assert.ok(!validate({ ...table, checkedOn: '2026-99-99' }), 'an impossible checkedOn fails');
}));

tally(test('checkedOn is a real calendar date, and the variant ids are unique with default first', () => {
  const checked = new Date(`${table.checkedOn}T00:00:00Z`);
  assert.ok(!Number.isNaN(checked.getTime()) && checked.toISOString().slice(0, 10) === table.checkedOn, `checkedOn ${table.checkedOn} is not a calendar date`);
  const ids = table.variants.map(variant => variant.id);
  assert.strictEqual(ids[0], 'default', 'the default variant comes first');
  assert.ok(!table.variants[0].adapters, 'the default variant plans every adapter');
  assert.deepStrictEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], 'duplicate variant ids');
}));

tally(test('every registered adapter has rows, and every row and variant names a registered adapter and a declared variant', () => {
  const ids = listInstallTargetAdapters().map(adapter => adapter.id);
  const variants = new Set(table.variants.map(variant => variant.id));
  assert.deepStrictEqual(ids.filter(id => !table.rows.some(row => row.adapter === id)), [], 'adapters without rows');
  assert.deepStrictEqual([...new Set(table.rows.map(row => row.adapter))].filter(id => !ids.includes(id)), [], 'rows for unknown adapters');
  assert.deepStrictEqual(table.variants.flatMap(variant => variant.adapters || []).filter(id => !ids.includes(id)), [], 'variants naming unknown adapters');
  assert.deepStrictEqual(table.rows.filter(row => row.variant && !variants.has(row.variant)).map(row => row.path), [], 'rows naming an undeclared variant');
}));

const result = checkToolPathsContract({ repoRoot: REPO_ROOT, table });

tally(test('every path any install target plans, in every variant, is in the table', () => {
  assert.deepStrictEqual(result.unmatched, [], `planned paths missing from manifests/tool-paths.json:\n      ${describeEntries(result.unmatched)}`);
}));

tally(test('every row of the table is a path some install target plans', () => {
  assert.deepStrictEqual(result.unhit, [], `rows no install target plans any more:\n      ${describeEntries(result.unhit)}`);
}));

tally(test('a path an adapter plans outside the table fails the contract', () => {
  const trimmed = { ...table, rows: table.rows.filter(row => !(row.adapter === 'claude-home' && row.path === '~/.claude/skills/')) };
  const broken = checkToolPathsContract({ repoRoot: REPO_ROOT, table: trimmed, adapters: listInstallTargetAdapters().filter(adapter => adapter.id === 'claude-home') });
  assert.ok(broken.unmatched.some(entry => entry.path.startsWith('~/.claude/skills/')), 'the skills of Claude Code are reported once their row is gone');
}));

tally(test('the longest matching row wins, and a variant row only applies in its variant', () => {
  assert.strictEqual(findRow(table.rows, 'cline-project', 'default', '<project>/.clinerules/hooks/PreToolUse').status, 'unverified');
  assert.strictEqual(findRow(table.rows, 'cline-project', 'default', '<project>/.clinerules/common-memory.md').surface, 'rules');
  assert.strictEqual(findRow(table.rows, 'windsurf-home', 'default', '~/AppData/Roaming/devin/config.json'), null);
  assert.ok(findRow(table.rows, 'windsurf-home', 'win32', '~/AppData/Roaming/devin/config.json'));
}));

tally(test(`${DOC_RELATIVE_PATH} is generated from the table`, () => {
  const current = fs.readFileSync(path.join(REPO_ROOT, DOC_RELATIVE_PATH), 'utf8');
  assert.strictEqual(current, renderToolPathsMarkdown(table), 'run node scripts/ci/generate-tool-paths-doc.js');
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
