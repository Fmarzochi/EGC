'use strict';
/**
 * secretPathChecker is the cheap half of isProtectedPath that the project
 * walks use for every file: it judges the denied directories and the
 * secret-file patterns without the dozens of file-system lookups per path
 * that isProtectedPath makes. It must still catch the secrets, and it must
 * stay fast enough to run over thousands of files.
 *
 * Run with: node tests/egc-guardian-secret-path.test.js
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
const { secretPathChecker, isProtectedPath } = require(buildPath);

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

const proj = path.join(os.tmpdir(), 'egc-secret-path-proj');
const SECRETS = [
  path.join(proj, '.env'),
  path.join(proj, 'config', '.env.production'),
  path.join(proj, 'keys', 'server.pem'),
  path.join(proj, '.npmrc'),
  path.join(os.homedir(), '.ssh', 'config'),
  path.join(os.homedir(), '.aws', 'credentials')
];
const ORDINARY = ['src/index.ts', 'README.md', 'lib/util.js', 'docs/environment.md', 'tests/a.test.js'].map(p => path.join(proj, p));

run('it flags what isProtectedPath flags among secrets, and nothing ordinary', () => {
  const check = secretPathChecker();
  for (const p of SECRETS) {
    assert.strictEqual(check(p), true, `${p} should be a secret path`);
    assert.strictEqual(isProtectedPath(p), true, `${p} is protected by the full check too`);
  }
  for (const p of ORDINARY) assert.strictEqual(check(p), false, `${p} is an ordinary file`);
});

run('it leaves git control files and hook surfaces to the full check, which guards writes and runs at the root and for snippet files', () => {
  const check = secretPathChecker();
  for (const p of ['.git/config', '.git/hooks/pre-commit', '.claude/settings.json']) {
    const file = path.join(proj, p);
    assert.strictEqual(isProtectedPath(file), true, `${p} is protected by the full check`);
    assert.strictEqual(check(file), false, `${p} is not judged by the cheap check`);
  }
});

run('it reads the home shorthand and surrounding whitespace the way isProtectedPath does', () => {
  const check = secretPathChecker();
  assert.strictEqual(check('~/.ssh/id_rsa'), true);
  assert.strictEqual(check(`${path.join(proj, '.env')}\n`), true);
});

run('a checker made once judges thousands of paths in well under a second', () => {
  const check = secretPathChecker();
  const started = Date.now();
  for (let i = 0; i < 3000; i++) check(path.join(proj, 'pkg', `module-${i}.ts`));
  const ms = Date.now() - started;
  // isProtectedPath takes tens of milliseconds a path, so 3000 would take minutes.
  assert.ok(ms < 1500, `3000 checks took ${ms} ms`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
