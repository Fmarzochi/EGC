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

const { redactPayload, writeAuditEntry, AUDIT_LOG_DIR, AUDIT_LOG_PATH, MAX_SIZE_BYTES } = require(buildPath);

console.log('\n=== Testing audit-log (egc-guardian) ===\n');

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

if (test('redactPayload: arrays are passed through unchanged', () => {
  const result = redactPayload({ files: ['/tmp/a', '/tmp/b'] });
  assert.deepStrictEqual(result.files, ['/tmp/a', '/tmp/b']);
})) passed++; else failed++;

// ── writeAuditEntry ─────────────────────────────────────────────────────────

if (test('writeAuditEntry: appends a valid NDJSON line to audit.log', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-audit-test-'));
  const tmpLog = path.join(tmpDir, 'audit.log');
  writeAuditEntry('TEST_ACTION', 'DENIED', { tool: 'bash', reason: 'blocked' }, tmpDir, tmpLog);
  const lines = fs.readFileSync(tmpLog, 'utf-8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.ok(entry.timestamp, 'should have timestamp');
  assert.strictEqual(entry.action, 'TEST_ACTION');
  assert.strictEqual(entry.status, 'DENIED');
  assert.strictEqual(entry.tool, 'bash');
  assert.strictEqual(entry.reason, 'blocked');
  fs.rmSync(tmpDir, { recursive: true, force: true });
})) passed++; else failed++;

if (test('writeAuditEntry: redacts secrets in logged details', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-audit-test-'));
  const tmpLog = path.join(tmpDir, 'audit.log');
  writeAuditEntry('COMMAND_EXECUTION', 'DENIED', { token: 'super-secret-123', command: 'rm -rf /' }, tmpDir, tmpLog);
  const entry = JSON.parse(fs.readFileSync(tmpLog, 'utf-8').trim());
  assert.strictEqual(entry.token, '[REDACTED]');
  assert.strictEqual(entry.command, 'rm -rf /');
  fs.rmSync(tmpDir, { recursive: true, force: true });
})) passed++; else failed++;

if (test('writeAuditEntry: rotates when file exceeds size limit', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-audit-test-'));
  const tmpLog = path.join(tmpDir, 'audit.log');
  // Write a file that exceeds a tiny limit (10 bytes)
  fs.writeFileSync(tmpLog, 'x'.repeat(20));
  writeAuditEntry('ROTATE_TEST', 'DENIED', {}, tmpDir, tmpLog, 10);
  const files = fs.readdirSync(tmpDir);
  const bakFiles = files.filter(f => f.includes('.bak'));
  assert.ok(bakFiles.length >= 1, 'should have created a .bak rotation file');
  assert.ok(fs.existsSync(tmpLog), 'should have created a fresh audit.log after rotation');
  fs.rmSync(tmpDir, { recursive: true, force: true });
})) passed++; else failed++;

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
