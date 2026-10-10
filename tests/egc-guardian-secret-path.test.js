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
// The cheap checker judges the path as written and isProtectedPath resolves links, so a home
// folder that is itself a link would make them differ for a reason that is not a defect.
const isLink = p => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const homeLinked = isLink(os.homedir()) || isLink(path.join(os.homedir(), '.ssh')) || isLink(path.join(os.homedir(), '.aws'));
const SECRETS = [
  path.join(proj, '.env'),
  path.join(proj, 'config', '.env.production'),
  path.join(proj, 'keys', 'server.pem'),
  path.join(proj, '.npmrc'),
  ...(homeLinked ? [] : [path.join(os.homedir(), '.ssh', 'config'), path.join(os.homedir(), '.aws', 'credentials')])
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
  if (!homeLinked) assert.strictEqual(check('~/.ssh/id_rsa'), true);
  assert.strictEqual(check(`${path.join(proj, '.env')}\n`), true);
});

run('a checker made once makes no file-system lookups for the paths it judges', () => {
  const check = secretPathChecker();
  // Counted, not timed: isProtectedPath makes about 180 synchronous lookups a path, which is what made it too slow for a project walk.
  let lookups = 0;
  const originals = ['lstatSync', 'realpathSync', 'statSync'].map(name => [name, fs[name]]);
  for (const [name, real] of originals) {
    const counting = function (...args) {
      lookups++;
      return real.apply(this, args);
    };
    counting.native = real.native;
    fs[name] = counting;
  }
  try {
    for (let i = 0; i < 3000; i++) check(path.join(proj, 'pkg', `module-${i}.ts`));
  } finally {
    for (const [name, real] of originals) fs[name] = real;
  }
  assert.strictEqual(lookups, 0, `3000 checks made ${lookups} synchronous lookups`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
