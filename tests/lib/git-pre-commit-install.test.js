/**
 * The git pre-commit hook both installers put in a clone of this repository
 * (scripts/lib/git-pre-commit-install.js): written once, appended to a hook
 * someone already has, never twice, and runnable by the bash Git for Windows
 * brings (LF line endings, no byte order mark).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { installPreCommitHook, HOOK, PREVIOUS_NAME } = require('../../scripts/lib/git-pre-commit-install');

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

function withRepo(fn, { git = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-pre-commit-'));
  try {
    if (git) fs.mkdirSync(path.join(root, '.git'));
    fn(root, path.join(root, '.git', 'hooks', 'pre-commit'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const CALL = 'bash "$ROOT/scripts/hooks/git-pre-commit.sh"';
const EARLIER_CALL = 'ROOT="$(git rev-parse --show-toplevel)"\nbash "$ROOT/scripts/hooks/git-pre-commit.sh"\n';

function runTests() {
  console.log('\n=== Testing the git pre-commit hook the installers put in place ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => (ok ? passed++ : failed++);

  record(test('a clone without a hook gets one that runs the strip script, as bash reads it', () => {
    withRepo((root, hook) => {
      assert.strictEqual(installPreCommitHook(root), 'installed');
      const text = fs.readFileSync(hook, 'utf8');
      assert.ok(text.startsWith('#!/usr/bin/env bash\n'), text);
      assert.ok(text.includes('ROOT="$(git rev-parse --show-toplevel)"\n'), text);
      assert.ok(text.includes(CALL), text);
      assert.ok(!text.includes('\r'), 'LF line endings only');
      assert.notStrictEqual(fs.readFileSync(hook)[0], 0xef, 'no byte order mark');
      if (process.platform !== 'win32') assert.ok(fs.statSync(hook).mode & 0o100, 'executable');
    });
  }));

  record(test('a hook someone already has is kept whole under its own name and runs after the strip', () => {
    withRepo((root, hook) => {
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, '#!/usr/bin/env python3\nprint("mine")\n', { mode: 0o755 });
      assert.strictEqual(installPreCommitHook(root), 'wrapped');
      const previous = path.join(path.dirname(hook), PREVIOUS_NAME);
      assert.strictEqual(fs.readFileSync(previous, 'utf8'), '#!/usr/bin/env python3\nprint("mine")\n');
      if (process.platform !== 'win32') assert.ok(fs.statSync(previous).mode & 0o100, 'still executable');
      assert.strictEqual(fs.readFileSync(hook, 'utf8'), HOOK);
      assert.strictEqual(installPreCommitHook(root), 'present');
    });
  }));

  record(test('the call an earlier installer appended is taken off the hook it kept', () => {
    withRepo((root, hook) => {
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, `#!/bin/sh\necho mine\nexit 0\n\n${EARLIER_CALL}`);
      assert.strictEqual(installPreCommitHook(root), 'wrapped');
      assert.strictEqual(fs.readFileSync(path.join(path.dirname(hook), PREVIOUS_NAME), 'utf8'), '#!/bin/sh\necho mine\nexit 0\n');
    });
  }));

  record(test('the hook an earlier installer wrote is replaced, with nothing kept beside it', () => {
    withRepo((root, hook) => {
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, `#!/usr/bin/env bash\n${EARLIER_CALL}`);
      assert.strictEqual(installPreCommitHook(root), 'updated');
      assert.strictEqual(fs.readFileSync(hook, 'utf8'), HOOK);
      assert.ok(!fs.existsSync(path.join(path.dirname(hook), PREVIOUS_NAME)));
    });
  }));

  record(test('a hook that only names the strip script, in a comment, is not taken for it', () => {
    withRepo((root, hook) => {
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, '#!/bin/sh\n# TODO: run scripts/hooks/git-pre-commit.sh\nexit 0\n');
      assert.strictEqual(installPreCommitHook(root), 'wrapped');
      assert.strictEqual(fs.readFileSync(hook, 'utf8'), HOOK);
    });
  }));

  record(test('a hook kept from before is not overwritten when another hook takes its place', () => {
    withRepo((root, hook) => {
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      const previous = path.join(path.dirname(hook), PREVIOUS_NAME);
      fs.writeFileSync(previous, 'kept\n');
      fs.writeFileSync(hook, 'someone else\n');
      assert.strictEqual(installPreCommitHook(root), 'conflict');
      assert.strictEqual(fs.readFileSync(previous, 'utf8'), 'kept\n');
      assert.strictEqual(fs.readFileSync(hook, 'utf8'), 'someone else\n');
    });
  }));

  record(test('a linked hook, or a linked hooks directory, is read and never written through', () => {
    withRepo((root, hook) => {
      const outside = path.join(root, 'shared-hook.sh');
      fs.writeFileSync(outside, '#!/bin/sh\necho shared\n');
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      try {
        fs.symlinkSync(outside, hook);
      } catch {
        console.log('    - skipped: this system does not let the test create a symlink');
        return;
      }
      assert.strictEqual(installPreCommitHook(root), 'linked');
      assert.strictEqual(fs.readFileSync(outside, 'utf8'), '#!/bin/sh\necho shared\n');
      fs.unlinkSync(hook);
      const strip = path.join(root, 'scripts', 'hooks', 'git-pre-commit.sh');
      fs.mkdirSync(path.dirname(strip), { recursive: true });
      fs.writeFileSync(strip, '#!/usr/bin/env bash\n');
      fs.symlinkSync(strip, hook);
      assert.strictEqual(installPreCommitHook(root), 'present', 'a link to the strip script already runs it');
      fs.unlinkSync(hook);
      const sharedDir = path.join(root, 'shared-hooks');
      fs.mkdirSync(sharedDir);
      fs.rmSync(path.dirname(hook), { recursive: true });
      fs.symlinkSync(sharedDir, path.dirname(hook), 'dir');
      assert.strictEqual(installPreCommitHook(root), 'linked');
      assert.deepStrictEqual(fs.readdirSync(sharedDir), []);
    });
  }));

  record(test('a hard-linked hook is left as it is, and so is the file it shares its content with', () => {
    for (const content of [`#!/bin/sh\necho shared\n\n${EARLIER_CALL}`, `#!/usr/bin/env bash\n${EARLIER_CALL}`, 'someone else\n']) {
      withRepo((root, hook) => {
        const outside = path.join(root, 'tracked-hook.sh');
        fs.writeFileSync(outside, content);
        fs.mkdirSync(path.dirname(hook), { recursive: true });
        fs.linkSync(outside, hook);
        const modeBefore = fs.statSync(outside).mode;
        assert.strictEqual(installPreCommitHook(root), 'linked', JSON.stringify(content));
        assert.strictEqual(fs.readFileSync(outside, 'utf8'), content);
        assert.strictEqual(fs.statSync(outside).mode, modeBefore);
        assert.ok(!fs.existsSync(path.join(path.dirname(hook), PREVIOUS_NAME)));
      });
    }
    withRepo((root, hook) => {
      const outside = path.join(root, 'tracked-hook.sh');
      fs.writeFileSync(outside, HOOK);
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.linkSync(outside, hook);
      assert.strictEqual(installPreCommitHook(root), 'present', 'a hard link that already is this hook');
    });
  }));

  record(test('a hook that is not UTF-8 is kept byte for byte, less the call an earlier installer appended', () => {
    withRepo((root, hook) => {
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      const own = Buffer.concat([Buffer.from('#!/bin/sh\necho '), Buffer.from([0xe9, 0xff, 0xfe, 0x80]), Buffer.from('\nexit 0\n')]);
      fs.writeFileSync(hook, Buffer.concat([own, Buffer.from(`\n${EARLIER_CALL}`)]));
      assert.strictEqual(installPreCommitHook(root), 'wrapped');
      assert.ok(fs.readFileSync(path.join(path.dirname(hook), PREVIOUS_NAME)).equals(own));
      fs.writeFileSync(hook, own);
      fs.unlinkSync(path.join(path.dirname(hook), PREVIOUS_NAME));
      assert.strictEqual(installPreCommitHook(root), 'wrapped');
      assert.ok(fs.readFileSync(path.join(path.dirname(hook), PREVIOUS_NAME)).equals(own), 'kept whole when nothing was appended');
    });
  }));

  record(test('the hook runs the strip, then the hook kept from before with its arguments, and stops when the strip fails', () => {
    if (process.platform === 'win32' || spawnSync('bash', ['--version']).status !== 0) {
      console.log('    - skipped: needs a POSIX bash');
      return;
    }
    withRepo((root, hook) => {
      fs.rmSync(path.join(root, '.git'), { recursive: true });
      assert.strictEqual(spawnSync('git', ['init', '-q', root]).status, 0);
      const log = path.join(root, 'order.log');
      const strip = path.join(root, 'scripts', 'hooks', 'git-pre-commit.sh');
      fs.mkdirSync(path.dirname(strip), { recursive: true });
      fs.writeFileSync(strip, `echo strip >> "${log}"\nexit "\${STRIP_EXIT:-0}"\n`);
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, `#!/bin/sh\necho "previous $*" >> "${log}"\nexit 7\n`, { mode: 0o755 });
      assert.strictEqual(installPreCommitHook(root), 'wrapped');
      const ran = spawnSync('bash', [hook, 'a b'], { cwd: root, encoding: 'utf8' });
      assert.strictEqual(ran.status, 7, 'the kept hook decides the exit');
      assert.strictEqual(fs.readFileSync(log, 'utf8'), 'strip\nprevious a b\n');
      fs.writeFileSync(log, '');
      const failed = spawnSync('bash', [hook], { cwd: root, encoding: 'utf8', env: { ...process.env, STRIP_EXIT: '3' } });
      assert.strictEqual(failed.status, 3, 'a failing strip stops the commit');
      assert.strictEqual(fs.readFileSync(log, 'utf8'), 'strip\n');
    });
  }));

  record(test('outside a clone (a published install, or .git as a worktree file) nothing is written', () => {
    withRepo((root) => {
      assert.strictEqual(installPreCommitHook(root), 'skipped');
      assert.ok(!fs.existsSync(path.join(root, '.git')));
    }, { git: false });
    withRepo((root) => {
      fs.rmSync(path.join(root, '.git'), { recursive: true });
      fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n');
      assert.strictEqual(installPreCommitHook(root), 'skipped');
      assert.deepStrictEqual(fs.readdirSync(root), ['.git'], 'nothing is written beside the .git file');
      assert.strictEqual(fs.readFileSync(path.join(root, '.git'), 'utf8'), 'gitdir: /elsewhere\n');
    });
  }));

  record(test('run as a command, it acts on the package it ships in, never on a path it is handed', () => {
    withRepo((root, hook) => {
      const helper = path.join(root, 'scripts', 'lib', 'git-pre-commit-install.js');
      fs.mkdirSync(path.dirname(helper), { recursive: true });
      fs.copyFileSync(require.resolve('../../scripts/lib/git-pre-commit-install'), helper);
      withRepo((elsewhere, elsewhereHook) => {
        const result = spawnSync(process.execPath, [helper, elsewhere], { encoding: 'utf8' });
        assert.strictEqual(result.status, 0, result.stderr);
        assert.ok(fs.existsSync(hook), 'the hook of the package the helper ships in');
        assert.ok(!fs.existsSync(elsewhereHook), 'nothing in the path handed to it');
      });
    });
  }));

  // Git for Windows checks the scripts out with CRLF line endings.
  const scripts = path.join(__dirname, '..', '..', 'scripts');
  const ps1 = fs.readFileSync(path.join(scripts, 'install.ps1'), 'utf8').replaceAll('\r\n', '\n');
  const sh = fs.readFileSync(path.join(scripts, 'install.sh'), 'utf8').replaceAll('\r\n', '\n');

  // Where the block that opens at `start` closes, by its braces.
  const blockEnd = (source, start) => {
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}' && --depth === 0) return i;
    }
    return -1;
  };

  record(test('both installers put the hook in a clone through this helper, outside a dry run, and stop when it fails', () => {
    const block = ps1.indexOf('if (-not $DryRun) {\n    # MCP auto-registration');
    const ps1Call = ps1.indexOf('(Join-Path "lib" "git-pre-commit-install.js")))\n');
    assert.ok(block >= 0 && ps1Call > block && ps1Call < blockEnd(ps1, block), 'install.ps1 must install the hook inside the non-dry-run block');
    assert.ok(/git-pre-commit-install\.js"\)\)\)\n\s*if \(\$LASTEXITCODE -ne 0\) \{\n[^}]*\n\s*exit \$LASTEXITCODE\n/.test(ps1),
      'install.ps1 must stop when the helper fails, as install.sh does under set -e');
    assert.ok(/^set -e$/m.test(sh.slice(0, sh.indexOf('git-pre-commit-install.js'))), 'install.sh runs the helper under set -e');
    assert.ok(/if \[\[ "\$DRY_RUN" = false \]\]; then\n\s*node "\$ROOT_DIR\/scripts\/lib\/git-pre-commit-install\.js"\n/.test(sh),
      'install.sh must install the hook through the same helper, outside a dry run');
  }));

  record(test('neither installer runs inline code to read the Node version', () => {
    for (const [label, source] of [['install.ps1', ps1], ['install.sh', sh]]) {
      assert.ok(!/\bnode\s+(?:-e|--eval|-p|--print)\b/.test(source), `${label} must not run node -e`);
      assert.ok(/node --version/.test(source), `${label} must read the version from node --version`);
    }
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
