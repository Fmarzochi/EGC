/**
 * Tests for `compress_observations` ruleBasedCompress logic.
 *
 * Run with: node tests/compress.test.js
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.stack}`);
    return false;
  }
}

let passed = 0;
let failed = 0;

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'compress.js');

if (!fs.existsSync(buildPath)) {
  console.log(`[SKIP] ${buildPath} not found. Run 'npm run build' in mcp/servers/egc-memory first.`);
  process.exit(0);
}

const { ruleBasedCompress } = require(buildPath);

if (
  test('detects tool_failure with exact patterns', () => {
    const result = ruleBasedCompress({
      id: 'obs-1',
      tool: 'bash',
      output: 'Error: expect(token).toBeDefined() - received undefined\n  at auth/login.test.ts:42',
    });
    assert.strictEqual(result.type, 'tool_failure');
    assert.ok(result.importance >= 0.7, 'Importance should be high for failure');
    assert.ok(result.facts.length > 0, 'Should extract facts');
    assert.ok(result.title.includes('Error: expect'), 'Title should extract error snippet');
  })
) passed++; else failed++;

if (
  test('detects tool_success with exact patterns', () => {
    const result = ruleBasedCompress({
      tool: 'bash',
      output: '✓ All 42 tests passed successfully',
    });
    assert.strictEqual(result.type, 'tool_success');
    assert.ok(result.importance < 0.7, 'Importance should be low for success');
    assert.strictEqual(result.facts[0], '✓ All 42 tests passed successfully');
  })
) passed++; else failed++;

if (
  test('detects file_edit for file operations', () => {
    const result = ruleBasedCompress({
      tool: 'write_file',
      output: 'written',
      path: 'src/auth.ts',
    });
    assert.strictEqual(result.type, 'file_edit');
    assert.ok(result.facts.includes('Tool: write_file'));
    assert.ok(result.facts.includes('File: src/auth.ts'));
  })
) passed++; else failed++;

if (
  test('always returns required fields', () => {
    const result = ruleBasedCompress({
      tool: 'bash',
      output: '',
    });
    assert.ok(result.type);
    assert.ok(result.title);
    assert.ok(Array.isArray(result.facts));
    assert.ok(typeof result.importance === 'number');
    assert.ok(Array.isArray(result.concepts));
    assert.ok(result.compressed_at);
  })
) passed++; else failed++;

if (
  test('caps facts at 6 for long outputs', () => {
    const longOutput = new Array(20).fill('Error: something went wrong at line X').join('\n');
    const result = ruleBasedCompress({
      tool: 'bash',
      output: longOutput,
    });
    assert.ok(result.facts.length <= 6, 'Facts should be capped at 6');
  })
) passed++; else failed++;

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.stack}`);
    return false;
  }
}

// A project whose observations.jsonl holds one observation, `o1`, under a
// throwaway home; `run` gets the file's directory and path.
async function withObservationFile(run) {
  const os = require('node:os');
  const crypto = require('node:crypto');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-compress-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-compress-project-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, EGC_STATE_DB: process.env.EGC_STATE_DB };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, EGC_STATE_DB: path.join(home, 'no-such.db') });
  const oldUmask = process.umask(0);
  try {
    const id = crypto.createHash('sha256').update(project, 'utf8').digest('hex').slice(0, 12);
    const dir = path.join(home, '.gemini', 'homunculus', 'projects', id);
    fs.mkdirSync(dir, { recursive: true });
    const obsPath = path.join(dir, 'observations.jsonl');
    fs.writeFileSync(obsPath, `${JSON.stringify({ id: 'o1', tool: 'bash', output: 'token=abc' })}\n`, { mode: 0o644 });
    await run({ project, dir, obsPath });
  } finally {
    process.umask(oldUmask);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

const COMPRESSED = { title: 'compressed', type: 'tool_success', facts: [], importance: 0.1 };

// The observation file holds tool output, secrets included: its rewrite goes
// through a temp file created private and exclusive, under a name of its
// own, and never leaves one behind.
async function replaceObservationWritesPrivately() {
  const { replaceObservation } = require(buildPath);
  await withObservationFile(async ({ project, dir, obsPath }) => {
    fs.writeFileSync(`${obsPath}.tmp`, 'stale');
    await replaceObservation(project, 'o1', COMPRESSED);
    assert.match(fs.readFileSync(obsPath, 'utf8'), /"title":"compressed"/);
    assert.strictEqual(fs.readFileSync(`${obsPath}.tmp`, 'utf8'), 'stale', 'a file already at a temp-like name is neither reused nor replaced');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['observations.jsonl', 'observations.jsonl.tmp'], 'no temp file is left behind');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(obsPath).mode & 0o777, 0o600, 'the rewritten file is private');
  });
}

async function replaceObservationCleansUpAfterAFailedRename() {
  const { replaceObservation } = require(buildPath);
  await withObservationFile(async ({ project, dir, obsPath }) => {
    const originalRenameSync = fs.renameSync;
    fs.renameSync = () => { throw new Error('rename refused'); };
    try {
      await assert.rejects(replaceObservation(project, 'o1', COMPRESSED), /rename refused/);
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert.deepStrictEqual(fs.readdirSync(dir), ['observations.jsonl'], 'the temp file is removed when the rename fails');
    assert.match(fs.readFileSync(obsPath, 'utf8'), /token=abc/, 'the original file is untouched');
  });
}

(async () => {
  if (await asyncTest('replaceObservation rewrites observations.jsonl through a private temp file of its own', replaceObservationWritesPrivately)) passed++;
  else failed++;
  if (await asyncTest('replaceObservation removes its temp file when the rename fails', replaceObservationCleansUpAfterAFailedRename)) passed++;
  else failed++;
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
