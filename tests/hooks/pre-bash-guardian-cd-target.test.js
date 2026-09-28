/**
 * A cd whose target the line builds from its own variables leads where the
 * shell takes it: the hook reads the script run after it in each directory
 * the values the line gives those variables name. A tilde before them is the
 * home directory, as the shell expands it first. A variable only the running
 * shell knows, a CDPATH search and a changed IFS still fail closed.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.EGC_GUARDIAN_CLI = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');
const { run } = require('../../scripts/hooks/pre-bash-guardian-validate');

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

const wipe = ['rm', '-rf', '/'].join(' ');
const grave = ['rm', '-rf', '~'].join(' ');

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o755 });
}

function runTests() {
  console.log('\n=== Testing cd targets built from the line\'s variables ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => (ok ? passed++ : failed++);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-cd-target-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-cd-home-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const judge = command => run({ tool_name: 'Bash', tool_input: { command }, cwd: dir });
  const abs = path.join(dir, 'abs');
  put(path.join(abs, 'sub', 'danger.sh'), `${wipe}\n`);
  put(path.join(abs, 'sub', 'fine.sh'), 'echo fine\n');
  put(path.join(dir, 'one', 'fine.sh'), 'echo fine\n');
  put(path.join(dir, 'two', 'danger.sh'), `${wipe}\n`);
  put(path.join(dir, 'two', 'fine.sh'), 'echo fine\n');
  put(path.join(home, 'x', 'danger.sh'), `${wipe}\n`);
  put(path.join(home, 'x', 'fine.sh'), 'echo fine\n');
  put(path.join(home, 'x', 'mixed.sh'), `${wipe}\n`);
  put(path.join(home, 'athome.sh'), `${wipe}\n`);
  put(path.join(home, '$D', 'mixed.sh'), 'echo fine\n');

  try {
    record(test('a cd to a directory the line fixes is followed, and the script after it is judged by what it holds', () => {
      for (const command of [
        `D=${abs}; cd $D/sub && ./danger.sh`, `D=${abs}; cd "$D/sub" && ./danger.sh`, `D=${abs}; cd \${D}/sub && bash danger.sh`,
        'D=two; cd $D && ./danger.sh', 'D=one; D=two; cd $D && ./danger.sh', 'if true; then D=one; else D=two; fi; cd $D && ./danger.sh',
        'for D in one two; do cd $D && ./danger.sh; done', 'D=tw; cd ${D}o && ./danger.sh',
        `CDPATH=/nowhere; D=${abs}; cd $D/sub && ./danger.sh`, 'D=; cd $D && ./athome.sh',
      ]) {
        const result = judge(command);
        assert.strictEqual(result.exitCode, 2, `${command}: ${JSON.stringify(result)}`);
        assert.match(result.stderr, /destructive/, command);
      }
      for (const command of [
        `D=${abs}; cd $D/sub && ./fine.sh`, `D=${abs}; cd "$D/sub" && ./fine.sh`, 'D=one; cd $D && ./fine.sh',
        'if true; then D=one; else D=two; fi; cd $D && ./fine.sh', `D=${abs}; cd $D/sub && ls`, `D=${abs}; cd $D/sub && git status`,
        // Two words are too many operands: cd fails and the line stays.
        'D="one two"; cd $D && ./fine.sh', 'D="two one"; cd $D && ./danger.sh',
      ]) {
        const result = judge(command);
        assert.strictEqual(result.exitCode, 0, `${command}: ${result.stderr}`);
      }
    }));

    record(test('a tilde before a variable is the home directory, in a cd, a command run by its path and a script operand', () => {
      for (const command of [
        'D=x; cd ~/$D && ./danger.sh', 'cd $HOME/x && ./danger.sh', 'D=x; ~/$D/danger.sh', 'D=x; ~/"$D"/danger.sh',
        `HOME=${dir}; D=two; cd ~/$D && ./danger.sh`, `HOME=${dir}; D=two; cd $HOME/$D && ./danger.sh`,
      ]) {
        const result = judge(command);
        assert.strictEqual(result.exitCode, 2, `${command}: ${JSON.stringify(result)}`);
        assert.match(result.stderr, /destructive/, command);
      }
      // A directory literally named $D beside the one the shell reaches is
      // not the script that runs.
      const operand = judge('D=x; bash ~/$D/mixed.sh');
      assert.strictEqual(operand.exitCode, 2, JSON.stringify(operand));
      for (const command of ['D=x; cd ~/$D && ./fine.sh', 'cd $HOME/x && ./fine.sh', 'D=x; ~/$D/fine.sh']) {
        const result = judge(command);
        assert.strictEqual(result.exitCode, 0, `${command}: ${result.stderr}`);
      }
    }));

    record(test('a target only the running shell knows still fails closed', () => {
      for (const command of [
        'cd $UNSET_EGC_DIR && ./fine.sh', 'read D; cd $D && ./fine.sh', 'D=$(cat f); cd $D/sub && ./fine.sh',
        'D=one; cd $D$UNSET_EGC_DIR && ./fine.sh', 'CDPATH=/nowhere; D=one; cd $D && ./fine.sh', 'CDPATH=/nowhere; D=one; cd "$D" && ./fine.sh',
        'IFS=/; D=one; cd $D && ./fine.sh', 'read HOME; D=x; cd ~/$D && ./fine.sh', 'D=x; cd ~root/$D && ./fine.sh',
        'D=-; cd $D && ./fine.sh', 'D=one; cd $D/* && ./fine.sh', 'read HOME; D=; cd $D && ./fine.sh',
        // Without HOME the shell takes the home from the user database.
        'unset HOME; D=x; cd ~/$D && ./fine.sh',
      ]) {
        const result = judge(command);
        assert.strictEqual(result.exitCode, 2, `${command}: ${JSON.stringify(result)}`);
        assert.match(result.stderr, /only known|expands to an option|returns to a directory only/, command);
      }
    }));

    record(test('a committed script follows the cd it builds from its own variables under the grave denials', () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-cd-target-repo-'));
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
        const files = {
          'deep/grave.sh': `${grave}\n`,
          'deep/fine.sh': 'echo fine\n',
          'to-grave.sh': 'D=deep\ncd "$D" && bash grave.sh\n',
          'to-fine.sh': 'D=de\ncd ${D}ep && bash fine.sh\n',
        };
        for (const [name, body] of Object.entries(files)) put(path.join(repo, name), body);
        git('add', '.');
        git('commit', '-q', '-m', 'scripts');
        assert.strictEqual(judged('bash to-grave.sh'), 2, 'the grave script behind the cd is found');
        assert.strictEqual(judged('bash to-fine.sh'), 0, 'a benign script behind the cd runs');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(emptyConfig, { force: true });
      }
    }));
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
