/**
 * Subprocess tests for scripts/hooks/claude-session-start.js
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
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

  const cases = [];
  function addCase(name, fn) {
    cases.push(() => test(name, fn));
  }

  addCase('prints the state file for the cwd received on stdin', () => {
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
  });

  addCase('uses the same slug sanitization as the egc-memory server', () => {
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
  });

  addCase('exits silently with code 0 when no state file exists', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      const result = runHook(homeDir, JSON.stringify({ cwd: '/workspace/empty' }));

      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(homeDir);
    }
  });

  addCase('exits silently with code 0 when the state file is blank', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      writeStateFile(homeDir, 'workspace-blank', '   \n\n');

      const result = runHook(homeDir, JSON.stringify({ cwd: '/workspace/blank' }));

      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      cleanup(homeDir);
    }
  });

  addCase('tolerates invalid stdin and falls back to environment paths', () => {
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
  });

  addCase('emits stack briefing for detectable project (JavaScript)', () => {
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
  });

  addCase('briefing and state are both printed when state exists', () => {
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
  });

  addCase('no briefing emitted for unrecognized project type', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      const result = runHook(homeDir, JSON.stringify({ cwd: '/workspace/empty' }));

      assert.strictEqual(result.code, 0);
      assert.ok(!result.stdout.includes('EGC Stack Briefing'), 'unexpected briefing');
    } finally {
      cleanup(homeDir);
    }
  });

  addCase('briefing shows install hint when agents directory is missing', () => {
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
  });

  addCase('stays silent for encrypted state when no key exists', () => {
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
  });

  addCase('migrates the legacy continuous-learning store on its first run', () => {
    const homeDir = createTempDir('claude-session-start-home-');
    try {
      fs.mkdirSync(path.join(homeDir, '.gemini', 'homunculus', 'instincts', 'personal'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, '.gemini', 'homunculus', 'instincts', 'personal', 'a.yaml'), 'a');

      const result = runHook(homeDir, JSON.stringify({ cwd: '/workspace/empty' }));

      assert.strictEqual(result.code, 0);
      assert.strictEqual(
        fs.readFileSync(path.join(homeDir, '.egc-learning', 'instincts', 'personal', 'a.yaml'), 'utf8'),
        'a',
        'the native settings.json install path must migrate the store too, not only the plugin hooks.json path'
      );
    } finally {
      cleanup(homeDir);
    }
  });

  addCase('the installed hook migrates the store, so the install plan ships every dependency', () => {
    const { planInstallTargetScaffold } = require('../../scripts/lib/install-targets/registry');
    const repoRoot = path.join(__dirname, '..', '..');
    const homeDir = createTempDir('claude-session-start-installed-');
    try {
      const plan = planInstallTargetScaffold({ target: 'claude', repoRoot, homeDir, modules: [] });
      for (const operation of plan.operations) {
        if (operation.kind !== 'copy-path') continue;
        const source = path.join(repoRoot, operation.sourceRelativePath);
        // A planned source that is gone fails here, loudly, instead of
        // shipping an install that only this test's last assertion would miss.
        assert.ok(fs.existsSync(source), `the install plan copies ${operation.sourceRelativePath}, which does not exist`);
        fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });
        fs.cpSync(source, operation.destinationPath, { recursive: true });
      }
      const installedHook = path.join(homeDir, '.claude', 'egc', 'hooks', 'claude-session-start.js');
      assert.ok(fs.existsSync(installedHook), 'the install plan places the hook');

      const legacy = path.join(homeDir, '.gemini', 'homunculus', 'instincts', 'personal');
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, 'a.yaml'), 'a');

      const result = spawnSync(process.execPath, [installedHook], {
        input: JSON.stringify({ cwd: '/workspace/empty' }),
        encoding: 'utf8',
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_PROJECT_DIR: '', PWD: '' },
        timeout: 10000,
      });

      assert.strictEqual(result.status, 0, `status ${result.status}, signal ${result.signal}, error ${result.error}, stderr ${result.stderr}`);
      assert.strictEqual(
        fs.readFileSync(path.join(homeDir, '.egc-learning', 'instincts', 'personal', 'a.yaml'), 'utf8'),
        'a',
        'a dependency missing from the install plan would make the adapter fall back to a silent no-op'
      );
    } finally {
      cleanup(homeDir);
    }
  });

  addCase('prints decrypted state when the encryption key exists', () => {
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
  });

  let passed = 0;
  let failed = 0;
  for (const run of cases) {
    if (run()) passed++; else failed++;
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

// Every hook these cases run posts a session_start event to the Dashboard;
// a listener owned by this run receives it, so a developer's running
// Dashboard on the default port never sees test traffic.
const dashboard = http.createServer((request, response) => {
  request.resume();
  response.writeHead(204).end();
});
dashboard.listen(0, '127.0.0.1', () => {
  process.env.EGC_PORT = String(dashboard.address().port);
  runTests();
});
