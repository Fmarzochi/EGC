'use strict';
/**
 * A command read out of a script committed in git and unchanged since is
 * project code: the Guardian holds it to the grave denials (writing or
 * deleting protected or top-level paths, git and container overrides), while
 * the rules that exist only to keep a command from hiding (eval, -c, reading
 * a protected file) flag it instead of blocking it. A command typed by the
 * agent keeps every rule.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'validator.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

const { validateCommand, validateCommittedScriptCommand } = require(path.join(buildDir, 'validator.js'));

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-committed-'));
const blocks = verdict => verdict.allowed === false && verdict.advisory !== true;
const wipe = ['rm', '-rf'].join(' ');

console.log('\n=== Testing commands from a committed script ===\n');

run('the rules that stop a command from hiding flag it in a committed script', () => {
  for (const command of [
    'eval "set -- $(printf %s x)"',
    'sh -c :',
    'bash -ec "echo hi"',
    'python3 -c "print(1)"',
    'node -e "console.log(1)"',
  ]) {
    const verdict = validateCommittedScriptCommand(command, cwd);
    assert.strictEqual(verdict.allowed, false, command);
    assert.strictEqual(verdict.advisory, true, `${command}: ${JSON.stringify(verdict)}`);
    assert.ok(verdict.reason.includes('committed in git'), verdict.reason);
  }
});

run('a delete or move is flagged only when its target is known to be narrow', () => {
  const flagged = [
    [`${wipe} build`],
    ['rm -f conftest*'],
    ['rm -f *.o'],
    [`${wipe} build/*`],
    [`${wipe} ./dist/cache`],
    ['mv build/a build/b'],
    ['dd if=/dev/zero of=disk.img bs=1M count=1'],
    ['truncate -s0 log.txt'],
    [`${wipe} ${JSON.stringify(path.join(os.tmpdir(), 'egc-work'))}`],
    [`${wipe} ~/.cache/egc`],
    [`${wipe} "$tmp"`, { tmp: ['$(mktemp -d)'] }],
    ['rm -f "$wrapperJarPath"', { wrapperJarPath: ['$MAVEN_PROJECTBASEDIR/.mvn/wrapper/maven-wrapper.jar'] }],
    [`${wipe} "\${BUILD}/out"`, { BUILD: ['build'] }],
    // A path below another variable the script sets is judged with that
    // variable's own values, down the chain.
    [`${wipe} "$out"`, { out: ['$BUILD/cache'], BUILD: ['build'] }],
    ['rm -f "$f"', { f: ['$(mktemp -d)/work/file'] }],
    ['rm -f "$f"', { f: ['$APP_HOME/bin/startup.sh'] }],
    ['rm -f "$jar"', { jar: ['$BASE/.mvn/wrapper/maven-wrapper.jar'], BASE: ['$(cd "$(dirname "$0")" && pwd)'] }],
  ];
  for (const [command, bound] of flagged) {
    const verdict = validateCommittedScriptCommand(command, cwd, bound);
    assert.strictEqual(verdict.advisory, true, `${command}: ${JSON.stringify(verdict)}`);
  }
});

run('a delete or move whose target is broad, protected, top-level or chosen outside the script is grave', () => {
  for (const command of [
    `${wipe} /`, `${wipe} /*`, `${wipe} ~`, `${wipe} ~/`, `${wipe} "$HOME"`, `${wipe} \${HOME}/*`, `${wipe} /usr`, `${wipe} /usr/{bin,lib}`,
    `${wipe} ~/.ssh`, `${wipe} ~/projects`, `${wipe} ~/.*`, `${wipe} "$HOME"/.*`, `${wipe} ~/*/`, `${wipe} ~/[a-z]*`, `${wipe} ~/.[!.]*`,
    `${wipe} "\${HOME:?}"`, `${wipe} ~someone`, `${wipe} ~someone/`, 'mv notes ~/.bashrc', 'dd if=/dev/zero of=/etc/passwd', 'dd of=/dev/sda',
    'shred /dev/sda', 'truncate -s0 /dev/sda', `${wipe} build /`, `${wipe} -- *`, `${wipe} .`, `${wipe} ..`, `${wipe} ../x`, `${wipe} [a-z]*`,
    `${wipe} "$1"`, `${wipe} "$@"`, `${wipe} \${1}`, `${wipe} "$tmp"`, `${wipe} "$T"`, `${wipe} "\${ROOT:-/}"`, `${wipe} "$PWD"/*`, `${wipe} "$(pwd)"`,
    'rm -f "$wrapperJarPath"', `${wipe} /opt/app`,
    "su -c 'rm -rf ~' root", "script -qc 'rm -rf /' /dev/null",
  ]) {
    assert.ok(blocks(validateCommittedScriptCommand(command, cwd)), command);
  }
  for (const bound of [{ other: ['build'] }, { tmp: ['/usr'] }, { tmp: ['${tmp:-build}'] }, { tmp: ['build', '/'] }, { tmp: ['$BASE/x'] }, { tmp: [] }]) {
    assert.ok(blocks(validateCommittedScriptCommand(`${wipe} "$tmp"`, cwd, bound)), `a variable set to something not narrow: ${JSON.stringify(bound)}`);
  }
  // A chain of variables the script sets resolves to what it names, and a
  // start only known when the script runs cannot make a protected end narrow.
  for (const bound of [
    { tmp: ['$BASE/etc/passwd'], BASE: ['/'] },
    { tmp: ['$BASE/etc/passwd'], BASE: [''] },
    { tmp: ['${BASE}/etc/passwd'], BASE: ['$ROOT'], ROOT: ['/'] },
    { tmp: ['$BASE/etc/passwd'] },
    { tmp: ['$(cd ~ && pwd)/.ssh/id_rsa'] },
    { tmp: ['$A/x/y'], A: ['$B'], B: ['$A'] },
    // A fresh temporary directory is narrow, not a path that climbs out of it.
    { tmp: ['$(mktemp -d)/../../../../etc/passwd'] },
    { tmp: ['$(mktemp -d)/$NAME'] },
    // A chain deeper than this check follows is not read to its end.
    { tmp: ['$V1/x'], V1: ['$V2'], V2: ['$V3'], V3: ['$V4'], V4: ['$V5'], V5: ['build'] },
  ]) {
    assert.ok(blocks(validateCommittedScriptCommand(`rm -f "$tmp"`, cwd, bound)), `a chain that reaches a grave target: ${JSON.stringify(bound)}`);
  }
});

run('the home directory and every directory above it are grave wherever home lives', () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const users = path.join(cwd, 'deep', 'users');
  process.env.HOME = path.join(users, 'me');
  process.env.USERPROFILE = process.env.HOME;
  try {
    for (const target of [path.join(cwd, 'deep'), users, process.env.HOME]) {
      assert.ok(blocks(validateCommittedScriptCommand(`${wipe} ${JSON.stringify(target)}`, cwd)), target);
    }
    // A home under a temporary directory is still held to the home rule.
    for (const command of [`${wipe} ~/[a-z]*`, `${wipe} ~/projects`, `${wipe} ~/*`]) {
      assert.ok(blocks(validateCommittedScriptCommand(command, cwd)), command);
    }
    assert.strictEqual(validateCommittedScriptCommand(`${wipe} ~/.cache/egc`, cwd).advisory, true);
    assert.strictEqual(validateCommittedScriptCommand(`${wipe} ${JSON.stringify(path.join(cwd, 'other'))}`, cwd).advisory, true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

run('reading a protected file is flagged, writing over one is still blocked', () => {
  for (const command of [
    '[ -f /etc/mavenrc ]',
    '. /etc/mavenrc',
    'source ~/.bashrc',
    'test -r /etc/gentoo-release',
    'cat /etc/papersize',
    'grep -v "^#" /etc/sysctl.conf',
    'read -r id < /etc/machine-id',
  ]) {
    const verdict = validateCommittedScriptCommand(command, cwd);
    assert.strictEqual(verdict.advisory, true, `${command}: ${JSON.stringify(verdict)}`);
  }
  for (const command of [
    'echo x > ~/.bashrc',
    'cat notes >> ~/.ssh/authorized_keys',
    'mktemp -d ~/.ssh/tmp.XXXXXX',
    'eval "set -- x" > ~/.bashrc',
    'python3 -c "print(1)" > ~/.profile',
    `${wipe} build > ~/.bashrc`,
  ]) {
    assert.ok(blocks(validateCommittedScriptCommand(command, cwd)), command);
  }
});

run('find runs what -exec names under the same rules, from a narrow starting point only', () => {
  for (const command of ["find build -name '*.o' -delete", "find build -name '*.pyc' -exec rm {} +", "find src -type f -exec chmod 644 {} ;", 'find . -fprint list.txt']) {
    const verdict = validateCommittedScriptCommand(command, cwd);
    assert.strictEqual(verdict.advisory, true, `${command}: ${JSON.stringify(verdict)}`);
  }
  for (const command of [
    `find build -exec ${wipe} ~ ;`, 'find ~/.ssh -delete', 'find / -delete', 'find build -exec mv {} ~/.bashrc ;', 'find . -fprint ~/.bashrc',
    'find . -delete', 'find -delete', "find . -name '*' -delete", 'find . -type f -delete', 'find .. -mindepth 1 -delete', "find . -name '*.pyc' -exec rm {} +",
  ]) {
    assert.ok(blocks(validateCommittedScriptCommand(command, cwd)), command);
  }
});

run('a quoted < is an argument, not a redirection: the path after it is still checked', () => {
  for (const command of ["tee '<' ~/.bashrc", "cp '<' ~/.ssh/id_rsa /tmp/", "tar czf /tmp/k.tgz '<' ~/.ssh", "cp x '0<' ~/.bashrc"]) {
    assert.ok(blocks(validateCommand(command, cwd)), `typed: ${command}`);
    assert.ok(blocks(validateCommittedScriptCommand(command, cwd)), `committed: ${command}`);
  }
});

run('the grave denials hold in a committed script', () => {
  for (const command of [
    'git push --force origin main',
    'git config core.hooksPath /tmp/hooks',
    'docker run --privileged -v /:/host alpine',
    'docker system prune -af',
    'GIT_CONFIG_PARAMETERS="core.hooksPath=/tmp" git status',
  ]) {
    assert.ok(blocks(validateCommittedScriptCommand(command, cwd)), command);
  }
});

run('a typed command keeps every rule, before and after a committed one is judged', () => {
  for (const command of ['eval "set -- x"', 'sh -c :', `${wipe} build`, '[ -f /etc/mavenrc ]', 'find . -exec rm {} +']) {
    assert.ok(blocks(validateCommand(command, cwd)), command);
    validateCommittedScriptCommand(command, cwd);
    assert.ok(blocks(validateCommand(command, cwd)), `${command} after a committed check`);
  }
});

run('an allowed command stays allowed and an ordinary advisory stays one', () => {
  assert.strictEqual(validateCommittedScriptCommand('git status', cwd).allowed, true);
  const advisory = validateCommittedScriptCommand('some-unknown-tool --flag', cwd);
  assert.strictEqual(advisory.advisory, true, JSON.stringify(advisory));
});

run('the command-batch CLI judges an entry marked committed as one, and anything else as typed', () => {
  const { spawnSync } = require('node:child_process');
  const cli = path.join(buildDir, 'guardian-cli.js');
  const batch = payload => JSON.parse(spawnSync(process.execPath, [cli, 'command-batch'], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 20000 }).stdout);
  const commands = ['eval "set -- x"', 'eval "set -- x"', 'eval "set -- x"', 'eval "set -- x"'];
  const verdicts = batch({ commands, cwd, committed: [true, false, 'true', 1] });
  assert.strictEqual(verdicts.length, 4);
  assert.strictEqual(verdicts[0].advisory, true, JSON.stringify(verdicts[0]));
  for (const verdict of verdicts.slice(1)) assert.ok(blocks(verdict), JSON.stringify(verdict));
  const shifted = batch({ commands: [7, 'eval "set -- x"'], cwd, committed: [false, true] });
  assert.strictEqual(shifted.length, 1);
  assert.strictEqual(shifted[0].advisory, true, 'a flag stays with its own command when an entry is dropped');
  assert.ok(blocks(batch({ commands: ['eval "set -- x"'], cwd })[0]), 'no flags: typed');
  const marked = batch({ commands: [`${wipe} "$tmp"`, `${wipe} "$tmp"`], cwd, committed: [{ bound: { tmp: ['$(mktemp -d)'] } }, { bound: { tmp: ['/'] } }] });
  assert.strictEqual(marked[0].advisory, true, `a variable the committed script sets narrowly: ${JSON.stringify(marked[0])}`);
  assert.ok(blocks(marked[1]), 'a variable the committed script sets to the root');
  const malformed = [{ bound: null }, { bound: { tmp: 'x' } }, {}, { bound: { tmp: [1] } }, { bound: [] }];
  const judged = batch({ commands: malformed.map(() => 'eval "set -- x"'), cwd, committed: malformed });
  for (const [i, verdict] of judged.entries()) assert.ok(blocks(verdict), `a malformed marker is judged as typed: ${JSON.stringify(malformed[i])}`);
  assert.ok(blocks(batch(['eval "set -- x"'])[0]), 'legacy array: typed');
});

fs.rmSync(cwd, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
