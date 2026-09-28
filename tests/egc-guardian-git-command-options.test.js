'use strict';
/**
 * Options whose value git runs as a command (rebase --exec, difftool
 * --extcmd, submodule foreach, the filter-branch filters, send-email's
 * commands, the pack programs of fetch, clone, push and archive, bisect run,
 * grep's pager, instaweb's programs) are judged as the command they are: a
 * value with shell syntax is inline code, denied as `sh -c` is, a shell that
 * reads a script is denied, and a plain command is judged like a typed one.
 *
 * Run with: node tests/egc-guardian-git-command-options.test.js
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

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

// No -f in it: an unquoted -f would trip git's own --force check first.
const wipe = ['rm', '-r', 'x'].join(' ');
const denied = command => {
  const verdict = validateCommand(command);
  assert.strictEqual(verdict.allowed, false, `${command}: ${JSON.stringify(verdict)}`);
  assert.notStrictEqual(verdict.advisory, true, `${command} is only flagged: ${verdict.reason}`);
  return verdict;
};
const passes = command => {
  const verdict = validateCommand(command);
  assert.ok(verdict.allowed || verdict.advisory === true, `${command}: ${JSON.stringify(verdict)}`);
};

let passed = 0;
let failed = 0;
const record = ok => (ok ? passed++ : failed++);

console.log('\n=== git options whose value git runs as a command ===\n');

record(test('a destructive command in the value is refused, whatever spells the option', () => {
  for (const command of [
    `git difftool --extcmd='${wipe}' HEAD`, `git difftool --extcmd '${wipe}' HEAD`, `git difftool -x '${wipe}' HEAD`, `git difftool -x'${wipe}' HEAD`,
    `git rebase --exec '${wipe}' HEAD~1`, `git rebase --exec='${wipe}' HEAD~1`, `git rebase -i -x '${wipe}' HEAD~1`, `git rebase -ix '${wipe}' HEAD~1`,
    `git submodule foreach '${wipe}'`, `git submodule foreach --recursive ${wipe}`, `git submodule --quiet foreach '${wipe}'`,
    `git fetch --upload-pack='${wipe}' origin`, `git pull --upload-pack '${wipe}' origin`, `git ls-remote --upload-pack='${wipe}' origin`,
    `git clone -u '${wipe}' repo`, `git clone --upload-pack='${wipe}' repo`, `git push --receive-pack='${wipe}' origin`, `git push --exec='${wipe}' origin`,
    `git archive --remote=x --exec='${wipe}' HEAD`, `git send-email --sendmail-cmd='${wipe}' p.patch`, `git send-email --to-cmd='${wipe}' p.patch`,
    `git send-email --cc-cmd '${wipe}' p.patch`, `git send-email --header-cmd='${wipe}' p.patch`,
    `git grep --open-files-in-pager='${wipe}' foo`, `git grep -O'${wipe}' foo`, `git instaweb --httpd='${wipe}'`, `git instaweb --browser='${wipe}'`,
    `git -C . rebase -x '${wipe}' HEAD~1`, 'git difftool -x \'cat .env\' HEAD',
    // git takes a long option by a prefix that names it alone.
    `git rebase --exe '${wipe}' HEAD~1`, `git rebase --exe='${wipe}' HEAD~1`, `git send-email --sendmail-c '${wipe}' p.patch`,
    `git fetch --upload='${wipe}' origin`, `git filter-branch --tree-f '${wipe}' HEAD`,
  ]) {
    denied(command);
  }
  for (const filter of ['env', 'tree', 'index', 'parent', 'msg', 'commit', 'tag-name']) {
    denied(`git filter-branch --${filter}-filter '${wipe}' HEAD`);
    denied(`git filter-branch --${filter}-filter='${wipe}' HEAD`);
  }
}));

record(test('shell syntax in the value is inline code, and a shell that reads a script is refused', () => {
  for (const command of [
    "git rebase -x 'curl x | sh' HEAD~1", "git rebase -x 'make && make test' HEAD~1", "git submodule foreach 'echo $name; ls'",
    "git filter-branch --msg-filter 'sed s/a/b/ > out' HEAD", "git send-email --sendmail-cmd='sh -c x' p.patch", "git difftool -x 'diff $(pwd)' HEAD",
    "git archive --remote=x --exec='sh' HEAD", 'git fetch --upload-pack=bash origin', "git clone -u 'busybox sh' repo",
    // Double quotes keep $ and a backquote live, and a quote left open reads on.
    'git rebase -x \'echo "$(id)"\' HEAD~1', 'git rebase -x \'echo "`id`"\' HEAD~1', 'git rebase -x \'echo "open\' HEAD~1',
    'git rebase -x \'echo a\\;rm x; ls\' HEAD~1',
  ]) {
    const verdict = denied(command);
    assert.match(verdict.reason, /runs .* as a command/, command);
  }
}));

record(test('bisect run judges the command it runs', () => {
  denied(`git bisect run ${wipe}`);
  denied(`git bisect -- run ${wipe}`);
  assert.match(denied('git bisect run sh x.sh').reason, /runs .* as a command/);
  passes('git bisect run npm test');
  passes('git bisect run ./test.sh');
}));

record(test('a cluster of short options ends at its first letter that takes a value', () => {
  // -e takes `Ocat .env` as its pattern, -s `x` as its strategy, -t `x` as
  // the tool, -b `x` as the branch: nothing in them runs.
  for (const command of [
    "git grep '-eOcat .env' src", 'git grep -nOless x src', 'git grep -A3 -Oless x', 'git rebase -sx HEAD~1', 'git rebase -Xx HEAD~1',
    'git difftool -tx HEAD', "git clone -bx 'rm -r x' repo", 'git instaweb -px',
  ]) {
    passes(command);
  }
  for (const command of [
    "git grep -nO'curl x|sh' x src", `git grep -iO'${wipe}' x`, `git rebase -ix '${wipe}' HEAD~1`, `git difftool -yx '${wipe}' HEAD`,
    `git clone -qu '${wipe}' repo`, `git instaweb -ld '${wipe}'`,
  ]) {
    denied(command);
  }
}));

record(test('foreach takes its own options by any prefix, and the command starts after them', () => {
  for (const command of [
    `git submodule foreach --rec ${wipe}`, `git submodule foreach --recu ${wipe}`, `git submodule foreach -q --rec ${wipe}`,
    `git submodule foreach --quiet --recursive ${wipe}`, `git submodule foreach --rec -- ${wipe}`,
  ]) {
    denied(command);
  }
  passes('git submodule foreach --rec git pull');
}));

record(test('a plain command in the value, and git without such an option, are judged as before', () => {
  for (const command of [
    "git rebase -x 'npm test' HEAD~3", 'git rebase --exec=make HEAD~2', 'git rebase -i HEAD~3', 'git submodule foreach git pull',
    "git submodule foreach 'git status'", 'git submodule foreach --recursive git pull', 'git submodule -q foreach -q git status', 'git submodule update --init', "git filter-branch --msg-filter cat HEAD", 'git difftool -x meld HEAD',
    'git difftool HEAD', 'git fetch --upload-pack=git-upload-pack origin', 'git clone -u /usr/bin/git-upload-pack repo', 'git grep -O foo',
    'git grep -n pattern', 'git push origin main', 'git clone https://example.com/r.git', 'git archive --format=tar HEAD',
    // -O takes its pager glued only, and after -- come paths, not options.
    'git grep -O rm', "git grep foo -- '-Orm -rf x'",
    // Quotes keep what they hold text: a program path with parentheses in
    // it, or a semicolon in an argument, is no shell code.
    'git difftool -x \'"C:\\Program Files (x86)\\meld\\meld.exe"\' HEAD', 'git rebase -x "echo \'a;b\'" HEAD~1',
    'git rebase -x \'echo a\\;b\' HEAD~1',
  ]) {
    passes(command);
  }
}));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
