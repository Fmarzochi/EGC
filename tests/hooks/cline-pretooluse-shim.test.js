/**
 * Tests for scripts/hooks/cline-pretooluse-shim.js
 *
 * This is the literal file Cline discovers and spawns directly as
 * .clinerules/hooks/PreToolUse -- it just relays stdin/stdout/exit code to
 * the real adapter at ../scripts/hooks/cline-guardian-adapter.js. Covers
 * the cubic-dev-ai P0 finding (PR #1087): if that target can't even be
 * spawned, the shim must fail CLOSED ({cancel: true}), not silently report
 * exit 0 with no output (which Cline would treat as an unconditional
 * allow, running the Guardian in name only).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');
const shimSource = path.join(repoRoot, 'scripts', 'hooks', 'cline-pretooluse-shim.js');

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

function runShim(shimPath, input) {
  const result = spawnSync('node', [shimPath], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// The shim resolves its target as __dirname/../scripts/hooks/cline-guardian-
// adapter.js, i.e. it assumes it lives at <root>/hooks/PreToolUse with the
// real adapter at <root>/scripts/hooks/ -- the exact layout
// cline-project.js's planOperations produces. Reproduces that layout in an
// isolated temp dir so the test exercises the real path relationship
// instead of running the shim from its own source location (a different,
// unrelated relative layout).
//
// For the "relay unchanged" cases, the target is a trivial stand-in script,
// not the real cline-guardian-adapter.js -- this test's job is only to
// prove the shim relays whatever valid JSON its target prints, verbatim
// (or fails closed when it doesn't); the Guardian's own allow/deny
// decisions for real commands are covered where they belong, at the
// adapter layer (tests/hooks/cline-guardian-adapter.test.js) and by a real
// isolated `egc install` end-to-end check.
function buildInstalledLayout({ targetScript }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-cline-shim-test-'));
  const hooksDir = path.join(root, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const shimPath = path.join(hooksDir, 'PreToolUse');
  fs.copyFileSync(shimSource, shimPath);

  if (targetScript) {
    const scriptsHooksDir = path.join(root, 'scripts', 'hooks');
    fs.mkdirSync(scriptsHooksDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsHooksDir, 'cline-guardian-adapter.js'), targetScript);
  }

  return shimPath;
}

function runTests() {
  console.log('\n=== Testing cline-pretooluse-shim ===\n');

  let passed = 0;
  let failed = 0;

  if (test('fails CLOSED ({cancel: true}, non-zero exit) when the real adapter cannot be spawned', () => {
    const isolatedShim = buildInstalledLayout({ targetScript: null });

    const result = runShim(isolatedShim, JSON.stringify({ preToolUse: { toolName: 'execute_command', parameters: { command: 'git status' } } }));

    assert.notStrictEqual(result.code, 0, 'Expected a non-zero exit when the target adapter is missing');
    const response = JSON.parse(result.stdout);
    assert.strictEqual(response.cancel, true, 'Must fail closed, not silently allow, when the Guardian could not even run');
    assert.ok(response.errorMessage && response.errorMessage.length > 0, 'expected a non-empty errorMessage explaining the failure');
  })) passed++; else failed++;

  if (test('fails CLOSED when the target runs but never prints valid JSON', () => {
    const isolatedShim = buildInstalledLayout({ targetScript: '#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdout.write("not json");\n' });

    const result = runShim(isolatedShim, JSON.stringify({ preToolUse: { toolName: 'execute_command', parameters: { command: 'git status' } } }));

    const response = JSON.parse(result.stdout);
    assert.strictEqual(response.cancel, true, 'A crashed/malformed target response must not be treated as an implicit allow');
  })) passed++; else failed++;

  if (test('relays a target\'s allow decision unchanged when it runs normally', () => {
    const installedShim = buildInstalledLayout({ targetScript: '#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdout.write(JSON.stringify({cancel:false}));\n' });
    const result = runShim(installedShim, JSON.stringify({ preToolUse: { toolName: 'execute_command', parameters: { command: 'git status' } } }));
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { cancel: false });
  })) passed++; else failed++;

  if (test('relays a target\'s deny decision unchanged when it runs normally', () => {
    const installedShim = buildInstalledLayout({ targetScript: '#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdout.write(JSON.stringify({cancel:true,errorMessage:"blocked"}));\n' });
    const result = runShim(installedShim, JSON.stringify({ preToolUse: { toolName: 'execute_command', parameters: { command: 'rm -rf /' } } }));
    assert.strictEqual(result.code, 0, 'Cline honors the JSON body regardless of exit code');
    assert.deepStrictEqual(JSON.parse(result.stdout), { cancel: true, errorMessage: 'blocked' });
  })) passed++; else failed++;

  if (test('forwards the real stdin payload to the target, not an empty/detached stream', () => {
    // Regression guard for a real bug found while verifying this fix end
    // to end: an earlier version of the shim captured the target's stdout
    // via spawnSync without also passing the shim's OWN received stdin
    // through as `input`, so the target always saw an empty stdin -- a
    // real isolated `egc install` + direct invocation showed EVERY command
    // (including "rm -rf /") coming back {cancel:false}, because the
    // target's own stdin-parsing fell through its malformed/empty-input
    // fail-open path every time, never seeing the actual command at all.
    const echoTarget = '#!/usr/bin/env node\nlet raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({cancel:false,echoedStdin:raw})));\n';
    const installedShim = buildInstalledLayout({ targetScript: echoTarget });
    const payload = JSON.stringify({ preToolUse: { toolName: 'execute_command', parameters: { command: 'echo distinctive-marker-38fa21' } } });

    const result = runShim(installedShim, payload);

    assert.strictEqual(result.code, 0);
    const response = JSON.parse(result.stdout);
    assert.strictEqual(response.echoedStdin, payload, 'The exact stdin this test sent to the shim must reach the target unchanged');
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
