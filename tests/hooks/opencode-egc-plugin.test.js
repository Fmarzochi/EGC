/** Installed-layout tests for scripts/hooks/opencode-egc-plugin.js. */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { planInstallTargetScaffold } = require('../../scripts/lib/install-targets/registry');

const REPO_ROOT = path.join(__dirname, '..', '..');
const FAKE_CLI = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');
const SESSION_FILES = [
  'scripts/hooks/opencode-session-start.js',
  'scripts/lib/session-start-adapter.js',
  'scripts/lib/session-context-loader.js',
  'scripts/lib/branch-state.js',
  'scripts/lib/global-state.js',
  'scripts/lib/project-detect.js',
  'scripts/lib/propagate-state.js',
  'scripts/lib/state-crypto.js',
];

function install(homeDir) {
  const plan = planInstallTargetScaffold({ target: 'opencode', repoRoot: REPO_ROOT, homeDir, modules: [] });
  for (const operation of plan.operations) {
    const source = path.join(REPO_ROOT, operation.sourceRelativePath);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });
    fs.copyFileSync(source, operation.destinationPath);
  }
  return path.join(homeDir, '.config', 'opencode');
}

function slug(projectDir) {
  return projectDir.replaceAll('\\', '/').split('/').filter(Boolean)
    .slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
}

function writeState(homeDir, projectDir, marker) {
  const stateDir = path.join(homeDir, '.egc', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, `${slug(projectDir)}.md`), `# State\n- ${marker}\n`);
}

function replaceTemporarily(file, content) {
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, content);
  return () => fs.writeFileSync(file, original);
}

async function withEnvironment(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function sessionEvent(id, directory) {
  return { type: 'session.created', properties: { info: { id, directory } } };
}

function clientWith(calls, error) {
  return { session: { prompt: async input => {
    if (error) throw error;
    calls.push(input);
  } } };
}

function captureDashboard() {
  return new Promise((resolve, reject) => {
    let accept;
    let fail;
    const request = new Promise((res, rej) => { accept = res; fail = rej; });
    const server = http.createServer((incoming, response) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { body += chunk; });
      incoming.on('end', () => {
        response.writeHead(204).end();
        try { accept(JSON.parse(body)); } catch (error) { fail(error); }
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      request,
      close: () => new Promise(done => server.close(done)),
    }));
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function runTests() {
  console.log('\n=== Testing opencode-egc-plugin ===\n');
  let passed = 0;
  let failed = 0;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-'));
  const savedEnv = Object.fromEntries([
    'EGC_GUARDIAN_CLI',
    'EGC_ASSUME_EGC_CLI',
    'HOME',
    'USERPROFILE',
    'EGC_PORT',
    'EGC_SESSION_CONTEXT_TIMEOUT_MS',
    'EGC_SESSION_CONTEXT_MAX_BYTES',
  ]
    .map(key => [key, process.env[key]]));

  process.env.EGC_GUARDIAN_CLI = FAKE_CLI;
  process.env.EGC_ASSUME_EGC_CLI = '0';
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;

  try {
    const root = install(tempDir);
    const pluginPath = path.join(root, 'plugins', 'opencode-egc-plugin.js');
    const bridgePath = path.join(root, 'scripts', 'hooks', 'opencode-session-start.js');
    let EgcGuardianCrusher;

    if (await test('installs the plugin and host-neutral session dependency tree', () => {
      assert.ok(fs.existsSync(pluginPath));
      for (const relative of SESSION_FILES) assert.ok(fs.existsSync(path.join(root, relative)), relative);
      delete require.cache[require.resolve(pluginPath)];
      ({ EgcGuardianCrusher } = require(pluginPath));
      assert.strictEqual(typeof EgcGuardianCrusher, 'function');
    })) passed++; else failed++;

    if (await test('restores context once across generic and event-specific dispatch', async () => {
      const project = path.join(tempDir, 'workspaces', 'context');
      fs.mkdirSync(project, { recursive: true });
      writeState(tempDir, project, 'opencode-context-marker');
      const calls = [];
      const hooks = await EgcGuardianCrusher({ client: clientWith(calls), directory: project });
      const event = sessionEvent('ses_context', project);
      const genericDispatch = hooks.event({ event });
      const specificDispatch = hooks['session.created'](event);
      await Promise.all([genericDispatch, specificDispatch]);
      await hooks.event({ event });
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].path, { id: 'ses_context' });
      assert.strictEqual(calls[0].body.noReply, true);
      assert.match(calls[0].body.parts[0].text, /opencode-context-marker/);
    })) passed++; else failed++;

    if (await test('reports OpenCode rather than Claude to the Dashboard', async () => {
      const project = path.join(tempDir, 'workspaces', 'telemetry');
      fs.mkdirSync(project, { recursive: true });
      writeState(tempDir, project, 'telemetry-marker');
      const capture = await captureDashboard();
      try {
        await withEnvironment('EGC_PORT', String(capture.port), async () => {
          const hooks = await EgcGuardianCrusher({ client: clientWith([]), directory: project });
          await hooks.event({ event: sessionEvent('ses_telemetry', project) });
          const payload = await capture.request;
          assert.deepStrictEqual(payload, { ide: 'opencode', event: 'session_start', session_id: 'ses_telemetry' });
        });
      } finally {
        await capture.close();
      }
    })) passed++; else failed++;

    if (await test('skips empty context and fails open on prompt rejection', async () => {
      const empty = path.join(tempDir, 'workspaces', 'empty');
      fs.mkdirSync(empty, { recursive: true });
      const calls = [];
      let hooks = await EgcGuardianCrusher({ client: clientWith(calls), directory: empty });
      await hooks.event({ event: sessionEvent('ses_empty', empty) });
      assert.strictEqual(calls.length, 0);

      const failing = path.join(tempDir, 'workspaces', 'failing');
      fs.mkdirSync(failing, { recursive: true });
      writeState(tempDir, failing, 'failure-marker');
      hooks = await EgcGuardianCrusher({ client: clientWith([], new Error('rejected')), directory: failing });
      await assert.doesNotReject(() => hooks.event({ event: sessionEvent('ses_failure', failing) }));
    })) passed++; else failed++;

    if (await test('fails open when the OpenCode prompt exceeds its timeout', async () => {
      const stub = "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({host:'opencode',context:'prompt-timeout-marker'}));\n";
      const restore = replaceTemporarily(bridgePath, stub);
      try {
        let attempts = 0;
        const client = { session: { prompt: () => {
          attempts += 1;
          return new Promise(() => {});
        } } };
        await withEnvironment('EGC_SESSION_CONTEXT_TIMEOUT_MS', '500', async () => {
          const hooks = await EgcGuardianCrusher({ client, directory: tempDir });
          const started = Date.now();
          await assert.doesNotReject(() => hooks.event({ event: sessionEvent('ses_prompt_timeout', tempDir) }));
          const elapsed = Date.now() - started;
          assert.ok(elapsed >= 75, `expected prompt timeout path, completed in ${elapsed}ms`);
          assert.ok(elapsed < 2000, `prompt timeout path took ${elapsed}ms`);
          assert.strictEqual(attempts, 1);
        });
      } finally { restore(); }
    })) passed++; else failed++;

    if (await test('fails open when the bridge exceeds its timeout', async () => {
      const restore = replaceTemporarily(bridgePath, "#!/usr/bin/env node\nsetTimeout(() => {}, 10000);\n");
      try {
        await withEnvironment('EGC_SESSION_CONTEXT_TIMEOUT_MS', '150', async () => {
          const calls = [];
          const hooks = await EgcGuardianCrusher({ client: clientWith(calls), directory: tempDir });
          const started = Date.now();
          await assert.doesNotReject(() => hooks.event({ event: sessionEvent('ses_timeout', tempDir) }));
          const elapsed = Date.now() - started;
          assert.ok(elapsed >= 75, `expected timeout path, completed in ${elapsed}ms`);
          assert.ok(elapsed < 2000, `timeout path took ${elapsed}ms`);
          assert.strictEqual(calls.length, 0);
        });
      } finally { restore(); }
    })) passed++; else failed++;

    if (await test('fails open when the bridge exceeds the output limit', async () => {
      const stub = "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({host:'opencode',context:'x'.repeat(4096)}));\n";
      const restore = replaceTemporarily(bridgePath, stub);
      try {
        await withEnvironment('EGC_SESSION_CONTEXT_MAX_BYTES', '1024', async () => {
          const calls = [];
          const hooks = await EgcGuardianCrusher({ client: clientWith(calls), directory: tempDir });
          await assert.doesNotReject(() => hooks.event({ event: sessionEvent('ses_oversize', tempDir) }));
          assert.strictEqual(calls.length, 0);
        });
      } finally { restore(); }
    })) passed++; else failed++;

    if (await test('ignores unrelated or malformed events and missing clients', async () => {
      const withoutClient = await EgcGuardianCrusher({ directory: tempDir });
      await assert.doesNotReject(() => withoutClient.event({ event: sessionEvent('ses_no_client', tempDir) }));
      const calls = [];
      const hooks = await EgcGuardianCrusher({ client: clientWith(calls), directory: tempDir });
      await hooks.event();
      await hooks.event({ event: { type: 'session.idle', properties: {} } });
      await hooks.event({ event: { type: 'session.created', properties: { info: { directory: tempDir } } } });
      assert.strictEqual(calls.length, 0);
    })) passed++; else failed++;

    if (await test('preserves Guardian and Crusher behavior', async () => {
      let hooks = await EgcGuardianCrusher({ directory: tempDir });
      const readOutput = { args: { filePath: '/tmp/x' } };
      await hooks['tool.execute.before']({ tool: 'read' }, readOutput);
      assert.deepStrictEqual(readOutput.args, { filePath: '/tmp/x' });
      const missingCommand = { args: {} };
      await hooks['tool.execute.before']({ tool: 'bash' }, missingCommand);
      await assert.rejects(
        () => hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'rm -rf /' } }),
        /EGC Guardian BLOCKED/
      );
      const safe = { args: { command: 'git status' } };
      await hooks['tool.execute.before']({ tool: 'bash' }, safe);
      assert.strictEqual(safe.args.command, 'git status');
      process.env.EGC_ASSUME_EGC_CLI = '1';
      hooks = await EgcGuardianCrusher({ directory: tempDir });
      const crushable = { args: { command: 'npm test' } };
      await hooks['tool.execute.before']({ tool: 'bash' }, crushable);
      assert.strictEqual(crushable.args.command, 'egc run npm test');
      process.env.EGC_ASSUME_EGC_CLI = '0';
    })) passed++; else failed++;
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
