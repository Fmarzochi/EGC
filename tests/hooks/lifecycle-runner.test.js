'use strict';

/**
 * Tests for scripts/hooks/lifecycle-runner.js and the hook commands that run it.
 *
 * The PreCompact, Stop and SessionEnd entries of hooks/hooks.json used to carry
 * a 2.5 KB inline `node -e` program each. They now find the lifecycle runner with
 * the shared resolver and pass it the hook id, target script, profiles, timeout
 * and fallback exit status. These tests cover the runner on its own and run every
 * such command from hooks/hooks.json and docs/hooks/memory-persistence/hooks.json.
 *
 * Run with: node tests/hooks/lifecycle-runner.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const RUNNER_SOURCE = path.join(REPO, 'scripts', 'hooks', 'lifecycle-runner.js');
const RUNNER_MARK = 'scripts/hooks/lifecycle-runner.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message || String(error));
    failed += 1;
  }
}

function lifecycleCommands(file) {
  const document = JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));
  const commands = [];
  for (const [event, groups] of Object.entries(document.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.command.includes(RUNNER_MARK)) commands.push({ event, command: hook.command });
      }
    }
  }
  return commands;
}

function argsOf(command) {
  return command.slice(command.lastIndexOf('" ') + 2).split(' ');
}

function makeRoot(stub) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-lifecycle-'));
  const hooksDir = path.join(root, 'scripts', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(RUNNER_SOURCE, path.join(hooksDir, 'lifecycle-runner.js'));
  if (stub) fs.writeFileSync(path.join(hooksDir, 'run-with-flags.js'), stub);
  return root;
}

function runIn(root, args, input) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'hooks', 'lifecycle-runner.js'), ...args], {
    input,
    encoding: 'utf8',
  });
}

const ECHO_STUB = [
  "const raw = require('fs').readFileSync(0, 'utf8');",
  "process.stdout.write('child:' + process.argv.slice(2).join('|') + ':' + raw);",
  "process.stderr.write('child-stderr');",
  'process.exit(Number(process.env.STUB_STATUS || 0));',
].join('\n');

const SILENT_STUB = "require('fs').readFileSync(0, 'utf8');";
const SLEEP_STUB = 'setTimeout(() => {}, 5000);';

function withRoot(stub, fn) {
  const root = makeRoot(stub);
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('hands the hook id, target and profiles to run-with-flags and returns its output', () => {
  withRoot(ECHO_STUB, root => {
    const result = runIn(root, ['stop:cost-tracker', 'scripts/hooks/cost-tracker.js', 'minimal,standard,strict', '30000', '0'], 'payload');
    assert.strictEqual(result.stdout, 'child:stop:cost-tracker|scripts/hooks/cost-tracker.js|minimal,standard,strict:payload');
    assert.strictEqual(result.stderr, 'child-stderr');
    assert.strictEqual(result.status, 0);
  });
});

test('forwards the exit status of the child', () => {
  withRoot(ECHO_STUB, root => {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'hooks', 'lifecycle-runner.js'), 'stop:probe', 'scripts/hooks/probe.js', 'standard', '30000', '0'], {
      input: 'payload',
      encoding: 'utf8',
      env: { ...process.env, STUB_STATUS: '2' },
    });
    assert.strictEqual(result.status, 2);
  });
});

test('passes stdin through when the child writes nothing', () => {
  withRoot(SILENT_STUB, root => {
    const result = runIn(root, ['stop:probe', 'scripts/hooks/probe.js', 'standard', '30000', '0'], 'payload');
    assert.strictEqual(result.stdout, 'payload');
    assert.strictEqual(result.status, 0);
  });
});

test('reports a child that outlives its timeout and exits with the fallback status', () => {
  withRoot(SLEEP_STUB, root => {
    const result = runIn(root, ['stop:probe', 'scripts/hooks/probe.js', 'standard', '300', '1'], 'payload');
    assert.strictEqual(result.stdout, 'payload');
    assert.match(result.stderr, /\[hook error\]/);
    assert.strictEqual(result.status, 1);
  });
});

test('passes stdin through and exits 0 when the root has no run-with-flags.js', () => {
  withRoot(null, root => {
    const result = runIn(root, ['stop:probe', 'scripts/hooks/probe.js', 'standard', '30000', '1'], 'payload');
    assert.strictEqual(result.stdout, 'payload');
    assert.strictEqual(result.status, 0);
  });
});

test('refuses arguments outside the hook grammar, passes stdin through and never starts the child', () => {
  withRoot(ECHO_STUB, root => {
    const bad = [
      ['stop:cost-tracker', '../../etc/passwd', 'standard', '30000', '0'],
      ['stop:cost-tracker', 'scripts/hooks/cost-tracker.js', 'standard; id', '30000', '0'],
      ['--inspect', 'scripts/hooks/cost-tracker.js', 'standard', '30000', '0'],
      ['stop:cost-tracker', 'scripts/hooks/cost-tracker.js', 'standard', 'abc', '0'],
    ];
    for (const args of bad) {
      const result = runIn(root, args, 'payload');
      assert.strictEqual(result.stdout, 'payload', args.join(' '));
      assert.match(result.stderr, /does not accept/, args.join(' '));
      assert.strictEqual(result.status, 0, args.join(' '));
    }
  });
});

for (const file of ['hooks/hooks.json', 'docs/hooks/memory-persistence/hooks.json']) {
  const entries = lifecycleCommands(file);

  test(`${file} runs lifecycle hooks through the runner and keeps no inline spawn`, () => {
    assert.ok(entries.length > 0, 'no lifecycle command found');
    const document = JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));
    const everyCommand = Object.values(document.hooks).flat().flatMap(group => group.hooks.map(hook => hook.command));
    assert.deepStrictEqual(everyCommand.filter(command => command.includes('spawnSync')), []);
  });

  test(`${file} gives every lifecycle command a hook id, a script under scripts/hooks, profiles, a timeout and a fallback status`, () => {
    for (const { command } of entries) {
      const [hookId, target, profiles, timeout, fallback] = argsOf(command);
      assert.match(hookId, /^[a-z]+:[a-z:-]+$/, command.slice(-120));
      assert.match(target, /^scripts\/hooks\/[a-z-]+\.js$/, command.slice(-120));
      assert.match(profiles, /^(minimal,)?standard,strict$/, command.slice(-120));
      assert.match(timeout, /^\d+$/, command.slice(-120));
      assert.match(fallback, /^[01]$/, command.slice(-120));
      assert.ok(fs.existsSync(path.join(REPO, target)), `${target} does not exist`);
    }
  });

  test(`${file} lifecycle commands run: a disabled hook passes its input through with status 0`, () => {
    const ids = entries.map(({ command }) => argsOf(command)[0]);
    for (const { command } of entries) {
      const result = spawnSync(command, {
        shell: true,
        input: '{"session_id":"lifecycle-runner-test"}',
        encoding: 'utf8',
        env: { ...process.env, EGC_PLUGIN_ROOT: REPO, EGC_DISABLED_HOOKS: ids.join(',') },
      });
      assert.strictEqual(result.status, 0, `${command.slice(-90)}: ${result.stderr}`);
      assert.strictEqual(result.stdout, '{"session_id":"lifecycle-runner-test"}', command.slice(-90));
    }
  });
}

test('Stop keeps the 300 s budget of the format and typecheck hook, and PreCompact exits 1 without a child status', () => {
  const entries = lifecycleCommands('hooks/hooks.json');
  const byId = new Map(entries.map(({ command }) => [argsOf(command)[0], argsOf(command)]));
  assert.strictEqual(byId.get('stop:format-typecheck')[3], '300000');
  assert.strictEqual(byId.get('pre:compact:egc-memory-save')[4], '1');
  for (const [id, args] of byId) {
    if (id !== 'stop:format-typecheck') assert.strictEqual(args[3], '30000', id);
    if (id !== 'pre:compact:egc-memory-save') assert.strictEqual(args[4], '0', id);
  }
});

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
