/**
 * The directories a command line can be in as it runs, followed through cd,
 * pushd and popd (scripts/lib/shell-cwd.js), as the Bash hook follows them.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { startCwd, afterMove } = require('../../scripts/lib/shell-cwd');

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

const root = path.resolve('/work');
const home = path.resolve('/home/me');
const words = (...values) => values.map(value => ({ value }));
// Literal targets name themselves, a bare cd goes home, `$X` is unknown.
const literal = word => {
  if (word === null) return [home];
  return word.value.startsWith('$') ? null : [word.value];
};
const move = (state, line) => {
  const [name, ...args] = line.split(' ');
  return afterMove(state, name, words(...args), literal);
};
const through = (...lines) => lines.reduce(move, startCwd(root));

function runTests() {
  console.log('\n=== Testing the directories cd, pushd and popd lead to ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => (ok ? passed++ : failed++);

  record(test('a cd adds where it leads and keeps where the line was, since a failed or subshell cd leaves it there', () => {
    assert.deepStrictEqual(through('cd sub').dirs, [root, path.join(root, 'sub')]);
    assert.deepStrictEqual(through('cd sub', 'cd deeper').dirs, [root, path.join(root, 'sub'), path.join(root, 'deeper'), path.join(root, 'sub', 'deeper')]);
    assert.deepStrictEqual(through('cd /abs').dirs, [root, path.resolve('/abs')]);
    assert.deepStrictEqual(through('cd').dirs, [root, home]);
    assert.strictEqual(through('cd sub').unknown, null);
  }));

  record(test("cd's options and -- are skipped, and a command that moves nothing changes nothing", () => {
    assert.deepStrictEqual(through('cd -P -- sub').dirs, [root, path.join(root, 'sub')]);
    assert.deepStrictEqual(through('cd -L -e sub').dirs, [root, path.join(root, 'sub')]);
    assert.deepStrictEqual(through('cd -- -dir').dirs, [root, path.join(root, '-dir')]);
    assert.deepStrictEqual(through('ls sub').dirs, [root]);
    assert.deepStrictEqual(through('cd a b').dirs, [root], 'too many operands is an error and stays');
    assert.deepStrictEqual(through('cd sub -P').dirs, [root], 'an option after the operand is a second operand');
    assert.deepStrictEqual(through('cd sub --').dirs, [root], '-- after the operand is a second operand');
  }));

  record(test('cd -P follows a symlink before its .., as the system does, and cd -L or plain cd reads .. by name', () => {
    const fs = require('fs');
    const os = require('os');
    const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'egc-cd-physical-')));
    try {
      fs.mkdirSync(path.join(top, 'real', 'sub'), { recursive: true });
      try {
        fs.symlinkSync(path.join(top, 'real', 'sub'), path.join(top, 'link'), 'dir');
      } catch {
        console.log('    - skipped: this system does not let the test create a symlink');
        return;
      }
      const at = (...lines) => lines.reduce((state, line) => {
        const [name, ...args] = line.split(' ');
        return afterMove(state, name, words(...args), word => [word.value]);
      }, startCwd(top));
      assert.ok(at('cd -P link/..').dirs.includes(path.join(top, 'real')), 'the parent of the linked directory');
      assert.ok(at('cd -LP link/..').dirs.includes(path.join(top, 'real')), 'the last of -L and -P decides');
      assert.ok(at('cd -P link', 'cd ..').dirs.includes(path.join(top, 'real')), 'a later .. starts from the physical directory');
      assert.ok(!at('cd link/..').dirs.includes(path.join(top, 'real')), 'plain cd reads .. by name');
      assert.ok(!at('cd -PL link/..').dirs.includes(path.join(top, 'real')), '-L after -P is logical');
      assert.ok(at('cd -P missing').dirs.includes(path.join(top, 'missing')), 'a target that is not there keeps the plain resolution');
    } finally {
      fs.rmSync(top, { recursive: true, force: true });
    }
  }));

  record(test('a target that expands to - is cd -, and one that expands to an option is unknown', () => {
    const expandsTo = values => word => (word?.value === '$X' ? values : literal(word));
    const moveX = (state, name, values) => afterMove(state, name, words('$X'), expandsTo(values));
    const back = moveX(through('cd sub', 'cd /abs'), 'cd', ['-']);
    assert.strictEqual(back.unknown, null);
    assert.ok(back.dirs.includes(path.join(root, 'sub')));
    assert.match(moveX(startCwd(root), 'cd', ['-']).unknown, /returns to a directory only the running shell knows/);
    assert.match(moveX(startCwd(root), 'cd', ['-P']).unknown, /expands to an option/);
    assert.match(moveX(startCwd(root), 'pushd', ['+1']).unknown, /expands to an option/);
    assert.match(moveX(startCwd(root), 'cd', ['sub', '-']).unknown, /expands to an option/);
    assert.deepStrictEqual(moveX(startCwd(root), 'cd', ['sub']).dirs, [root, path.join(root, 'sub')]);
  }));

  record(test('cd - returns to where the last move started, and is unknown with no move before it on the line', () => {
    const back = through('cd sub', 'cd /abs', 'cd -');
    assert.strictEqual(back.unknown, null);
    assert.ok(back.dirs.includes(path.join(root, 'sub')));
    assert.match(through('cd -').unknown, /returns to a directory only the running shell knows/);
  }));

  record(test('pushd and popd follow the stack this line builds, and anything older is unknown', () => {
    const pushed = through('pushd sub');
    assert.deepStrictEqual(pushed.stack, [[root]]);
    const popped = move(pushed, 'popd');
    assert.deepStrictEqual(popped.stack, []);
    assert.ok(popped.dirs.includes(root));
    assert.deepStrictEqual(move(pushed, 'pushd').dirs, pushed.dirs, 'pushd alone swaps back to the pushed directories');
    assert.match(through('popd').unknown, /directory stack the shell had/);
    assert.match(through('pushd').unknown, /directory stack the shell had/);
    assert.match(through('pushd +1').unknown, /rotates a stack/);
    assert.match(move(pushed, 'popd +1').unknown, /takes a directory from a stack/);
  }));

  record(test('a target only the running shell knows leaves the directory unknown from there on', () => {
    const lost = through('cd $X');
    assert.match(lost.unknown, /cd \$X moves to a directory only known when the command runs/);
    assert.strictEqual(move(lost, 'cd sub'), lost, 'a later move does not make it known again');
    assert.deepStrictEqual(lost.dirs, [root]);
  }));

  record(test('more directories than the hook follows is unknown', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `cd d${i}`);
    assert.match(through(...lines).unknown, /more directories than this hook follows/);
    assert.strictEqual(through(...lines.slice(0, 3)).unknown, null);
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
