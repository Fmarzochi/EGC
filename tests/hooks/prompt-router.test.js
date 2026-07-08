/**
 * Tests for scripts/hooks/prompt-router.js via run-with-flags.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runner = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'run-with-flags.js');
const fakeCli = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runHook(prompt, env = {}) {
  const rawInput = JSON.stringify({ prompt });
  const result = spawnSync('node', [runner, 'prompt:router', 'scripts/hooks/prompt-router.js', 'standard,strict'], {
    input: rawInput,
    encoding: 'utf8',
    env: {
      ...process.env,
      ECC_HOOK_PROFILE: 'standard',
      EGC_GUARDIAN_CLI: fakeCli,
      ...env
    },
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function runTests() {
  console.log('\n=== Testing prompt-router ===\n');

  let passed = 0;
  let failed = 0;

  if (test('keyword mode injects routing context for a task-shaped prompt', () => {
    const result = runHook('review this typescript pull request for security issues', { EGC_ROUTING_MODE: 'keyword' });
    assert.strictEqual(result.code, 0, `Expected exit 0, got stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('=== EGC Routing ==='), `Expected routing header, got: ${result.stdout}`);
    assert.ok(result.stdout.includes('Skills: security-review'), `Expected skills line, got: ${result.stdout}`);
  })) passed++; else failed++;

  if (test('stays silent for prompts below the minimum length', () => {
    const result = runHook('oi');
    assert.strictEqual(result.code, 0, 'Expected exit 0');
    assert.strictEqual(result.stdout, '', `Expected empty stdout, got: ${result.stdout}`);
  })) passed++; else failed++;

  if (test('never echoes the raw input JSON into context', () => {
    const result = runHook('review this typescript pull request for security issues');
    assert.ok(!result.stdout.includes('"prompt"'), `Raw input leaked into stdout: ${result.stdout}`);
  })) passed++; else failed++;

  if (test('keyword mode stays silent when the router crashes', () => {
    const brokenCli = path.join(os.tmpdir(), `egc-broken-cli-${Date.now()}.js`);
    fs.writeFileSync(brokenCli, 'process.exit(1);\n');
    try {
      const result = runHook('review this typescript pull request for security issues', {
        EGC_ROUTING_MODE: 'keyword',
        EGC_GUARDIAN_CLI: brokenCli,
      });
      assert.strictEqual(result.code, 0, 'Expected exit 0 on router crash');
      assert.strictEqual(result.stdout, '', `Expected empty stdout, got: ${result.stdout}`);
    } finally {
      try { fs.rmSync(brokenCli, { force: true }); } catch { /* best-effort cleanup */ }
    }
  })) passed++; else failed++;

  if (test('catalog mode lists candidates from the skill index for the model to pick', () => {
    const indexFile = path.join(os.tmpdir(), `egc-skill-index-${Date.now()}.json`);
    fs.writeFileSync(indexFile, JSON.stringify({
      entries: [
        { kind: 'skill', name: 'security-review-fixture', description: 'Security review of pull request changes' },
        { kind: 'skill', name: 'baking-recipes', description: 'Sourdough bread hydration tables' },
        { kind: 'agent', name: 'security-reviewer-fixture', description: 'Reviews security sensitive typescript code' },
      ],
    }));
    try {
      const result = runHook('review this typescript pull request for security issues', {
        [`EGC_SKILL_INDEX_PATH`]: indexFile,
      });
      assert.strictEqual(result.code, 0, `Expected exit 0, got stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('=== EGC Catalog (in-session routing) ==='), `Expected catalog header, got: ${result.stdout}`);
      assert.ok(result.stdout.includes('security-review-fixture'), `Expected matching skill, got: ${result.stdout}`);
      assert.ok(result.stdout.includes('security-reviewer-fixture'), `Expected matching agent, got: ${result.stdout}`);
      assert.ok(!result.stdout.includes('baking-recipes'), `Unrelated skill leaked in: ${result.stdout}`);
      assert.ok(result.stdout.includes('If none fit, proceed without them.'), `Expected opt-out line, got: ${result.stdout}`);
    } finally {
      try { fs.rmSync(indexFile, { force: true }); } catch { /* best-effort cleanup */ }
    }
  })) passed++; else failed++;

  if (test('catalog mode stays silent when nothing in the index matches', () => {
    const indexFile = path.join(os.tmpdir(), `egc-skill-index-${Date.now()}.json`);
    fs.writeFileSync(indexFile, JSON.stringify({
      entries: [
        { kind: 'skill', name: 'baking-recipes', description: 'Sourdough bread hydration tables' },
      ],
    }));
    try {
      const result = runHook('zzz qqq xxx unmatched wording here', {
        [`EGC_SKILL_INDEX_PATH`]: indexFile,
      });
      assert.strictEqual(result.code, 0, 'Expected exit 0');
      assert.strictEqual(result.stdout, '', `Expected empty stdout, got: ${result.stdout}`);
    } finally {
      try { fs.rmSync(indexFile, { force: true }); } catch { /* best-effort cleanup */ }
    }
  })) passed++; else failed++;

  if (test('catalog mode falls back to keyword routing when the index is missing', () => {
    const result = runHook('review this typescript pull request for security issues', {
      [`EGC_SKILL_INDEX_PATH`]: path.join(os.tmpdir(), 'egc-missing-index.json'),
      EGC_ROUTER_DISABLE_BUNDLED_INDEX: '1',
    });
    assert.strictEqual(result.code, 0, `Expected exit 0, got stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('=== EGC Routing ==='), `Expected keyword fallback, got: ${result.stdout}`);
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
