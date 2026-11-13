/**
 * Tests for GitBackend: what a push ships to the shared repository. The
 * memory database under ~/.egc/memory never leaves the machine (an older
 * version mirrored it into the sync checkout in the clear), and the guards
 * before init() hold. Runs against the built memory server modules.
 */
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const BUILD = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build');

// Fixed git locations before a PATH lookup.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

// GitBackend reads the home directory when it pushes, so the suite runs with
// a home of its own: the real ~/.egc/memory is never read, touched or shipped.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-gitbackend-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result
        .then(() => {
          console.log(`  ✓ ${name}`);
          return true;
        })
        .catch(error => {
          console.log(`  ✗ ${name}`);
          console.log(`    Error: ${error.message}`);
          return false;
        });
    }
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function git(args, cwd) {
  return execFileSync(GIT_BIN, args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

// Every path committed on `branch` of a bare remote, or nothing when the
// branch does not exist yet.
function remoteTree(remote, branch) {
  try {
    return git(['ls-tree', '-r', '--name-only', branch], remote).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// A backend initialized against a bare remote of its own, ready to push.
async function pushingBackend(GitBackend, tempBase, name) {
  const remote = path.join(tempBase, `${name}-remote.git`);
  git(['init', '--bare', remote], tempBase);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  const repoDir = path.join(tempBase, `${name}-repo`);
  const backend = new GitBackend(repoDir);
  await backend.init({ backend: 'git', remote, branch: 'main' });
  return { backend, repoDir, remote };
}

function stageOneEnvelope(repoDir) {
  fs.mkdirSync(path.join(repoDir, 'state', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'state', 'proj', 'main.md'), '{"egcTeamEnvelope":2}\n');
}

async function runTests() {
  console.log('\n=== Testing GitBackend team sync ===\n');

  let GitBackend;
  const buildFile = path.join(BUILD, 'sync', 'GitBackend.js');
  if (!fs.existsSync(buildFile)) {
    console.error(`[SKIP] GitBackend build not found at ${buildFile}. Run 'npm run build' in mcp/servers/egc-memory first.`);
    process.exit(0);
  }
  const mod = await import(pathToFileURL(buildFile).href);
  GitBackend = mod.GitBackend;
  const { gitEnvironment } = await import(pathToFileURL(path.join(BUILD, 'sync', 'git-env.js')).href);

  let passed = 0;
  let failed = 0;
  const run = async (name, fn) => {
    if (await test(name, fn)) passed++; else failed++;
  };
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-gitbackend-test-'));

  try {
    await run('push never ships the memory database: ~/.egc/memory stays out of the shared repository', async () => {
      const memoryDir = path.join(HOME, '.egc', 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, 'state.db'), 'sqlite bytes that must stay on this machine');
      const { backend, repoDir, remote } = await pushingBackend(GitBackend, tempBase, 'ships');
      stageOneEnvelope(repoDir);
      assert.strictEqual(await backend.push(), true, 'the staged state is pushed');
      assert.ok(!fs.existsSync(path.join(repoDir, 'memory')), 'no memory/ tree is written into the sync checkout');
      const tree = remoteTree(remote, 'main');
      assert.deepStrictEqual(tree.filter(p => p.startsWith('memory/')), [], `nothing under memory/ reaches the remote, got: ${tree.join(', ')}`);
      assert.ok(tree.includes('state/proj/main.md'), 'the state envelope does reach the remote');
      assert.ok(fs.existsSync(path.join(memoryDir, 'state.db')), 'the local database is untouched');
      await backend.destroy();
    });

    await run('push retires a memory/ tree an older version left in the sync checkout, and the commit removes it from the shared repository', async () => {
      const { backend, repoDir, remote } = await pushingBackend(GitBackend, tempBase, 'retires');
      // What a push before this change left behind: the database mirrored
      // into the checkout in the clear and committed to the shared repository.
      fs.mkdirSync(path.join(repoDir, 'memory'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'memory', 'state.db'), 'mirrored in the clear by an older version');
      git(['add', '-A'], repoDir);
      git(['-c', 'user.name=older', '-c', 'user.email=older@egc.local', 'commit', '-q', '-m', 'sync: team memory update from older'], repoDir);
      git(['push', '-q', 'origin', 'main'], repoDir);
      assert.ok(remoteTree(remote, 'main').includes('memory/state.db'), 'precondition: the old mirror is in the remote');
      stageOneEnvelope(repoDir);
      assert.strictEqual(await backend.push(), true, 'the push commits the retirement and the new state');
      assert.ok(!fs.existsSync(path.join(repoDir, 'memory')), 'the old memory/ tree leaves the checkout');
      const tree = remoteTree(remote, 'main');
      assert.deepStrictEqual(tree.filter(p => p.startsWith('memory/')), [], `the commit removes memory/ from the remote, got: ${tree.join(', ')}`);
      assert.ok(tree.includes('state/proj/main.md'));
      await backend.destroy();
    });

    await run('push sweeps the temporaries an interrupted old mirror left beside memory/, so none of them is committed', async () => {
      const { backend, repoDir, remote } = await pushingBackend(GitBackend, tempBase, 'sweeps');
      for (const name of ['.tmp-sync-memory-1-ab', '.tmp-old-memory-1-cd', 'memory']) {
        fs.mkdirSync(path.join(repoDir, name), { recursive: true });
        fs.writeFileSync(path.join(repoDir, name, 'state.db'), `left by an interrupted mirror in ${name}`);
      }
      stageOneEnvelope(repoDir);
      assert.strictEqual(await backend.push(), true, 'the push still goes through');
      const left = fs.readdirSync(repoDir).filter(entry => entry === 'memory' || entry.startsWith('.tmp-sync-memory-') || entry.startsWith('.tmp-old-memory-'));
      assert.deepStrictEqual(left, [], 'the mirror and its temporaries leave the checkout');
      const tree = remoteTree(remote, 'main');
      assert.deepStrictEqual(tree.filter(p => p.startsWith('memory/') || p.startsWith('.tmp-')), [], `nothing of the mirror reaches the remote, got: ${tree.join(', ')}`);
      assert.ok(tree.includes('state/proj/main.md'));
      await backend.destroy();
    });

    await run('GitBackend guards against operations before init', async () => {
      const repoDir = path.join(tempBase, 'repo-guards');
      const backend = new GitBackend(repoDir);

      await assert.rejects(async () => backend.status(), /GitBackend not initialized/);
      await assert.rejects(async () => backend.pull(), /GitBackend not initialized/);
      await assert.rejects(async () => backend.push(), /GitBackend not initialized/);

      await backend.destroy();
      await assert.rejects(async () => backend.status(), /GitBackend not initialized/);
    });

    await run('init refuses a remote it cannot read and names the reason, instead of swallowing the failed pull', async () => {
      const backend = new GitBackend(path.join(tempBase, 'repo-unreachable'));
      await assert.rejects(
        () => backend.init({ backend: 'git', remote: path.join(tempBase, 'no-such-remote.git'), branch: 'main' }),
        /cannot be read: \S/,
      );
      await backend.destroy();
    });

    await run('the git the backend runs never waits for a terminal: prompts off, ssh in batch mode, the choices of the person kept', async () => {
      const bare = { PATH: '/usr/bin' };
      assert.deepStrictEqual(gitEnvironment(bare, null), { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' });
      assert.strictEqual(gitEnvironment(bare, 'ssh -i ~/.ssh/team_key').GIT_SSH_COMMAND, 'ssh -i ~/.ssh/team_key -oBatchMode=yes', 'a configured core.sshCommand keeps its flags');
      const own = gitEnvironment({ ...bare, GIT_TERMINAL_PROMPT: '1', GIT_SSH_COMMAND: 'my-ssh' }, 'ssh -i key');
      assert.strictEqual(own.GIT_TERMINAL_PROMPT, '1', 'a prompt setting of the person is kept');
      assert.strictEqual(own.GIT_SSH_COMMAND, 'my-ssh', 'an ssh command of the person is kept as it is');
      const legacy = gitEnvironment({ ...bare, GIT_SSH: '/usr/bin/plink', GIT_SSH_VARIANT: 'plink' }, null);
      assert.strictEqual(legacy.GIT_SSH, '/usr/bin/plink');
      assert.strictEqual(legacy.GIT_SSH_VARIANT, 'plink', 'the variant travels with GIT_SSH');
      assert.strictEqual(legacy.GIT_SSH_COMMAND, undefined, 'GIT_SSH is a choice of the person too');
      // git runs a configured core.sshCommand even when GIT_SSH is set, so
      // that is the command the flag goes on.
      assert.strictEqual(gitEnvironment({ ...bare, GIT_SSH: '/usr/bin/plink' }, 'ssh -i team_key').GIT_SSH_COMMAND, 'ssh -i team_key -oBatchMode=yes');
      // What simple-git guards never reaches git from the server, as before.
      const guarded = gitEnvironment({ ...bare, HOME: '/home/me', EDITOR: 'vim', Pager: 'less', GIT_CONFIG_GLOBAL: '/x', GIT_ASKPASS: '/y', SSH_ASKPASS_REQUIRE: 'force' }, null);
      assert.deepStrictEqual(Object.keys(guarded).sort(), ['GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT', 'HOME', 'PATH']);
      // Windows keeps the case a variable was set with; the three are read
      // in any case and forwarded under their canonical name.
      const mixed = gitEnvironment({ ...bare, git_ssh_command: 'my-ssh', Git_Terminal_Prompt: '1' }, null);
      assert.deepStrictEqual(mixed, { PATH: '/usr/bin', GIT_SSH_COMMAND: 'my-ssh', GIT_TERMINAL_PROMPT: '1' });
      // PuTTY's plink refuses the OpenSSH spelling of the batch flag.
      assert.strictEqual(gitEnvironment(bare, '"C:\\Program Files\\PuTTY\\plink.exe" -i key.ppk').GIT_SSH_COMMAND, '"C:\\Program Files\\PuTTY\\plink.exe" -i key.ppk -batch');
      assert.strictEqual(gitEnvironment(bare, 'tortoiseplink.exe').GIT_SSH_COMMAND, 'tortoiseplink.exe -batch');
      assert.strictEqual(gitEnvironment(bare, "'/opt/putty/plink' -l me").GIT_SSH_COMMAND, "'/opt/putty/plink' -l me -batch", 'a single-quoted executable is read too');
      assert.deepStrictEqual(bare, { PATH: '/usr/bin' }, 'the environment given is not changed');
    });

    await run('init against an ssh remote runs ssh in batch mode and fails at once with the reason instead of waiting for a prompt', async () => {
      // An ssh that records how git called it and answers the way a host
      // whose key is unknown answers in batch mode.
      const fakeBin = path.join(tempBase, 'fake-ssh-bin');
      fs.mkdirSync(fakeBin, { recursive: true });
      const log = path.join(tempBase, 'fake-ssh-argv.txt');
      // Each argument on a line of its own, then the prompt setting git
      // handed down. Where cmd.exe runs the twin, the arguments go to node
      // as they came: cmd.exe itself splits them at an equals sign, in %1 as
      // in a for over %*, and -oBatchMode=yes would come apart.
      const writeFakeSsh = (file, marker) => {
        fs.writeFileSync(file, `#!/bin/sh\n{ printf '%s\\n' "$@"; printf 'GIT_TERMINAL_PROMPT=%s\\n' "$GIT_TERMINAL_PROMPT"; echo '${marker}'; } > "$EGC_TEST_SSH_LOG"\necho "Host key verification failed." >&2\nexit 255\n`, { mode: 0o755 });
        fs.writeFileSync(`${file}.js`, [
          "'use strict';",
          "const fs = require('node:fs');",
          `fs.writeFileSync(process.env.EGC_TEST_SSH_LOG, [...process.argv.slice(2), 'GIT_TERMINAL_PROMPT=' + (process.env.GIT_TERMINAL_PROMPT ?? ''), '${marker}', ''].join('\\n'));`,
          "process.stderr.write('Host key verification failed.\\n', () => process.exit(255));",
          '',
        ].join('\n'));
        fs.writeFileSync(`${file}.cmd`, `@"${process.execPath}" "${file}.js" %*\r\n`);
      };
      // git runs GIT_SSH itself, without a shell: on Windows that has to be
      // the .cmd twin by name.
      const ownSsh = path.join(fakeBin, process.platform === 'win32' ? 'own-ssh.cmd' : 'own-ssh');
      writeFakeSsh(path.join(fakeBin, 'ssh'), 'FAKE_SSH_ON_PATH');
      writeFakeSsh(path.join(fakeBin, 'own-ssh'), 'OWN_SSH_FROM_GIT_SSH');
      const argvLines = () => fs.readFileSync(log, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const saved = { PATH: process.env.PATH, EGC_TEST_SSH_LOG: process.env.EGC_TEST_SSH_LOG, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, GIT_SSH: process.env.GIT_SSH, GIT_SSH_VARIANT: process.env.GIT_SSH_VARIANT };
      process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;
      process.env.EGC_TEST_SSH_LOG = log;
      delete process.env.GIT_SSH_COMMAND;
      delete process.env.GIT_SSH;
      delete process.env.GIT_SSH_VARIANT;
      // An init that waited for a prompt would never return; the case gives
      // it a bound of its own instead of waiting on the suite's.
      const bounded = (promise, what) => Promise.race([
        promise,
        new Promise((_, rejectWith) => setTimeout(() => rejectWith(new Error(`${what} did not come back within 20 s`)), 20000).unref()),
      ]);
      // Under Git for Windows the sh that runs GIT_SSH_COMMAND puts its own
      // /usr/bin ahead of PATH, so the ssh it finds by name is the real one:
      // there the batch flag of the default command rests on the environment
      // case above, and a command of the person reaches the recording ssh by
      // its absolute path, with the forward slashes sh reads.
      const onWindows = process.platform === 'win32';
      const sshCommand = args => (onWindows ? `"${path.join(fakeBin, 'ssh').replace(/\\/g, '/')}" ${args}` : `ssh ${args}`);
      let lines;
      try {
        const backend = new GitBackend(path.join(tempBase, 'repo-ssh'));
        await bounded(assert.rejects(
          () => backend.init({ backend: 'git', remote: 'ssh://git@sync.example.invalid/team/egc-memory.git', branch: 'main' }),
          onWindows ? /cannot be read: \S/ : /cannot be read: .*Host key verification failed/,
        ), 'init against the ssh remote');
        if (onWindows) {
          console.log('    (the ssh on PATH is out of reach under Git for Windows: the default command fails at once with the reason of the real ssh)');
        } else {
          lines = argvLines();
          assert.ok(lines.includes('-oBatchMode=yes'), `ssh ran in batch mode, got: ${lines.join(' ')}`);
          assert.ok(lines.includes('GIT_TERMINAL_PROMPT=0'), `git ran with its prompts off, got: ${lines.join(' ')}`);
          assert.ok(lines.includes('FAKE_SSH_ON_PATH'), 'the ssh on PATH is the one git ran');
        }
        await backend.destroy();

        // A core.sshCommand of the person, in the checkout the first init
        // made, is read on the next init and kept, with the flag added.
        git(['config', 'core.sshCommand', sshCommand('-i team_key')], path.join(tempBase, 'repo-ssh'));
        fs.rmSync(log, { force: true });
        const again = new GitBackend(path.join(tempBase, 'repo-ssh'));
        await bounded(assert.rejects(
          () => again.init({ backend: 'git', remote: 'ssh://git@sync.example.invalid/team/egc-memory.git', branch: 'main' }),
          /cannot be read: .*Host key verification failed/,
        ), 'the second init against the ssh remote');
        lines = argvLines();
        assert.deepStrictEqual(lines.slice(0, 3), ['-i', 'team_key', '-oBatchMode=yes'], 'the configured ssh command runs with its own flags and the batch flag after them');
        await again.destroy();

        // An ssh the person named in GIT_SSH is the one git runs, as they
        // set it, with no flag added; the variant travels with it. The
        // configured command leaves first, since git would prefer it.
        git(['config', '--unset', 'core.sshCommand'], path.join(tempBase, 'repo-ssh'));
        fs.rmSync(log, { force: true });
        process.env.GIT_SSH = ownSsh;
        process.env.GIT_SSH_VARIANT = 'ssh';
        const own = new GitBackend(path.join(tempBase, 'repo-ssh'));
        await bounded(assert.rejects(
          () => own.init({ backend: 'git', remote: 'ssh://git@sync.example.invalid/team/egc-memory.git', branch: 'main' }),
          /cannot be read: .*Host key verification failed/,
        ), 'the init with GIT_SSH of the person');
        lines = argvLines();
        assert.ok(lines.includes('OWN_SSH_FROM_GIT_SSH'), `the ssh named in GIT_SSH is the one git ran, got: ${lines.join(' ')}`);
        assert.ok(!lines.includes('-oBatchMode=yes'), 'no flag is added to an ssh the person chose');
        assert.ok(lines.includes('GIT_TERMINAL_PROMPT=0'), 'the prompt setting still applies');
        await own.destroy();

        // Before the checkout exists, the setting read is the person's global
        // one, never that of whatever repository happens to hold the directory.
        delete process.env.GIT_SSH;
        delete process.env.GIT_SSH_VARIANT;
        const globalHome = path.join(tempBase, 'global-home');
        fs.mkdirSync(globalHome, { recursive: true });
        // The quotes of a path survive the config parser only escaped.
        fs.writeFileSync(path.join(globalHome, '.gitconfig'), `[core]\n\tsshCommand = ${sshCommand('-i global_key').replace(/"/g, '\\"')}\n`);
        const enclosing = path.join(tempBase, 'enclosing-repo');
        fs.mkdirSync(enclosing, { recursive: true });
        git(['init', '-q'], enclosing);
        git(['config', 'core.sshCommand', 'ssh -i enclosing_key'], enclosing);
        const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
        process.env.HOME = globalHome;
        process.env.USERPROFILE = globalHome;
        fs.rmSync(log, { force: true });
        try {
          const nested = new GitBackend(path.join(enclosing, 'nested', 'repo-ssh'));
          await bounded(assert.rejects(
            () => nested.init({ backend: 'git', remote: 'ssh://git@sync.example.invalid/team/egc-memory.git', branch: 'main' }),
            /cannot be read: .*Host key verification failed/,
          ), 'the first init inside another repository');
          lines = argvLines();
          assert.deepStrictEqual(lines.slice(0, 3), ['-i', 'global_key', '-oBatchMode=yes'], `the global setting applies before the checkout exists, not that of the enclosing repository, got: ${lines.join(' ')}`);
          await nested.destroy();
        } finally {
          process.env.HOME = savedHome.HOME;
          process.env.USERPROFILE = savedHome.USERPROFILE;
        }
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
    });

    await run('init against an empty remote succeeds, and pull reports nothing to pull without an error', async () => {
      const { backend } = await pushingBackend(GitBackend, tempBase, 'empty');
      assert.deepStrictEqual(await backend.pull(), [], 'an empty remote branch is not a failure');
      await backend.destroy();
    });

    await run('pull throws when the remote stops being readable, instead of returning an empty list', async () => {
      const { backend, remote } = await pushingBackend(GitBackend, tempBase, 'vanishing');
      fs.rmSync(remote, { recursive: true, force: true });
      await assert.rejects(() => backend.pull(), /cannot be read: \S/);
      await backend.destroy();
    });

    await run('status answers from the local checkout when the remote cannot be read, with a local-only init', async () => {
      const { backend, repoDir, remote } = await pushingBackend(GitBackend, tempBase, 'offline');
      await backend.destroy();
      fs.rmSync(remote, { recursive: true, force: true });
      const again = new GitBackend(repoDir);
      await again.init({ backend: 'git', remote, branch: 'main' }, { readRemote: false });
      const status = await again.status();
      assert.strictEqual(status.remoteUrl, remote);
      assert.strictEqual(status.conflictCount, 0);
      await again.destroy();
    });

    await run('init refuses an existing checkout that follows another branch, and leaves it as it was', async () => {
      const { backend, repoDir, remote } = await pushingBackend(GitBackend, tempBase, 'rebranch');
      await backend.destroy();
      const again = new GitBackend(repoDir);
      await assert.rejects(() => again.init({ backend: 'git', remote, branch: 'other' }), /on branch main, not .* on branch other/);
      assert.strictEqual(git(['symbolic-ref', '--short', 'HEAD'], repoDir), 'main', 'the checkout stays on its branch');
      await again.destroy();
    });

    await run('init refuses an existing checkout that follows another remote, and keeps its origin', async () => {
      const { backend, repoDir, remote } = await pushingBackend(GitBackend, tempBase, 'reremote');
      await backend.destroy();
      const otherRemote = path.join(tempBase, 'reremote-other.git');
      git(['init', '--bare', otherRemote], tempBase);
      const again = new GitBackend(repoDir);
      await assert.rejects(() => again.init({ backend: 'git', remote: otherRemote, branch: 'main' }), /follows .*reremote-remote\.git on branch main, not .*reremote-other\.git/);
      assert.strictEqual(git(['remote', 'get-url', 'origin'], repoDir), remote, 'origin still points at the first remote');
      await again.destroy();
    });

    await run('init refuses an existing checkout whose origin pushes elsewhere, and one with remotes but no origin', async () => {
      const { backend, repoDir, remote } = await pushingBackend(GitBackend, tempBase, 'pushurl');
      await backend.destroy();
      const elsewhere = path.join(tempBase, 'pushurl-elsewhere.git');
      git(['init', '--bare', elsewhere], tempBase);
      git(['remote', 'set-url', '--push', 'origin', elsewhere], repoDir);
      const again = new GitBackend(repoDir);
      await assert.rejects(() => again.init({ backend: 'git', remote, branch: 'main' }), /and pushes to .*pushurl-elsewhere\.git on branch main/);
      await again.destroy();
      git(['remote', 'rename', 'origin', 'upstream'], repoDir);
      const noOrigin = new GitBackend(repoDir);
      await assert.rejects(() => noOrigin.init({ backend: 'git', remote, branch: 'main' }), /follows upstream with no origin on branch main/);
      await noOrigin.destroy();
    });

    await run('init on an existing checkout with the same remote and branch goes through', async () => {
      const { backend, repoDir, remote } = await pushingBackend(GitBackend, tempBase, 'same');
      await backend.destroy();
      const again = new GitBackend(repoDir);
      await again.init({ backend: 'git', remote, branch: 'main' });
      assert.strictEqual(git(['symbolic-ref', '--short', 'HEAD'], repoDir), 'main');
      await again.destroy();
    });

    await run('GitBackend constructor initializes repository directory', () => {
      const customRepo = path.join(tempBase, 'custom-repo-dir');
      assert.ok(!fs.existsSync(customRepo), 'precondition: custom repo dir does not exist');
      const backend = new GitBackend(customRepo);
      assert.ok(fs.existsSync(customRepo), 'constructor must create the repo directory');
      assert.ok(backend instanceof GitBackend);
    });
  } finally {
    fs.rmSync(tempBase, { recursive: true, force: true });
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
