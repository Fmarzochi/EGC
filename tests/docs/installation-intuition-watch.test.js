'use strict';

/**
 * The installation guide says what auto-intuition and egc watch need, and
 * those statements follow the code (#1666): the intent classifier only runs
 * with one of the provider keys intuition.ts checks and stops on
 * EGC_INTUITION_LLM=0, and egc watch watches one project, the current
 * directory unless a path or --project is given.
 *
 * Run with: node tests/docs/installation-intuition-watch.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const repoRoot = path.resolve(__dirname, '..', '..');
const INTUITION_BUILD = path.join(repoRoot, 'mcp/servers/egc-guardian/build/intuition.js');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

const guide = fs.readFileSync(path.join(repoRoot, 'docs/installation.md'), 'utf8');
const intuition = fs.readFileSync(path.join(repoRoot, 'mcp/servers/egc-guardian/src/intuition.ts'), 'utf8');
const watch = fs.readFileSync(path.join(repoRoot, 'scripts/watch.js'), 'utf8');

// The provider keys hasProviderKey() reads, taken from the code itself so a
// new key fails this test until the guide names it too.
function providerKeys() {
  const body = intuition.match(/function hasProviderKey\(\)[\s\S]*?\n}/);
  assert.ok(body, 'intuition.ts must define hasProviderKey()');
  const keys = [...body[0].matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(match => match[1]);
  assert.ok(keys.length > 0, 'hasProviderKey() must read at least one provider key');
  return keys;
}

// Runs fn with exactly the given provider/intuition variables and a fake
// fetch that answers like the Anthropic API with a session_end intent, then
// puts back what was there. Returns fn's result and how often fetch ran.
async function withFakeProvider(env, fn) {
  const names = [...providerKeys(), 'EGC_INTUITION_LLM'];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  const savedFetch = globalThis.fetch;
  let calls = 0;
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, env);
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, json: async () => ({ content: [{ text: '{"intent":"session_end"}' }] }) };
    };
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = savedFetch;
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

async function runTests() {
  console.log('\n=== Testing the installation guide on auto-intuition and egc watch ===\n');

  await test('the guide names every provider key the intent classifier accepts', () => {
    for (const key of providerKeys()) {
      assert.ok(guide.includes(`\`${key}\``), `docs/installation.md must name ${key}`);
    }
  });

  await test('the guide documents EGC_INTUITION_LLM=0, and that value really turns the classifier off', async () => {
    assert.ok(guide.includes('EGC_INTUITION_LLM=0'), 'docs/installation.md must document EGC_INTUITION_LLM=0');
    if (!fs.existsSync(INTUITION_BUILD)) {
      console.log('    (egc-guardian is not built here; CI builds it, so the behavior is checked there)');
      return;
    }
    const { detectIntent } = await import(pathToFileURL(INTUITION_BUILD).href);

    // Control: with a key and no switch the classifier calls the provider,
    // so the off case below cannot pass by never reaching it.
    const on = await withFakeProvider({ ANTHROPIC_API_KEY: 'test-key' }, () => detectIntent('bye for today'));
    assert.deepStrictEqual(on.result, { intent: 'session_end', source: 'llm' });
    assert.strictEqual(on.calls, 1, 'with a key the classifier must call the provider');

    const off = await withFakeProvider(
      { ANTHROPIC_API_KEY: 'test-key', EGC_INTUITION_LLM: '0' },
      () => detectIntent('bye for today')
    );
    assert.deepStrictEqual(off.result, { intent: 'none', source: 'none' });
    assert.strictEqual(off.calls, 0, 'EGC_INTUITION_LLM=0 must not call the provider');

    const noKey = await withFakeProvider({}, () => detectIntent('bye for today'));
    assert.deepStrictEqual(noKey.result, { intent: 'none', source: 'none' });
    assert.strictEqual(noKey.calls, 0, 'without a provider key nothing is detected');
  });

  await test('the egc watch row says it watches one project and how to pick it', () => {
    assert.ok(/projectPath: process\.cwd\(\)/.test(watch), 'watch.js must default to the current directory');
    assert.ok(watch.includes("'--project'"), 'watch.js must accept --project');
    assert.ok(/!args\[i\]\.startsWith\('-'\)/.test(watch), 'watch.js must accept a positional project path');
    const row = guide.split('\n').find(line => line.startsWith('| `egc watch` |'));
    assert.ok(row, 'docs/installation.md must list egc watch in the command reference');
    assert.ok(/\bone project\b/.test(row), 'the egc watch row must say it watches one project');
    assert.ok(/current directory/.test(row), 'the egc watch row must say it defaults to the current directory');
    assert.ok(/as an argument/.test(row), 'the egc watch row must document the positional path');
    assert.ok(row.includes('`--project`'), 'the egc watch row must mention --project');
  });

  if (failed > 0) {
    console.log(`\nFailed: ${failed}`);
    process.exit(1);
  }

  console.log(`\nPassed: ${passed}`);
}

runTests();
