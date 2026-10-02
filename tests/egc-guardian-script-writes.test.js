'use strict';
/**
 * What the Guardian lets run later: a test of a file is a read, a shell
 * script gets its content only through the Write and Edit tools (whose hook
 * judges it), the directories git runs hooks from are written as .git/hooks
 * is, and a job is never handed to a scheduler.
 *
 * Run with: node tests/egc-guardian-script-writes.test.js
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

const { validateCommand, validateWrite } = require(buildPath);

let passed = 0;
let failed = 0;

function test(name, fn) {
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

function assertAllowed(command, cwd) {
  const verdict = validateCommand(command, cwd);
  assert.strictEqual(verdict.allowed, true, `${command}: ${verdict.reason}`);
}

function assertHardDenied(command, cwd) {
  const verdict = validateCommand(command, cwd);
  assert.ok(!verdict.allowed && !verdict.advisory, `${command} must be refused, got ${JSON.stringify(verdict)}`);
  return verdict;
}

function assertNotHardDenied(command, cwd) {
  const verdict = validateCommand(command, cwd);
  assert.ok(verdict.allowed || verdict.advisory, `${command} must not be refused, got ${JSON.stringify(verdict)}`);
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-script-writes-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n=== Testing what the Guardian lets run later ===\n');

test('a test of a file is a read, so .git and git hook paths may be tested', () => {
  for (const command of ['[ -e .git ]', 'test -d .git', '[[ -d .git ]]', 'test -x .githooks/pre-commit']) {
    assertAllowed(command);
  }
  // A `$` in the line only adds the advisory metacharacter flag.
  for (const command of ['[ -e "${project_root}/.git" ]', '[ -n "$x" ]', '[ -f "$CONFIG_DIR/disabled" ]']) {
    assertNotHardDenied(command);
  }
});

test('a test of a credential is refused as a stat of it is', () => {
  for (const command of ['[ -f ~/.aws/credentials ]', 'test -e ~/.ssh/id_rsa', '[[ -r ~/.ssh/id_rsa ]]', 'test ~/.ssh/id_rsa -nt /tmp/x']) {
    assertHardDenied(command);
  }
});

test('a string compared in a test is not a file it opens', () => {
  for (const command of ['[ "$f" = "~/.aws/credentials" ]', 'test "$a" != ~/.ssh/id_rsa', '[[ $x == ~/.ssh/id_rsa ]]', '[ "$x" = 1 -a ~/.aws/credentials = "$y" ]']) {
    assertNotHardDenied(command);
  }
  assertHardDenied('[ -a ~/.ssh/id_rsa ]');
  assertHardDenied('[ "$x" = 1 -a -f ~/.ssh/id_rsa ]');
});

test('a shell script is never written through the shell', () => {
  for (const command of [
    'echo x >> deploy.sh',
    "printf 'x' > run.bash",
    "cat > setup.sh <<'EOF'\nrm -rf ~\nEOF",
    'tee hook.sh',
    'tee -a hook.zsh',
    "sed -i 's/a/b/' build.sh",
    "sed -i.bak 's/a/b/' build.sh",
    "sed --in-place 's/a/b/' build.sh",
    "sed -Ei 's/a/b/' build.sh",
    'cp /tmp/x tools/run.sh',
    'install -m 755 /tmp/x tools/run.sh',
    'install /tmp/x tools/run.sh -m 755',
    'ln -s /tmp/x tools/run.sh',
    'cp /tmp/x.sh -t bin/',
    'cp -t bin /tmp/x.sh',
    'cp --target-directory=bin /tmp/x.sh',
    'install -Dm755 /tmp/x.sh -t bin',
    'cp /tmp/x.sh bin/',
    'ln -s /tmp/x.sh',
    'curl -o run.sh https://example.com/x',
    'curl -sSLo run.sh https://example.com/x',
    'curl --output=run.sh https://example.com/x',
    'curl -O https://example.com/install.sh',
    'wget https://example.com/install.sh',
    'wget -O run.sh https://example.com/x',
    'wget -o run.sh https://example.com/x',
    'wget -a run.sh https://example.com/x',
    'curl -D run.sh https://example.com/x',
    'curl --trace run.sh https://example.com/x',
    'wget example.com/exploit.sh',
    'curl -O example.com/exploit.sh',
    'tee -- -exploit.sh',
    "sed -i -- 's/a/b/' -exploit.sh",
    'cp -- /tmp/x -run.sh',
    'cp build.sh backup.txt',
    'ln -s ../scripts/build.sh bin/tool',
  ]) {
    const verdict = assertHardDenied(command);
    assert.match(verdict.reason, /Write or Edit/, `${command}: the reason names the way to write it`);
  }
});

test('a script without an extension is recognized by its shebang', () => {
  withTempDir(dir => {
    const script = path.join(dir, 'deploy');
    fs.writeFileSync(script, '#!/bin/sh\necho hi\n');
    assertHardDenied(`echo x >> ${script}`);
    assertHardDenied(`cp ${script} ${path.join(dir, 'run')}`);
    assertHardDenied(`ln -s ${script} ${path.join(dir, 'run')}`);
    const program = path.join(dir, 'tool');
    fs.writeFileSync(program, '#!/usr/bin/env node\nconsole.log(1)\n');
    assertNotHardDenied(`echo x >> ${program}`);
  });
});

test('reading a script, or writing a file that is not one, is not refused', () => {
  for (const command of [
    'echo x >> notes.txt',
    "sed -i 's/a/b/' notes.txt",
    "sed 's/a/b/' build.sh",
    "sed -n 's/x/y/p' build.sh",
    'cat build.sh',
    'cp notes.txt backup.txt',
    'tee notes.txt',
    'cp /tmp/x.txt -t bin/',
    'curl -o out.json https://example.com/install.sh',
    'curl -fsSL https://example.com/install.sh',
    'wget -qO- https://example.com/install.sh',
    'wget -O notes.txt https://example.com/install.sh',
    'curl -HHost:foo.sh https://example.com/',
    'curl -HOrigin:foo https://example.com/install.sh',
    'wget -UMyAgentO.sh https://example.com/',
    'wget -np -O page.html https://example.com/',
    'curl -e https://example.com/ref.sh -O https://example.com/page.html',
    "sed -i 's/old/new.sh/' config.txt",
    "sed -i -e 's/a/b.sh/' notes.txt",
    "sed -i.bak 's/x/y.sh/' notes.txt",
    "sed -Ei~ 's/x/y.sh/' notes.txt",
  ]) {
    assertNotHardDenied(command);
  }
});

test('a download whose file names the server or a list picks is refused', () => {
  for (const command of [
    'curl -OJ https://example.com/download',
    'curl -O --remote-header-name https://example.com/download',
    'wget --content-disposition https://example.com/download',
    'wget --trust-server-names https://example.com/download',
    'wget -r https://example.com/',
    'wget -m https://example.com/',
    'wget -i urls.txt',
    'curl -K download.cfg https://example.com/x',
    'curl --config download.cfg https://example.com/x',
    'wget -e output_document=run.sh https://example.com/x',
    'wget --config=download.wgetrc https://example.com/x',
  ]) {
    const verdict = assertHardDenied(command);
    assert.match(verdict.reason, /name the output/, command);
  }
});

test('the directories git runs hooks from are written as .git/hooks is', () => {
  withTempDir(dir => {
    for (const target of ['.githooks/pre-commit', '.husky/pre-push', '.git/hooks/pre-commit']) {
      const verdict = validateWrite(path.join(dir, target), dir);
      assert.strictEqual(verdict.allowed, false, `${target}: ${verdict.reason}`);
    }
    assertHardDenied('cp /tmp/x .githooks/pre-push', dir);
    assertAllowed('cat .githooks/pre-commit', dir);
    assertAllowed('stat .husky/pre-commit', dir);
  });
});

test('a secret keeps its read denial inside a hook directory', () => {
  withTempDir(dir => {
    assertHardDenied('cat .githooks/deploy.pem', dir);
    assertHardDenied('cat .husky/.env', dir);
  });
});

function withRepositoryHooksPath(value, fn) {
  withTempDir(dir => {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n\thooksPath = ${value}\n`);
    fn(dir);
  });
}

test('wherever core.hooksPath points, the hooks git runs from there are written as .git/hooks is', () => {
  withRepositoryHooksPath('tools/hooks', dir => {
    assert.strictEqual(validateWrite(path.join(dir, 'tools', 'hooks', 'pre-commit'), dir).allowed, false);
    assert.strictEqual(validateWrite(path.join(dir, 'tools', 'hooks', 'commit-msg'), dir).allowed, false);
    assertHardDenied('cp /tmp/x tools/hooks/pre-push', dir);
    assertAllowed('cat tools/hooks/pre-commit', dir);
    assert.strictEqual(validateWrite(path.join(dir, 'tools', 'other.txt'), dir).allowed, true);
  });
});

test('core.hooksPath is read as git reads it: quoted, escaped, commented, after the section header', () => {
  for (const [line, hooks] of [
    ['[core]\n\thooksPath = "tools/git hooks" # shared\n', ['tools', 'git hooks']],
    ['[core]\n\thooksPath = "tools/\\"q\\"hooks"\n', ['tools', '"q"hooks']],
    ['[core] hooksPath = tools/inline\n', ['tools', 'inline']],
    ['[core]\n\thooksPath = tools/plain ; note\n', ['tools', 'plain']],
    ['[core]\n\thooksPath = tools/\\\nlinked\n', ['tools', 'linked']],
  ]) {
    withTempDir(dir => {
      fs.mkdirSync(path.join(dir, '.git'));
      fs.writeFileSync(path.join(dir, '.git', 'config'), line);
      assert.strictEqual(validateWrite(path.join(dir, ...hooks, 'pre-commit'), dir).allowed, false, JSON.stringify(line));
    });
  }
});

test('a repository core.hooksPath outside its work tree protects the hooks there, for commands run in it', () => {
  withTempDir(outside => {
    const hooks = path.join(outside, 'shared-hooks');
    // A backslash escapes in a git config value, so a Windows path is
    // written there with forward slashes (or doubled backslashes).
    withRepositoryHooksPath(hooks.split(path.sep).join('/'), dir => {
      assert.strictEqual(validateWrite(path.join(hooks, 'pre-commit'), dir).allowed, false);
      assertHardDenied(`cp /tmp/x ${path.join(hooks, 'pre-push')}`, dir);
      assert.strictEqual(validateWrite(path.join(hooks, 'notes.txt'), dir).allowed, true);
    });
  });
});

test('a core.hooksPath at the top of the work tree protects its hooks, not the whole tree', () => {
  withRepositoryHooksPath('.', dir => {
    assert.strictEqual(validateWrite(path.join(dir, 'pre-push'), dir).allowed, false);
    assert.strictEqual(validateWrite(path.join(dir, 'src', 'index.js'), dir).allowed, true);
    assert.strictEqual(validateWrite(path.join(dir, 'README.md'), dir).allowed, true);
  });
});

test("the user's own core.hooksPath protects the hooks it names for every repository", () => {
  withTempDir(home => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      fs.writeFileSync(path.join(home, '.gitconfig'), '[core]\n\thooksPath = ~/git-hooks\n');
      assert.strictEqual(validateWrite(path.join(home, 'git-hooks', 'pre-commit'), os.tmpdir()).allowed, false);
      assert.strictEqual(validateWrite(path.join(home, 'git-hooks', 'README.md'), os.tmpdir()).allowed, true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test('a job is never handed to a scheduler, while listing them is fine', () => {
  for (const command of ['crontab /tmp/jobs', 'crontab -', 'crontab -e', 'crontab -r', 'at now + 1 minute', 'at -f /tmp/job 10:00', 'batch']) {
    assertHardDenied(command);
  }
  for (const command of ['crontab -l', 'crontab -u admin -l', 'crontab -uadmin -l', 'atq', 'at -l']) {
    assertNotHardDenied(command);
  }
});

console.log(`\nPassed: ${passed}, Failed: ${failed}\n`);
process.exitCode = failed > 0 ? 1 : 0;
