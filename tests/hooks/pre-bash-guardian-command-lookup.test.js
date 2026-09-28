/**
 * `command -v` and `command -V` (alone or in a cluster such as -pv) only
 * say what each name would run; they run nothing. The Bash hook reads the
 * words after them as names, neither a command to unwrap nor a script to
 * read, and the validator judges nothing behind them. Any other `command`
 * still runs what follows it and is judged as that.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.EGC_GUARDIAN_CLI = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');
const { run } = require('../../scripts/hooks/pre-bash-guardian-validate');

const validatorPath = path.join(__dirname, '..', '..', 'mcp', 'servers', 'egc-guardian', 'build', 'validator.js');

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

function runTests() {
  console.log('\n=== Testing command -v and -V, which run nothing ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => (ok ? passed++ : failed++);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-command-lookup-'));
  fs.writeFileSync(path.join(dir, 'x.sh'), `${wipe}\n`, { mode: 0o755 });
  const judge = command => run({ tool_name: 'Bash', tool_input: { command }, cwd: dir });

  try {
    record(test('the hook reads the words after command -v or -V as names', () => {
      for (const command of [
        'command -v bash sh', 'command -v ./x.sh', 'command -V ./x.sh', 'command -pv git', 'command -vp ./x.sh',
        'command -p -v ./x.sh', 'command -v -- ./x.sh', 'command -V bash x.sh', 'if command -v ./x.sh >/dev/null; then echo ok; fi',
      ]) {
        const result = judge(command);
        assert.strictEqual(result.exitCode, 0, `${command}: ${result.stderr}`);
      }
    }));

    record(test('any other command runs what follows it, and the hook judges that', () => {
      // Another wrapper's -v (strace's verbose) still runs what follows it.
      for (const command of [
        'command bash x.sh', 'command ./x.sh', 'command -p ./x.sh', 'command -- ./x.sh', 'sudo command bash x.sh', 'strace -v ./x.sh',
        'command -v ls; ./x.sh', 'command -v ls && bash x.sh', 'command -v $(./x.sh)',
      ]) {
        const result = judge(command);
        assert.strictEqual(result.exitCode, 2, `${command}: ${JSON.stringify(result)}`);
        assert.match(result.stderr, /destructive/, command);
      }
    }));

    record(test('the validator judges nothing behind command -v or -V, and what any other command runs', () => {
      if (!fs.existsSync(validatorPath)) {
        console.log('    [SKIP] build not found; run npm run build in mcp/servers/egc-guardian first');
        return;
      }
      const { validateCommand } = require(validatorPath);
      for (const command of [`command -v ${wipe}`, 'command -V rm', `command -pv ${wipe}`, `command -p -V ${wipe}`, `command -v -- ${wipe}`]) {
        const verdict = validateCommand(command);
        assert.strictEqual(verdict.allowed || verdict.advisory === true, true, `${command}: ${JSON.stringify(verdict)}`);
        assert.doesNotMatch(String(verdict.reason ?? ''), /destructive/, command);
      }
      for (const command of [`command ${wipe}`, `command -p ${wipe}`, `command -- ${wipe}`, `sudo command ${wipe}`, `strace -v ${wipe}`]) {
        const verdict = validateCommand(command);
        assert.strictEqual(verdict.allowed, false, `${command}: ${JSON.stringify(verdict)}`);
        assert.match(verdict.reason, /destructive/, command);
      }
      // The validator reads one line whole: what goes on past the names is
      // still flagged by its chaining check, as any other chain is.
      for (const command of [`command -v ls ; ${wipe}`, `command -v ls;${wipe}`, `command -v ls && ${wipe}`, `command -v ls | ${wipe}`, `command -v $(${wipe})`]) {
        const verdict = validateCommand(command);
        assert.strictEqual(verdict.allowed, false, `${command}: ${JSON.stringify(verdict)}`);
      }
    }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
