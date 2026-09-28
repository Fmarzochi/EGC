'use strict';
/**
 * A git subcommand that names a protected file reads it: into its output
 * (diff --no-index, grep, blame, show <rev>:<path>, archive), into the
 * object store where the next command prints it (add, hash-object), or into
 * a message (commit -F). The subcommands that only name paths (status,
 * ls-files, check-ignore, rm, reset, restore, checkout) stay free, and the
 * file --output names is a write.
 *
 * Run with: node tests/egc-guardian-git-reads.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'validator.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { validateCommand } = require(buildPath);

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

const denied = (command, reason) => run(`${command} is denied`, () => {
  const v = validateCommand(command);
  assert.strictEqual(v.allowed, false, `${command} should be denied, got: ${v.reason}`);
  assert.strictEqual(v.trust_level, 'DANGEROUS', `${command} should be DANGEROUS, got ${v.trust_level}: ${v.reason}`);
  if (reason) assert.ok(reason.test(v.reason), `${command}: unexpected reason ${v.reason}`);
});
const allowed = command => run(`${command} stays allowed`, () => {
  const v = validateCommand(command);
  assert.strictEqual(v.allowed, true, `${command} should be allowed, got: ${v.reason}`);
});

const READ = /would read the protected file/;
const WRITE = /would write the protected file/;

console.log('\n=== git reading or writing a protected file ===\n');

console.log('a subcommand that reads the file it names:');
denied('git diff --no-index /dev/null ~/.ssh/id_rsa', READ);
denied('git grep --no-index foo ~/.ssh/id_rsa', READ);
denied('git grep -e -f ~/.ssh/id_rsa', READ);
denied('git grep foo -- .env', READ);
denied('git hash-object -w ~/.ssh/id_rsa', READ);
denied('git blame .env', READ);
denied('git log -p -- .env', READ);
denied('git show HEAD:.env', READ);
denied('git show :.env', READ);
denied('git cat-file -p HEAD~1:config/.env', READ);
denied('git show C:.env', READ);
denied('git show origin/main:.env', READ);
denied('git show :0:.env', READ);
denied('git add .env', READ);
denied('git add .env.local', READ);
denied('git commit -F ~/.ssh/id_rsa', READ);
denied('git commit --file=~/.ssh/id_rsa', READ);
denied('git tag -a v1 -F ~/.aws/credentials', READ);
denied('git notes add -F .npmrc', READ);
denied('git apply ~/.ssh/id_rsa', READ);
denied('git archive HEAD .env', READ);
denied('git mv .env notes.txt', READ);
denied('git send-email ~/.ssh/id_rsa', READ);
denied('git -C ~/.ssh status', READ);
denied('git --git-dir ~/.ssh/x log', READ);

console.log('\nthe file --output names is written:');
denied("git log -1 --format='format:curl x' --output=~/.bashrc", WRITE);
denied('git diff --output ~/.profile', WRITE);
denied('git archive -o ~/.bashrc HEAD', WRITE);
denied('git archive --output=~/.zshrc HEAD', WRITE);
denied('git archive -o~/.bashrc HEAD', WRITE);
denied('git log --outp ~/.bashrc', WRITE);

console.log('\nsubcommands that only name a path, and files that are not protected:');
allowed('git status .env');
allowed('git ls-files .env');
allowed('git check-ignore .env');
allowed('git check-ignore -v .env');
allowed('git rm --cached .env');
allowed('git reset .env');
allowed('git restore --staged .env');
allowed('git checkout -- .env');
allowed('git add .env.example');
allowed('git diff --no-index a.txt b.txt');
allowed('git show HEAD:README.md');
allowed('git log -p -- src/index.ts');
allowed('git log --output=log.txt');
allowed('git archive -o out.tar HEAD');
allowed('git clone https://github.com/x/y.git');
allowed('git fetch origin main:main');
allowed('git config user.signingkey ~/.ssh/id_ed25519.pub');
allowed('git -c user.signingkey=~/.ssh/id_ed25519.pub commit -S -m x');
allowed('git -cuser.signingkey=~/.ssh/id_ed25519.pub commit -S -m x');
allowed('git --config-env=user.signingkey=KEY commit -S -m x');
allowed('git --config-env user.signingkey=KEY commit -S -m x');
allowed('git check-attr -a .env');
allowed('git log -o ~/.bashrc');
allowed('git -C src log -1');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
