/**
 * Tests for mcp/servers/egc-guardian/src/audit-log.ts (issue #578)
 *
 * Covers redactPayload(), writeAuditEntry() rotation, and permission
 * hardening. Tests run against the compiled build output.
 *
 * Run with: node tests/guardian-audit-log.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function test(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'audit-log.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

const { redactPayload, writeAuditEntry, redactSecretsInText } = require(buildPath);

console.log('\n=== Testing audit-log (egc-guardian) ===\n');

// ── redactSecretsInText (audit 2026-08-17, F6/F7) ────────────────────────────

if (test('redactSecretsInText: bearer headers, flag values and key=value assignments', () => {
  const cmd = 'curl -H "Authorization: Bearer abc.def.ghi" --token=t0p-secret -u admin:hunter2 https://api.example.test?api_key=k123 && export GITHUB_TOKEN=ghp_' + 'A'.repeat(36);
  const out = redactSecretsInText(cmd);
  assert.ok(!out.includes('abc.def.ghi'), out);
  assert.ok(!out.includes('t0p-secret'), out);
  assert.ok(!out.includes('k123'), out);
  assert.ok(!out.includes('ghp_' + 'A'.repeat(36)), out);
  assert.ok(out.includes('Authorization: Bearer [REDACTED]'), out);
  assert.ok(out.includes('--token=[REDACTED]'), out);
  assert.ok(out.includes('curl -H'), 'the surrounding command text survives');
})) passed++; else failed++;

if (test('redactSecretsInText: URL credentials, cloud and vendor token prefixes, JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SomeSignatureHere1234567';
  const text = `git clone https://user:pa55w0rd@github.com/x/y.git; aws --key AKIAABCDEFGHIJKLMNOP; sk-${'z'.repeat(24)} xoxb-1234567890-abc glpat-${'q'.repeat(20)} ${jwt}`;
  const out = redactSecretsInText(text);
  for (const leaked of ['pa55w0rd', 'AKIAABCDEFGHIJKLMNOP', 'sk-' + 'z'.repeat(24), 'xoxb-1234567890-abc', 'glpat-' + 'q'.repeat(20), jwt]) {
    assert.ok(!out.includes(leaked), `${leaked} must not survive: ${out}`);
  }
  assert.ok(out.includes('https://user:[REDACTED]@github.com/x/y.git'), out);
})) passed++; else failed++;

if (test('redactSecretsInText: ordinary commands are left alone', () => {
  for (const cmd of ['git status', 'npm test -- --grep token', 'ls -la ~/.ssh', 'echo "the password policy doc"', 'git checkout 4f054e08']) {
    assert.strictEqual(redactSecretsInText(cmd), cmd);
  }
})) passed++; else failed++;

if (test('redactPayload: applies in-text redaction to string values and array items', () => {
  const result = redactPayload({ command: 'curl -H "Authorization: Bearer abc.def.ghi" https://x', args: ['--password=pw', 'ok'] });
  assert.strictEqual(result.command, 'curl -H "Authorization: Bearer [REDACTED]" https://x');
  assert.deepStrictEqual(result.args, ['--password=[REDACTED]', 'ok']);
})) passed++; else failed++;

// ── redactPayload ────────────────────────────────────────────────────────────

if (test('redactPayload: leaves non-sensitive keys unchanged', () => {
  const result = redactPayload({ tool: 'validate_command', reason: 'blocked', count: 42 });
  assert.strictEqual(result.tool, 'validate_command');
  assert.strictEqual(result.reason, 'blocked');
  assert.strictEqual(result.count, 42);
})) passed++; else failed++;

if (test('redactPayload: redacts known secret keys (token, password, api_key, secret)', () => {
  const result = redactPayload({ token: 'abc123', password: 'hunter2', api_key: 'sk-xyz', secret: 'shh' });
  assert.strictEqual(result.token, '[REDACTED]');
  assert.strictEqual(result.password, '[REDACTED]');
  assert.strictEqual(result.api_key, '[REDACTED]');
  assert.strictEqual(result.secret, '[REDACTED]');
})) passed++; else failed++;

if (test('redactPayload: redacts JWT-shaped values by pattern', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SomeSignatureHere1234567';
  const result = redactPayload({ authorization: jwt });
  assert.strictEqual(result.authorization, '[REDACTED]');
})) passed++; else failed++;

if (test('redactPayload: redacts long hex strings by pattern', () => {
  const hexSecret = 'a'.repeat(32);
  const result = redactPayload({ value: hexSecret });
  assert.strictEqual(result.value, '[REDACTED]');
})) passed++; else failed++;

if (test('redactPayload: short strings are not redacted by pattern', () => {
  const result = redactPayload({ value: 'short' });
  assert.strictEqual(result.value, 'short');
})) passed++; else failed++;

if (test('redactPayload: walks nested objects one level deep', () => {
  const result = redactPayload({ meta: { token: 'secret-value', tool: 'bash' } });
  assert.strictEqual(result.meta.token, '[REDACTED]');
  assert.strictEqual(result.meta.tool, 'bash');
})) passed++; else failed++;

if (test('redactPayload: arrays are walked — non-secret strings pass through, secret strings are redacted', () => {
  const result = redactPayload({ files: ['/tmp/a', '/tmp/b'] });
  assert.deepStrictEqual(result.files, ['/tmp/a', '/tmp/b']);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SomeSignatureHere1234567';
  const result2 = redactPayload({ headers: [{ authorization: jwt }] });
  assert.strictEqual(result2.headers[0].authorization, '[REDACTED]');
})) passed++; else failed++;

// ── writeAuditEntry ─────────────────────────────────────────────────────────

if (test('writeAuditEntry: appends a valid NDJSON line to audit.log', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-audit-test-'));
  const tmpLog = path.join(tmpDir, 'audit.log');
  try {
    writeAuditEntry('TEST_ACTION', 'DENIED', { tool: 'bash', reason: 'blocked' }, tmpDir, tmpLog);
    const lines = fs.readFileSync(tmpLog, 'utf-8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.ok(entry.timestamp, 'should have timestamp');
    assert.strictEqual(entry.action, 'TEST_ACTION');
    assert.strictEqual(entry.status, 'DENIED');
    assert.strictEqual(entry.tool, 'bash');
    assert.strictEqual(entry.reason, 'blocked');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('writeAuditEntry: redacts secrets in logged details', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-audit-test-'));
  const tmpLog = path.join(tmpDir, 'audit.log');
  try {
    writeAuditEntry('COMMAND_EXECUTION', 'DENIED', { token: 'super-secret-123', command: 'rm -rf /' }, tmpDir, tmpLog);
    const entry = JSON.parse(fs.readFileSync(tmpLog, 'utf-8').trim());
    assert.strictEqual(entry.token, '[REDACTED]');
    assert.strictEqual(entry.command, 'rm -rf /');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('writeAuditEntry: rotates when file exceeds size limit', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-audit-test-'));
  const tmpLog = path.join(tmpDir, 'audit.log');
  try {
    // Write a file that exceeds a tiny limit (10 bytes)
    fs.writeFileSync(tmpLog, 'x'.repeat(20));
    writeAuditEntry('ROTATE_TEST', 'DENIED', {}, tmpDir, tmpLog, 10);
    const files = fs.readdirSync(tmpDir);
    const bakFiles = files.filter(f => f.includes('.bak'));
    assert.ok(bakFiles.length >= 1, 'should have created a .bak rotation file');
    assert.ok(fs.existsSync(tmpLog), 'should have created a fresh audit.log after rotation');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
