'use strict';
/**
 * `egc context` prints the three-block briefing on stdout and, with --explain,
 * the explain table on stderr. Bad arguments exit 1; a missing build exits 2.
 *
 * Run with: node tests/egc-context-command.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'context.js');
const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'file-rank.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-context-cmd-'));
const root = path.join(tmp, 'proj');
fs.mkdirSync(path.join(root, 'billing'), { recursive: true });
fs.writeFileSync(path.join(root, 'billing', 'payments.ts'), 'export function chargeCard() { return 1; }\n');

let passed = 0;
let failed = 0;
function run(name, fn) {
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

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

run('prints the three-block briefing on stdout', () => {
  const r = spawnSync(process.execPath, [script, 'chargeCard', '--project', root, '--no-git'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[PROJECT HISTORY]'));
  assert.ok(r.stdout.includes('billing/payments.ts'));
  assert.ok(r.stdout.trimEnd().endsWith('chargeCard'));
  assert.strictEqual(r.stderr.trim(), '', 'no explain output without --explain');
});

run('egc context refuses a filesystem root and the home directory', () => {
  for (const [dir, reason] of [[path.parse(root).root, /filesystem root/], [os.homedir(), /home directory/]]) {
    const r = spawnSync(process.execPath, [script, 'chargeCard', '--project', dir, '--no-git'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1, r.stdout);
    assert.ok(r.stderr.startsWith('egc context:'), r.stderr);
    assert.match(r.stderr, reason);
    assert.strictEqual(r.stdout, '', 'nothing from the refused directory is printed');
  }
});

run('a flag without its value is named, with the usage line, and is not a TypeError', () => {
  for (const flag of ['--project', '--top', '--history']) {
    const r = spawnSync(process.execPath, [script, 'chargeCard', flag], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1);
    assert.ok(r.stderr.includes(`${flag} needs a value`), r.stderr);
    assert.ok(r.stderr.includes('usage: egc context'), r.stderr);
    assert.ok(!r.stderr.includes('TypeError'), r.stderr);
  }
  const next = spawnSync(process.execPath, [script, 'chargeCard', '--project', '--explain'], { encoding: 'utf8' });
  assert.ok(next.stderr.includes('--project needs a value'), 'a following flag is not taken for the value');
});

run('a project that does not exist fails with a one-line message, not a stack trace', () => {
  const r = spawnSync(process.execPath, [script, 'chargeCard', '--project', path.join(tmp, 'missing'), '--no-git'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.startsWith('egc context:'), r.stderr);
  assert.ok(!r.stderr.includes('    at '), 'no stack trace');
});

run('--explain writes the table to stderr and leaves stdout as the briefing', () => {
  const r = spawnSync(process.execPath, [script, 'chargeCard', '--project', root, '--no-git', '--explain'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stderr.startsWith('explain:'));
  assert.ok(!r.stdout.includes('explain:'));
});

run('--history reads the history from a file', () => {
  const h = path.join(tmp, 'history.txt');
  fs.writeFileSync(h, 'decided: refunds stay in a separate module');
  const r = spawnSync(process.execPath, [script, 'refunds', '--project', root, '--no-git', '--history', h], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('refunds stay in a separate module'));
});

run('--history - reads the history from stdin', () => {
  const r = spawnSync(process.execPath, [script, 'refunds', '--project', root, '--no-git', '--history', '-'], { input: 'piped history', encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('piped history'));
});

run('no query is a usage error with exit 1', () => {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('usage'));
});

run('an unknown flag is a usage error with exit 1', () => {
  const r = spawnSync(process.execPath, [script, 'x', '--bogus'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
});

run('--help prints the usage line and exits 0', () => {
  const r = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('usage: egc context'));
});

run('egc help context routes to the script through the command table', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'egc.js'), 'help', 'context'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('usage: egc context'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
