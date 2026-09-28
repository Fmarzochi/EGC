'use strict';
/**
 * git loads the config and runs the hooks of the git directory it uses.
 * Only a directory named `.git` or `<name>.git` has those files protected
 * from a write, so git is refused a directory outside that convention,
 * whether it is named by --git-dir, found as a bare repository where git
 * runs or above it, or named by the `gitdir:` line of a `.git` file.
 *
 * Run with: node tests/egc-guardian-git-directory.test.js
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
const { validateCommand, isProtectedPath, isReadDeniedPath } = require(buildPath);

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

const denied = (command, cwd) => {
  const verdict = validateCommand(command, cwd);
  assert.strictEqual(verdict.allowed, false, `${command} in ${cwd}: ${JSON.stringify(verdict)}`);
  assert.notStrictEqual(verdict.advisory, true, `${command} is only flagged: ${verdict.reason}`);
  return verdict;
};
const passes = (command, cwd) => {
  const verdict = validateCommand(command, cwd);
  assert.ok(verdict.allowed || verdict.advisory === true, `${command} in ${cwd}: ${JSON.stringify(verdict)}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-git-directory-'));
const at = (...parts) => path.join(root, ...parts);

// A git directory as git recognizes one: HEAD, objects and refs.
function gitDirectory(dir) {
  fs.mkdirSync(path.join(dir, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dir, 'config'), '[core]\n\tbare = true\n');
}

gitDirectory(at('evil'));
fs.mkdirSync(at('evil', 'sub'));
gitDirectory(at('repo.git'));
gitDirectory(at('work', '.git'));
fs.mkdirSync(at('work', 'src'));
gitDirectory(at('work', '.git', 'worktrees', 'wt'));
fs.mkdirSync(at('linked'));
fs.writeFileSync(at('linked', '.git'), `gitdir: ${at('evil')}\n`);
fs.mkdirSync(at('worktree'));
fs.writeFileSync(at('worktree', '.git'), `gitdir: ${at('work', '.git', 'worktrees', 'wt')}\n`);
fs.mkdirSync(at('relative'));
fs.writeFileSync(at('relative', '.git'), 'gitdir: ../evil\n');
gitDirectory(at('hollow'));
fs.mkdirSync(at('hollow', '.git'));
fs.mkdirSync(at('plain'));
// git takes a level's .git before the level itself as a bare repository.
gitDirectory(at('both'));
gitDirectory(at('both', '.git'));
// Short of HEAD as a file, objects or refs, git sees no repository.
gitDirectory(at('noobjects'));
fs.rmSync(at('noobjects', 'objects'), { recursive: true });
gitDirectory(at('norefs'));
fs.rmSync(at('norefs', 'refs'), { recursive: true });
gitDirectory(at('headdir'));
fs.rmSync(at('headdir', 'HEAD'));
fs.mkdirSync(at('headdir', 'HEAD'));
// A relative gitdir: is read from the .git file's own directory.
fs.mkdirSync(at('host.git', 'modules', 'w'), { recursive: true });
fs.writeFileSync(at('host.git', 'modules', 'w', '.git'), 'gitdir: ../s\n');
// A .git file that does not start with `gitdir: ` git refuses, running nothing.
fs.mkdirSync(at('broken'));
fs.writeFileSync(at('broken', '.git'), 'not a gitfile\n');

let passed = 0;
let failed = 0;
const record = ok => (ok ? passed++ : failed++);

console.log('\n=== the git directory git uses ===\n');

record(test('the config, hooks and links of any .git or <name>.git directory are protected from a write and free to read', () => {
  for (const file of [
    '/tmp/evil.git/config', '/tmp/evil.git/hooks/post-checkout', '/tmp/evil.git/hooks', '/p/.git/config', '/p/.git/hooks/pre-commit',
    '/p/.git/config.worktree', '/p/.git/commondir', '/p/.git/modules/sub/config', '/p/.git/modules/a/b/hooks/post-checkout',
    '/p/.git/worktrees/wt/config.worktree', '/p/.git/worktrees/wt/commondir', '/srv/repo.git/modules/s/config',
    // The directory itself and the ones it keeps for work trees and
    // submodules, where a directory copied or linked in brings its config.
    '/p/.git', '/tmp/evil.git', '/p/.git/worktrees/wt', '/p/.git/modules/sub', '/p/.git/worktrees',
  ]) {
    assert.strictEqual(isProtectedPath(file), true, `${file} is not protected`);
    assert.strictEqual(isReadDeniedPath(file), false, `${file} cannot be read`);
  }
  for (const file of [
    '/p/src/config', '/p/.git/refs/heads/config', '/p/.gitignore', '/p/.git/info/exclude', '/p/.github/config', '/p/config',
    '/p/.git/objects/ab/config', '/p/.git/HEAD',
  ]) {
    assert.strictEqual(isProtectedPath(file), false, `${file} is protected`);
  }
}));

record(test('--git-dir is refused a directory outside the .git convention', () => {
  for (const command of [
    'git --git-dir=/tmp/evil status', 'git --git-dir /tmp/evil fetch', 'git --git-dir=/tmp/evil/ log', 'git --git-dir=$HOME/.cfg status',
    'git --git-dir=.git --git-dir=/tmp/evil status',
  ]) {
    assert.match(denied(command, at('plain')).reason, /git directory/, command);
  }
  for (const command of [
    'git --git-dir=/tmp/evil/.git status', 'git --git-dir=/srv/repo.git log', 'git --git-dir .git status', 'git --git-dir=.git/ status',
    'git --git-dir=/tmp/evil --git-dir=.git status',
  ]) {
    passes(command, at('plain'));
  }
}));

record(test('GIT_DIR and GIT_COMMON_DIR are held to the same rule as --git-dir', () => {
  for (const command of ['GIT_DIR=/tmp/evil git status', 'GIT_COMMON_DIR=$HOME/.cfg git fetch', "GIT_DIR='/tmp/evil' git log"]) {
    assert.match(denied(command, at('plain')).reason, /\.git or <name>\.git directory/, command);
  }
  for (const command of [
    'GIT_DIR=.git git status', 'GIT_DIR=/srv/repo.git git log', 'GIT_DIR=.git/worktrees/wt git status', "GIT_COMMON_DIR='/srv/app/.git' git log",
  ]) {
    passes(command, at('plain'));
  }
}));

record(test('a bare repository outside the convention is refused where git runs, above it, and through -C', () => {
  for (const [command, cwd] of [
    ['git status', at('evil')], ['git fetch', at('evil', 'sub')], [`git -C ${at('evil')} log`, at('plain')],
    ['git status', at('hollow')], [`git -C ${at('evil', 'sub')} -C .. status`, at('plain')],
  ]) {
    assert.match(denied(command, cwd).reason, /git directory/, `${command} in ${cwd}`);
  }
  for (const [command, cwd] of [
    ['git status', at('repo.git')], ['git status', at('work')], ['git log', at('work', 'src')], ['git status', at('plain')],
    [`git --git-dir=${at('repo.git')} status`, at('evil')], ['git status', at('both')], ['git status', at('noobjects')],
    ['git status', at('norefs')], ['git status', at('headdir')],
  ]) {
    passes(command, cwd);
  }
}));

record(test('a directory is not copied, synced or linked into a git directory, and a link is trusted for where it leads', () => {
  for (const command of [
    `cp -r ${at('evil')} ${at('c.git')}`, `cp ${at('evil', 'config')} ${at('repo.git')}/`, `cp -r ${at('evil')} ${at('work', '.git', 'worktrees', 'x')}`,
    `rsync -a ${at('evil')}/ ${at('s.git')}/`, `ln -s ${at('evil')} ${at('l.git')}`,
  ]) {
    denied(command, at('plain'));
  }
  // A link named like a git directory leads git to the directory it points
  // at; on Windows a junction stands in for the link.
  fs.symlinkSync(at('evil'), at('link.git'), process.platform === 'win32' ? 'junction' : 'dir');
  // A name outside the convention is refused even when it leads to one.
  fs.symlinkSync(at('repo.git'), at('alias'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const [command, cwd] of [
    [`git --git-dir=${at('link.git')} status`, at('plain')], ['git status', at('link.git')], [`git --git-dir=${at('alias')} status`, at('plain')],
    // A relative GIT_DIR is followed from where the command runs.
    ['GIT_DIR=link.git git status', root], ['export GIT_DIR=link.git', root],
  ]) {
    assert.match(denied(command, cwd).reason, /git directory/, `${command} in ${cwd}`);
  }
  passes('GIT_DIR=repo.git git status', root);
  // A git directory named outright may be a file git reads as a .git file,
  // following its gitdir: line: the directory it leads to is judged.
  fs.writeFileSync(at('pointer.git'), `gitdir: ${at('evil')}\n`);
  fs.writeFileSync(at('good.git'), `gitdir: ${at('repo.git')}\n`);
  for (const [command, cwd] of [[`git --git-dir=${at('pointer.git')} status`, at('plain')], ['GIT_DIR=pointer.git git status', root]]) {
    assert.match(denied(command, cwd).reason, /git directory/, `${command} in ${cwd}`);
  }
  passes(`git --git-dir=${at('good.git')} status`, at('plain'));
  passes('GIT_DIR=good.git git status', root);
  // Overwriting a regular file that already exists under a name ending in
  // .git makes no git directory, so it is free; a new path so named stays
  // protected, since it may become one, and a .git file only points.
  fs.writeFileSync(at('notes.git'), 'x\n');
  assert.strictEqual(isProtectedPath(at('notes.git')), false, 'an existing regular file named x.git');
  assert.strictEqual(isProtectedPath(at('linked', '.git')), false, 'a .git file');
  assert.strictEqual(isProtectedPath(at('new.git')), true, 'a new path named x.git');
  assert.strictEqual(isProtectedPath(at('repo.git')), true, 'a git directory named x.git');
}));

record(test('a .git file is followed to the git directory it names', () => {
  for (const cwd of [at('linked'), at('relative')]) {
    assert.match(denied('git status', cwd).reason, /git directory/, cwd);
  }
  passes('git status', at('worktree'));
  passes('git status', at('host.git', 'modules', 'w'));
  passes('git status', at('broken'));
}));

const cli = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'guardian-cli.js');

record(test('the command-batch CLI judges an entry in every directory it can run in, and a malformed list where the batch runs', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [cli, 'command-batch'], {
    input: JSON.stringify({
      commands: ['git status', 'git status', 'git status', 'git status', 'git status'],
      cwd: at('plain'),
      cwds: [[at('plain'), at('evil')], [at('plain')], [at('evil'), 3], null, []],
    }),
    encoding: 'utf8',
    timeout: 20000,
  });
  const [bothWays, plainOnly, malformed, missing, empty] = JSON.parse(result.stdout);
  assert.strictEqual(bothWays.allowed, false, JSON.stringify(bothWays));
  assert.strictEqual(plainOnly.allowed, true, JSON.stringify(plainOnly));
  assert.strictEqual(malformed.allowed, true, JSON.stringify(malformed));
  assert.strictEqual(missing.allowed, true, JSON.stringify(missing));
  assert.strictEqual(empty?.allowed, true, JSON.stringify(empty));
  // A command read out of a committed script is judged in each directory
  // too: `> config` there writes .git/config once a cd has moved into .git.
  const committed = spawnSync(process.execPath, [cli, 'command-batch'], {
    input: JSON.stringify({
      commands: ['echo x > config', 'echo x > config'],
      cwd: at('work'),
      cwds: [[at('work'), at('work', '.git')], [at('work')]],
      committed: [true, true],
    }),
    encoding: 'utf8',
    timeout: 20000,
  });
  const [intoGitDir, atTop] = JSON.parse(committed.stdout);
  const refused = verdict => !verdict.allowed && verdict.advisory !== true;
  assert.ok(refused(intoGitDir), JSON.stringify(intoGitDir));
  assert.ok(!refused(atTop), JSON.stringify(atTop));
}));

record(test('the Bash hook judges git in the directory a cd before it leaves the line in', () => {
  process.env.EGC_GUARDIAN_CLI = cli;
  const { run } = require(path.join(__dirname, '..', 'scripts', 'hooks', 'pre-bash-guardian-validate'));
  const blocked = command => run({ tool_name: 'Bash', tool_input: { command }, cwd: root }).exitCode === 2;
  fs.writeFileSync(at('plain', 's.sh'), 'git status\n');
  fs.writeFileSync(at('plain', 'lost.sh'), 'cd "$EGC_UNSET_DIR"\ngit status\n');
  const script = at('plain', 's.sh').replaceAll('\\', '/');
  const lost = at('plain', 'lost.sh').replaceAll('\\', '/');
  for (const command of [
    'cd evil && git status', 'cd evil/sub && git fetch', '(cd evil; git status)', 'D=evil; cd $D && git status', 'pushd evil && git status',
    // A script run after the cd runs its commands there too, however it is
    // reached: the same file from both directories, or only from the new one.
    `cd evil && bash ${script}`, `cd evil && . ${script}`, 'cd evil && sh ../plain/s.sh',
    // Past a move of its own only the running shell knows, a script's
    // command is judged where the script may start.
    `cd evil && bash ${lost}`,
  ]) {
    assert.ok(blocked(command), command);
  }
  assert.ok(!blocked(`bash ${script}`), 'a script run where the line starts');
  // A move only the running shell knows leaves the line where it starts.
  for (const command of ['cd work && git status', 'cd plain && git status', 'cd $EGC_UNSET_DIR && git status']) {
    assert.ok(!blocked(command), command);
  }
}));

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
