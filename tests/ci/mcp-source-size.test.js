'use strict';
/**
 * Source size of the two MCP servers: every TypeScript file under
 * mcp/servers/<server>/src stays under 800 lines, the limit #1712 set for
 * production files, so a module that grows past it is split before it lands
 * instead of years later. The generated catalog parts count too: the
 * generator sizes them to fit.
 *
 * Run with: node tests/ci/mcp-source-size.test.js [repository root]
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', '..');
const SERVERS = ['egc-guardian', 'egc-memory'];
const MAX_LINES = 800;

// Lines as wc -l counts them: one per line break.
function lineCount(file) {
  return (fs.readFileSync(file, 'utf8').match(/\n/g) || []).length;
}

function oversizedSources(server) {
  const dir = path.join(ROOT, 'mcp', 'servers', server, 'src');
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.ts'))
    .map(name => ({ file: `mcp/servers/${server}/src/${name}`, lines: lineCount(path.join(dir, name)) }))
    .filter(entry => entry.lines > MAX_LINES);
}

for (const server of SERVERS) {
  test(`every TypeScript source of ${server} stays under ${MAX_LINES} lines`, () => {
    const oversized = oversizedSources(server).map(entry => `${entry.file} (${entry.lines} lines)`);
    assert.deepStrictEqual(oversized, [], `sources over ${MAX_LINES} lines, to be split into modules: ${oversized.join(', ')}`);
  });
}
