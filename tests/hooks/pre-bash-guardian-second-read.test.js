/**
 * Code a shell reads after the line's own shell has expanded it (a heredoc
 * with an unquoted delimiter, the code of -c or eval in a word that expands)
 * is read a second time: the value a variable takes becomes code there. The
 * hook reads it again with every value the line gives the variables in it; a
 * variable the line fixes from a source it cannot read fails closed, unless
 * a committed script holds it, and one only the environment holds stays as
 * it is.
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

const wipe = ['rm', '-rf', '/'].join(' ');
const grave = ['rm', '-rf', '~'].join(' ');

function runTests() {
  console.log('\n=== Testing code a shell reads a second time ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => (ok ? passed++ : failed++);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-second-read-'));
  const judge = command => run({ tool_name: 'Bash', tool_input: { command }, cwd: dir });

  try {
    record(test('a heredoc the line expands is read again with every value the line gives its variables', () => {
      for (const command of [
        `X='ls; ${wipe}'; bash <<EOF\nls $X\nEOF`, `X='ls; ${wipe}'; bash <<EOF\nls \${X}\nEOF`, `X=ls; X='ls; ${wipe}'; sh <<EOF\necho $X\nEOF`,
        `if true; then X='ls; ${wipe}'; fi; bash <<EOF\nls $X\nEOF`, `X='ls; ${wipe}'; sudo bash <<EOF\nls $X\nEOF`,
        `X="x'; ${wipe}; '"; Y=ok; bash <<EOF\necho $Y '$X'\nEOF`, `LIST_CMD='ls; ${wipe}'; bash <<EOF\n$LIST_CMD\nEOF`,
        `A=ls; B='ls; ${wipe}'; bash <<EOF\n$A $B\nEOF`, `X='ls; ${wipe}'; bash <<EOF\nls \\\\$X\nEOF`,
        `X='ls; ${wipe}'; bash <<EOF\nls \${X:-y}\nEOF`, 'X=; bash <<EOF\nls ${X:-;r}m -rf /\nEOF', 'X=a; bash <<EOF\nls ${X:+;r}m -rf /\nEOF',
        'X=a; bash <<EOF\necho $X ${X:+;r}m -rf /\nEOF',
      ]) {
        const result = judge(command);
        assert.strictEqual(result.exitCode, 2, `${command}: ${JSON.stringify(result)}`);
      }
    }));

    record(test('a variable the environment holds is read again with its value', () => {
      const saved = process.env.EGC_SECOND_READ_PROBE;
      process.env.EGC_SECOND_READ_PROBE = `ls; ${wipe}`;
      try {
        const result = judge('bash <<EOF\nls $EGC_SECOND_READ_PROBE\nEOF');
        assert.strictEqual(result.exitCode, 2, JSON.stringify(result));
      } finally {
        if (saved === undefined) delete process.env.EGC_SECOND_READ_PROBE; else process.env.EGC_SECOND_READ_PROBE = saved;
      }
    }));

    record(test('a variable the line fixes from a source the hook cannot read, or through an expansion it does not follow, fails closed there', () => {
      for (const command of [
        'X=$(cat f); bash <<EOF\nls $X\nEOF', 'read X; bash <<EOF\nls $X\nEOF', 'source env.sh; bash <<EOF\nls $X\nEOF',
        'X=a; bash <<EOF\nls ${X#a}\nEOF', 'X=; Y=a; bash <<EOF\nls ${X:-$Y}\nEOF',
      ]) {
        const result = judge(command);
        assert.strictEqual(result.exitCode, 2, `${command}: ${JSON.stringify(result)}`);
        assert.match(result.stderr, /reads .* a second time|cannot read|does not follow/, command);
      }
    }));

    record(test('code whose variables take more combinations of values than the hook follows fails closed', () => {
      // Ten values each (nine from the list and unset) make a hundred readings.
      const nine = 'a b c d e f g h i';
      const result = judge(`for A in ${nine}; do :; done; for B in ${nine}; do :; done; bash <<EOF\necho $A $B\nEOF`);
      assert.strictEqual(result.exitCode, 2, JSON.stringify(result));
      assert.match(result.stderr, /more combinations of values than this hook follows/);
      const few = judge('for A in a b c; do :; done; for B in a b c; do :; done; bash <<EOF\necho $A $B\nEOF');
      assert.strictEqual(few.exitCode, 0, few.stderr);
    }));

    record(test('what the shell does not read twice, and a variable only the environment holds, stay as they were', () => {
      for (const command of [
        'bash <<EOF\ncd $HOME && ls\nEOF', 'X=ls; bash <<EOF\nls $X\nEOF', `X='ls; ${wipe}'; bash <<'EOF'\nls $X\nEOF`,
        `X='ls; ${wipe}'; bash <<EOF\nls \\$X\nEOF`, `X='ls; ${wipe}'; cat <<EOF\nls $X\nEOF`, 'X=ls; bash <<EOF\necho $1 $$ $?\nEOF',
        `X='ls; ${wipe}'; bash <<EOF\necho '$X'\nEOF`,
      ]) {
        const result = judge(command);
        assert.strictEqual(result.exitCode, 0, `${command}: ${result.stderr}`);
      }
    }));

    record(test('a committed script is read the same way under the grave denials, and a source it cannot read is left there', () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-second-read-repo-'));
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
          'reread-c.sh': `X='x; ${grave}'\nsh -c "echo $X"\n`,
          'reread-heredoc.sh': `X='x; ${grave}'\nbash <<EOF\necho $X\nEOF\n`,
          'reread-eval.sh': `X='x; ${grave}'\neval "echo $X"\n`,
          'reread-op.sh': `X='x; ${grave}'\nsh -c "echo \${X#q}"\n`,
          'positional.sh': `X='x; ${grave}'\nY=ok\nsh -c "ls \\$1 $Y" sh "$X"\n`,
          'single.sh': `X='x; ${grave}'\nsh -c 'echo $X'\n`,
          'env.sh': 'sh -c "cd $DIR && make"\n',
          'opaque.sh': 'X=$(git rev-parse HEAD)\nbash <<EOF\necho $X\nEOF\n',
        };
        for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), body);
        git('add', '.');
        git('commit', '-q', '-m', 'scripts');
        assert.strictEqual(judged('bash reread-c.sh'), 2, 'the -c code a committed script expands is read with the value it sets');
        assert.strictEqual(judged('bash reread-heredoc.sh'), 2, 'the heredoc a committed script expands is read with the value it sets');
        assert.strictEqual(judged('bash reread-eval.sh'), 2, 'the eval code a committed script expands is read with the value it sets');
        assert.strictEqual(judged('bash reread-op.sh'), 2, 'an expansion the hook does not follow still reads the values the script sets');
        assert.strictEqual(judged('bash positional.sh'), 0, 'a $1 the code expands itself is not read as code a second time');
        assert.strictEqual(judged('bash single.sh'), 0, 'single quotes leave the expansion to the shell that runs the code');
        assert.strictEqual(judged('bash env.sh'), 0, 'a variable only the environment holds');
        assert.strictEqual(judged('bash opaque.sh'), 0, 'a committed script is held to the grave denials only');
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
