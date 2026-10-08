/**
 * A script run with literal words gets them as its positional parameters
 * when the hook reads its body: a command word taken from "$@", $1 or $*
 * is judged as the words the script was given. Words the hook cannot read,
 * and a script that moves or resets its parameters (shift, set) or runs them
 * inside a function, still fail closed.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.EGC_GUARDIAN_CLI = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');
const { run } = require('../../scripts/hooks/pre-bash-guardian-validate');
const { removeDirWithRetries } = require('../fixtures/remove-dir');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

const rm = 'rm';
const grave = [rm, '-rf', '~'].join(' ');
const SCRIPTS = {
  'wrap.sh': 'exec "$@"\n',
  'scope.sh': 'exec systemd-run --user --scope "$@"\n',
  'arg1.sh': 'echo "$1"\n',
  'first.sh': '"$1" "${2}" /tmp/egc-victim\n',
  'star.sh': '$*\n',
  'quoted-star.sh': '"$*"\n',
  'count.sh': '[ $# -gt 0 ] && "$@"\n',
  'shift.sh': 'shift\n"$@"\n',
  'setargs.sh': 'set -- ls\n"$@"\n',
  'setnone.sh': 'set --\n"$@"\n',
  'evalset.sh': 'eval "set -- ls"\n"$@"\n',
  'evalvar.sh': `S='set -- ${rm} -rf /tmp/egc-victim'\neval "$S"\n"$@"\n`,
  'setter.sh': 'set -- ls\n',
  'sources.sh': '. ./setter.sh\n"$@"\n',
  'strict.sh': 'set -euo pipefail\nset +o xtrace -e\nexec "$@"\n',
  'func.sh': 'run() { "$@"; }\nrun ls\n',
  'sourced.sh': '. ./wrap.sh\n',
};

function runTests() {
  console.log('\n=== Testing the words a script is given as its positional parameters ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => (ok ? passed++ : failed++);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-positional-'));
  const judge = command => run({ tool_name: 'Bash', tool_input: { command }, cwd: dir });
  for (const [name, body] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });

  try {
    record(test('a script that runs the words it is given is judged by those words', () => {
      for (const command of [
        './wrap.sh node x.js', 'bash wrap.sh ls', 'sh wrap.sh git status', './scope.sh node tests/run-all.js', './arg1.sh hello',
        "./wrap.sh echo 'a b'", './star.sh ls -la', './count.sh ls', './wrap.sh', './first.sh ls -la',
        // "$*" is one word: a program named `ls -la`, which no shell finds.
        './quoted-star.sh ls -la', `./quoted-star.sh ${rm} -rf /tmp/egc-victim`,
        './strict.sh node x.js', './wrap.sh ls > /dev/null',
      ]) {
        const result = judge(command);
        assert.strictEqual(result.exitCode, 0, `${command}: ${result.stderr}`);
      }
      for (const command of [
        `./wrap.sh ${rm} -rf /tmp/egc-victim`, `bash wrap.sh ${rm} -rf /tmp/egc-victim`, `./wrap.sh ${rm} -rf ~/egc-victim`,
        `./star.sh ${rm} -rf /tmp/egc-victim`, `./count.sh ${rm} -rf /tmp/egc-victim`, `./first.sh ${rm} -rf`,
        `sudo ./wrap.sh ${rm} -rf /tmp/egc-victim`, `./wrap.sh sudo ${rm} -rf /tmp/egc-victim`, `./strict.sh ${rm} -rf /tmp/egc-victim`,
        // A redirection anywhere on the line is the caller's, not a word the script gets.
        `./wrap.sh > /dev/null ${rm} -rf /tmp/egc-victim`, `./wrap.sh 2>/dev/null ${rm} -rf /tmp/egc-victim`,
      ]) {
        const result = judge(command);
        assert.strictEqual(result.exitCode, 2, `${command}: ${JSON.stringify(result)}`);
        assert.match(result.stderr, /destructive/, command);
      }
    }));

    record(test('words the hook cannot read, and parameters the script moves, resets or hands a function, still fail closed', () => {
      for (const command of [
        './wrap.sh "$CMD"', './wrap.sh $(cat f)', './wrap.sh *.js', 'CMD=ls; ./wrap.sh $CMD', './wrap.sh ~root/bin/x',
        './wrap.sh {ls,cat}', './shift.sh ls', './setargs.sh ls', './func.sh ls', './sourced.sh ls',
        './setnone.sh ls', './evalset.sh ls', './evalvar.sh ls', './sources.sh ls',
      ]) {
        const result = judge(command);
        assert.strictEqual(result.exitCode, 2, `${command}: ${JSON.stringify(result)}`);
        assert.match(result.stderr, /cannot read|only the shell knows/, command);
      }
    }));

    record(test('a committed script gets its words too, held to the grave denials only', () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-positional-repo-'));
      const emptyConfig = path.join(repo, '..', `${path.basename(repo)}.gitconfig`);
      fs.writeFileSync(emptyConfig, '');
      const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
      Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig });
      const git = (...args) => {
        const result = spawnSync('git', args, { cwd: repo, env: gitEnv, encoding: 'utf8', timeout: 20000 });
        assert.strictEqual(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
      };
      const judged = command => run({ tool_name: 'Bash', tool_input: { command }, cwd: repo }).exitCode;
      try {
        git('init', '-q');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Test');
        git('config', 'core.autocrlf', 'false');
        fs.writeFileSync(path.join(repo, 'wrap.sh'), SCRIPTS['wrap.sh'], { mode: 0o755 });
        git('add', '.');
        git('commit', '-q', '-m', 'wrapper');
        assert.strictEqual(judged(`./wrap.sh ${grave}`), 2, 'the grave command the words make is refused');
        assert.strictEqual(judged('./wrap.sh node x.js'), 0, 'a benign command the words make runs');
        assert.strictEqual(judged('./wrap.sh "$CMD"'), 0, 'a word the hook cannot read is left to the grave denials');
      } finally {
        removeDirWithRetries(repo);
        fs.rmSync(emptyConfig, { force: true });
      }
    }));
  } finally {
    removeDirWithRetries(dir);
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
