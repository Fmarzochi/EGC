'use strict';
/**
 * The git commands that discard work the person has not committed, or work
 * that only a reflog remembers, are refused with a reason that says what
 * they would throw away: reset --hard and --merge, branch -D, tag -d,
 * restore of the worktree, checkout of a path and stash drop or clear. The
 * forms that keep the work stay allowed (#2134).
 *
 * Run with: node tests/egc-guardian-git-destructive.test.js
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

const denied = (command, reasonPart) => {
  const verdict = validateCommand(command);
  assert.strictEqual(verdict.allowed, false, `${command}: ${JSON.stringify(verdict)}`);
  assert.notStrictEqual(verdict.advisory, true, `${command} is only flagged: ${verdict.reason}`);
  assert.ok(verdict.reason.includes(reasonPart), `${command}: reason "${verdict.reason}" lacks "${reasonPart}"`);
  return verdict;
};
const passes = command => {
  const verdict = validateCommand(command);
  assert.ok(verdict.allowed || verdict.advisory === true, `${command}: ${JSON.stringify(verdict)}`);
};

console.log('\n=== Guardian: git commands that discard work ===\n');

test('git reset --hard and --merge are refused, the index-only resets stay allowed', () => {
  denied('git reset --hard', 'git reset --hard');
  denied('git reset --hard HEAD~1', 'git reset --hard');
  denied('git reset --merge', 'git reset --merge');
  denied('git reset --har HEAD~1', 'git reset --hard');
  denied('git reset --mer', 'git reset --merge');
  passes('git reset');
  passes('git reset --soft HEAD~1');
  passes('git reset HEAD src/app.js');
  passes('git reset --keep HEAD~1');
});

test('git branch -D is refused, the safe delete and the rest of branch stay allowed', () => {
  denied('git branch -D feature/x', 'git branch -D');
  denied('git branch --delete --force feature/x', 'git branch -D');
  denied('git branch -d -f feature/x', 'git branch -D');
  denied('git branch --del --force feature/x', 'git branch -D');
  passes('git branch -d feature/x');
  passes('git branch feature/x');
  passes('git branch --list');
  passes('git branch -m old new');
});

test('git tag -d is refused, creating and listing tags stay allowed', () => {
  denied('git tag -d v1.0.0', 'git tag -d');
  denied('git tag --delete v1.0.0', 'git tag -d');
  denied('git tag --del v1.0.0', 'git tag -d');
  passes('git tag v1.0.0');
  passes('git tag -a v1.0.0 -m release');
  passes('git tag -l');
});

test('git restore of the worktree is refused, unstaging with --staged stays allowed', () => {
  denied('git restore src/app.js', 'git restore');
  denied('git restore .', 'git restore');
  denied('git restore --source=HEAD~1 src/app.js', 'git restore');
  denied('git restore --worktree src/app.js', 'git restore');
  denied('git restore -SW src/app.js', 'git restore');
  denied('git restore --work src/app.js', 'git restore');
  denied('git restore -- --staged', 'git restore');
  passes('git restore --staged src/app.js');
  passes('git restore --stag src/app.js');
  passes('git restore --staged -- --worktree');
  passes('git restore -S src/app.js');
});

test('git checkout of a path is refused, checkout of a branch stays allowed', () => {
  denied('git checkout -- src/app.js', 'git checkout');
  denied('git checkout HEAD -- src/app.js', 'git checkout');
  denied('git checkout -- .', 'git checkout');
  denied('git checkout HEAD src/app.js', 'git checkout');
  denied('git checkout main src/a.js src/b.js', 'git checkout');
  passes('git checkout main');
  passes('git checkout -B feature/x origin/main');
  passes('git checkout --orphan gh-pages');
  passes('git checkout -b feature/x');
  passes('git checkout -b feature/x origin/main');
  passes('git checkout --detach HEAD~1');
});

test('git stash drop and clear are refused, the stash forms that keep the work stay allowed', () => {
  denied('git stash drop', 'git stash drop');
  denied('git stash drop stash@{1}', 'git stash drop');
  denied('git stash clear', 'git stash clear');
  passes('git stash');
  passes('git stash push -m wip');
  passes('git stash push -m drop');
  passes('git stash -m clear');
  passes('git stash push --message clear');
  passes('git stash push -u -m draft -- tests/lib/x.js');
  passes('git stash pop');
  passes('git stash apply stash@{0}');
  passes('git stash list');
  passes('git stash show -p');
});

test('the refusal names what the command would throw away and the way out', () => {
  const verdict = denied('git reset --hard', 'commit');
  assert.ok(/stash|commit/i.test(verdict.reason), verdict.reason);
  assert.strictEqual(verdict.trust_level, 'DANGEROUS');
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
