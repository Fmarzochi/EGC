'use strict';
/**
 * A target spelled with a variable the command line sets is judged by every
 * value the line gives it, under every target rule: protected paths, files
 * denied to a read, shell scripts written through the shell.
 *
 * Run with: node tests/egc-guardian-line-variables.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'validator.js');

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

const { validateCommand } = require(buildPath);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-line-variables-'));

function shown(bound) {
  return JSON.stringify(bound ?? {}).slice(0, 160);
}

function assertDenied(command, bound, pattern) {
  const verdict = validateCommand(command, cwd, bound);
  assert.ok(!verdict.allowed && !verdict.advisory, `${command} with ${shown(bound)} must be refused, got ${JSON.stringify(verdict)}`);
  if (pattern) assert.match(verdict.reason, pattern);
}

function assertNotHardDenied(command, bound) {
  const verdict = validateCommand(command, cwd, bound);
  assert.ok(verdict.allowed || verdict.advisory, `${command} with ${shown(bound)} must not be refused, got ${JSON.stringify(verdict)}`);
}

console.log('\n=== Testing targets spelled with variables the line sets ===\n');

test('a redirection onto a variable bound to a protected file is refused', () => {
  assertDenied('echo x > "$D"', { D: ['~/.ssh/id_rsa'] }, /protected/);
  assertDenied('echo x >> ${D}', { D: ['~/.ssh/id_rsa'] }, /protected/);
});

test('a read through a variable bound to a credential is refused', () => {
  assertDenied('cat "$D"', { D: ['~/.ssh/id_rsa'] });
  assertDenied('cat < "$D"', { D: ['~/.ssh/id_rsa'] });
});

test('a variable that names a directory of a protected file is followed into the file', () => {
  assertDenied('cat "$D/id_rsa"', { D: ['~/.ssh'] });
  assertDenied('cat "${D}/id_rsa"', { D: ['~/.ssh'] });
});

test('a value that names another bound variable is resolved through it', () => {
  assertDenied('cat "$T"', { D: ['~/.ssh'], T: ['$D/id_rsa'] });
});

test('a variable under a parameter operator is read by its value', () => {
  assertDenied('cat ~/.ssh/${D:-foo}', { D: ['id_rsa'] });
  assertDenied('cat "${D:=x}"', { D: ['~/.ssh/id_rsa'] });
  assertDenied('cat "${D%.bak}"', { D: ['~/.ssh/id_rsa.bak'] });
});

test('an operator that yields its word when the variable is set or unset is read that way', () => {
  assertDenied('cat "${D:+~/.ssh/id_rsa}"', { D: ['notes.txt'] });
  assertDenied('cat "${UNSET:-$E}"', { E: ['~/.ssh/id_rsa'] });
  assertDenied('cat "${UNSET-~/.ssh/id_rsa}"', { E: ['x'] });
  assertDenied('cat "${A:-${B}}"', { B: ['~/.ssh/id_rsa'] });
  assertNotHardDenied('cat "${UNSET:+~/.ssh/id_rsa}"', { E: ['x'] });
});

test('many values and many references stay bounded in time and memory', () => {
  const values = Array.from({ length: 2000 }, (_, i) => `file${i}.txt`);
  const started = Date.now();
  assertNotHardDenied('cat "$B$B$B$B"', { B: values });
  assertDenied('cat "$B$B$C"', { B: values, C: ['', '.env'] });
  assert.ok(Date.now() - started < 2000, 'the resolution must stay fast');
});

test('every variable of a word is resolved, however many the word carries', () => {
  assertDenied('cat $A$B$C$D$E', { A: ['c'], B: ['er'], C: ['t.'], D: ['pe'], E: ['m'] });
});

test('a value that names itself stops resolving instead of growing', () => {
  assertNotHardDenied('cat "$D"', { D: ['$D/x'] });
});

test('every value a variable takes on the line is judged', () => {
  assertDenied('cat "$D"', { D: ['notes.txt', '~/.ssh/id_rsa'] });
});

test('a copy or an in-place edit onto a variable bound to a protected file is refused', () => {
  assertDenied('cp payload "$D"', { D: ['.env'] });
  assertDenied('tee "$D"', { D: ['.env'] });
  assertDenied('sed -i s/a/b/ "$D"', { D: ['~/.aws/credentials'] });
});

test('a shell script written through a variable is refused the way a named one is', () => {
  assertDenied('echo x > "$S"', { S: ['deploy.sh'] }, /Write or Edit/);
});

test('a bound variable that names an ordinary file is left alone', () => {
  assertNotHardDenied('echo x > "$D"', { D: ['notes.txt'] });
  assertNotHardDenied('cat "$D"', { D: ['notes.txt'] });
});

test('a variable the line does not set is judged as before', () => {
  assertNotHardDenied('echo x > "$UNSET"', {});
  assertNotHardDenied('echo x > "$UNSET"');
  assertNotHardDenied('cat "$D"', { OTHER: ['~/.ssh/id_rsa'] });
});

test('a value spelled from the home directory is read as the path it names', () => {
  assertDenied('cat "$D"', { D: ['$HOME/.ssh/id_rsa'] });
  assertDenied('cat "$D"', { D: ['${HOME}/.ssh/id_rsa'] });
});

test('a value this check cannot read stays unresolved', () => {
  assertNotHardDenied('cat "$D"', { D: ['$(mktemp)'] });
  assertNotHardDenied('cat "$D"', { D: ['$OTHER/.ssh/id_rsa'] });
});

test('the bound names do not leak into the next command', () => {
  validateCommand('cat "$D"', cwd, { D: ['~/.ssh/id_rsa'] });
  assertNotHardDenied('cat "$D"');
});

fs.rmSync(cwd, { recursive: true, force: true });
console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
