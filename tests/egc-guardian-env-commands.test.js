'use strict';
/**
 * An environment variable git reads as a command to run, a config file to
 * load, a template to copy hooks from, or a file to write its trace to is
 * judged as that: the ones git runs or loads are refused by name, as
 * GIT_PAGER and GIT_EDITOR already were; a trace written to a protected file
 * is refused; a pager or an editor the line names is judged by what it runs,
 * so `PAGER=cat` stays free while a script or inline code does not.
 *
 * Run with: node tests/egc-guardian-env-commands.test.js
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

const hardDenied = v => v.allowed === false && !v.advisory;
const denied = command => run(`${command} is denied`, () => {
  const v = validateCommand(command);
  assert.ok(hardDenied(v), `${command} should be denied, got: ${JSON.stringify(v)}`);
});
const notDenied = command => run(`${command} is not denied`, () => {
  const v = validateCommand(command);
  assert.ok(!hardDenied(v), `${command} should not be denied, got: ${v.reason}`);
});

console.log('\n=== Variables whose value git runs, loads or copies hooks from ===\n');
denied('GIT_EXTERNAL_DIFF=./x.sh git diff');
denied('GIT_SEQUENCE_EDITOR=./x.sh git rebase -i HEAD~2');
denied('GIT_ASKPASS=./x.sh git push');
denied('SSH_ASKPASS=./x.sh git push');
denied('GIT_PROXY_COMMAND=./x.sh git fetch');
denied('GIT_CONFIG_GLOBAL=./evil.cfg git log');
denied('GIT_CONFIG_SYSTEM=./evil.cfg git log');
denied('GIT_TEMPLATE_DIR=./t git init');
denied("LESSOPEN='|./x.sh %s' git log");
denied('export GIT_EXTERNAL_DIFF=./x.sh');
denied('env GIT_PROXY_COMMAND=./x.sh git fetch');
denied('git_external_diff=./x.sh git diff');

console.log('\n=== A trace git writes to a protected file ===\n');
denied('GIT_TRACE=~/.bashrc git status');
denied('GIT_TRACE2_EVENT=~/.ssh/authorized_keys git status');
denied('export GIT_TRACE_PACKET=~/.bashrc');
notDenied('GIT_TRACE=1 git status');
notDenied('GIT_TRACE=/tmp/git-trace.log git status');
notDenied('GIT_TRACE2_PERF=true git fetch');

console.log('\n=== A pager or an editor is judged by what it runs ===\n');
denied('PAGER=./x.sh git log');
denied('EDITOR=./x.sh git commit');
denied("VISUAL='sh -c x' git commit");
denied("PAGER='less; rm -rf x' git log");
denied('MANPAGER=/tmp/x.sh man ls');
denied('export PAGER=./x.sh');
denied('PAGER=python3 git log');
notDenied('PAGER=cat git log');
notDenied('PAGER=less git log');
notDenied("PAGER='less -R' git log");
notDenied('PAGER=/usr/bin/less git log');
notDenied('EDITOR=vim git commit');
notDenied('EDITOR=true git commit');
denied("EDITOR='code --wait' git commit");
notDenied('export EDITOR=nano');
notDenied('OUT=./build/out.txt npm run build');

console.log('\n=== A program handed an argument, a path git writes, a config home, less options ===\n');
denied("PAGER='awk -f evil.awk' git log");
denied("EDITOR=\"vim -c '!x'\" git commit");
denied("PAGER='less +!id' git log");
denied('LESSKEY=evil.key git log');
denied("LESS='+!id' git log");
denied("LESS='-k evil.key' git log");
denied('GIT_INDEX_FILE=~/.bashrc git add .');
denied('GIT_DIR=~/.ssh git init');
denied('GIT_WORK_TREE=~/.ssh git checkout -f');
denied('HOME=/tmp/evil git status');
denied('XDG_CONFIG_HOME=/tmp/evil git log');
denied('env HOME=/tmp/evil git status');
notDenied("PAGER='bat --paging=always' git log");
denied("EDITOR='nano -w' git commit");
notDenied('LESS=FRX git log');
notDenied('LESS=-R git log');
notDenied('GIT_INDEX_FILE=/tmp/idx git add .');
notDenied('GIT_DIR=.git git status');
notDenied('HOME=/tmp/x npm install');
notDenied('MAKEFLAGS=-k make');

console.log('\n=== An editor is named alone, and a repository is a .git directory ===\n');
denied("EDITOR='sed -fevil' git commit");
denied("VISUAL='vim -u x' git commit");
denied("VISUAL='code --wait' git commit");
denied('GIT_DIR=/tmp/evil git status');
denied('GIT_COMMON_DIR=/tmp/evil git fetch');
notDenied('GIT_DIR=../other/.git git log');
notDenied('GIT_DIR=/srv/app/.git/ git log');

console.log('\n=== Code a shell or the loader runs before the program, and a config home left for later ===\n');
denied('BASH_ENV=./evil.sh bash ok.sh');
denied('ENV=./evil.sh sh -i');
denied('LD_PRELOAD=./evil.so ls');
denied('LD_AUDIT=./evil.so ls');
denied('DYLD_INSERT_LIBRARIES=./evil.dylib ls');
denied('export BASH_ENV=./evil.sh');
denied('export HOME=/tmp/evil');
denied('export XDG_CONFIG_HOME=/tmp/evil');
denied('HOME=/tmp/evil');
notDenied('LD_LIBRARY_PATH=./build/lib ls');
denied("GIT_CONFIG=~/.bashrc git config alias.x '!id'");
denied('GIT_CONFIG=~/.bashrc git config user.name x');
denied('HOME=/tmp/evil git-upload-pack .');
denied('XDG_CONFIG_HOME=/tmp/evil git-receive-pack .');

console.log('\n=== An editor\'s startup commands and gpg\'s home ===\n');
denied("VIMINIT='!id' EDITOR=vim git commit");
denied("EXINIT='!id' EDITOR=vi git commit");
denied("GVIMINIT='!id' gvim x");
denied('VIM=/tmp/evil EDITOR=vim git commit');
denied('VIMRUNTIME=/tmp/evil vim x');
denied('EMACSLOADPATH=/tmp/evil emacs x');
denied("GNUPGHOME=/tmp/evil git commit -S -m 'x'");
denied('GNUPGHOME=/tmp/evil gpg --sign f');
denied('HOME=/tmp/evil gpg --sign f');
denied('export GNUPGHOME=/tmp/evil');
notDenied('GNUPGHOME=/tmp/x npm test');

console.log('\n=== A config home that reaches git or gpg through a wrapper ===\n');
denied('HOME=/tmp/evil env git fetch');
denied('HOME=/tmp/evil nice git fetch');
denied('HOME=/tmp/evil nohup git fetch');
denied('HOME=/tmp/evil timeout 5 git fetch');
denied('GNUPGHOME=/tmp/evil env gpg --sign f');
denied('HOME=/tmp/evil env -- git fetch');
denied('HOME=/tmp/evil env -u FOO git fetch');
notDenied('HOME=/tmp/x env node app.js');
notDenied('HOME=/tmp/x nice npm install');
notDenied('HOME=/tmp/x env');

console.log('\n=== A path that climbs out of a system directory, and a quoted export ===\n');
denied('EDITOR=/usr/bin/../../tmp/evil.sh git commit');
denied('VISUAL=/usr/../tmp/evil.sh git commit');
denied('PAGER=/bin/../tmp/evil.sh git log');
denied('export "BASH_ENV=/tmp/evil.sh"');
denied("export 'GIT_SSH_COMMAND=x'");
denied('export "GIT_EXTERNAL_DIFF=./x.sh"');
notDenied('EDITOR=/usr/bin/vim git commit');
notDenied('EDITOR=/usr/bin/../lib/git-core/git-editor git commit');
notDenied('export "FOO=bar"');
notDenied('export "PATH=/usr/bin"');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
