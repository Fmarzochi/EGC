'use strict';
/**
 * rankProjectFiles ties the index, the git signal and the scorer together and
 * renders the explain table (stderr) and the three-block briefing (stdout).
 *
 * Run with: node tests/egc-guardian-filerank-briefing.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'file-rank.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { rankProjectFiles, renderExplain, renderBriefing } = require(path.join(buildDir, 'file-rank.js'));

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-filerank-brief-'));
const root = path.join(tmp, 'proj');
fs.mkdirSync(path.join(root, 'billing'), { recursive: true });
fs.writeFileSync(path.join(root, 'billing', 'payments.ts'), "import { fee } from './fees';\nexport function chargeCard() { return fee(); }\n");
fs.writeFileSync(path.join(root, 'billing', 'fees.ts'), 'export function fee() { return 1; }\n');
fs.writeFileSync(path.join(root, 'unrelated.ts'), 'export const color = "red";\n');

(async () => {
  await run('returns ranked files with per-signal breakdown, best first', async () => {
    const r = await rankProjectFiles({ projectPath: root, query: 'fix chargeCard payments', useGit: false });
    assert.strictEqual(r.ranked[0].path, 'billing/payments.ts');
    assert.ok(r.ranked[0].signals.bm25 > 0);
    assert.ok(r.ranked[0].signals.path_hit > 0);
  });

  await run('import propagation pulls the imported file in with a decayed contribution', async () => {
    const r = await rankProjectFiles({ projectPath: root, query: 'chargeCard', useGit: false });
    const fees = r.ranked.find(f => f.path === 'billing/fees.ts');
    assert.ok(fees && fees.signals.import_graph > 0, 'fees.ts reached through the import');
  });

  await run('explain table has a header, one row per file, and the signal columns', () => {
    const lines = renderExplain([{ path: 'a.ts', score: 2.5, signals: { bm25: 1.5, path_hit: 1.0 } }]);
    assert.ok(lines[0].startsWith('explain:'));
    assert.ok(lines.some(l => l.includes('bm25') && l.includes('path_hit')));
    assert.ok(lines.some(l => l.includes('a.ts') && l.includes('2.50')));
  });

  await run('briefing has the three blocks in order, with the request last', () => {
    const b = renderBriefing('fix chargeCard', 'decided to keep fees separate', [{ path: 'a.ts', score: 1, signals: {} }]);
    const i1 = b.indexOf('[PROJECT HISTORY]');
    const i2 = b.indexOf('[RELEVANT CODEBASE CONTEXT]');
    const i3 = b.indexOf('[USER REQUEST]');
    assert.ok(i1 >= 0 && i1 < i2 && i2 < i3);
    assert.ok(b.endsWith('fix chargeCard'));
    assert.ok(b.includes('decided to keep fees separate'));
  });

  await run('briefing with no history says so, and with no files says so', () => {
    const b = renderBriefing('q', '   ', []);
    assert.ok(b.includes('(no session history found)'));
    assert.ok(b.includes('(no relevant files found)'));
  });

  await run('a history line that looks like a secret is redacted before printing', () => {
    const b = renderBriefing('q', 'note: api_key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', []);
    assert.ok(!b.includes('sk-ant-api03-AAAA'), 'secret is not printed');
  });

  await run('a query with no matches returns an empty ranking, not an error', async () => {
    const r = await rankProjectFiles({ projectPath: root, query: 'the and', useGit: false });
    assert.deepStrictEqual(r.ranked, []);
    assert.ok(r.briefing.includes('[USER REQUEST]'));
  });

  await run('no project files gives an empty ranking', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    const r = await rankProjectFiles({ projectPath: empty, query: 'anything', useGit: false });
    assert.deepStrictEqual(r.ranked, []);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
