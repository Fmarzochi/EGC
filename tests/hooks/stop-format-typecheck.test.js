/**
 * Tests for scripts/hooks/post-edit-accumulator.js and
 *           scripts/hooks/stop-format-typecheck.js
 *
 * Run with: node tests/hooks/stop-format-typecheck.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const accumulator = require('../../scripts/hooks/post-edit-accumulator');
const { parseAccumulator } = require('../../scripts/hooks/stop-format-typecheck');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;

// Use a unique session ID for tests so we don't pollute real sessions
const TEST_SESSION_ID = `test-${Date.now()}`;
const origSessionId = process.env.EGC_SESSION_ID;
process.env.EGC_SESSION_ID = TEST_SESSION_ID;

function getAccumFile() {
  return path.join(os.tmpdir(), `egc-edited-${TEST_SESSION_ID}.txt`);
}

function cleanAccumFile() {
  try { fs.unlinkSync(getAccumFile()); } catch { /* doesn't exist */ }
}

// ── post-edit-accumulator.js ─────────────────────────────────────

console.log('\npost-edit-accumulator: pass-through behavior');
console.log('=============================================\n');

if (test('returns original input unchanged', () => {
  cleanAccumFile();
  const input = JSON.stringify({ tool_input: { file_path: '/tmp/x.ts' } });
  const result = accumulator.run(input);
  assert.strictEqual(result, input);
  cleanAccumFile();
})) passed++; else failed++;

if (test('returns original input for invalid JSON', () => {
  cleanAccumFile();
  const input = 'not json';
  const result = accumulator.run(input);
  assert.strictEqual(result, input);
})) passed++; else failed++;

if (test('returns original input when no file_path', () => {
  cleanAccumFile();
  const input = JSON.stringify({ tool_input: { command: 'ls' } });
  const result = accumulator.run(input);
  assert.strictEqual(result, input);
  cleanAccumFile();
})) passed++; else failed++;

console.log('\npost-edit-accumulator: file accumulation');
console.log('=========================================\n');

if (test('creates accumulator file for a .ts file', () => {
  cleanAccumFile();
  const input = JSON.stringify({ tool_input: { file_path: '/tmp/foo.ts' } });
  accumulator.run(input);
  const accumFile = getAccumFile();
  assert.ok(fs.existsSync(accumFile), 'accumulator file should exist');
  const lines = fs.readFileSync(accumFile, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.includes('/tmp/foo.ts'));
  cleanAccumFile();
})) passed++; else failed++;

if (test('accumulates multiple files across calls', () => {
  cleanAccumFile();
  accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/a.ts' } }));
  accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/b.tsx' } }));
  accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/c.js' } }));
  const lines = fs.readFileSync(getAccumFile(), 'utf8').split('\n').filter(Boolean);
  assert.deepStrictEqual(lines, ['/tmp/a.ts', '/tmp/b.tsx', '/tmp/c.js']);
  cleanAccumFile();
})) passed++; else failed++;

if (test('all appended paths are preserved including duplicates (dedup is Stop hook responsibility)', () => {
  cleanAccumFile();
  accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/a.ts' } }));
  accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/b.ts' } }));
  accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/a.ts' } })); // duplicate
  const lines = fs.readFileSync(getAccumFile(), 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 3); // all three appends land
  assert.strictEqual(new Set(lines).size, 2); // two unique paths
  cleanAccumFile();
})) passed++; else failed++;

if (test('accumulates Write tool file_path', () => {
  cleanAccumFile();
  accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/new-file.ts' } }));
  const lines = fs.readFileSync(getAccumFile(), 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.includes('/tmp/new-file.ts'));
  cleanAccumFile();
})) passed++; else failed++;

if (test('accumulates MultiEdit edits array paths', () => {
  cleanAccumFile();
  accumulator.run(JSON.stringify({
    tool_input: {
      edits: [
        { file_path: '/tmp/multi-a.ts', old_string: 'a', new_string: 'b' },
        { file_path: '/tmp/multi-b.tsx', old_string: 'c', new_string: 'd' },
        { file_path: '/tmp/skip.md', old_string: 'e', new_string: 'f' }
      ]
    }
  }));
  const lines = fs.readFileSync(getAccumFile(), 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.includes('/tmp/multi-a.ts'));
  assert.ok(lines.includes('/tmp/multi-b.tsx'));
  assert.ok(!lines.includes('/tmp/skip.md'), 'non-JS/TS should be excluded');
  cleanAccumFile();
})) passed++; else failed++;

if (test('does not create accumulator file for non-JS/TS files', () => {
  cleanAccumFile();
  accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/README.md' } }));
  accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/styles.css' } }));
  assert.ok(!fs.existsSync(getAccumFile()), 'no accumulator for non-JS/TS files');
})) passed++; else failed++;

if (test('handles .tsx and .jsx extensions', () => {
  cleanAccumFile();
  accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/comp.tsx' } }));
  accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/comp.jsx' } }));
  const lines = fs.readFileSync(getAccumFile(), 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.includes('/tmp/comp.tsx'));
  assert.ok(lines.includes('/tmp/comp.jsx'));
  cleanAccumFile();
})) passed++; else failed++;

// ── stop-format-typecheck: accumulator teardown ──────────────────

console.log('\nstop-format-typecheck: accumulator cleanup');
console.log('==========================================\n');

if (test('stop hook removes accumulator file after reading it', () => {
  cleanAccumFile();
  fs.writeFileSync(getAccumFile(), '/nonexistent/file.ts\n', 'utf8');
  assert.ok(fs.existsSync(getAccumFile()), 'accumulator should exist before stop hook');

  // Require the stop hook and invoke main() directly via its stdin entry.
  // We simulate the stdin+stdout flow by spawning node and feeding empty stdin.
  const { execFileSync } = require('child_process');
  const stopScript = path.resolve(__dirname, '../../scripts/hooks/stop-format-typecheck.js');
  try {
    execFileSync('node', [stopScript], {
      input: '{}',
      env: { ...process.env, EGC_SESSION_ID: TEST_SESSION_ID },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000
    });
  } catch {
    // tsc/formatter may fail for the nonexistent file: that's OK
  }

  assert.ok(!fs.existsSync(getAccumFile()), 'accumulator file should be deleted by stop hook');
})) passed++; else failed++;

if (test('stop hook is a no-op when no accumulator exists', () => {
  cleanAccumFile();
  const { execFileSync } = require('child_process');
  const stopScript = path.resolve(__dirname, '../../scripts/hooks/stop-format-typecheck.js');
  // Should exit cleanly with no errors
  execFileSync('node', [stopScript], {
    input: '{}',
    env: { ...process.env, EGC_SESSION_ID: TEST_SESSION_ID },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000
  });
})) passed++; else failed++;

if (test('parseAccumulator deduplicates repeated paths', () => {
  const raw = '/tmp/a.ts\n/tmp/b.ts\n/tmp/a.ts\n/tmp/a.ts\n/tmp/c.js\n';
  const result = parseAccumulator(raw);
  assert.deepStrictEqual(result, ['/tmp/a.ts', '/tmp/b.ts', '/tmp/c.js']);
})) passed++; else failed++;

if (test('parseAccumulator ignores blank lines and trims whitespace', () => {
  const raw = '  /tmp/a.ts  \n\n/tmp/b.ts\n\n';
  const result = parseAccumulator(raw);
  assert.deepStrictEqual(result, ['/tmp/a.ts', '/tmp/b.ts']);
})) passed++; else failed++;

if (test('stop hook clears accumulator after processing duplicates', () => {
  cleanAccumFile();
  fs.writeFileSync(getAccumFile(), '/nonexistent/x.ts\n/nonexistent/x.ts\n/nonexistent/y.ts\n', 'utf8');
  const { execFileSync } = require('child_process');
  const stopScript = path.resolve(__dirname, '../../scripts/hooks/stop-format-typecheck.js');
  try {
    execFileSync('node', [stopScript], {
      input: '{}',
      env: { ...process.env, EGC_SESSION_ID: TEST_SESSION_ID },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000
    });
  } catch { /* formatter/tsc may fail for nonexistent files */ }
  assert.ok(!fs.existsSync(getAccumFile()), 'accumulator cleared after stop hook');
})) passed++; else failed++;

if (test('stop hook passes stdin through unchanged', () => {
  cleanAccumFile();
  const { execFileSync } = require('child_process');
  const stopScript = path.resolve(__dirname, '../../scripts/hooks/stop-format-typecheck.js');
  const input = '{"stop_reason":"end_turn"}';
  const result = execFileSync('node', [stopScript], {
    input,
    env: { ...process.env, EGC_SESSION_ID: TEST_SESSION_ID },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000
  });
  assert.strictEqual(result.toString(), input);
})) passed++; else failed++;

console.log('\npost-edit-accumulator: C12 hardening\n=====================================\n');

if (process.platform !== 'win32') {
  if (test('the accumulator file is created with no group/other access, not the process umask', () => {
    cleanAccumFile();
    accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/x.ts' } }));
    const mode = fs.statSync(getAccumFile()).mode & 0o777;
    // openSync ANDs the requested 0600 against the process umask, but 0600
    // already excludes group/other bits, so only a umask that also clears
    // owner bits (e.g. 0777) narrows the file -- down to 0000, which is not
    // "still-private" but owner-unreadable, and makes the Stop-side
    // readFileNoFollow fail so the whole batch is silently dropped (cubic
    // review, confidence 8). Group/other access must stay zero, and the
    // owner must still be able to read what was just written.
    assert.strictEqual(mode & 0o077, 0, `expected no group/other access, got ${mode.toString(8)}`);
    assert.ok(mode & 0o400, `expected the owner to still be able to read the file, got ${mode.toString(8)}`);
    cleanAccumFile();
  })) passed++; else failed++;
}

if (test('a path containing a newline is dropped instead of injecting an extra entry', () => {
  cleanAccumFile();
  accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/real.ts\n/tmp/injected.ts' } }));
  assert.ok(!fs.existsSync(getAccumFile()), 'nothing is written for a path carrying a newline');
  cleanAccumFile();
})) passed++; else failed++;

if (process.platform !== 'win32') {
  if (test('appendPath refuses to follow a symlink planted at the accumulator path', () => {
    cleanAccumFile();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-accum-target-'));
    const target = path.join(outside, 'victim.ts');
    fs.writeFileSync(target, '// untouched\n');
    fs.symlinkSync(target, getAccumFile());
    accumulator.run(JSON.stringify({ tool_input: { file_path: '/tmp/x.ts' } }));
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '// untouched\n', 'the symlink target is never written through');
    fs.unlinkSync(getAccumFile());
    fs.rmSync(outside, { recursive: true, force: true });
  })) passed++; else failed++;

  if (test('the Stop hook refuses to read through a symlink planted at the accumulator path', () => {
    cleanAccumFile();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-accum-target-'));
    const target = path.join(outside, 'secret.ts');
    fs.writeFileSync(target, '/some/private/path.ts\n');
    fs.symlinkSync(target, getAccumFile());
    const { execFileSync } = require('child_process');
    const stopScript = path.resolve(__dirname, '../../scripts/hooks/stop-format-typecheck.js');
    execFileSync('node', [stopScript], {
      input: '{}',
      env: { ...process.env, EGC_SESSION_ID: TEST_SESSION_ID },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000
    });
    assert.ok(fs.existsSync(getAccumFile()), 'the symlink itself is left alone, never unlinked as if it had been read');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '/some/private/path.ts\n', 'the link target is never touched');
    fs.unlinkSync(getAccumFile());
    fs.rmSync(outside, { recursive: true, force: true });
  })) passed++; else failed++;
}

if (origSessionId === undefined) {
  delete process.env.EGC_SESSION_ID;
} else {
  process.env.EGC_SESSION_ID = origSessionId;
}

console.log(`\n=== Test Results ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);

process.exit(failed > 0 ? 1 : 0);
