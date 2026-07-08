/**
 * Subprocess tests for scripts/hooks/claude-session-start.js
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'claude-session-start.js');

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

function runHook(homeDir, stdinPayload, extraEnv = {}) {
  const result = spawnSync('node', [SCRIPT], {
    input: stdinPayload,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_PROJECT_DIR: '',
      PWD: '',
      ...extraEnv,
    },
    timeout: 10000,
  });

  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function writeStateFile(homeDir, slug, content) {
  const stateDir = path.join(homeDir, '.egc', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, `${slug}.md`), content);
}

// Same payload layout the egc-memory server writes: EGC1 magic + IV + GCM tag
// + ciphertext (see mcp/servers/egc-memory/src/encryption.ts).
function encryptFixture(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return Buffer.concat([Buffer.from('EGC1:', 'utf-8'), iv, cipher.getAuthTag(), encrypted]);
}

function runTests() {
  console.log('\n=== Testing claude-session-start.js hook ===\n');

  let passed = 0;
  let failed = 0;

  if (test('prints the state file for the cwd received on stdin', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      writeStateFile(homeDir, 'workspace--demo', '# Project State\n- resume feature X\n');

      const result = runHook(
        homeDir,
        JSON.stringify({ cwd: '/workspace/demo', hook_event_name: 'SessionStart' })
      );

      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('EGC persistent memory'));
      assert.ok(result.stdout.includes('resume feature X'));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('uses the same slug sanitization as the egc-memory server', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      writeStateFile(homeDir, 'My_Projects--app_v2_0', 'sanitized slug state\n');

      const result = runHook(
        homeDir,
        JSON.stringify({ cwd: '/home/user/My Projects/app v2.0' })
      );

      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('sanitized slug state'));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('exits silently with code 0 when no state file exists', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      const result = runHook(homeDir, JSON.stringify({ cwd: '/workspace/empty' }));

      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('exits silently with code 0 when the state file is blank', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      writeStateFile(homeDir, 'workspace-blank', '   \n\n');

      const result = runHook(homeDir, JSON.stringify({ cwd: '/workspace/blank' }));

      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('tolerates invalid stdin and falls back to environment paths', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      writeStateFile(homeDir, 'env--project', 'state from env fallback\n');

      const result = runHook(homeDir, 'not json at all', {
        CLAUDE_PROJECT_DIR: '/env/project',
      });

      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('state from env fallback'));
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('emits stack briefing for detectable project (JavaScript)', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    const projectDir = createTempDir('claude-session-start-project-');
    try {
      fs.writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test', version: '1.0.0' })
      );

      const result = runHook(homeDir, JSON.stringify({ cwd: projectDir }));

      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('=== EGC Stack Briefing ==='), 'briefing header missing');
      assert.ok(result.stdout.includes('Stack:'), 'stack line missing');
      assert.ok(result.stdout.includes('coding-standards'), 'coding-standards reminder missing');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('briefing and state are both printed when state exists', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    const projectDir = createTempDir('claude-session-start-project-');
    try {
      fs.writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test', version: '1.0.0' })
      );

      const slug = path.basename(os.tmpdir()) + '--' + path.basename(projectDir);
      const sanitized = slug.replace(/[^a-zA-Z0-9-_]/g, '_');
      writeStateFile(homeDir, sanitized, '# My Project State\n- resume task A\n');

      const result = runHook(homeDir, JSON.stringify({ cwd: projectDir }));

      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('EGC persistent memory'), 'state header missing');
      assert.ok(result.stdout.includes('=== EGC Stack Briefing ==='), 'briefing missing');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('no briefing emitted for unrecognized project type', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      const result = runHook(homeDir, JSON.stringify({ cwd: '/workspace/empty' }));

      assert.strictEqual(result.code, 0);
      assert.ok(!result.stdout.includes('EGC Stack Briefing'), 'unexpected briefing');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('briefing shows install hint when agents directory is missing', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    const projectDir = createTempDir('claude-session-start-project-');
    try {
      fs.writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test', version: '1.0.0' })
      );

      const result = runHook(homeDir, JSON.stringify({ cwd: projectDir }), {
        EGC_AGENTS_DIR: path.join(homeDir, 'nonexistent-agents'),
      });

      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('=== EGC Stack Briefing ==='), 'briefing header missing');
      assert.ok(result.stdout.includes('none installed'), 'install hint missing');
      assert.ok(result.stdout.includes('coding-standards'), 'coding-standards reminder missing');
    } finally {
      cleanup(homeDir);
      cleanup(projectDir);
    }
  })) passed++; else failed++;

  if (test('stays silent for encrypted state when no key exists', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      const key = crypto.randomBytes(32);
      writeStateFile(homeDir, 'workspace--secret', encryptFixture('# Project State\nclassified\n', key));

      const result = runHook(homeDir, JSON.stringify({ cwd: '/workspace/secret' }));

      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('prints decrypted state when the encryption key exists', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      const key = crypto.randomBytes(32);
      const egcDir = path.join(homeDir, '.egc');
      fs.mkdirSync(egcDir, { recursive: true });
      fs.writeFileSync(path.join(egcDir, 'encryption.key'), key.toString('hex'), 'utf-8');
      writeStateFile(
        homeDir,
        'workspace--secret',
        encryptFixture('# Project State\n- decrypted memory line\n', key)
      );

      const result = runHook(homeDir, JSON.stringify({ cwd: '/workspace/secret' }));

      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.includes('EGC persistent memory'), 'state header missing');
      assert.ok(result.stdout.includes('decrypted memory line'), 'plaintext missing');
      assert.ok(!result.stdout.includes('EGC1:'), 'ciphertext must not leak');
    } finally {
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
