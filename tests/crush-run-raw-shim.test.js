'use strict';
/**
 * End-to-end regression test for EGC-521: `egc run --raw <cmd>` must return
 * the real raw output even when <cmd> resolves through the Token Crusher
 * PATH shim (git, npm, ...) instead of the real binary. Before this fix, the
 * shim ran as an independent child process with no visibility into --raw and
 * compressed the output anyway, so crush-run.js's own "skip compression"
 * path just forwarded output that was already crushed.
 *
 * Run with: node tests/crush-run-raw-shim.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CRUSH_RUN = path.join(__dirname, '..', 'scripts', 'crush-run.js');
const DISPATCH_MODULE = path.join(__dirname, '..', 'scripts', 'lib', 'crusher', 'shim-dispatch.js');

// Built with String.fromCharCode/RegExp instead of typing the raw U+2028 and
// U+2029 characters, so this file never carries invisible codepoints of its
// own while implementing a fix for exactly that class of problem.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const UNSAFE_CODE_CHARS = {
  '<': '\\u003C',
  '>': '\\u003E',
  [LINE_SEPARATOR]: '\\u2028',
  [PARAGRAPH_SEPARATOR]: '\\u2029',
};
const UNSAFE_CODE_CHARS_RE = new RegExp(`[<>${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, 'g');

// JSON.stringify alone is not a safe way to embed a value inside generated
// source code: it leaves characters like < > and the U+2028/U+2029 line
// separators untouched, which can still break out of the surrounding syntax
// depending on context (flagged by CodeQL as js/bad-code-sanitization). These
// fake binaries only ever receive fixed test fixtures, never external input,
// but the construction itself should not rely on that.
function jsStringLiteral(value) {
  return JSON.stringify(value).replace(UNSAFE_CODE_CHARS_RE, (c) => UNSAFE_CODE_CHARS[c]);
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

// Mirrors shim-install.js's posixLauncherSource(): the exact launcher shape
// `egc crusher-shim install` writes to ~/.egc/bin/<name>.
function writeShimLauncher(binDir, name) {
  const launcherPath = path.join(binDir, name);
  const source = [
    '#!/usr/bin/env node',
    `require(${jsStringLiteral(DISPATCH_MODULE)}).runShim(${jsStringLiteral(name)}, process.argv.slice(2));`,
    '',
  ].join('\n');
  fs.writeFileSync(launcherPath, source);
  fs.chmodSync(launcherPath, 0o755);
  return launcherPath;
}

// Stands in for the real /usr/bin/git that the shim launcher resolves to via
// its manifest.
function writeRealBinary(dir, name, stdout) {
  const binPath = path.join(dir, name);
  // fs.writeSync(1, ...), not process.stdout.write(), matters here: this
  // binary's stdout fd is inherited across two process hops (crush-run.js's
  // own pipe, re-inherited by the shim launcher into this process), and
  // process.stdout.write()'s callback firing does not reliably mean the data
  // reached the OS pipe buffer across that many hops on every platform. This
  // was seen as a real CI flake truncating the tail of large output on
  // macOS + Node 20.x even after waiting for that callback. fs.writeSync is a
  // genuine blocking syscall (loops internally until every byte is written),
  // so there is nothing left pending by the time this process exits.
  fs.writeFileSync(binPath, `#!/usr/bin/env node\nrequire('fs').writeSync(1, ${jsStringLiteral(stdout)});\nprocess.exit(0);\n`);
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

function setUpShimmedGit(home, bigBody) {
  const shimBin = path.join(home, '.egc', 'bin');
  fs.mkdirSync(shimBin, { recursive: true });
  const realBinDir = createTempDir('egc-crush-run-raw-real-');
  const realGit = writeRealBinary(realBinDir, 'git', bigBody);
  writeShimLauncher(shimBin, 'git');
  fs.writeFileSync(path.join(shimBin, 'manifest.json'), JSON.stringify({ git: realGit }));
  return { shimBin, realBinDir };
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.stack || err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
const runCase = (name, fn) => { if (test(name, fn)) passed++; else failed++; };

console.log('\n=== Testing egc run --raw against the PATH-level Token Crusher shim (EGC-521) ===\n');

// The shim ships as a POSIX shebang launcher; Windows uses a separate .cmd
// mechanism not exercised here (see needsShellOnWindows coverage instead).
if (process.platform !== 'win32') {
  const bigBody = Array.from({ length: 100 }, (_, i) => `commit ${'a'.repeat(40)}\nAuthor: x\nDate: y\n\n    message ${i}\n`).join('\n');

  runCase('egc run --raw returns the true raw output, not the shim\'s compressed form', () => {
    const home = createTempDir('egc-crush-run-raw-');
    const { shimBin, realBinDir } = setUpShimmedGit(home, bigBody);
    try {
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${shimBin}${path.delimiter}${process.env.PATH}`,
      };

      const result = spawnSync(process.execPath, [CRUSH_RUN, '--raw', 'git', 'log', '--stat'], { encoding: 'utf8', env });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, bigBody, 'expected the exact raw output through egc run --raw, even though "git" on PATH resolves to the shim');
      assert.ok(!result.stdout.includes('[egc-crusher]'), '--raw must never show the compression marker');
    } finally {
      cleanup(home, realBinDir);
    }
  });

  runCase('without --raw, the same setup still compresses through the shim (sanity check)', () => {
    const home = createTempDir('egc-crush-run-raw-');
    const { shimBin, realBinDir } = setUpShimmedGit(home, bigBody);
    try {
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${shimBin}${path.delimiter}${process.env.PATH}`,
      };

      const result = spawnSync(process.execPath, [CRUSH_RUN, 'git', 'log', '--stat'], { encoding: 'utf8', env });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('[egc-crusher] saved'), 'expected the crusher marker when --raw is not passed');
    } finally {
      cleanup(home, realBinDir);
    }
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
