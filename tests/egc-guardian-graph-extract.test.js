'use strict';
/**
 * The graph extractor reads JS/TS source as text and reports its symbols,
 * imports and references without running or fully parsing it.
 *
 * Run with: node tests/egc-guardian-graph-extract.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'graph-extract.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { extractFile } = require(buildPath);

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}
const sym = (r, name) => r.symbols.find(s => s.name === name);

const ES = [
  "import def, { a, b as c } from './mod.js';",
  'import * as ns from "../lib/util";',
  "import './side-effect';",
  "export { x as y } from './re';",
  "export * from './all';",
  'export function foo(a) { return a + helper(c) + ns.run(); }',
  'export default class Widget { render() { return foo(1); } static make() { return new Widget(); } }',
  'const helper = (v) => v * 2;',
  'export const answer = 42;'
].join('\n');

run('ES imports and re-exports', () => {
  const r = extractFile(ES);
  assert.deepStrictEqual(r.imports.map(i => i.specifier), ['./mod.js', '../lib/util', './side-effect', './re', './all']);
  assert.deepStrictEqual(r.imports[0].bindings, [
    { local: 'def', imported: 'default' },
    { local: 'a', imported: 'a' },
    { local: 'c', imported: 'b' }
  ]);
  assert.deepStrictEqual(r.imports[1].bindings, [{ local: 'ns', imported: '*' }]);
  assert.strictEqual(r.imports[3].reexport, true);
  assert.deepStrictEqual(r.imports[3].bindings, [{ local: 'y', imported: 'x' }]);
  assert.deepStrictEqual(r.imports[4].bindings, [{ local: '*', imported: '*' }]);
});

run('ES symbols, kinds, export flags and line ranges', () => {
  const r = extractFile(ES);
  assert.deepStrictEqual(r.symbols.map(s => s.name), ['foo', 'Widget', 'Widget.render', 'Widget.make', 'helper', 'answer']);
  assert.strictEqual(sym(r, 'foo').kind, 'function');
  assert.strictEqual(sym(r, 'foo').exported, true);
  assert.strictEqual(sym(r, 'foo').startLine, 6);
  assert.strictEqual(sym(r, 'foo').endLine, 6);
  assert.strictEqual(sym(r, 'Widget').kind, 'class');
  assert.strictEqual(sym(r, 'Widget.render').kind, 'method');
  assert.strictEqual(sym(r, 'Widget.render').exported, true);
  assert.strictEqual(sym(r, 'helper').kind, 'function');
  assert.strictEqual(sym(r, 'helper').exported, false);
  assert.strictEqual(sym(r, 'answer').kind, 'variable');
});

run('references: plain, namespace member, this member', () => {
  const r = extractFile(ES + '\nexport class K { a() { return this.b(); } b() { return 1; } }');
  assert.ok(sym(r, 'foo').refs.includes('helper'));
  assert.ok(sym(r, 'foo').refs.includes('c'));
  assert.ok(sym(r, 'foo').refs.includes('ns.run'));
  assert.ok(sym(r, 'Widget.render').refs.includes('foo'));
  assert.ok(sym(r, 'K.a').refs.includes('.b'));
  assert.ok(!sym(r, 'foo').refs.includes('foo'), 'a symbol does not reference itself');
});

run('CommonJS require, destructuring, module.exports, dynamic import', () => {
  const src = [
    "const fs = require('node:fs');",
    "const { read, write: put } = require('./io');",
    'function load(p) { return read(p); }',
    'module.exports = { load, put };',
    'exports.extra = function () { return fs; };',
    "const lazy = () => import('./lazy.js');"
  ].join('\n');
  const r = extractFile(src);
  const bySpec = Object.fromEntries(r.imports.map(i => [i.specifier, i.bindings]));
  assert.deepStrictEqual(bySpec['node:fs'], [{ local: 'fs', imported: '*' }]);
  assert.deepStrictEqual(bySpec['./io'], [{ local: 'read', imported: 'read' }, { local: 'put', imported: 'write' }]);
  assert.deepStrictEqual(bySpec['./lazy.js'], []);
  assert.strictEqual(sym(r, 'load').exported, true);
  assert.strictEqual(sym(r, 'extra').exported, true);
  assert.strictEqual(sym(r, 'lazy').kind, 'function');
  assert.strictEqual(sym(r, 'fs'), undefined, 'a require binding is an import, not a symbol');
});

run('keywords inside comments, strings, templates and regex literals are ignored', () => {
  const src = [
    "// import fake from './nope';",
    '/* export function ghost() {} */',
    "const s = \"import x from './str'\";",
    'const t = `export function tpl() {} ${ fn("}") } ${`nested ${1}`}`;',
    'const r = /export function re() {}\\//g;',
    'export function real() { return s + t + r; }'
  ].join('\n');
  const r = extractFile(src);
  assert.strictEqual(r.imports.length, 0);
  assert.deepStrictEqual(r.symbols.map(s => s.name), ['s', 't', 'r', 'real']);
});

run('multi-line ranges for functions and arrow constants', () => {
  const src = 'export function a() {\n  return 1;\n}\n\nexport const b = () => {\n  return 2;\n};\n';
  const r = extractFile(src);
  assert.deepStrictEqual([sym(r, 'a').startLine, sym(r, 'a').endLine], [1, 3]);
  assert.deepStrictEqual([sym(r, 'b').startLine, sym(r, 'b').endLine], [5, 7]);
});

run('TypeScript interface, type, enum, abstract class, typed arrow', () => {
  const src = [
    'export interface Opts { a: string }',
    'export type Id = string;',
    'export enum Color { Red }',
    'export abstract class Base { abstract run(): void; go(): void { return; } }',
    'export const f = (a: number): number => { return a; };'
  ].join('\n');
  const r = extractFile(src);
  assert.deepStrictEqual(r.symbols.map(s => [s.name, s.kind]), [
    ['Opts', 'type'], ['Id', 'type'], ['Color', 'type'], ['Base', 'class'], ['Base.go', 'method'], ['f', 'function']
  ]);
});

run('malformed input never throws', () => {
  for (const src of ['', 'export function (( {{', '}}}}', 'import {', 'class {', '`unterminated', '/* open', 'const x = "open\nconst y = 1;', '\u0000\u0001\u0002']) {
    const r = extractFile(src);
    assert.ok(Array.isArray(r.symbols) && Array.isArray(r.imports));
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
