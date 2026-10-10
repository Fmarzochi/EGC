'use strict';
/**
 * Several processes ask for context on the same cold project at once, on the
 * portable SQL engine. That engine holds the whole database in memory and
 * writes it back whole on close, so a handle opened before the build lock
 * could be a stale copy that overwrites what another process saved. Every
 * caller must succeed and the graph on disk must hold every file and its links.
 *
 * Run with: node tests/egc-guardian-graph-race.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CLI_TIMEOUT_MS } = require('./fixtures/subprocess-timeouts.js');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'graph-context.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
// A test can point the children at another build of the module (EGC_TEST_CONTEXT_MODULE).
const contextModule = process.env.EGC_TEST_CONTEXT_MODULE || path.join(buildDir, 'graph-context.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-graph-race-'));
const env = { ...process.env, EGC_DIR: path.join(tmp, 'egc-home'), EGC_SQLITE_ENGINE: 'wasm' };
const FILES = 14;
const root = path.join(tmp, 'proj');
fs.mkdirSync(root, { recursive: true });
for (let i = 0; i < FILES; i++) {
  const imports = i > 0 ? `import { step${i - 1} } from './m${i - 1}.js';\n` : '';
  const body = i > 0 ? `return step${i - 1}() + 1;` : 'return 0;';
  fs.writeFileSync(path.join(root, `m${i}.js`), `${imports}export function step${i}() {\n  ${body}\n}\n`);
}

const childSource = `
  const [moduleFile, project] = process.argv.slice(1);
  import(require('node:url').pathToFileURL(moduleFile).href)
    .then(m => m.buildRelevantContext('change step3 and step9', project, undefined, { env: process.env }))
    .then(r => process.stdout.write(JSON.stringify({ status: r.status, reason: r.reason })));
`;

function child() {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ['-e', childSource, contextModule, root], { env, windowsHide: true });
    let out = '';
    let err = '';
    let timedOut = false;
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    // A child that hangs (the lock or engine deadlock this test exists to catch) must fail the test, not stall the suite.
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, CLI_TIMEOUT_MS);
    p.on('close', code => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
  });
}

(async () => {
  let failed = 0;
  try {
    const results = await Promise.all(Array.from({ length: 4 }, child));
    for (const r of results) {
      assert.ok(!r.timedOut, `a child did not finish within ${CLI_TIMEOUT_MS} ms`);
      assert.strictEqual(r.code, 0, r.err);
      const answer = JSON.parse(r.out);
      assert.strictEqual(answer.status, 'ok', JSON.stringify(answer));
    }

    process.env.EGC_SQLITE_ENGINE = 'wasm';
    const { graphDbPath, openGraphStore } = require(path.join(buildDir, 'graph-store.js'));
    const store = await openGraphStore(graphDbPath(fs.realpathSync(root), env));
    const data = await store.load();
    await store.close();
    assert.strictEqual(data.files.length, FILES, 'every file is in the graph');
    assert.ok(data.edges.length >= FILES - 1, `the links are all there (${data.edges.length})`);
    console.log('  PASS four processes on a cold project, portable engine: every caller ok and the graph is whole (smoke test; the lock-held case is pinned in the graph-context test)');
  } catch (err) {
    failed = 1;
    console.log('  FAIL four processes on a cold project, portable engine');
    console.log(`    ${err.stack || err.message}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${failed ? 0 : 1} passed, ${failed} failed`);
  process.exitCode = failed;
})();
