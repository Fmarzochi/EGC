'use strict';
/**
 * git config and git grep judged the way git reads their arguments (measured
 * on git 2.51): a subcommand counts only as the first word, options end at
 * the first operand, an option's value is never an action, and a file that
 * -f/--file names is written by every call that is not a read.
 *
 * Run with: node tests/egc-guardian-git-config.test.js
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

function assertDenied(command, reason) {
  const v = validateCommand(command);
  assert.strictEqual(v.allowed, false, `${command} should be denied`);
  assert.strictEqual(v.trust_level, 'DANGEROUS', `${command} should be DANGEROUS, got ${v.trust_level}: ${v.reason}`);
  if (reason) assert.ok(reason.test(v.reason), `${command}: unexpected reason ${v.reason}`);
}

function assertAllowed(command) {
  const v = validateCommand(command);
  assert.strictEqual(v.allowed, true, `${command} should be allowed, got: ${v.reason}`);
}

const denied = (command, reason) => run(`${command} is denied`, () => assertDenied(command, reason));
const allowed = command => run(`${command} stays allowed`, () => assertAllowed(command));

const KEY = /persists a hook\/execution-bypass override/;
const WRITE = /would write the protected file/;
const READ = /would read the protected file/;

console.log('\n=== git config and git grep, read as git reads them ===\n');

console.log('the set, edit and rename-section subcommands:');
denied('git config set core.hooksPath /opt/evil', KEY);
denied("git config set --global alias.x '!rm -rf ~'", KEY);
denied('git config set --comment note core.hooksPath /opt/evil', KEY);
denied('git config set --comment --get core.hooksPath /opt/evil', KEY);
denied('git config edit', /editable session/);
denied('git config rename-section x core', /rename/);
denied("git config rename-section x 'filter.lfs'", /rename/);
denied('git config --rename-section x core', /rename/);
denied('git config --rename-section x alias', /rename/);
allowed('git config set user.name Felipe');
allowed('git config get core.hooksPath');
allowed('git config list');
allowed('git config unset core.hooksPath');
allowed('git config rename-section old new');
allowed('git config --rename-section old new');

console.log('\na long option abbreviated as git accepts it (a unique prefix) is that option:');
denied('git config --ren x core', /rename/);
denied('git config --rena x alias', /rename/);
denied('git config --edi', /editable session/);
denied('git config --ed', /editable session/);
denied('git config --rep core.hooksPath /opt/evil', KEY);
denied('git config --ad core.hooksPath /opt/evil', KEY);
denied('git config --fil ~/.gitconfig user.name x', WRITE);
allowed('git config --ren old new');
allowed('git config --li');
allowed('git config --get-a core.hooksPath');
allowed('git config --no-inc --get-r core');
allowed('git config --no-t --get core.hooksPath');
allowed('git config --glo --get core.hooksPath');
allowed('git config --unset core.hooksPath');
allowed('git config --unset-a core.hooksPath');
allowed('git config --get core.hooksPath /opt/evil');

console.log('\nan option git refuses (an ambiguous prefix, or a value given to one that takes none) is not resolved; the words after it are read as a write:');
denied('git config --get= core.hooksPath /opt/evil', KEY);
denied('git config --unse core.hooksPath /opt/evil', KEY);

console.log('\nan option value is not an action, and options end at the first operand:');
denied('git config --comment --get core.hooksPath /opt/evil', KEY);
denied('git config --comm --get core.hooksPath /opt/evil', KEY);
denied('git config --comment X core.hooksPath /opt/evil', KEY);
denied('git config --default --list core.hooksPath /opt/evil', KEY);
denied('git config core.hooksPath /opt/evil --get', KEY);
denied('git config core.hooksPath /opt/evil --unset', KEY);
denied('git config --no-such-option --get core.hooksPath /opt/evil', KEY);
denied('git config --no-such-option X core.hooksPath /opt/evil', KEY);
denied('git config -Q --get core.hooksPath /opt/evil', KEY);
allowed('git config --get core.hooksPath');
allowed('git config --get-all alias.co');
allowed('git config --no-show-origin --get core.hooksPath');
allowed('git config user.name x --get');

console.log('\nthe file -f/--file names is written unless the call only reads:');
denied('git config --file ~/.bashrc a.b c', WRITE);
denied('git config -f ~/.profile a.b c', WRITE);
denied('git config --file=~/.zshrc a.b c', WRITE);
denied('git config -f~/.bashrc a.b c', WRITE);
denied('git config --fil ~/.bashrc a.b c', WRITE);
denied('git config -zf ~/.bashrc a.b c', WRITE);
denied('git config -t bool --file ~/.bashrc a.b c', WRITE);
denied('git config --file ~/.bashrc --unset a.b', WRITE);
denied('git config --file ~/.bashrc a.b --get', WRITE);
denied('git config set --file ~/.bashrc a.b c', WRITE);
denied('git config --file .git/config user.name x', WRITE);
denied('git config -zf .git/config core.hooksPath /opt/evil');
allowed('git config --file ~/.bashrc --get a.b');
allowed('git config --file ~/.gitconfig --get user.name');
allowed('git config get --file ~/.gitconfig user.name');
allowed('git config --file ~/.gitconfig -l');
allowed('git config -lf ~/.gitconfig');
allowed('git config --file ~/.gitconfig --default x --get user.name');
allowed('git config --file ~/.gitconfig --type bool --get core.bare');
allowed('git config -t bool --file ~/.gitconfig --get core.bare');
allowed('git config --file ~/.gitconfig --comment note --get user.name');
allowed('git config get --file ~/.gitconfig --value x user.name');
allowed('git config get --file ~/.gitconfig --url https://example.com http.proxy');
allowed('git config --file ./local.cfg a.b c');
allowed('git config -f .gitmodules submodule.x.url https://example.com/x.git');

console.log('\nevery key whose value git runs, set with git config or inline:');
for (const [key, value] of [
  ['core.gitProxy', '/opt/evil'], ['core.askPass', '/opt/evil'], ['core.alternateRefsCommand', "'rm -rf ~'"],
  ['credential.https://example.com.helper', "'!rm -rf ~'"], ['diff.foo.textconv', "'rm -rf ~'"],
  ['difftool.x.cmd', "'rm -rf ~'"], ['difftool.x.path', '/opt/evil'], ['mergetool.x.cmd', "'rm -rf ~'"],
  ['mergetool.x.path', '/opt/evil'], ['man.x.cmd', "'rm -rf ~'"], ['man.x.path', '/opt/evil'],
  ['browser.x.cmd', "'rm -rf ~'"], ['browser.x.path', '/opt/evil'], ['guitool.x.cmd', "'rm -rf ~'"],
  ['gpg.program', '/opt/evil'], ['gpg.ssh.program', '/opt/evil'], ['gpg.ssh.defaultKeyCommand', "'rm -rf ~'"],
  ['remote.origin.uploadpack', "'rm -rf ~'"], ['remote.origin.receivepack', "'rm -rf ~'"], ['remote.origin.vcs', 'evil'],
  ['tar.tgz.command', "'rm -rf ~'"], ['trailer.x.command', "'rm -rf ~'"], ['trailer.x.cmd', "'rm -rf ~'"],
  ['sendemail.toCmd', "'rm -rf ~'"], ['sendemail.work.ccCmd', "'rm -rf ~'"], ['sendemail.headerCmd', "'rm -rf ~'"],
  ['sendemail.sendmailCmd', "'rm -rf ~'"], ['sendemail.smtpServer', '/opt/evil'], ['sequence.editor', "'rm -rf ~'"],
  ['gc.recentObjectsHook', "'rm -rf ~'"], ['imap.tunnel', "'rm -rf ~'"], ['instaweb.httpd', "'rm -rf ~'"],
  ['interactive.diffFilter', "'rm -rf ~'"], ['uploadpack.packObjectsHook', "'rm -rf ~'"], ['init.templateDir', '/opt/evil'],
  ['pager.log', "'rm -rf ~'"], ['submodule.x.update', "'!rm -rf ~'"], ['protocol.ext.allow', 'always'],
  ['protocol.allow', 'user'], ['include.path', '/opt/evil.cfg'], ['includeIf.gitdir:/x/.path', '/opt/evil.cfg'],
]) {
  denied(`git config ${key} ${value}`, KEY);
}
denied("git -c pager.log='rm -rf ~' log", /inline config override/);
denied('git -c protocol.ext.allow=always fetch', /inline config override/);
denied('git --config-env alias.x=EVIL x', /inline config override/);
denied('git --config-env=pager.log=PAGER log', /inline config override/);
denied('git --config-env submodule.x.update=CMD submodule update', /inline config override/);
denied('git config --rename-section x pager', /rename/);
denied('git config rename-section x remote.origin', /rename/);
allowed('git config pager.branch false');
allowed('git config pager.log 0');
allowed('git config pager.log False');
allowed('git config submodule.x.update rebase');
allowed('git config sendemail.smtpServer smtp.example.com');
allowed('git config protocol.ext.allow never');
allowed('git config protocol.file.allow always');
allowed('git config remote.origin.url https://example.com/x.git');
allowed('git config gpg.format ssh');
allowed('git config core.autocrlf input');
allowed('git -c pager.log=false log');
allowed('git -c pager.log log');
allowed('git config --rename-section branch.old branch.new');

console.log('\na short-option cluster is read letter by letter:');
denied('git config -zf ~/.ssh/config --list', READ);
denied('git config -lf ~/.ssh/config', READ);
denied('git grep -if ~/.ssh/id_rsa x', READ);
denied('git grep -Ff ~/.ssh/id_rsa', READ);
denied('git grep --file ~/.ssh/id_rsa x', READ);
allowed('git grep -e -f x');
allowed('git grep -n -e foo');
allowed('git grep -m5 foo');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
