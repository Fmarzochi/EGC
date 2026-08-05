'use strict';

// Shared fixtures for suites that exercise the Token Crusher PATH shim, so
// the launcher shape lives in one place and the suites cannot drift from
// what `egc crusher-shim install` actually writes.

const fs = require('node:fs');
const path = require('node:path');

const DISPATCH_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'lib', 'crusher', 'shim-dispatch.js');

// Built with String.fromCharCode/RegExp instead of typing the raw U+2028 and
// U+2029 characters, so this file never carries invisible codepoints of its
// own while building fixtures for exactly that class of problem.
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
// depending on context (flagged by CodeQL as js/bad-code-sanitization).
// These fixtures only ever receive fixed test values, never external input,
// but the construction itself should not rely on that.
function jsStringLiteral(value) {
  return JSON.stringify(value).replace(UNSAFE_CODE_CHARS_RE, (c) => UNSAFE_CODE_CHARS[c]);
}

// Mirrors shim-install.js's posixLauncherSource(): the launcher shape
// `egc crusher-shim install` writes to ~/.egc/bin/<name>, pointing back at
// this checkout's shim-dispatch.js. The EGC_TEST_SHIM_DEPTH lines are
// test-only armor: if every anti-recursion layer under test regressed at
// once, the chain dies at depth 3 with a distinct exit code (97), so the
// suite fails with an assertion instead of fork-bombing the machine that
// runs it.
function writeShimLauncher(binDir, name) {
  const launcherPath = path.join(binDir, name);
  fs.writeFileSync(launcherPath, [
    '#!/usr/bin/env node',
    'const depth = Number(process.env.EGC_TEST_SHIM_DEPTH || 0);',
    "if (depth > 3) { process.stderr.write('test shim depth exceeded\\n'); process.exit(97); }",
    'process.env.EGC_TEST_SHIM_DEPTH = String(depth + 1);',
    `require(${jsStringLiteral(DISPATCH_SCRIPT)}).runShim(${jsStringLiteral(name)}, process.argv.slice(2));`,
    '',
  ].join('\n'));
  fs.chmodSync(launcherPath, 0o755);
  return launcherPath;
}

module.exports = { DISPATCH_SCRIPT, jsStringLiteral, writeShimLauncher };
