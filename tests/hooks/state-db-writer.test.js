'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const WRITER = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'state-db-writer.js');
const { createStateStore } = require('../../scripts/lib/state-store');
const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

function runWriter(payload, overrides) {
  const env = { ...process.env, ...overrides };
  delete env.EGC_DIR;
  return spawnSync('node', [WRITER], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
  });
}

// The writer with its stdin fed in pieces: each part is written after a
// pause, the way a slow parent or a Windows pipe delivers a payload.
function runWriterInPieces(parts, pauseMs, overrides) {
  const env = { ...process.env, ...overrides };
  delete env.EGC_DIR;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
    const feed = (index) => {
      if (index >= parts.length) {
        child.stdin.end();
        return;
      }
      child.stdin.write(parts[index]);
      setTimeout(() => feed(index + 1), pauseMs);
    };
    setTimeout(() => feed(0), pauseMs);
  });
}

async function countEvents(homeDir, sessionId) {
  const store = await createStateStore({ homeDir });
  try {
    return store.listRecentEvents({ sessionId }).length;
  } finally {
    store.close();
  }
}

async function withSeededHome(fn) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-writer-home-'));
  try {
    const seeded = await createStateStore({ homeDir });
    seeded.close();
    await fn(homeDir, { HOME: homeDir, USERPROFILE: homeDir });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

async function main() {
  let passed = 0;
  let failed = 0;

  console.log('\n=== state-db-writer hook ===\n');

  if (await test('a payload that arrives in pieces, with pauses, is recorded whole', async () => {
    await withSeededHome(async (homeDir, env) => {
      const payload = JSON.stringify({ event_type: 'tool_use', session_id: 'pieces-session', tool: 'Edit' });
      const middle = Math.floor(payload.length / 2);
      const result = await runWriterInPieces([payload.slice(0, middle), payload.slice(middle)], 200, env);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stderr.trim(), '', `the writer reported an error: ${result.stderr}`);
      assert.strictEqual(await countEvents(homeDir, 'pieces-session'), 1, 'the event lands once the whole payload is in');
    });
  })) passed++; else failed++;

  if (await test('a payload over the input cap is refused aloud instead of lost in silence', async () => {
    await withSeededHome(async (homeDir, env) => {
      const oversized = JSON.stringify({ event_type: 'tool_use', session_id: 'oversized-session', filler: 'x'.repeat(1024 * 1024) });
      const result = await runWriterInPieces([oversized], 20, env);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /cut off/, 'the writer must say the input was cut off');
      assert.strictEqual(await countEvents(homeDir, 'oversized-session'), 0, 'a partial payload is never recorded');
    });
  })) passed++; else failed++;

  if (await test('input that is not JSON is refused aloud instead of lost in silence', async () => {
    await withSeededHome(async (homeDir, env) => {
      const result = await runWriterInPieces(['{"event_type": "tool_use", "session_id": "broken-session"'], 20, env);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /not JSON/, 'the writer must say the input is not JSON');
      assert.strictEqual(await countEvents(homeDir, 'broken-session'), 0);
    });
  })) passed++; else failed++;

  if (await test('writes the event to the shared store when a harness variable points elsewhere', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-writer-home-'));
    try {
      const seeded = await createStateStore({ homeDir });
      seeded.close();
      fs.mkdirSync(path.join(homeDir, '.gemini', 'egc'), { recursive: true });

      const result = runWriter(
        { event_type: 'tool_use', session_id: 'writer-session', tool: 'Bash' },
        { HOME: homeDir, USERPROFILE: homeDir, GEMINI_PROJECT_DIR: homeDir }
      );
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(!fs.existsSync(path.join(homeDir, '.gemini', 'egc', 'state.db')), 'no store may appear in the harness directory');

      const store = await createStateStore({ homeDir });
      try {
        const events = store.listRecentEvents({ sessionId: 'writer-session' });
        assert.strictEqual(events.length, 1, 'the event lands in the shared store');
        assert.strictEqual(events[0].eventType, 'tool_use');
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
