'use strict';
/**
 * The project index walks a project, skipping ignored and protected paths,
 * and builds ranking documents: path tokens everywhere, symbols and imports
 * for JS/TS, and a summary from the first non-empty line.
 *
 * Run with: node tests/egc-guardian-filerank-index.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'file-index.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { buildFileIndex, MAX_FILE_BYTES } = require(path.join(buildDir, 'file-index.js'));

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.stack || err.message}`);
    failed++;
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-filerank-index-'));
let n = 0;
function project(files) {
  const root = path.join(tmp, `p${n++}`);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

(async () => {
  await run('indexes text files, skips node_modules, dist and .gitignore matches', async () => {
    const root = project({
      'billing/payments.ts': 'export function chargeCard() {}\n',
      'README.md': '# Billing overview\nText.\n',
      'node_modules/x/index.js': 'x',
      'dist/out.js': 'y',
      'secret.txt': 'z',
      '.gitignore': 'secret.txt\n'
    });
    const { docs } = await buildFileIndex(root);
    assert.deepStrictEqual(docs.map(d => d.path), ['README.md', 'billing/payments.ts']);
  });

  await run('path tokens come from every path segment (stemmed); symbols come from the extractor', async () => {
    const root = project({ 'billing/payments.ts': 'export function chargeCard() {}\n' });
    const d = (await buildFileIndex(root)).docs[0];
    assert.ok(d.fields.path.includes('bill'), 'billing stems to bill');
    assert.ok(d.fields.path.includes('payment'), 'payments stems to payment');
    assert.ok(d.fields.symbols.includes('charge'));
    assert.ok(d.fields.symbols.includes('card'));
  });

  await run('summary is the first non-empty line of a markdown file, stripped of markup', async () => {
    const root = project({ 'docs/guide.md': '\n\n# Billing overview\nBody.\n' });
    const d = (await buildFileIndex(root)).docs[0];
    assert.ok(d.fields.summary.includes('bill'));
    assert.ok(d.fields.summary.includes('overview'));
  });

  await run('import edges use the same shape as The Link and resolve relative specifiers', async () => {
    const root = project({
      'a.ts': "import { b } from './b';\nexport const a = b;\n",
      'b.ts': 'export const b = 1;\n'
    });
    const { edges } = await buildFileIndex(root);
    assert.deepStrictEqual(edges, [{ from: 'a.ts', to: 'b.ts', rel: 'imports' }]);
  });

  await run('a file over the size cap is indexed by path only, its body never read', async () => {
    const big = 'export const x = "' + 'y'.repeat(MAX_FILE_BYTES + 10) + '";\n';
    const root = project({ 'huge/big.ts': big });
    const d = (await buildFileIndex(root)).docs.find(x => x.path === 'huge/big.ts');
    assert.ok(d, 'present');
    assert.deepStrictEqual(d.fields.symbols, []);
    assert.deepStrictEqual(d.fields.summary, []);
  });

  await run('a file with a NUL byte is indexed by path only', async () => {
    const root = project({ 'tools/blob.sh': 'hello\u0000world\n' });
    const d = (await buildFileIndex(root)).docs.find(x => x.path === 'tools/blob.sh');
    assert.ok(d);
    assert.deepStrictEqual(d.fields.summary, []);
  });

  await run('an empty project gives no documents and no edges', async () => {
    const root = path.join(tmp, 'empty-project');
    fs.mkdirSync(root);
    assert.deepStrictEqual(await buildFileIndex(root), { docs: [], edges: [], skipped: 0 });
  });

  await run('the deadline bounds the whole index: files left when it passes are skipped, not indexed', async () => {
    const root = project({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n', 'c.ts': 'export const c = 1;\n' });
    const realNow = Date.now;
    const realLstat = fs.promises.lstat;
    let jump = 0;
    // The clock jumps past the deadline as soon as the first file is looked at.
    Date.now = () => realNow() + jump;
    fs.promises.lstat = (...args) => {
      // Only a source file in the index, not the .gitignore looked up first.
      if (String(args[0]).endsWith('.ts')) jump = 10 * 60 * 1000;
      return realLstat.apply(fs.promises, args);
    };
    let index;
    try {
      index = await buildFileIndex(root);
    } finally {
      Date.now = realNow;
      fs.promises.lstat = realLstat;
    }
    assert.strictEqual(index.docs.length, 1, 'only the file in hand when the deadline passed');
    assert.strictEqual(index.skipped, 2);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
