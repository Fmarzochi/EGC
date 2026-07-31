/**
 * Tests for the host-neutral session-context-loader core.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LOADER = path.join(__dirname, '..', '..', 'scripts', 'lib', 'session-context-loader.js');

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

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function projectSlug(projectPath) {
  const parts = projectPath.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
}

function writeState(homeDir, projectPath, content) {
  const stateDir = path.join(homeDir, '.egc', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, `${projectSlug(projectPath)}.md`), content, 'utf8');
}

function runLoader(homeDir, projectPath, host, extraEnv = {}) {
  const program = [
    `const { loadSessionContext } = require(${JSON.stringify(LOADER)});`,
    `const result = loadSessionContext(${JSON.stringify({ projectPath, host })});`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', program], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      EGC_AGENTS_DIR: path.join(homeDir, 'missing-agents'),
      ...extraEnv,
    },
    timeout: 10000,
  });

  assert.strictEqual(result.status, 0, result.stderr || 'loader subprocess failed');
  return JSON.parse(result.stdout);
}

function runTests() {
  console.log('\n=== Testing session-context-loader ===\n');

  let passed = 0;
  let failed = 0;

  if (test('returns identical shared context while preserving each host identifier', () => {
    const homeDir = createTempDir('session-context-loader-home-');
    const projectPath = '/workspace/shared-project';
    try {
      writeState(homeDir, projectPath, '# Project State\n- shared-memory-marker\n');
      const claude = runLoader(homeDir, projectPath, 'claude');
      const opencode = runLoader(homeDir, projectPath, 'opencode');

      assert.strictEqual(claude.host, 'claude');
      assert.strictEqual(opencode.host, 'opencode');
      assert.strictEqual(claude.context, opencode.context);
      assert.match(claude.context, /EGC persistent memory/);
      assert.match(claude.context, /shared-memory-marker/);
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('returns empty data without assuming a host when input is missing', () => {
    const homeDir = createTempDir('session-context-loader-home-');
    try {
      const program = [
        `const { loadSessionContext } = require(${JSON.stringify(LOADER)});`,
        'process.stdout.write(JSON.stringify(loadSessionContext()));',
      ].join('\n');
      const result = spawnSync(process.execPath, ['-e', program], {
        encoding: 'utf8',
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      });
      assert.strictEqual(result.status, 0);
      assert.deepStrictEqual(JSON.parse(result.stdout), { host: null, context: '' });
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('returns empty context when no matching state or stack exists', () => {
    const homeDir = createTempDir('session-context-loader-home-');
    try {
      const result = runLoader(homeDir, '/workspace/empty-project', 'opencode');
      assert.deepStrictEqual(result, { host: 'opencode', context: '' });
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('adds a stack briefing independently of the host adapter', () => {
    const homeDir = createTempDir('session-context-loader-home-');
    const projectDir = createTempDir('session-context-loader-project-');
    try {
      fs.writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'loader-test', version: '1.0.0' }),
        'utf8'
      );
      const result = runLoader(homeDir, projectDir, 'opencode');
      assert.match(result.context, /=== EGC Stack Briefing ===/);
      assert.match(result.context, /coding-standards/);
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
