'use strict';

// The hook probe of egc doctor (PR-G1 of the September audit): every
// Guardian hook an install recorded is run with a call the Guardian always
// refuses, in its tool's own event shape, and a hook that does not refuse is
// an error. The contract cases run each probe event against the real script
// in this repository, so an adapter whose wire shape changes breaks here
// before a doctor run reports a working hook as broken.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  HOOK_PROBES,
  buildHookReport,
  isRefusal,
  probeHook,
  recordedGuardianHooks,
} = require('../../scripts/lib/doctor-hooks');
const { createInstallState, writeInstallState } = require('../../scripts/lib/install-state');

const REPO_ROOT = path.join(__dirname, '..', '..');
const HOOKS_DIR = path.join(REPO_ROOT, 'scripts', 'hooks');
const FAKE_CLI = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-guardian-cli.js');
const fakeEnv = { ...process.env, EGC_GUARDIAN_CLI: FAKE_CLI };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function script(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

test('every Guardian hook script in the repository has a probe', () => {
  const guardianScripts = fs.readdirSync(HOOKS_DIR).filter(name => (
    /-guardian-adapter\.js$/.test(name)
    || ['pre-bash-guardian-validate.js', 'pre-write-guardian-validate.js', 'bash-hook-dispatcher.js'].includes(name)
  ));
  const missing = guardianScripts.filter(name => !Object.hasOwn(HOOK_PROBES, name));
  assert.deepStrictEqual(missing, [], 'a new Guardian adapter needs its event in HOOK_PROBES');
});

for (const [name, probe] of Object.entries(HOOK_PROBES)) {
  test(`the probe event for ${name} is refused by the real script`, () => {
    const result = probeHook(path.join(HOOKS_DIR, name), probe.event(os.homedir()), {
      timeoutMs: 30000,
      env: fakeEnv,
      cwd: os.tmpdir(),
      what: probe.what,
    });
    assert.strictEqual(result.status, 'ok', `${name}: ${result.detail}`);
  });
}

test('refusals in every shape the tools read are recognized, and an allow is not', () => {
  assert.strictEqual(isRefusal({ status: 2, stdout: '' }), true);
  assert.strictEqual(isRefusal({ status: 0, stdout: '{"decision":"deny","reason":"x"}' }), true);
  assert.strictEqual(isRefusal({ status: 0, stdout: 'note\n{"permission":"deny"}\n' }), true);
  assert.strictEqual(isRefusal({ status: 0, stdout: '{"cancel":true}' }), true);
  assert.strictEqual(isRefusal({ status: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}' }), true);
  assert.strictEqual(isRefusal({ status: 0, stdout: '' }), false);
  assert.strictEqual(isRefusal({ status: 1, stdout: '' }), false, 'a crash is not a refusal: the tool runs the command');
  assert.strictEqual(isRefusal({ status: 0, stdout: '{"decision":"allow"}' }), false);
});

test('a hook that crashes, allows, is missing or hangs is reported with the reason', () => {
  const dir = tempDir('egc-doctor-hooks-');
  try {
    const options = { timeoutMs: 3000, env: process.env, cwd: dir };
    const crash = probeHook(script(dir, 'crash.js', "require('./not-there');\n"), {}, options);
    assert.strictEqual(crash.status, 'error');
    assert.strictEqual(crash.reason, 'allowed');
    assert.match(crash.detail, /exit 1/);
    assert.match(crash.detail, /not-there/, 'the stderr tail names what broke');

    const allow = probeHook(script(dir, 'allow.js', 'process.exit(0);\n'), {}, options);
    assert.strictEqual(allow.reason, 'allowed');

    const missing = probeHook(path.join(dir, 'gone.js'), {}, options);
    assert.strictEqual(missing.reason, 'missing');

    const hang = probeHook(script(dir, 'hang.js', 'setInterval(() => {}, 1000);\n'), {}, { ...options, timeoutMs: 500 });
    assert.strictEqual(hang.reason, 'timeout');

    const refuse = probeHook(script(dir, 'refuse.js', 'process.exitCode = 2;\n'), {}, options);
    assert.strictEqual(refuse.status, 'ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the report probes the Guardian hooks an install recorded, once per script, and nothing else', () => {
  const dir = tempDir('egc-doctor-hooks-state-');
  try {
    const hooksDir = path.join(dir, 'scripts', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const guardian = script(hooksDir, 'pre-bash-guardian-validate.js', 'process.exitCode = 2;\n');
    const crusher = script(hooksDir, 'crusher-hook.js', 'process.exit(0);\n');
    const statePath = path.join(dir, 'egc', 'install-state.json');
    const hookOperation = (scriptPath, matcher) => ({
      kind: 'merge-claude-settings-hooks',
      moduleId: 'egc-bash-guardian-hook',
      sourceRelativePath: `scripts/hooks/${path.basename(scriptPath)}`,
      destinationPath: path.join(dir, 'hooks.json'),
      strategy: 'merge-claude-settings-hooks',
      ownership: 'managed',
      scaffoldOnly: false,
      hookEvent: 'PreToolUse',
      hookMatcher: matcher,
      hookScriptPath: scriptPath,
    });
    writeInstallState(statePath, createInstallState({
      adapter: { id: 'codex-home', target: 'codex', kind: 'home' },
      targetRoot: dir,
      installStatePath: statePath,
      request: { profile: null, modules: [], includeComponents: [], excludeComponents: [], legacyLanguages: [], legacyMode: false },
      resolution: { selectedModules: [], skippedModules: [] },
      source: { repoVersion: '0.0.0', repoCommit: null, manifestVersion: 1 },
      operations: [hookOperation(guardian, 'Bash'), hookOperation(guardian, 'Shell'), hookOperation(crusher, 'Bash')],
    }));

    assert.deepStrictEqual(recordedGuardianHooks(statePath).map(hook => hook.script), ['pre-bash-guardian-validate.js']);
    const report = buildHookReport([{ adapter: { id: 'codex-home' }, installStatePath: statePath }], { homeDir: dir, timeoutMs: 5000 });
    assert.strictEqual(report.probes.length, 1);
    assert.strictEqual(report.probes[0].target, 'codex-home');
    assert.strictEqual(report.refusing, 1);
    assert.strictEqual(report.errorCount, 0);

    assert.deepStrictEqual(buildHookReport([{ adapter: { id: 'x' }, installStatePath: path.join(dir, 'none.json') }]).probes, [], 'no state, nothing to probe');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
