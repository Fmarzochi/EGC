'use strict';
/**
 * egc import brings an exported memory document back into the state (#2138):
 * a round trip through egc export, a merge that appends only what the memory
 * lacks, a file that does not parse, an entry with the shape of a credential,
 * and a dry run that writes nothing. Everything runs under a temporary HOME.
 *
 * Run with: node tests/scripts/import.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IMPORT = path.join(__dirname, '..', '..', 'scripts', 'import.js');
const EXPORT = path.join(__dirname, '..', '..', 'scripts', 'export.js');
const { mergeSections } = require('../../scripts/import');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-import-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-import-project-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.EGC_DIR;
  const run = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: project, env, encoding: 'utf8' });
  const docPath = name => path.join(home, name);
  return { home, project, run, docPath, cleanup: () => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); } };
}

const FIRST = [
  '# Project State',
  'project: /somewhere/else',
  'author: someone',
  'updated: 2026-11-01T00:00:00.000Z',
  '',
  '## Context',
  'A service that sends invoices.',
  '',
  '## Active Decisions',
  '- Invoices are numbered per year',
  '- PDF rendering stays in the worker',
  '',
  '## Do Not Repeat',
  '- Rendering in the request thread timed out',
  '',
  '## Preferences',
  '- Tests first',
  '',
  '## Next Session',
  '- Wire the retry queue',
  '',
].join('\n');

const SECOND = [
  '# Project State',
  'project: /somewhere/else',
  '',
  '## Context',
  'A service that sends invoices and credit notes.',
  '',
  '## Active Decisions',
  '- PDF rendering stays in the worker',
  '- Credit notes share the invoice numbering',
  '',
  '## Next Session',
  '- Wire the retry queue',
  '- Add the credit note template',
  '',
].join('\n');

console.log('\n=== egc import ===\n');

test('a document is imported into an empty memory and comes back through egc export', () => {
  const box = sandbox();
  try {
    fs.writeFileSync(box.docPath('first.md'), FIRST);
    const result = box.run(IMPORT, [box.docPath('first.md')]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /replaced the memory for /);
    assert.match(result.stdout, /Active Decisions: 0 -> 2/);

    const exported = box.run(EXPORT, ['--json']);
    assert.strictEqual(exported.status, 0, exported.stderr);
    const doc = JSON.parse(exported.stdout);
    assert.strictEqual(doc.context, 'A service that sends invoices.');
    assert.deepStrictEqual(doc.active_decisions, ['Invoices are numbered per year', 'PDF rendering stays in the worker']);
    assert.deepStrictEqual(doc.next_session, ['Wire the retry queue']);
    assert.strictEqual(doc.project, box.project, 'the memory belongs to the target project, not to the path in the document');
    assert.strictEqual(doc.author, 'someone');

    const stateDir = path.join(box.home, '.egc', 'state');
    const files = fs.readdirSync(stateDir, { recursive: true }).filter(name => String(name).endsWith('.md'));
    assert.strictEqual(files.length, 1, `one state file, got ${files.join(', ')}`);
    const raw = fs.readFileSync(path.join(stateDir, String(files[0])));
    assert.ok(raw.subarray(0, 5).toString() === 'EGC1:', 'the state file on disk is encrypted');
  } finally {
    box.cleanup();
  }
});

test('a second document merges: new entries are appended once, the Context is replaced, nothing is lost', () => {
  const box = sandbox();
  try {
    fs.writeFileSync(box.docPath('first.md'), FIRST);
    fs.writeFileSync(box.docPath('second.md'), SECOND);
    assert.strictEqual(box.run(IMPORT, [box.docPath('first.md')]).status, 0);
    const merged = box.run(IMPORT, [box.docPath('second.md'), '--json']);
    assert.strictEqual(merged.status, 0, merged.stderr);
    const report = JSON.parse(merged.stdout);
    assert.strictEqual(report.mode, 'merge');
    assert.strictEqual(report.written, true);
    assert.deepStrictEqual(report.sections['Active Decisions'], { before: 2, after: 3 });
    assert.deepStrictEqual(report.sections['Next Session'], { before: 1, after: 2 });

    const doc = JSON.parse(box.run(EXPORT, ['--json']).stdout);
    assert.strictEqual(doc.context, 'A service that sends invoices and credit notes.');
    assert.deepStrictEqual(doc.active_decisions, [
      'Invoices are numbered per year',
      'PDF rendering stays in the worker',
      'Credit notes share the invoice numbering',
    ]);
    assert.deepStrictEqual(doc.do_not_repeat, ['Rendering in the request thread timed out'], 'a section the document lacks keeps what the memory had');
    assert.deepStrictEqual(doc.next_session, ['Wire the retry queue', 'Add the credit note template']);
  } finally {
    box.cleanup();
  }
});

test('--replace writes the document in place of the memory', () => {
  const box = sandbox();
  try {
    fs.writeFileSync(box.docPath('first.md'), FIRST);
    fs.writeFileSync(box.docPath('second.md'), SECOND);
    assert.strictEqual(box.run(IMPORT, [box.docPath('first.md')]).status, 0);
    assert.strictEqual(box.run(IMPORT, [box.docPath('second.md'), '--replace']).status, 0);
    const doc = JSON.parse(box.run(EXPORT, ['--json']).stdout);
    assert.deepStrictEqual(doc.active_decisions, ['PDF rendering stays in the worker', 'Credit notes share the invoice numbering']);
    assert.deepStrictEqual(doc.do_not_repeat, []);
  } finally {
    box.cleanup();
  }
});

test('a file with none of the AMI sections is refused and nothing is written', () => {
  const box = sandbox();
  try {
    fs.writeFileSync(box.docPath('notes.md'), '# Notes\n\nJust some prose, no sections.\n');
    const result = box.run(IMPORT, [box.docPath('notes.md')]);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /none of the AMI sections/);
    assert.ok(!fs.existsSync(path.join(box.home, '.egc', 'state')), 'no state directory was created');
  } finally {
    box.cleanup();
  }
});

test('an entry with the shape of a credential is refused by its shape, the value is not echoed, nothing is written', () => {
  const box = sandbox();
  try {
    const leaked = 'AKIAIOSFODNN7EXAMPLE';
    fs.writeFileSync(box.docPath('leak.md'), `## Active Decisions\n- The deploy key is ${leaked} for now\n`);
    const result = box.run(IMPORT, [box.docPath('leak.md')]);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /section "Active Decisions" has an entry with an AWS access key id/);
    assert.ok(!result.stderr.includes(leaked) && !result.stdout.includes(leaked), 'the value never appears in the output');
    assert.ok(!fs.existsSync(path.join(box.home, '.egc', 'state')));
  } finally {
    box.cleanup();
  }
});

test('--dry-run prints the change per section and writes nothing', () => {
  const box = sandbox();
  try {
    fs.writeFileSync(box.docPath('first.md'), FIRST);
    const result = box.run(IMPORT, [box.docPath('first.md'), '--dry-run']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /would replace the memory for /);
    assert.match(result.stdout, /Next Session: 0 -> 1/);
    assert.match(result.stdout, /nothing was written/);
    assert.ok(!fs.existsSync(path.join(box.home, '.egc', 'state')));
    const asJson = JSON.parse(box.run(IMPORT, [box.docPath('first.md'), '--dry-run', '--json']).stdout);
    assert.strictEqual(asJson.written, false);
  } finally {
    box.cleanup();
  }
});

test('a missing file, an empty document and a bad flag are refused with their own exit codes', () => {
  const box = sandbox();
  try {
    assert.strictEqual(box.run(IMPORT, []).status, 1);
    assert.strictEqual(box.run(IMPORT, [box.docPath('absent.md')]).status, 1);
    fs.writeFileSync(box.docPath('empty.md'), '## Context\n\n## Active Decisions\n');
    const empty = box.run(IMPORT, [box.docPath('empty.md')]);
    assert.strictEqual(empty.status, 2, empty.stderr);
    assert.strictEqual(box.run(IMPORT, [box.docPath('empty.md'), '--bogus']).status, 1);
  } finally {
    box.cleanup();
  }
});

test('mergeSections keeps order, drops duplicates and takes the Context from the document when it has one', () => {
  const merged = mergeSections(
    { 'Context': ['old'], 'Active Decisions': ['a', 'b'], 'Preferences': ['p'] },
    { 'Context': [], 'Active Decisions': ['b', 'c', 'c'], 'Next Session': ['n'] }
  );
  assert.deepStrictEqual(merged, {
    'Context': ['old'],
    'Active Decisions': ['a', 'b', 'c'],
    'Do Not Repeat': [],
    'Preferences': ['p'],
    'Next Session': ['n'],
  });
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
