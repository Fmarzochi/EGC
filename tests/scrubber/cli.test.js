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
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.catch(() => {}); // an accidental async test's rejection is handled, not fatal
      throw new Error('async test cases are not supported by this harness');
    }
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

check('refuses a non-image binary file by its raw magic bytes', () => {
  const file = tmpFile('e.txt', Buffer.from('PK\x03\x04rest of a zip', 'latin1'));
  const r = runCli(['clean', file]);
  assert.strictEqual(r.code, 2);
  assert.ok(/looks like a zip/.test(r.err));
});

check('cleans an image file by stripping metadata chunks', () => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const png = Buffer.concat([
    sig,
    chunk('IHDR', Buffer.alloc(13)),
    chunk('tEXt', Buffer.from('k\0SomeAI', 'latin1')),
    chunk('IDAT', Buffer.from([1])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const file = tmpFile('img.png', png);
  const r = runCli(['clean', file, '--json']);
  assert.strictEqual(r.code, 0);
  const cleaned = fs.readFileSync(path.join(tmp, 'img.cleaned.png'));
  assert.ok(!cleaned.toString('latin1').includes('SomeAI'));
  assert.ok(cleaned.subarray(0, 8).equals(sig));
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

check('a recognized-but-unsupported image is not written and reports honestly', () => {
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(8)]);
  const file = tmpFile('pic.webp', webp);
  const r = runCli(['clean', file]);
  assert.strictEqual(r.code, 3);
  assert.ok(/not clean/.test(r.err));
  assert.ok(!fs.existsSync(path.join(tmp, 'pic.cleaned.webp')));
});

check('a recognized-but-unsupported image with --json emits a JSON report and exit 3', () => {
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(8)]);
  const file = tmpFile('pic2.webp', webp);
  const r = runCli(['clean', file, '--json']);
  assert.strictEqual(r.code, 3);
  const report = JSON.parse(r.err);
  assert.strictEqual(report.format, 'webp');
  assert.strictEqual(report.supported, false);
  assert.strictEqual(report.scanned, false);
  assert.deepStrictEqual(report.removed, []);
});

check('a bare image magic-byte prefix with no valid structure is refused as binary', () => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = tmpFile('broken.png', Buffer.concat([sig, Buffer.from('garbage', 'latin1')]));
  const r = runCli(['clean', file]);
  assert.strictEqual(r.code, 2);
  assert.ok(/looks like/.test(r.err));
});

check('cleans a pdf by redacting Info metadata in place', () => {
  const pdfBuf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Producer (SomeAI) >>\nendobj\ntrailer\n<< /Info 1 0 R >>\n%%EOF\n', 'latin1');
  const file = tmpFile('doc.pdf', pdfBuf);
  const r = runCli(['clean', file, '--json']);
  assert.strictEqual(r.code, 0);
  const cleaned = fs.readFileSync(path.join(tmp, 'doc.cleaned.pdf'));
  assert.strictEqual(cleaned.length, pdfBuf.length);
  assert.ok(!cleaned.toString('latin1').includes('SomeAI'));
});

check('leaves an encrypted pdf untouched and exits 3', () => {
  const pdfBuf = Buffer.from('%PDF-1.4\n<< /Encrypt 5 0 R /Producer (SomeAI) >>\n%%EOF\n', 'latin1');
  const file = tmpFile('enc.pdf', pdfBuf);
  const r = runCli(['clean', file]);
  assert.strictEqual(r.code, 3);
  assert.ok(/encrypted/.test(r.err));
  assert.ok(!fs.existsSync(path.join(tmp, 'enc.cleaned.pdf')));
});

check('rewrite prints a Layer B prompt with the text embedded and the honest note', () => {
  const file = tmpFile('draft.md', 'A short drafted paragraph about testing.');
  const r = runCli(['rewrite', file]);
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.includes('A short drafted paragraph about testing.'));
  assert.ok(/Restate the passage/.test(r.out));
  assert.ok(/no proof/i.test(r.err) && /vendor detector/i.test(r.err));
});

check('rewrite honors --strength and rejects an unknown one', () => {
  const file = tmpFile('draft2.md', 'Another paragraph.');
  const human = runCli(['rewrite', file, '--strength', 'humanize']);
  assert.strictEqual(human.code, 0);
  assert.ok(/a person would write it/.test(human.out));
  const bad = runCli(['rewrite', file, '--strength', 'nope']);
  assert.strictEqual(bad.code, 2);
  assert.ok(/paraphrase/.test(bad.err));
});

check('rewrite rejects --strength with no value instead of silently defaulting', () => {
  const file = tmpFile('draft-s.md', 'some text');
  const r = runCli(['rewrite', file, '--strength']);
  assert.strictEqual(r.code, 2);
  assert.ok(/--strength requires a value/.test(r.err));
  const shortOpt = runCli(['rewrite', file, '--strength', '-o', 'out.md']);
  assert.strictEqual(shortOpt.code, 2);
  assert.ok(/--strength requires a value/.test(shortOpt.err));
});

check('rewrite propagates --lang to the backtranslate prompt', () => {
  const file = tmpFile('draft-l.md', 'some text to translate');
  const r = runCli(['rewrite', file, '--strength', 'backtranslate', '--lang', 'German']);
  assert.strictEqual(r.code, 0);
  assert.ok(/into German/.test(r.out), 'the pivot language must follow --lang, not the default');
  const missing = runCli(['rewrite', file, '--strength', 'backtranslate', '--lang']);
  assert.strictEqual(missing.code, 2);
  assert.ok(/--lang/.test(missing.err));
  const oneMissing = runCli(['rewrite', file, '--strength', 'backtranslate', '--lang', 'German', '--original-lang']);
  assert.strictEqual(oneMissing.code, 2);
  assert.ok(/--original-lang requires a value/.test(oneMissing.err), 'names the specific malformed flag');
  const noEffect = runCli(['rewrite', file, '--strength', 'paraphrase', '--lang', 'German']);
  assert.strictEqual(noEffect.code, 0);
  assert.ok(/only affect the backtranslate/.test(noEffect.err), 'warns pivot flags have no effect here');
});

check('rewrite refuses binary input', () => {
  const png = tmpFile('x.png', Buffer.from('\x89PNG\r\n\x1a\n\x00\x00binary', 'latin1'));
  const r = runCli(['rewrite', png]);
  assert.strictEqual(r.code, 2);
});

check('usage lists the rewrite subcommand', () => {
  const r = runCli([]);
  assert.strictEqual(r.code, 2);
  assert.ok(/rewrite/.test(r.err));
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
