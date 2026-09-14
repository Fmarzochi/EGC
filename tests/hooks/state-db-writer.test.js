'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WRITER = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'state-db-writer.js');
const { createStateStore } = require('../../scripts/lib/state-store');

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
    timeout: 30000,
  });
}

async function main() {
  let passed = 0;
  let failed = 0;

  console.log('\n=== state-db-writer hook ===\n');

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
