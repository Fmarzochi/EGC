/**
 * A script handed to a shell interpreter (bash x.sh, sh notes.txt, source
 * env.sh) is judged with the same validator as typed commands, so writing a
 * denied command to a file first does not change the verdict (security
 * audit 2026-08-17, H3). Runs the hook in-process against the fake CLI.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.EGC_GUARDIAN_CLI = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');
const { run } = require('../../scripts/hooks/pre-bash-guardian-validate');

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

function runTests() {
  console.log('\n=== Testing scripts run by an interpreter ===\n');
  let passed = 0;
  let failed = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-script-operand-'));
  const wipe = ['rm', '-rf'].join(' ');
  try {
    const denied = path.join(dir, 'notes.txt');
    fs.writeFileSync(denied, `echo start\n${wipe} /tmp/egc-victim\n`);
    const benign = path.join(dir, 'build.sh');
    fs.writeFileSync(benign, '#!/bin/bash\ncargo build\necho done\n');

    if (test('bash <file> is blocked when the file runs a denied command, whatever its name', () => {
      for (const command of [`bash ${denied}`, `sh notes.txt`, `source ${denied}`, `. notes.txt`, `bash -x notes.txt`]) {
        const result = run({ tool_name: 'Bash', tool_input: { command }, cwd: dir });
        assert.strictEqual(result.exitCode, 2, `${command}: ${JSON.stringify(result)}`);
        assert.ok(result.stderr.includes('BLOCKED'), result.stderr);
      }
    })) passed++; else failed++;

    if (test('bash <file> passes when the script is benign, and a missing file changes nothing', () => {
      for (const command of [`bash ${benign}`, 'bash does-not-exist.sh', 'bash']) {
        const result = run({ tool_name: 'Bash', tool_input: { command }, cwd: dir });
        assert.strictEqual(result.exitCode, 0, `${command}: ${JSON.stringify(result)}`);
      }
    })) passed++; else failed++;

    if (test('quoted paths, path-qualified and wrapped interpreters, and variable interpreters reach the file', () => {
      const spaced = path.join(dir, 'my dir');
      fs.mkdirSync(spaced, { recursive: true });
      const inSpaced = path.join(spaced, 'notes.txt');
      fs.writeFileSync(inSpaced, `${wipe} /tmp/egc-victim\n`);
      fs.writeFileSync(path.join(dir, '-payload.sh'), `${wipe} /tmp/egc-victim\n`);
      const posixOnly = process.platform === 'win32' ? [] : [`bash my\\ dir/notes.txt`];
      for (const command of [`bash "${inSpaced}"`, `bash 'my dir/notes.txt'`, ...posixOnly, `/bin/bash ${denied}`, `sudo bash ${denied}`, `sudo -u root bash ${denied}`, `sudo --user root bash ${denied}`, `env FOO=1 bash ${denied}`, `FOO=1 bash ${denied}`, `$SHELL ${denied}`, `xargs bash ${denied}`, `xargs -n 1 bash ${denied}`, `bash -- -payload.sh`]) {
        const result = run({ tool_name: 'Bash', tool_input: { command }, cwd: dir });
        assert.strictEqual(result.exitCode, 2, `${command}: ${JSON.stringify(result)}`);
      }
    })) passed++; else failed++;

    if (test('chdir wrappers, executor wrappers with positionals, ANSI-C quoting and a line continuation still reach the file', () => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-elsewhere-'));
      try {
        fs.writeFileSync(path.join(dir, 'outer-rel.sh'), 'echo outer\nbash inner-rel.sh\n');
        fs.writeFileSync(path.join(dir, 'inner-rel.sh'), `${wipe} /tmp/egc-victim\n`);
        for (const command of [`env -C ${dir} bash notes.txt`, `env -C${dir} bash notes.txt`, `env --chdir=${dir} bash notes.txt`, `sudo -D ${dir} bash notes.txt`, `sudo --chdir ${dir} bash notes.txt`, `systemd-run --working-directory=${dir} bash notes.txt`, `systemd-run -p MemoryMax=1G bash ${denied}`, `env -C ${dir} bash outer-rel.sh`, `timeout 5 bash ${denied}`, `timeout -s KILL 5 bash ${denied}`, `flock /tmp/egc-operand.lock bash ${denied}`, `stdbuf -oL bash ${denied}`, `ionice -c 3 bash ${denied}`, `bash $'${denied.replace(/\\/g, '\\\\')}'`, `bash \\\n${denied}`]) {
          const result = run({ tool_name: 'Bash', tool_input: { command }, cwd: elsewhere });
          assert.strictEqual(result.exitCode, 2, `${command}: ${JSON.stringify(result)}`);
        }
      } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    })) passed++; else failed++;

    if (test('a chroot maps the script, byte escapes fail closed, and an apostrophe in double quotes keeps a continuation', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-chroot-'));
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-elsewhere-'));
      try {
        fs.mkdirSync(path.join(root, 'opt'), { recursive: true });
        fs.writeFileSync(path.join(root, 'opt', 'run.sh'), `${wipe} /tmp/egc-victim\n`);
        for (const command of [`sudo -R ${root} bash /opt/run.sh`, `sudo -R${root} bash /opt/run.sh`, `sudo --chroot=${root} -D /opt bash run.sh`, `echo "it's" \\\n${denied.replace('notes.txt', '')}notes.txt; bash \\\n${denied}`]) {
          const result = run({ tool_name: 'Bash', tool_input: { command }, cwd: elsewhere });
          assert.strictEqual(result.exitCode, 2, `${command}: ${JSON.stringify(result)}`);
        }
        const bytes = run({ tool_name: 'Bash', tool_input: { command: `bash $'\\377notes.txt'` }, cwd: dir });
        assert.strictEqual(bytes.exitCode, 2, JSON.stringify(bytes));
        assert.ok(bytes.stderr.includes('byte escapes'), bytes.stderr);
        const beyond = run({ tool_name: 'Bash', tool_input: { command: `bash $'\\U00110000notes.txt'` }, cwd: dir });
        assert.strictEqual(beyond.exitCode, 2, JSON.stringify(beyond));
        const escapingRoot = run({ tool_name: 'Bash', tool_input: { command: `sudo -R ${root} bash ../../${path.relative(path.dirname(path.dirname(root)), denied)}` }, cwd: elsewhere });
        assert.strictEqual(escapingRoot.exitCode, 2, JSON.stringify(escapingRoot));
        assert.ok(escapingRoot.stderr.includes('leaves the chroot'), escapingRoot.stderr);
        const escapedRoot = run({ tool_name: 'Bash', tool_input: { command: `sudo -R $'${root}\\377' bash /opt/run.sh` }, cwd: elsewhere });
        assert.strictEqual(escapedRoot.exitCode, 2, JSON.stringify(escapedRoot));
        assert.ok(escapedRoot.stderr.includes('byte escapes'), escapedRoot.stderr);

      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    })) passed++; else failed++;

    if (test('a wildcard operand fails closed even when it also names an existing file', () => {
      const literal = run({ tool_name: 'Bash', tool_input: { command: 'bash notes.*' }, cwd: dir });
      assert.strictEqual(literal.exitCode, 2, JSON.stringify(literal));
      assert.ok(literal.stderr.includes('wildcard'), literal.stderr);
      const quoted = run({ tool_name: 'Bash', tool_input: { command: `bash 'build.sh'` }, cwd: dir });
      assert.strictEqual(quoted.exitCode, 0, JSON.stringify(quoted));
    })) passed++; else failed++;

    if (test('a wildcard operand fails closed, and a quoted backslash stays part of the path', () => {
      const glob = run({ tool_name: 'Bash', tool_input: { command: 'bash *.txt' }, cwd: dir });
      assert.strictEqual(glob.exitCode, 2, JSON.stringify(glob));
      assert.ok(glob.stderr.includes('wildcard'), glob.stderr);
      if (process.platform !== 'win32') {
        fs.writeFileSync(path.join(dir, 'payload\\evil.sh'), `${wipe} /tmp/egc-victim\n`);
        const quoted = run({ tool_name: 'Bash', tool_input: { command: "bash 'payload\\evil.sh'" }, cwd: dir });
        assert.strictEqual(quoted.exitCode, 2, JSON.stringify(quoted));
      }
    })) passed++; else failed++;

    if (test('a script that runs another script is followed, and a script that cannot be inspected fails closed', () => {
      const inner = path.join(dir, 'inner.sh');
      fs.writeFileSync(inner, `echo inner\n${wipe} /tmp/egc-victim\n`);
      const outer = path.join(dir, 'outer.sh');
      fs.writeFileSync(outer, `echo outer\nbash ${inner}\n`);
      const nested = run({ tool_name: 'Bash', tool_input: { command: `bash ${outer}` }, cwd: dir });
      assert.strictEqual(nested.exitCode, 2, JSON.stringify(nested));
      const loop = path.join(dir, 'loop.sh');
      fs.writeFileSync(loop, `bash ${loop}\necho fine\n`);
      const cyclic = run({ tool_name: 'Bash', tool_input: { command: `bash ${loop}` }, cwd: dir });
      assert.strictEqual(cyclic.exitCode, 0, JSON.stringify(cyclic));
      const huge = path.join(dir, 'huge.sh');
      fs.writeFileSync(huge, 'echo fine\n'.repeat(60000));
      const oversized = run({ tool_name: 'Bash', tool_input: { command: `bash ${huge}` }, cwd: dir });
      assert.strictEqual(oversized.exitCode, 2, JSON.stringify(oversized));
      assert.ok(oversized.stderr.includes('too large'), oversized.stderr);
    })) passed++; else failed++;

    if (test('a non-interpreter command with a script operand is not read', () => {
      const result = run({ tool_name: 'Bash', tool_input: { command: `cat ${denied}` }, cwd: dir });
      assert.strictEqual(result.exitCode, 0, JSON.stringify(result));
    })) passed++; else failed++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
