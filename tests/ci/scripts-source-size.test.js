'use strict';
/**
 * Source size of the CLI, the hooks and their libraries: every JavaScript
 * file under scripts/ stays under 800 lines, the limit #1712 set for
 * production files, so a module that grows past it is split before it lands
 * instead of years later.
 *
 * Run with: node tests/ci/scripts-source-size.test.js [repository root]
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const MAX_LINES = 800;
const SKIPPED_DIRECTORIES = new Set(['node_modules']);

// Lines as wc -l counts them: one per line break.
function lineCount(file) {
  return (fs.readFileSync(file, 'utf8').match(/\n/g) || []).length;
}

function* javascriptSources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* javascriptSources(full);
    } else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

test(`every JavaScript source under scripts/ stays under ${MAX_LINES} lines`, () => {
  const oversized = [...javascriptSources(SCRIPTS)]
    .map(file => ({ file: path.relative(ROOT, file).split(path.sep).join('/'), lines: lineCount(file) }))
    .filter(entry => entry.lines > MAX_LINES)
    .map(entry => `${entry.file} (${entry.lines} lines)`);
  assert.deepStrictEqual(oversized, [], `sources over ${MAX_LINES} lines, to be split into modules: ${oversized.join(', ')}`);
});
