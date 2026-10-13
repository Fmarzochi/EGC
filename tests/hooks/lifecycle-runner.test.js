'use strict';

/**
 * Tests for scripts/hooks/lifecycle-runner.js, scripts/hooks/lifecycle-hooks.json
 * and the hook commands that run them.
 *
 * The PreCompact, Stop and SessionEnd entries of hooks/hooks.json used to carry
 * a 2.5 KB inline `node -e` program each. They now find the lifecycle runner with
 * the shared resolver and pass it the hook id and target script; the profiles,
 * timeout and fallback exit status live in lifecycle-hooks.json. These tests cover
 * the runner on its own and run every such command from hooks/hooks.json and
 * docs/hooks/memory-persistence/hooks.json.
 *
 * Run with: node tests/hooks/lifecycle-runner.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const REPO = path.join(__dirname, '..', '..');
const HOOKS_DIR = path.join(REPO, 'scripts', 'hooks');

const NO_ROOT_ENV = Object.fromEntries(
  ['EGC_PLUGIN_ROOT', 'ECC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CODEBUDDY_PLUGIN_ROOT', 'GEMINI_PLUGIN_ROOT', 'EGC_DIR'].map(name => [name, ''])
);

// The inline resolver also looks for an installed egc in every PATH
// directory, so on a machine that has EGC installed an empty home is not
// enough: the root is found and the hook really runs. The no-root case gets
// a PATH that holds node alone, in a folder of the temporary home.
function nodeOnlyDir(home) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  if (process.platform === 'win32') {
    const node = path.join(bin, 'node.exe');
    try {
      fs.linkSync(process.execPath, node);
    } catch {
      fs.copyFileSync(process.execPath, node);
    }
  } else {
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  }
  return bin;
}

function envWithoutRoot(home) {
  const env = { ...process.env, ...NO_ROOT_ENV, HOME: home, USERPROFILE: home };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === 'PATH') delete env[name];
  }
  return { ...env, PATH: nodeOnlyDir(home) };
}

const TABLE = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'lifecycle-hooks.json'), 'utf8'));
const RUNNER_MARK = 'scripts/hooks/lifecycle-runner.js';
const KNOWN_ID = 'stop:cost-tracker';

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

function argsFor(id) {
  return [id, TABLE[id].target];
}

function idOf(command) {
  return command.slice(command.lastIndexOf('" ') + 2).split(' ')[0];
}

function targetOf(command) {
  return command.slice(command.lastIndexOf('" ') + 2).split(' ')[1];
}

function makeRoot(stub) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-lifecycle-'));
  const hooksDir = path.join(root, 'scripts', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(path.join(HOOKS_DIR, 'lifecycle-runner.js'), path.join(hooksDir, 'lifecycle-runner.js'));
  fs.copyFileSync(path.join(HOOKS_DIR, 'lifecycle-hooks.json'), path.join(hooksDir, 'lifecycle-hooks.json'));
  if (stub) fs.writeFileSync(path.join(hooksDir, 'run-with-flags.js'), stub);
  return root;
}

function runIn(root, args, input, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'hooks', 'lifecycle-runner.js'), ...args], {
    input,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: { ...process.env, ...extraEnv },
  });
}

const ECHO_STUB = [
  "const raw = require('fs').readFileSync(0, 'utf8');",
  "process.stdout.write('child:' + process.argv.slice(2).join('|') + ':' + raw);",
  "process.stderr.write('child-stderr');",
  'process.exit(Number(process.env.STUB_STATUS || 0));',
].join('\n');

const SILENT_STUB = "require('fs').readFileSync(0, 'utf8');";
const HANG_STUB = "require('fs').readFileSync(0, 'utf8'); setInterval(() => {}, 1000);";
const SHORT_TIMEOUT_MS = 500;

function withRoot(stub, fn) {
  const root = makeRoot(stub);
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('hands the hook id, target and profiles from the table to run-with-flags and returns its output', () => {
  withRoot(ECHO_STUB, root => {
    const { target, profiles } = TABLE[KNOWN_ID];
    const result = runIn(root, argsFor(KNOWN_ID), 'payload');
    assert.strictEqual(result.stdout, `child:${KNOWN_ID}|${target}|${profiles}:payload`);
    assert.strictEqual(result.stderr, 'child-stderr');
    assert.strictEqual(result.status, 0);
  });
});

test('forwards the exit status of the child', () => {
  withRoot(ECHO_STUB, root => {
    const result = runIn(root, argsFor(KNOWN_ID), 'payload', { STUB_STATUS: '2' });
    assert.strictEqual(result.status, 2);
  });
});

test('passes stdin through when the child writes nothing', () => {
  withRoot(SILENT_STUB, root => {
    const result = runIn(root, argsFor(KNOWN_ID), 'payload');
    assert.strictEqual(result.stdout, 'payload');
    assert.strictEqual(result.status, 0);
  });
});

test('exits with the fallback status of the entry when the child is stopped by its timeout and reports none', () => {
  withRoot(HANG_STUB, root => {
    const tablePath = path.join(root, 'scripts', 'hooks', 'lifecycle-hooks.json');
    const shortTable = Object.fromEntries(Object.entries(TABLE).map(([id, entry]) => [id, { ...entry, timeoutMs: SHORT_TIMEOUT_MS }]));
    fs.writeFileSync(tablePath, JSON.stringify(shortTable));
    assert.strictEqual(runIn(root, argsFor('pre:compact:egc-memory-save'), 'payload').status, 1);
    assert.strictEqual(runIn(root, argsFor(KNOWN_ID), 'payload').status, 0);
  });
});

test('passes stdin through and exits 0 when the root has no run-with-flags.js', () => {
  withRoot(null, root => {
    const result = runIn(root, argsFor(KNOWN_ID), 'payload');
    assert.strictEqual(result.stdout, 'payload');
    assert.strictEqual(result.status, 0);
  });
});

test('refuses ids missing from the table, passes stdin through and never starts the child', () => {
  withRoot(ECHO_STUB, root => {
    const bad = [
      [],
      [KNOWN_ID],
      ['--inspect', TABLE[KNOWN_ID].target],
      ['stop:unknown', TABLE[KNOWN_ID].target],
      ['constructor', TABLE[KNOWN_ID].target],
      ['__proto__', TABLE[KNOWN_ID].target],
      [KNOWN_ID, '../../etc/passwd'],
      [KNOWN_ID, TABLE['stop:session-end'].target],
    ];
    for (const args of bad) {
      const result = runIn(root, args, 'payload');
      assert.strictEqual(result.stdout, 'payload', args.join(' '));
      assert.match(result.stderr, /does not know this hook id and script/, args.join(' '));
      assert.strictEqual(result.status, 0, args.join(' '));
    }
  });
});

test('every table entry names a script under scripts/hooks, known profiles, a timeout and a 0 or 1 fallback status', () => {
  const ids = Object.keys(TABLE);
  assert.ok(ids.length > 0, 'empty table');
  for (const id of ids) {
    const { target, profiles, timeoutMs, fallbackStatus } = TABLE[id];
    assert.match(id, /^[a-z]+(?::[a-z-]+)+$/, id);
    assert.match(target, /^scripts\/hooks\/[a-z-]+\.js$/, id);
    assert.match(profiles, /^(minimal,)?standard,strict$/, id);
    assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0, id);
    assert.ok(fallbackStatus === 0 || fallbackStatus === 1, id);
    assert.ok(fs.existsSync(path.join(REPO, target)), `${target} does not exist`);
  }
});

test('Stop keeps the 300 s budget of the format and typecheck hook, and PreCompact exits 1 without a child status', () => {
  for (const [id, entry] of Object.entries(TABLE)) {
    assert.strictEqual(entry.timeoutMs, id === 'stop:format-typecheck' ? 300000 : 30000, id);
    assert.strictEqual(entry.fallbackStatus, id === 'pre:compact:egc-memory-save' ? 1 : 0, id);
  }
});

for (const file of ['hooks/hooks.json', 'docs/hooks/memory-persistence/hooks.json']) {
  const entries = lifecycleCommands(file);

  test(`${file} runs lifecycle hooks through the runner and keeps no inline spawn`, () => {
    assert.ok(entries.length > 0, 'no lifecycle command found');
    const document = JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));
    const everyCommand = Object.values(document.hooks).flat().flatMap(group => group.hooks.map(hook => hook.command));
    assert.deepStrictEqual(everyCommand.filter(command => command.includes('spawnSync')), []);
  });

  test(`${file} gives every lifecycle command a hook id and the target script the table lists for it`, () => {
    for (const { command } of entries) {
      assert.ok(Object.hasOwn(TABLE, idOf(command)), command.slice(-120));
      assert.strictEqual(targetOf(command), TABLE[idOf(command)].target, command.slice(-120));
    }
  });

  test(`${file} lifecycle commands run: a disabled hook passes its input through with status 0`, () => {
    const ids = entries.map(({ command }) => idOf(command));
    for (const { command } of entries) {
      const result = spawnSync(command, {
        shell: true,
        input: '{"session_id":"lifecycle-runner-test"}',
        encoding: 'utf8',
        timeout: CLI_TIMEOUT_MS,
        env: { ...process.env, EGC_PLUGIN_ROOT: REPO, EGC_DISABLED_HOOKS: ids.join(',') },
      });
      assert.strictEqual(result.status, 0, `${command.slice(-90)}: ${result.stderr}`);
      assert.strictEqual(result.stdout, '{"session_id":"lifecycle-runner-test"}', command.slice(-90));
      assert.strictEqual(result.stderr, '', command.slice(-90));
    }
  });

  test(`${file} lifecycle commands pass stdin through when no EGC root can be found`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-lifecycle-home-'));
    try {
      const env = envWithoutRoot(home);
      for (const { command } of entries) {
        const result = spawnSync(command, {
          shell: true,
          input: '{"session_id":"lifecycle-runner-test"}',
          encoding: 'utf8',
          timeout: CLI_TIMEOUT_MS,
          env,
        });
        assert.strictEqual(result.status, 0, `${command.slice(-60)}: ${result.stderr}`);
        assert.strictEqual(result.stdout, '{"session_id":"lifecycle-runner-test"}', command.slice(-60));
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

for (const [label, table] of [['corrupt', '{not json'], ['missing', null]]) {
  test(`passes stdin through with status 0 when the lifecycle table is ${label}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-lifecycle-table-'));
    try {
      const copy = path.join(dir, 'lifecycle-runner.js');
      fs.copyFileSync(path.join(HOOKS_DIR, 'lifecycle-runner.js'), copy);
      if (table !== null) fs.writeFileSync(path.join(dir, 'lifecycle-hooks.json'), table);
      const result = spawnSync(process.execPath, [copy, KNOWN_ID, TABLE[KNOWN_ID].target], {
        input: '{"session_id":"lifecycle-runner-test"}',
        encoding: 'utf8',
        timeout: CLI_TIMEOUT_MS,
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, '{"session_id":"lifecycle-runner-test"}');
      assert.match(result.stderr, /could not read lifecycle-hooks\.json/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
