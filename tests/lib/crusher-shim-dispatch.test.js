'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DISPATCH_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'lib', 'crusher', 'shim-dispatch.js');
const { needsShellOnWindows } = require('../../scripts/lib/crusher/shim-dispatch');

function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

// Fake binaries are small Node scripts, not shell scripts: a POSIX shebang
// script does not execute at all on Windows (no shell, no chmod semantics),
// so the underlying behavior is expressed once, in Node, and only the
// per-platform launcher mechanics differ (a shebang file vs. a .cmd
// wrapper), matching how the real npm.cmd/npx.cmd wrappers work there.
function implBody({ stdout, exitCode = 0, echoStdin = false, selfSignal }) {
  if (echoStdin) {
    return "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write(d,()=>process.exit(0));});";
  }
  if (selfSignal) {
    // Simulates a process killed by a signal (Ctrl+C/SIGINT, SIGTERM, ...):
    // spawnSync reports this as status=null, signal=<name> for the parent.
    return `process.stdout.write(${JSON.stringify(stdout ?? '')},()=>{process.kill(process.pid, ${JSON.stringify(selfSignal)});});setTimeout(()=>{},1000);`;
  }
  // The write callback, not a bare statement after write(), is what makes this
  // reliable: stdout to a pipe is asynchronous on POSIX (smaller default pipe
  // buffers on macOS make this bite harder than on Linux), and process.exit()
  // does not wait for pending writes to flush -- calling it before the write
  // callback fires can truncate the tail of large output non-deterministically
  // by OS and Node version (seen as a real CI flake on macOS + Node 20.x).
  return `process.stdout.write(${JSON.stringify(stdout ?? '')},()=>process.exit(${exitCode}));`;
}

function writeFakeBinary(dir, name, spec) {
  const implPath = path.join(dir, `${name}.impl.js`);
  fs.writeFileSync(implPath, implBody(spec), 'utf8');

  if (process.platform === 'win32') {
    const binPath = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(binPath, `@echo off\r\nnode "${implPath}" %*\r\n`);
    return binPath;
  }

  const binPath = path.join(dir, name);
  fs.writeFileSync(binPath, `#!/usr/bin/env node\nrequire(${JSON.stringify(implPath)});\n`);
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

function seedManifest(homeDir, entries) {
  const binDir = path.join(homeDir, '.egc', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'manifest.json'), JSON.stringify(entries));
}

function runShim(homeDir, name, args, options = {}) {
  // os.homedir() reads USERPROFILE on Windows, HOME everywhere else -- both
  // must be set or the real runner/user home leaks into the child process.
  return spawnSync(process.execPath, [DISPATCH_SCRIPT, name, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    ...options,
  });
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.stack || err.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing scripts/lib/crusher/shim-dispatch.js ===\n');
  let passed = 0;
  let failed = 0;

  if (test('a non-generic command with large output gets compressed with the crusher marker', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      const bigBody = Array.from({ length: 100 }, (_, i) => `commit ${'a'.repeat(40)}\nAuthor: x\nDate: y\n\n    message ${i}\n`).join('\n');
      const fakeGit = writeFakeBinary(dir, 'git', { stdout: bigBody });
      seedManifest(dir, { git: fakeGit });

      const result = runShim(dir, 'git', ['log', '--stat']);
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('[egc-crusher] saved'), 'expected the crusher marker in output');
      assert.ok(result.stdout.length < bigBody.length, 'expected compressed output to be smaller than the original');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('EGC_CRUSHER_RAW=1 bypasses compression for a large non-generic command (egc run --raw escape hatch, audit EGC-521)', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      const bigBody = Array.from({ length: 100 }, (_, i) => `commit ${'a'.repeat(40)}\nAuthor: x\nDate: y\n\n    message ${i}\n`).join('\n');
      const fakeGit = writeFakeBinary(dir, 'git', { stdout: bigBody });
      seedManifest(dir, { git: fakeGit });

      const result = runShim(dir, 'git', ['log', '--stat'], {
        env: { ...process.env, HOME: dir, USERPROFILE: dir, EGC_CRUSHER_RAW: '1' },
      });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, bigBody, 'expected the exact raw output, not the compressed form');
      assert.ok(!result.stdout.includes('[egc-crusher]'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('a generic command (git status) never gets captured or compressed, even with large output', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      const bigBody = 'x'.repeat(5000);
      const fakeGit = writeFakeBinary(dir, 'git', { stdout: bigBody });
      seedManifest(dir, { git: fakeGit });

      const result = runShim(dir, 'git', ['status']);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, bigBody);
      assert.ok(!result.stdout.includes('[egc-crusher]'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('small non-generic output (below the crush threshold) passes through unchanged', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      const fakeGit = writeFakeBinary(dir, 'git', { stdout: 'commit abc123\n' });
      seedManifest(dir, { git: fakeGit });

      const result = runShim(dir, 'git', ['log']);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout.trim(), 'commit abc123');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('the real exit code is preserved through the shim', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      const fakeGit = writeFakeBinary(dir, 'git', { stdout: 'failure\n', exitCode: 7 });
      seedManifest(dir, { git: fakeGit });

      const result = runShim(dir, 'git', ['status']);
      assert.strictEqual(result.status, 7);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('a child killed by a signal makes the shim die by the same signal, not a generic exit code (audit EGC-520)', () => {
    if (process.platform === 'win32') return; // POSIX signal semantics only
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      const fakeGit = writeFakeBinary(dir, 'git', { selfSignal: 'SIGTERM' });
      seedManifest(dir, { git: fakeGit });

      const result = runShim(dir, 'git', ['status']);
      assert.strictEqual(result.signal, 'SIGTERM');
      assert.strictEqual(result.status, null);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('stdin is passed through to the real binary untouched', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      const fakeNpm = writeFakeBinary(dir, 'npm', { echoStdin: true });
      seedManifest(dir, { npm: fakeNpm });

      const result = runShim(dir, 'npm', ['status'], { input: 'hello from stdin' });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, 'hello from stdin');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('an unresolvable binary name exits 127 with "command not found"', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      seedManifest(dir, {});
      const result = runShim(dir, 'totally-fake-binary-xyz-123', ['--version']);
      assert.strictEqual(result.status, 127);
      assert.ok(result.stderr.includes('command not found'));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('a stale manifest entry pointing nowhere degrades to "command not found", never crashes', () => {
    const dir = createTempDir('egc-shim-dispatch-');
    try {
      // The manifest points at a path that does not exist, and a fresh PATH
      // lookup for this nonsense name also fails -- must degrade to "command
      // not found", not an uncaught throw or a hung process.
      seedManifest(dir, { 'totally-fake-binary-xyz-123': path.join(dir, 'does-not-exist') });
      const result = runShim(dir, 'totally-fake-binary-xyz-123', []);
      assert.strictEqual(result.status, 127);
      assert.strictEqual(result.signal, null, 'must exit cleanly, not crash/signal');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('needsShellOnWindows requires shell only for .cmd/.bat on win32, never on POSIX', () => {
    withPlatform('win32', () => {
      assert.strictEqual(needsShellOnWindows('C:\\Program Files\\nodejs\\npm.cmd'), true);
      assert.strictEqual(needsShellOnWindows('C:\\Program Files\\nodejs\\npm.CMD'), true);
      assert.strictEqual(needsShellOnWindows('C:\\tools\\ruby\\bundle.bat'), true);
      assert.strictEqual(needsShellOnWindows('C:\\Program Files\\Git\\bin\\git.exe'), false);
    });
    withPlatform('linux', () => {
      assert.strictEqual(needsShellOnWindows('/usr/local/bin/npm.cmd'), false, 'never true off win32, regardless of extension');
    });
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
