'use strict';

// Scrubber manual CLI: inspect/clean on real temp files, binary refusal on raw
// bytes, path validation, and the usage path. Exercises main() in-process and
// captures stdout/stderr so assertions can read the output.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../../scripts/hooks/scrubber-cli');

const ZWSP = String.fromCodePoint(0x200b);
const EM_DASH = String.fromCodePoint(0x2014);

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    Error: ${err.stack}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  if (test(name, fn)) passed += 1;
  else failed += 1;
}

// Run main() with stdout/stderr captured. Returns { code, out, err }.
function runCli(args) {
  const out = [];
  const err = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = chunk => { out.push(String(chunk)); return true; };
  process.stderr.write = chunk => { err.push(String(chunk)); return true; };
  let code;
  try {
    code = cli.main(['node', 'scrubber-cli.js', ...args]);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { code, out: out.join(''), err: err.join('') };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrubber-cli-'));
function tmpFile(name, contents) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, contents);
  return p;
}

check('inspect reports suspicious characters as JSON', () => {
  const file = tmpFile('a.md', `hello${ZWSP} world`);
  const r = runCli(['inspect', file]);
  assert.strictEqual(r.code, 0);
  const report = JSON.parse(r.out);
  assert.ok(report.suspiciousTotal >= 1);
});

check('clean writes a *.cleaned file by default', () => {
  const file = tmpFile('b.txt', `x${ZWSP}y ${EM_DASH} z`);
  const r = runCli(['clean', file]);
  assert.strictEqual(r.code, 0);
  const outPath = path.join(tmp, 'b.cleaned.txt');
  assert.strictEqual(fs.readFileSync(outPath, 'utf8'), 'xy, z');
});

check('clean --in-place overwrites the file', () => {
  const file = tmpFile('c.js', `const a = 1;${ZWSP}`);
  const r = runCli(['clean', file, '--in-place']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'const a = 1;');
});

check('clean -o writes to the chosen output path', () => {
  const file = tmpFile('d.txt', `p${ZWSP}q`);
  const outPath = path.join(tmp, 'custom-out.txt');
  const r = runCli(['clean', file, '-o', outPath]);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(outPath, 'utf8'), 'pq');
});

check('refuses a binary file by its raw magic bytes', () => {
  const file = tmpFile('e.txt', Buffer.from('\x89PNG\r\n\x1a\nrest', 'latin1'));
  const r = runCli(['clean', file]);
  assert.strictEqual(r.code, 2);
  assert.ok(/looks like a png/.test(r.err));
});

check('reports the stats with --json', () => {
  const file = tmpFile('f.txt', `m${ZWSP}n`);
  const r = runCli(['clean', file, '--json']);
  assert.strictEqual(r.code, 0);
  assert.ok(/removedCount/.test(r.err));
});

check('prints usage and returns 2 for an unknown command', () => {
  const r = runCli(['frobnicate', 'x']);
  assert.strictEqual(r.code, 2);
  assert.ok(/usage:/.test(r.err));
});

check('safePath rejects a path containing a NUL byte', () => {
  assert.throws(() => cli.safePath(`bad${String.fromCodePoint(0)}path`));
  assert.strictEqual(cli.safePath('a/b.txt'), path.resolve('a/b.txt'));
});

check('cleanedPath inserts .cleaned before the extension', () => {
  assert.strictEqual(cli.cleanedPath('dir/file.md'), 'dir/file.cleaned.md');
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
