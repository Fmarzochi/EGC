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
  const rawInput = JSON.stringify(typeof prompt === 'string' ? { prompt } : prompt);
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

  if (test('catalog mode separates what the tool has installed from what only exists in the catalog', () => {
    const indexFile = path.join(os.tmpdir(), `egc-skill-index-${Date.now()}.json`);
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-router-home-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-router-project-'));
    fs.writeFileSync(indexFile, JSON.stringify({
      entries: [
        { kind: 'skill', name: 'playwright-e2e-fixture', description: 'Playwright end to end browser tests for web apps', source: 'skills/testing/playwright-e2e-fixture/SKILL.md' },
        { kind: 'skill', name: 'playwright-visual-fixture', description: 'Playwright visual regression screenshots for browser tests', source: 'skills/testing/playwright-visual-fixture/SKILL.md' },
        { kind: 'agent', name: 'e2e-runner-fixture', description: 'Runs playwright browser tests and reports checkout failures', source: 'agents/e2e-runner-fixture.md' },
      ],
    }));
    const state = path.join(homeDir, '.claude', 'egc', 'install-state.json');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, JSON.stringify({ operations: [{ kind: 'copy-file', sourceRelativePath: 'skills/testing/playwright-e2e-fixture/SKILL.md' }] }));
    try {
      const result = runHook({ prompt: 'write playwright browser tests for the checkout flow', session_id: `router-split-${Date.now()}`, cwd: projectDir }, {
        EGC_SKILL_INDEX_PATH: indexFile, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_PROJECT_DIR: projectDir,
      });
      assert.strictEqual(result.code, 0, `Expected exit 0, got stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('EGC on this tool: 1 of 2 catalog skills and 0 of 1 agents installed.'), `Expected the inventory line, got: ${result.stdout}`);
      assert.ok(result.stdout.includes('egc install --prompt-library'), `Expected the install hint, got: ${result.stdout}`);
      assert.ok(result.stdout.includes('Route by intent'), `Expected the intent line, got: ${result.stdout}`);
      assert.ok(/Installed skills:\n- playwright-e2e-fixture/.test(result.stdout), `Expected the installed skill under its label, got: ${result.stdout}`);
      assert.ok(!result.stdout.includes('- playwright-visual-fixture:'), `A skill that is not installed must not be offered as a candidate: ${result.stdout}`);
      assert.ok(/Not installed for this tool \(catalog only, do not invoke\): [^\n]*playwright-visual-fixture/.test(result.stdout), `Expected the not-installed line, got: ${result.stdout}`);
      assert.ok(/Not installed for this tool[^\n]*e2e-runner-fixture/.test(result.stdout), `The agent that is not installed belongs on the not-installed line: ${result.stdout}`);
      const second = runHook({ prompt: 'write playwright browser tests for the checkout flow', session_id: 'router-split-second', cwd: projectDir }, {
        EGC_SKILL_INDEX_PATH: indexFile, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_PROJECT_DIR: projectDir,
      });
      const third = runHook({ prompt: 'write playwright browser tests for the checkout flow', session_id: 'router-split-second', cwd: projectDir }, {
        EGC_SKILL_INDEX_PATH: indexFile, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_PROJECT_DIR: projectDir,
      });
      assert.ok(second.stdout.includes('EGC on this tool:'), 'the first prompt of a session carries the inventory');
      assert.ok(!third.stdout.includes('EGC on this tool:'), `the second prompt of the same session does not: ${third.stdout}`);
    } finally {
      try { fs.rmSync(indexFile, { force: true }); } catch { /* best-effort cleanup */ }
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      try { fs.rmSync(path.join(os.tmpdir(), 'egc-router-router-split-second.seen'), { force: true }); } catch { /* best-effort cleanup */ }
    }
  })) passed++; else failed++;

  if (test('catalog mode stays silent when the only matches are words most of the catalog shares', () => {
    const indexFile = path.join(os.tmpdir(), `egc-skill-index-${Date.now()}.json`);
    const entries = [];
    for (let i = 0; i < 12; i++) {
      entries.push({ kind: 'skill', name: `egc-tool-${i}`, description: `Operate the EGC engine and its memory for project ${i}` });
    }
    fs.writeFileSync(indexFile, JSON.stringify({ entries }));
    try {
      const result = runHook('bom dia, me atualize de onde paramos no egc e carregue a memoria', { EGC_SKILL_INDEX_PATH: indexFile });
      assert.strictEqual(result.code, 0, 'Expected exit 0');
      assert.strictEqual(result.stdout, '', `Shared words must not produce a list: ${result.stdout}`);
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
