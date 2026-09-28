/**
 * A command handed to another process to run is judged as the command it
 * is: what a tmux session, window, pane, popup or run-shell runs and the keys
 * send-keys types into a pane; what screen starts, stuffs into a window or
 * execs; what ssh runs on the remote host; and what docker exec and kubectl
 * exec run in a container.
 */
'use strict';

const assert = require('assert');
const path = require('path');

// The verdicts come from the deterministic stand-in for the guardian CLI,
// so these cases do not depend on the egc-guardian build being there.
process.env.EGC_GUARDIAN_CLI = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');
const { run } = require('../../scripts/hooks/pre-bash-guardian-validate');
const { handoffCommandsOf } = require('../../scripts/lib/handoff-commands');

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
const judge = command => run({ tool_name: 'Bash', tool_input: { command }, cwd: path.join(__dirname, '..', '..') });
const words = line => line.split(' ');

function runTests() {
  console.log('\n=== Testing commands handed to another process ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => (ok ? passed++ : failed++);

  record(test('tmux: what a session, window, pane, popup, pipe or run-shell runs is judged', () => {
    for (const command of [
      `tmux new-session -d '${wipe}'`, `tmux new -d -s dev '${wipe}'`, `tmux neww '${wipe}'`, `tmux split-window -h -t 0 '${wipe}'`,
      `tmux splitw '${wipe}'`, `tmux respawn-pane -k '${wipe}'`, `tmux respawnw -k -t 1 '${wipe}'`, `tmux display-popup -E '${wipe}'`,
      `tmux popup '${wipe}'`, `tmux pipe-pane -o '${wipe}'`, `tmux run-shell '${wipe}'`, `tmux run -b '${wipe}'`,
      `tmux if-shell '${wipe}' 'display x'`, `tmux if 'true' "run-shell '${wipe}'"`, `tmux -c '${wipe}'`,
      `tmux new-session -d rm -rf /`, `tmux new -d -s a \\; neww '${wipe}'`, `tmux new-s -d '${wipe}'`,
      `sudo tmux new -d '${wipe}'`, `tmux -L sock -f /dev/null new -d '${wipe}'`,
      `tmux new -d -sdev '${wipe}'`, `tmux bind-key x run-shell '${wipe}'`, `tmux set-hook -g after-new-window "run-shell '${wipe}'"`,
      `tmux confirm-before "run-shell '${wipe}'"`, `tmux set-option -g default-command '${wipe}'`,
    ]) {
      assert.strictEqual(judge(command).exitCode, 2, command);
    }
  }));

  record(test('tmux: the keys send-keys types are judged as a command line', () => {
    for (const command of [
      `tmux send-keys -t dev '${wipe}' Enter`, `tmux send -t dev '${wipe}' C-m`, `tmux send-keys rm Space -rf Space / Enter`,
      `tmux send-keys -l '${wipe}'`, `tmux send-keys -t dev -H 72 6d 20 2d 72 66 20 2f 0a`,
    ]) {
      assert.strictEqual(judge(command).exitCode, 2, command);
    }
  }));

  record(test('screen: what it starts, stuffs into a window or execs is judged', () => {
    for (const command of [
      `screen -dm ${wipe}`, `screen -dmS job ${wipe}`, `screen -S job -X stuff '${wipe}\\n'`,
      `screen -S job -X stuff '${wipe}^M'`, `screen -X exec ${wipe}`, `screen -X screen ${wipe}`,
      `screen -s /bin/sh -dm ${wipe}`, `screen -L -Logfile /tmp/log -dm ${wipe}`,
    ]) {
      assert.strictEqual(judge(command).exitCode, 2, command);
    }
  }));

  record(test('ssh: a command given as an option is judged, where it runs remotely or on this machine', () => {
    for (const command of [
      `ssh -o RemoteCommand='${wipe}' host`, `ssh -oRemoteCommand='${wipe}' host`, `ssh -o 'RemoteCommand ${wipe}' host`,
      `ssh -o remotecommand='${wipe}' host`, `ssh -o 'RemoteCommand = ${wipe}' host`, `ssh host -o RemoteCommand='${wipe}'`,
      `ssh -o ProxyCommand='${wipe}' host`, `ssh -o PermitLocalCommand=yes -o LocalCommand='${wipe}' host ls`,
      `ssh -o KnownHostsCommand='${wipe}' host`, `ssh -N -o ProxyCommand='${wipe}' host`, `docker exec -- web ${wipe}`,
      'kubectl exec pod -c app rm /data', `screen -m -d ${wipe}`, `screen -X eval 'exec ${wipe}'`, `screen -X bind x exec ${wipe}`,
    ]) {
      assert.strictEqual(judge(command).exitCode, 2, command);
    }
    for (const command of ["ssh -o RemoteCommand='ls -la' host", 'ssh -o RemoteCommand=none host', 'ssh -o ProxyCommand=none host', "ssh -o 'ServerAliveInterval 30' host ls"]) {
      assert.strictEqual(judge(command).exitCode, 0, command);
    }
    assert.deepStrictEqual(handoffCommandsOf(['ssh', '-o', 'RemoteCommand=ls -la', 'host']), ['ls -la']);
    assert.deepStrictEqual(handoffCommandsOf(['ssh', '-o', 'ProxyCommand nc %h %p', '-o', 'StrictHostKeyChecking=no', 'host', 'uptime']), ['nc %h %p', 'uptime']);
    assert.deepStrictEqual(handoffCommandsOf(['ssh', '-G', '-o', 'RemoteCommand=ls', 'host']), ['ls']);
    assert.deepStrictEqual(handoffCommandsOf(['ssh', '-o', 'RemoteCommand=None', '-o', 'ProxyCommand none', 'host']), [], 'none turns the command off');
  }));

  record(test('ssh, docker exec and kubectl exec: what they run remotely or in a container is judged', () => {
    for (const command of [
      `ssh host ${wipe}`, `ssh -p 22 -i key user@host '${wipe}'`, `ssh -o StrictHostKeyChecking=no host -- ${wipe}`,
      `ssh -t host sudo ${wipe}`, `ssh -o A=1 -- host ${wipe}`, `docker exec web ${wipe}`, `docker exec -it -u root web ${wipe}`,
      `docker container exec -e A=1 web ${wipe}`, `podman exec web ${wipe}`, `docker compose exec web ${wipe}`,
      `kubectl exec pod -- ${wipe}`, `kubectl exec -it pod -c app -n prod -- ${wipe}`, `kubectl -n prod exec pod -- ${wipe}`,
    ]) {
      assert.strictEqual(judge(command).exitCode, 2, command);
    }
  }));

  record(test('what they run that is harmless stays allowed', () => {
    for (const command of [
      'tmux new-session -d -s dev', "tmux new -d -s dev 'npm run dev'", "tmux send-keys -t dev 'npm test' Enter",
      'tmux ls', 'tmux attach -t dev', 'tmux kill-session -t dev', 'tmux capture-pane -t dev -p',
      "tmux if-shell -F '#{pane_active}' 'display x'", "tmux run-shell -C 'display-message hi'", 'tmux send-keys -X cancel',
      'screen -ls', 'screen -dmS dev npm run dev', "screen -S dev -X stuff 'npm test\\n'", 'screen -r dev',
      'ssh host ls -la', 'ssh -N -L 8080:localhost:80 host', 'ssh -G host', 'docker exec web ls /app',
      'docker ps', 'kubectl exec pod -- ls /', 'kubectl get pods',
    ]) {
      const result = judge(command);
      assert.strictEqual(result.exitCode, 0, `${command}: ${result.stderr}`);
    }
  }));

  record(test('handoffCommandsOf reads each tool the way it reads its own words', () => {
    assert.deepStrictEqual(handoffCommandsOf(words('tmux new -d -s dev -c /tmp npm run dev')), ["'npm' 'run' 'dev'"]);
    assert.deepStrictEqual(handoffCommandsOf(['tmux', 'new', '-d', 'npm run dev']), ['npm run dev']);
    assert.deepStrictEqual(handoffCommandsOf(['tmux', 'send-keys', '-t', 'x', 'ls', 'Space', '-la', 'Enter']), ['ls -la\n']);
    assert.deepStrictEqual(handoffCommandsOf(['tmux', 'send-keys', '-l', 'Enter']), ['Enter']);
    assert.deepStrictEqual(handoffCommandsOf(['tmux', 'send-keys', 'C-c', 'Up', 'F5', 'KPEnter', 'Escape', 'ls', 'Enter']), ['\nls\n']);
    assert.deepStrictEqual(handoffCommandsOf(['tmux', 'send-keys', '-H', '6c', '73', '0a']), ['ls\n']);
    assert.deepStrictEqual(handoffCommandsOf(['tmux', 'run-shell', '-C', 'display hi']), ['tmux display hi']);
    assert.deepStrictEqual(handoffCommandsOf(['tmux', 'if', '-F', '#{x}', 'run-shell ls']), ['tmux run-shell ls']);
    assert.deepStrictEqual(handoffCommandsOf(['tmux', 'bind', 'x', 'run-shell', 'ls']), ["tmux 'run-shell' 'ls'"]);
    assert.deepStrictEqual(handoffCommandsOf(['screen', '-S', 'x', '-X', 'stuff', 'ls^M']), ['ls\n']);
    assert.deepStrictEqual(handoffCommandsOf(['ssh', '-p', '22', 'host', 'ls', '-la']), ['ls -la']);
    assert.deepStrictEqual(handoffCommandsOf(['ssh', '-N', 'host']), []);
    assert.deepStrictEqual(handoffCommandsOf(['ssh', '-s', 'host', 'sftp']), []);
    assert.deepStrictEqual(handoffCommandsOf(['docker', 'exec', '-w', '/app', 'web', 'ls']), ["'ls'"]);
    assert.deepStrictEqual(handoffCommandsOf(['kubectl', 'exec', 'pod', '--', 'ls', '/']), ["'ls' '/'"]);
    assert.deepStrictEqual(handoffCommandsOf(['ls', '-la']), []);
    assert.deepStrictEqual(handoffCommandsOf(['tmux', 'new', '-sdev', 'ls']), ['ls']);
    assert.deepStrictEqual(handoffCommandsOf(['tmux', 'new', '--', '-la']), ['-la']);
    assert.deepStrictEqual(handoffCommandsOf(['tmux', 'send-keys', '-X', 'cancel']), []);
    assert.deepStrictEqual(handoffCommandsOf(['screen', '-r', 'dev']), []);
    assert.deepStrictEqual(handoffCommandsOf(['screen', '-d', '-m', 'ls']), ["'ls'"]);
    assert.deepStrictEqual(handoffCommandsOf(['ssh', '--', 'host', 'ls']), ['ls']);
    assert.deepStrictEqual(handoffCommandsOf(['docker', 'exec', '--', 'web', 'rm', '-rf', '/']), ["'rm' '-rf' '/'"]);
    assert.deepStrictEqual(handoffCommandsOf(['kubectl', 'exec', 'pod', '-c', 'app', 'rm', '/data']), ["'rm' '/data'"]);
    assert.deepStrictEqual(handoffCommandsOf(['kubectl', '-n', 'x', 'exec', 'pod', '--container', 'app', '-i', 'ls']), ["'ls'"]);
    assert.deepStrictEqual(handoffCommandsOf(['docker', 'exec', 'web', '-c', 'x']), ["'-c' 'x'"], 'docker options end at the container');
    assert.deepStrictEqual(handoffCommandsOf(['screen', '-m', '-d', 'rm', '-rf', '/']), ["'rm' '-rf' '/'"]);
    assert.deepStrictEqual(handoffCommandsOf(['screen', '-d', '-m', 'rm', '-rf', '/']), ["'rm' '-rf' '/'"]);
    assert.deepStrictEqual(handoffCommandsOf(['screen', '-d', 'mysession']), [], '-d without -m names a session');
    assert.deepStrictEqual(handoffCommandsOf(['screen', '-X', 'eval', 'exec rm -rf /', 'stuff "ls^M"']), ["'rm' '-rf' '/'", 'ls\n']);
    assert.deepStrictEqual(handoffCommandsOf(['screen', '-X', 'at', '0', 'exec', 'rm', '-rf', '/']), ["'rm' '-rf' '/'"]);
    assert.deepStrictEqual(handoffCommandsOf(['screen', '-X', 'bind', 'x', 'exec', 'rm', '-rf', '/']), ["'rm' '-rf' '/'"]);
    assert.deepStrictEqual(handoffCommandsOf(['screen', '-X', 'bindkey', '-k', 'k1', 'exec', 'rm']), ["'rm'"]);
    assert.deepStrictEqual(handoffCommandsOf(['screen', '-X', 'bind', 'x', 'kill']), []);
    assert.deepStrictEqual(handoffCommandsOf(['docker', 'exec', '-it', '--', 'web', '--', 'ls']), ["'ls'"]);
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
