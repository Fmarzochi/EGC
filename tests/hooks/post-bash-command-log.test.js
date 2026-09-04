/**
 * post-bash-command-log.js writes every Bash command the agent ran to a log
 * under the user's home. Secrets embedded in the command must never reach
 * it, and the file must be private to the user (security audit 2026-08-17,
 * F7). The hook runs as a child with a synthetic HOME, exactly as installed.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'post-bash-command-log.js');
const { sanitizeCommand } = require(HOOK);

function permissionBitsEnforced() {
  if (process.platform === 'win32') return false;
  return !(typeof process.getuid === 'function' && process.getuid() === 0);
}

function runHook(home, command, mode = 'audit') {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  return spawnSync(process.execPath, [HOOK, mode], {
    input,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

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
  console.log('\n=== Testing post-bash-command-log.js ===\n');
  let passed = 0;
  let failed = 0;

  if (test('sanitizeCommand redacts headers, flags, assignments, URL credentials, vendor tokens and JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SomeSignatureHere1234567';
    const cmd = `curl -H "Authorization: Bearer abc.def.ghi" --token=t0p-secret -u admin:hunter2 "https://u:pa55@x.tld/?api_key=k123" && export GITHUB_TOKEN=ghp_${'A'.repeat(36)} sk-${'z'.repeat(24)} xoxb-1234567890-abc AKIAABCDEFGHIJKLMNOP ${jwt}`;
    const out = sanitizeCommand(cmd);
    for (const leaked of ['abc.def.ghi', 't0p-secret', 'pa55@', 'k123', 'ghp_' + 'A'.repeat(36), 'sk-' + 'z'.repeat(24), 'xoxb-1234567890-abc', 'AKIAABCDEFGHIJKLMNOP', jwt]) {
      assert.ok(!out.includes(leaked), `${leaked} must not survive: ${out}`);
    }
    assert.ok(out.includes('Authorization: Bearer <REDACTED>'), out);
    assert.ok(out.includes('https://u:<REDACTED>@x.tld'), out);
    assert.ok(out.startsWith('curl -H'), 'the command shape survives');
  })) passed++; else failed++;

  if (test('sanitizeCommand keeps basic-auth users, covers API-key headers, secret aliases and quoted values', () => {
    const cases = [
      ['curl -u admin:hunter2 https://x', 'curl -u admin:<REDACTED> https://x'],
      ['curl -H "X-API-Key: k-123" https://x', 'curl -H "X-API-Key: <REDACTED>" https://x'],
      ['AUTH=abc CREDENTIAL=ghi ./run', 'AUTH=<REDACTED> CREDENTIAL=<REDACTED> ./run'],
      ['x --token="abc def" --password=\'p w\' y', 'x --token=<REDACTED> --password=<REDACTED> y'],
      ['git push -u origin main', 'git push -u origin main'],
      ['git commit --author="Ann <a@x.tld>" -m x', 'git commit --author="Ann <a@x.tld>" -m x'],
    ];
    for (const [input, expected] of cases) assert.strictEqual(sanitizeCommand(input), expected, input);
  })) passed++; else failed++;

  if (test('sanitizeCommand keeps -u outside curl, covers key aliases and api secrets, and skips flags without a value', () => {
    const cases = [
      ['rsync -u user@host:src dest', 'rsync -u user@host:src dest'],
      ['sudo -u root:wheel ls', 'sudo -u root:wheel ls'],
      ['curl -sS -u admin:hunter2 https://x', 'curl -sS -u admin:<REDACTED> https://x'],
      ['cmd --api_secret abc', 'cmd --api_secret <REDACTED>'],
      ['AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP PRIVATEKEY=p API-KEY=q MY_ACCESS_KEY=r ./run', 'AWS_ACCESS_KEY_ID=<REDACTED> PRIVATEKEY=<REDACTED> API-KEY=<REDACTED> MY_ACCESS_KEY=<REDACTED> ./run'],
      ['tool --secret --other flag', 'tool --secret --other flag'],
      ['tool --token=-hunter2 TOKEN=-hunter2 x', 'tool --token=<REDACTED> TOKEN=<REDACTED> x'],
      ['curl -uadmin:hunter2 https://x', 'curl -uadmin:<REDACTED> https://x'],
      ['curl -uadmin:pw1 -u root:pw2 -u=ops:pw3 https://x', 'curl -uadmin:<REDACTED> -u root:<REDACTED> -u=ops:<REDACTED> https://x'],
      ['sudo -u root:wheel curl -u admin:pw https://x', 'sudo -u root:wheel curl -u admin:<REDACTED> https://x'],
      ['CURL -u admin:pw https://x', 'CURL -u admin:<REDACTED> https://x'],
      ['curl -u :hunter2 https://x', 'curl -u :<REDACTED> https://x'],
      ['curl -d "a;b|c&d" -u admin:pw https://x', 'curl -d "a;b|c&d" -u admin:<REDACTED> https://x'],
      ['curl https://x\nrsync -u user@host:src dest', 'curl https://x rsync -u user@host:src dest'],
      ['curl -u ":hunter 2" https://x', 'curl -u ":<REDACTED>" https://x'],
      ['curl -u ":" https://x', 'curl -u ":<REDACTED>" https://x'],
      ["curl -d 'a\\' -u admin:pw https://x", "curl -d 'a\\' -u admin:<REDACTED> https://x"],
      ['curl --user admin:pw https://x', 'curl --user admin:<REDACTED> https://x'],
      ['echo curl\n-u user:pw', 'echo curl -u user:pw'],
      [`curl ${'-u a:b '.repeat(400)}https://x`, `curl ${'-u a:<REDACTED> '.repeat(400)}https://x`],
      ['curl.exe -u admin:pw https://x', 'curl.exe -u admin:<REDACTED> https://x'],
      ['C:/tools/CURL.EXE -u admin:pw https://x', 'C:/tools/CURL.EXE -u admin:<REDACTED> https://x'],
      ["sh -c 'curl -u user:pw https://x'", "sh -c 'curl -u user:<REDACTED> https://x'"],
      ['echo $(curl -u user:pw https://x)', 'echo $(curl -u user:<REDACTED> https://x)'],
      ['echo pre$(curl -u user:pw https://x)', 'echo pre$(curl -u user:<REDACTED> https://x)'],
      ['cat <(curl -u user:pw https://x)', 'cat <(curl -u user:<REDACTED> https://x)'],
      ['RESULT=$(curl -u user:pw https://x) ./run', 'RESULT=$(curl -u user:<REDACTED> https://x) ./run'],
      ['echo `curl -u user:pw https://x`', 'echo `curl -u user:<REDACTED> https://x`'],
      ['echo "c\'url" -u user@host:src', 'echo "c\'url" -u user@host:src'],
      ["c'url' -u admin:pw https://x", "c'url' -u admin:<REDACTED> https://x"],
      ...(require('node:os').platform() === 'win32' ? [] : [['c\\url -u admin:pw https://x', 'c\\url -u admin:<REDACTED> https://x']]),
      ['echo curl\n-u user:pw', 'echo curl -u user:pw'],
      [`curl ${'-u a:b '.repeat(400)}https://x`, `curl ${'-u a:<REDACTED> '.repeat(400)}https://x`],
    ];
    for (const [input, expected] of cases) assert.strictEqual(sanitizeCommand(input), expected, input);
  })) passed++; else failed++;

  if (test('sanitizeCommand leaves ordinary commands untouched', () => {
    for (const cmd of ['git status', 'npm test -- --grep token', 'ls -la ~/.ssh', 'echo "read the password policy"', 'git checkout 4f054e08']) {
      assert.strictEqual(sanitizeCommand(cmd), cmd);
    }
  })) passed++; else failed++;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'post-bash-command-log-'));
  const logFile = path.join(home, '.gemini', 'bash-commands.log');
  try {
    if (test('the hook logs a redacted line and passes its input through unchanged', () => {
      const result = runHook(home, 'curl -H "Authorization: Bearer abc.def.ghi" https://api.example.test');
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('"tool_name":"Bash"'), 'stdin must be passed through');
      const text = fs.readFileSync(logFile, 'utf8');
      assert.ok(!text.includes('abc.def.ghi'), text);
      assert.ok(text.includes('Authorization: Bearer <REDACTED>'), text);
    })) passed++; else failed++;

    if (test('the log file is private to the user and a permissive copy is tightened on the next write', () => {
      if (!permissionBitsEnforced()) {
        console.log('    - skipped: directory permission bits are not enforced here (root, or Windows)');
        return;
      }
      assert.strictEqual(fs.statSync(logFile).mode & 0o777, 0o600, 'fresh log must be 0600');
      assert.strictEqual(fs.statSync(path.dirname(logFile)).mode & 0o777, 0o700, 'a directory the hook created must be 0700');
      fs.chmodSync(logFile, 0o644);
      const result = runHook(home, 'git status');
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.statSync(logFile).mode & 0o777, 0o600, 'an existing world-readable log must be tightened');
    })) passed++; else failed++;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
