'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BUILD = path.join(__dirname, '..', '..', 'mcp', 'servers', 'egc-memory', 'build', 'state-store-path.js');
if (!fs.existsSync(BUILD)) {
  console.log(`[SKIP] Missing ${BUILD}. Run 'npm run build' in mcp/servers/egc-memory first.`);
  process.exit(0);
}

const { resolveStateStoreDbPath } = require(BUILD);

function test(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

function withHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-memory-store-path-'));
  return {
    homeDir,
    env: { HOME: homeDir, USERPROFILE: homeDir },
    cleanup() {
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

let passed = 0;
let failed = 0;

console.log('\n=== egc-memory state store path ===\n');

if (test('reads the shared store when it exists, whatever the harness variables say', () => {
  const home = withHome();
  try {
    const canonical = path.join(home.homeDir, '.egc', 'egc', 'state.db');
    touch(canonical);
    touch(path.join(home.homeDir, '.gemini', 'egc', 'state.db'));
    assert.strictEqual(resolveStateStoreDbPath({ ...home.env, GEMINI_PROJECT_DIR: home.homeDir }), canonical);
  } finally {
    home.cleanup();
  }
})) passed++; else failed++;

if (test('falls back to a harness copy only while the shared store is missing', () => {
  const home = withHome();
  try {
    const legacy = path.join(home.homeDir, '.gemini', 'egc', 'state.db');
    touch(legacy);
    assert.strictEqual(resolveStateStoreDbPath(home.env), legacy);
  } finally {
    home.cleanup();
  }
})) passed++; else failed++;

if (test('names the shared store when nothing exists yet', () => {
  const home = withHome();
  try {
    assert.strictEqual(resolveStateStoreDbPath(home.env), path.join(home.homeDir, '.egc', 'egc', 'state.db'));
  } finally {
    home.cleanup();
  }
})) passed++; else failed++;

if (test('EGC_STATE_DB overrides everything', () => {
  const home = withHome();
  try {
    const override = path.join(home.homeDir, 'elsewhere', 'state.db');
    touch(path.join(home.homeDir, '.egc', 'egc', 'state.db'));
    assert.strictEqual(resolveStateStoreDbPath({ ...home.env, EGC_STATE_DB: override }), override);
  } finally {
    home.cleanup();
  }
})) passed++; else failed++;

if (test('prefers the copy of the active tool when several harness copies exist and the shared store is missing', () => {
  const home = withHome();
  try {
    const claudeCopy = path.join(home.homeDir, '.claude', 'egc', 'state.db');
    const geminiCopy = path.join(home.homeDir, '.gemini', 'egc', 'state.db');
    touch(claudeCopy);
    touch(geminiCopy);
    assert.strictEqual(resolveStateStoreDbPath({ ...home.env, GEMINI_PROJECT_DIR: home.homeDir }), geminiCopy);
    assert.strictEqual(resolveStateStoreDbPath(home.env), geminiCopy, 'without a variable the order of getKnownHarnessDirs applies');
  } finally {
    home.cleanup();
  }
})) passed++; else failed++;

if (test('reads a copy under any known harness root, OpenCode included', () => {
  const home = withHome();
  try {
    const opencodeCopy = path.join(home.homeDir, '.config', 'opencode', 'egc', 'state.db');
    touch(opencodeCopy);
    assert.strictEqual(resolveStateStoreDbPath(home.env), opencodeCopy);
  } finally {
    home.cleanup();
  }
})) passed++; else failed++;

if (test('EGC_DIR is honored like the CLI does', () => {
  const home = withHome();
  try {
    touch(path.join(home.homeDir, '.egc', 'egc', 'state.db'));
    assert.strictEqual(resolveStateStoreDbPath({ ...home.env, EGC_DIR: path.join(home.homeDir, 'custom') }), path.join(home.homeDir, 'custom', 'egc', 'state.db'));
  } finally {
    home.cleanup();
  }
})) passed++; else failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
