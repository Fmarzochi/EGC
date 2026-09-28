'use strict';
/**
 * git clone sets its -c/--config keys in the repository it makes before
 * it fetches, and clone and init copy the hooks of a --template directory
 * into it: a key that runs a command, or a template, takes effect in that
 * very call, as `git -c` does. They are judged by the same rules.
 *
 * Run with: node tests/egc-guardian-git-new-repo-settings.test.js
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

console.log('\n=== settings git applies to the repository clone or init makes ===\n');

record(test('clone -c or --config with a key that runs a command is refused, however it is spelled', () => {
  for (const command of [
    "git clone -c core.sshCommand='sh -c x' ssh://h/r", 'git clone --config core.sshCommand=evil ssh://h/r', 'git clone -c core.fsmonitor=./x.sh repo',
    'git clone --config=core.hooksPath=/tmp/h repo', 'git clone -ccore.pager=less repo', 'git clone -qc core.sshCommand=x repo',
    'git clone --conf core.editor=vim repo', "git clone -c alias.x='!rm -r x' repo", 'git clone -c user.name=x -c credential.helper=x repo',
    // Without `=` git writes the key as `true`; after an option that took
    // its value, the next option is read again.
    'git clone -c core.hooksPath repo', 'git clone --depth 1 -c core.sshCommand=x repo', 'git clone -b main --config=core.pager=less repo',
  ]) {
    assert.match(denied(command).reason, /git clone/, command);
  }
}));

record(test('a --template for clone or init is refused, as init.templateDir is', () => {
  for (const command of [
    'git clone --template=/tmp/t repo', 'git clone --template /tmp/t repo', 'git clone --templ /tmp/t repo', 'git init --template=/tmp/t',
    'git init --templ=/tmp/t', 'git init -q --template /tmp/t dir', 'git clone -b main --template=/tmp/t repo', 'git clone --origin up --template /tmp/t repo',
    // A value glued to its option leaves the next word to be read.
    'git clone --branch=main --template=/tmp/t repo', 'git clone -bmain --template=/tmp/t repo',
  ]) {
    assert.match(denied(command).reason, /template/, command);
  }
}));

record(test('a key that runs nothing, and clone or init without these options, are judged as before', () => {
  for (const command of [
    'git clone -c user.name=x repo', 'git clone --config core.autocrlf=false repo', 'git clone repo', 'git clone -b main repo',
    'git clone -bc repo', 'git init', 'git init -q dir', "git clone -c 'pager.log=false' repo",
    // -b takes `c` as the branch here, and the next word is the repository.
    'git clone -bc core.sshCommand=x',
    // An option that takes a value takes the next word, whatever it looks
    // like: here a branch or an origin named like an option.
    'git clone -b --template evil', 'git init -b --template', 'git clone --branch --template evil', 'git clone --bra --config=core.sshCommand=x repo',
    'git clone -o -c core.sshCommand=x', 'git clone -qb --template repo',
  ]) {
    passes(command);
  }
}));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
