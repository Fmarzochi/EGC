/** Installed-layout tests for scripts/hooks/opencode-egc-plugin.js. */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
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
  'scripts/lib/learning-store.js',
  'scripts/lib/utils.js',
  'scripts/hooks/mesh-events-inject.js',
];

function install(homeDir) {
  const plan = planInstallTargetScaffold({ target: 'opencode', repoRoot: REPO_ROOT, homeDir, modules: [] });
  for (const operation of plan.operations) {
    if (operation.kind !== 'copy-path') continue;
    const source = path.join(REPO_ROOT, operation.sourceRelativePath);
    // A planned source that is gone fails loudly instead of leaving the
    // installed layout silently short of a file a real install would need.
    assert.ok(fs.existsSync(source), `the install plan copies ${operation.sourceRelativePath}, which does not exist`);
    fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });
    fs.cpSync(source, operation.destinationPath, { recursive: true, force: false, errorOnExist: true });
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
  let results;
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
    let plugin;
    const cases = [];
    const addCase = (name, fn) => cases.push(() => test(name, fn));

    addCase('installs the plugin and host-neutral session dependency tree', async () => {
      assert.ok(fs.existsSync(pluginPath));
      for (const relative of SESSION_FILES) assert.ok(fs.existsSync(path.join(root, relative)), relative);
      // OpenCode imports the plugin as an ES module; Node needs the package
      // type hint to do the same for a .js file, so the temp layout gets one.
      fs.writeFileSync(path.join(root, 'plugins', 'package.json'), '{ "type": "module" }\n');
      const mod = await import(pathToFileURL(pluginPath).href);
      plugin = mod.default;
      // One default export serves both loaders: OpenCode 2 reads id and setup,
      // OpenCode 1.18.29+ reads the server entrypoint. V1 calls every export
      // as a function, so nothing else may be exported.
      assert.strictEqual(typeof plugin, 'object', 'the default export is the plugin definition');
      assert.strictEqual(plugin.id, 'egc');
      assert.strictEqual(typeof plugin.setup, 'function', 'OpenCode 2 loads the plugin through setup');
      assert.strictEqual(typeof plugin.server, 'function', 'OpenCode 1 loads the plugin through server');
      assert.deepStrictEqual(Object.keys(mod), ['default'], 'the default export is the only export');
      EgcGuardianCrusher = plugin.server;
    });

    addCase('the installed session bridge migrates the legacy continuous-learning store', async () => {
      // Runs the installed copy, not the repository one, so a dependency the
      // install plan forgot to copy turns this red instead of falling back to
      // a silent no-op.
      const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-migrate-home-'));
      // The bridge also posts session_start to the Dashboard: a listener owned
      // by this case takes it, never a developer's running Dashboard.
      const dashboard = await captureDashboard();
      try {
        const legacy = path.join(freshHome, '.gemini', 'homunculus', 'instincts', 'personal');
        fs.mkdirSync(legacy, { recursive: true });
        fs.writeFileSync(path.join(legacy, 'a.yaml'), 'a');

        const result = spawnSync(process.execPath, [bridgePath], {
          input: JSON.stringify({ cwd: freshHome }),
          encoding: 'utf8',
          env: { ...process.env, HOME: freshHome, USERPROFILE: freshHome, EGC_PORT: String(dashboard.port) },
          timeout: 10000,
        });

        assert.strictEqual(result.status, 0, `status ${result.status}, signal ${result.signal}, error ${result.error}, stderr ${result.stderr}`);
        assert.strictEqual(
          fs.readFileSync(path.join(freshHome, '.egc-learning', 'instincts', 'personal', 'a.yaml'), 'utf8'),
          'a'
        );
      } finally {
        await dashboard.close();
        fs.rmSync(freshHome, { recursive: true, force: true });
      }
    });

    addCase('restores context once across generic and event-specific dispatch', async () => {
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
    });

    addCase('reports OpenCode rather than Claude to the Dashboard', async () => {
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
    });

    addCase('skips empty context and fails open on prompt rejection', async () => {
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
    });

    addCase('fails open when the OpenCode prompt exceeds its timeout', async () => {
      const stub = "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({host:'opencode',context:'prompt-timeout-marker'}));\n";
      const restore = replaceTemporarily(bridgePath, stub);
      try {
        let attempts = 0;
        const client = { session: { prompt: () => {
          attempts += 1;
          return new Promise(() => {});
        } } };
        // One variable bounds both the bridge spawn and the prompt: a budget
        // a cold runner's spawn cannot exceed, so the prompt is the stage that
        // times out here (the bridge's own timeout has the case below).
        await withEnvironment('EGC_SESSION_CONTEXT_TIMEOUT_MS', '1500', async () => {
          const hooks = await EgcGuardianCrusher({ client, directory: tempDir });
          const started = Date.now();
          await assert.doesNotReject(() => hooks.event({ event: sessionEvent('ses_prompt_timeout', tempDir) }));
          const elapsed = Date.now() - started;
          assert.strictEqual(attempts, 1, `the prompt was attempted ${attempts} times: 0 means the bridge stage timed out first, after ${elapsed}ms`);
          assert.ok(elapsed >= 750, `expected prompt timeout path, completed in ${elapsed}ms`);
          assert.ok(elapsed < 5000, `prompt timeout path took ${elapsed}ms`);
        });
      } finally { restore(); }
    });

    addCase('fails open when the bridge exceeds its timeout', async () => {
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
    });

    addCase('fails open when the bridge exceeds the output limit', async () => {
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
    });

    addCase('ignores unrelated or malformed events and missing clients', async () => {
      const withoutClient = await EgcGuardianCrusher({ directory: tempDir });
      await assert.doesNotReject(() => withoutClient.event({ event: sessionEvent('ses_no_client', tempDir) }));
      const calls = [];
      const hooks = await EgcGuardianCrusher({ client: clientWith(calls), directory: tempDir });
      await hooks.event();
      await hooks.event({ event: { type: 'session.idle', properties: {} } });
      await hooks.event({ event: { type: 'session.created', properties: { info: { directory: tempDir } } } });
      assert.strictEqual(calls.length, 0);
    });

    addCase('validates write and edit targets with the Guardian', async () => {
      const hooks = await EgcGuardianCrusher({ directory: tempDir });
      await assert.rejects(
        () => hooks['tool.execute.before']({ tool: 'write' }, { args: { filePath: path.join(tempDir, '.ssh', 'id_rsa'), content: 'x' } }),
        /EGC Guardian BLOCKED/
      );
      await assert.rejects(
        () => hooks['tool.execute.before']({ tool: 'edit' }, { args: { filePath: path.join(tempDir, '.aws', 'credentials'), oldString: 'a', newString: 'b' } }),
        /EGC Guardian BLOCKED/
      );
      const fine = { args: { filePath: path.join(tempDir, 'notes.md'), content: 'hello' } };
      await hooks['tool.execute.before']({ tool: 'write' }, fine);
      assert.strictEqual(fine.args.content, 'hello');
    });

    addCase('preserves Guardian and Crusher behavior', async () => {
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
    });

    addCase('judges and rewrites the shell tool of OpenCode 2 the way it does bash, on both loaders', async () => {
      // OpenCode 2 names its command tool `shell`; the plugin only knew `bash`,
      // so every command there ran past the Guardian and the Crusher (#2107).
      const hooks = await EgcGuardianCrusher({ directory: tempDir });
      await assert.rejects(
        () => hooks['tool.execute.before']({ tool: 'shell' }, { args: { command: 'rm -rf /' } }),
        /EGC Guardian BLOCKED/
      );
      const fake = fakeContext(tempDir);
      await plugin.setup(fake.ctx);
      const before = fake.registered.tool['execute.before'];
      await assert.rejects(
        () => before({ tool: 'shell', sessionID: 'ses_shell', input: { command: 'rm -rf /' } }),
        /EGC Guardian BLOCKED/
      );
      await before({ tool: 'shell', sessionID: 'ses_shell', input: {} });
      const safe = { tool: 'shell', sessionID: 'ses_shell', input: { command: 'git status' } };
      await before(safe);
      assert.strictEqual(safe.input.command, 'git status');
      await withEnvironment('EGC_ASSUME_EGC_CLI', '1', async () => {
        const crushable = { tool: 'shell', sessionID: 'ses_shell', input: { command: 'npm test' } };
        await before(crushable);
        assert.strictEqual(crushable.input.command, 'egc run npm test');
        const legacy = { args: { command: 'npm test' } };
        await hooks['tool.execute.before']({ tool: 'shell' }, legacy);
        assert.strictEqual(legacy.args.command, 'egc run npm test');
      });
    });

    addCase('honors EGC_DISABLED_HOOKS and EGC_HOOK_PROFILE in-process, gate by gate', async () => {
      // The hosts that spawn hooks read the flags in run-with-flags; the plugin
      // runs the hooks in-process and read none, so the escape hatch the
      // Guardian names when it cannot validate did nothing here (#2107).
      const fake = fakeContext(tempDir);
      await plugin.setup(fake.ctx);
      const before = fake.registered.tool['execute.before'];
      const secret = path.join(tempDir, '.ssh', 'id_rsa');
      await withEnvironment('EGC_DISABLED_HOOKS', 'pre:bash:guardian-validate', async () => {
        const lifted = { tool: 'shell', sessionID: 'ses_flags', input: { command: 'rm -rf /' } };
        await before(lifted);
        assert.strictEqual(lifted.input.command, 'rm -rf /', 'the command gate is lifted');
        await assert.rejects(
          () => before({ tool: 'write', sessionID: 'ses_flags', input: { filePath: secret, content: 'x' } }),
          /EGC Guardian BLOCKED/,
          'the write gate stays'
        );
      });
      await withEnvironment('EGC_DISABLED_HOOKS', 'pre:edit-write:guardian-validate', async () => {
        const write = { tool: 'write', sessionID: 'ses_flags', input: { filePath: secret, content: 'x' } };
        await before(write);
        assert.strictEqual(write.input.content, 'x', 'the write gate is lifted');
        await assert.rejects(
          () => before({ tool: 'shell', sessionID: 'ses_flags', input: { command: 'rm -rf /' } }),
          /EGC Guardian BLOCKED/,
          'the command gate stays'
        );
      });
      await withEnvironment('EGC_ASSUME_EGC_CLI', '1', async () => {
        await withEnvironment('EGC_DISABLED_HOOKS', 'pre:bash:crusher-rewrite', async () => {
          const plain = { tool: 'shell', sessionID: 'ses_flags', input: { command: 'npm test' } };
          await before(plain);
          assert.strictEqual(plain.input.command, 'npm test', 'the rewrite is off');
        });
        await withEnvironment('EGC_HOOK_PROFILE', 'minimal', async () => {
          const plain = { tool: 'shell', sessionID: 'ses_flags', input: { command: 'npm test' } };
          await before(plain);
          assert.strictEqual(plain.input.command, 'npm test', 'the minimal profile has no rewrite');
          await assert.rejects(
            () => before({ tool: 'shell', sessionID: 'ses_flags', input: { command: 'rm -rf /' } }),
            /EGC Guardian BLOCKED/,
            'the minimal profile keeps the Guardian'
          );
        });
      });
    });

    addCase('runs the Guardian validator with Node when process.execPath is the opencode binary', async () => {
      // Inside OpenCode the plugin runs under Bun and process.execPath is the
      // opencode binary, which cannot run the validator: every call ended
      // without a verdict and the fail-closed hook refused every command and
      // every write (#2107). The validator now runs with the Node on PATH.
      const originalExecPath = process.execPath;
      const originalPath = process.env.PATH;
      const realNodeDir = path.dirname(process.execPath);
      const fake = fakeContext(tempDir);
      await plugin.setup(fake.ctx);
      const before = fake.registered.tool['execute.before'];
      try {
        process.execPath = process.platform === 'win32' ? 'C:\\Users\\someone\\AppData\\Local\\opencode\\opencode.exe' : '/usr/local/bin/opencode';
        process.env.PATH = `.${path.delimiter}${realNodeDir}`;
        await assert.rejects(
          () => before({ tool: 'shell', sessionID: 'ses_bun', input: { command: 'rm -rf /' } }),
          /EGC Guardian BLOCKED/,
          'a denial is still a verdict, not a validator that could not start'
        );
        const safe = { tool: 'shell', sessionID: 'ses_bun', input: { command: 'git status' } };
        await before(safe);
        assert.strictEqual(safe.input.command, 'git status', 'a safe command still passes');
        await assert.rejects(
          () => before({ tool: 'write', sessionID: 'ses_bun', input: { filePath: path.join(tempDir, '.ssh', 'id_rsa'), content: 'x' } }),
          /EGC Guardian BLOCKED/
        );
        const fine = { tool: 'write', sessionID: 'ses_bun', input: { filePath: path.join(tempDir, 'notes.md'), content: 'hello' } };
        await before(fine);
        assert.strictEqual(fine.input.content, 'hello', 'a safe write still passes');

        // Without any Node on an absolute PATH entry the gate stays closed and
        // says why, instead of failing on a binary that is not Node.
        process.env.PATH = `.${path.delimiter}`;
        await assert.rejects(
          () => before({ tool: 'shell', sessionID: 'ses_bun', input: { command: 'git status' } }),
          /could not validate this command, so it did not run: the validator could not be started \(no node executable/
        );
      } finally {
        process.execPath = originalExecPath;
        process.env.PATH = originalPath;
      }
    });

    addCase('ignores relative PATH entries and planted node binary in project root', async () => {
      const originalExecPath = process.execPath;
      const originalPath = process.env.PATH;
      
      const isWin = process.platform === 'win32';
      const fakeBinaryName = isWin ? 'node.exe' : 'node';
      const realNodeDir = path.dirname(process.execPath);

      const project = path.join(tempDir, 'workspaces', 'safe-path');
      fs.mkdirSync(project, { recursive: true });
      writeState(tempDir, project, 'safe-path-marker');

      const fakeBinaryPath = path.join(project, fakeBinaryName);

      try {
        if (isWin) {
          fs.writeFileSync(fakeBinaryPath, 'fake node binary', { mode: 0o755 });
        } else {
          fs.writeFileSync(fakeBinaryPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        }

        // Simulate host app running under Bun or non-Node runtime
        process.execPath = isWin ? 'C:\\bun.exe' : '/usr/local/bin/bun';
        // Set PATH with relative entries first, followed by real Node directory
        process.env.PATH = `.${path.delimiter}${path.delimiter}${realNodeDir}`;

        const calls = [];
        const hooks = await EgcGuardianCrusher({ client: clientWith(calls), directory: project });
        await hooks.event({ event: sessionEvent('ses_safe_path', project) });

        // Must ignore planted node in project cwd and resolve via system Node
        assert.strictEqual(calls.length, 1);
        assert.match(calls[0].body.parts[0].text, /safe-path-marker/);
      } finally {
        if (fs.existsSync(fakeBinaryPath)) {
          fs.unlinkSync(fakeBinaryPath);
        }
        process.execPath = originalExecPath;
        process.env.PATH = originalPath;
      }
    });

    addCase('fails open cleanly without executing anything when PATH contains only relative entries', async () => {
      const originalExecPath = process.execPath;
      const originalPath = process.env.PATH;

      const isWin = process.platform === 'win32';
      const fakeBinaryName = isWin ? 'node.exe' : 'node';

      const project = path.join(tempDir, 'workspaces', 'relative-only-path');
      fs.mkdirSync(project, { recursive: true });
      writeState(tempDir, project, 'should-not-run-marker');

      const fakeBinaryPath = path.join(project, fakeBinaryName);

      try {
        if (isWin) {
          fs.writeFileSync(fakeBinaryPath, 'fake node binary', { mode: 0o755 });
        } else {
          fs.writeFileSync(fakeBinaryPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        }

        process.execPath = isWin ? 'C:\\bun.exe' : '/usr/local/bin/bun';
        // PATH contains ONLY relative entries
        process.env.PATH = `.${path.delimiter}`;

        const calls = [];
        const hooks = await EgcGuardianCrusher({ client: clientWith(calls), directory: project });
        await hooks.event({ event: sessionEvent('ses_relative_path', project) });

        // Fail-open: Must not execute planted binary and must return no prompt calls
        assert.strictEqual(calls.length, 0);
      } finally {
        if (fs.existsSync(fakeBinaryPath)) {
          fs.unlinkSync(fakeBinaryPath);
        }
        process.execPath = originalExecPath;
        process.env.PATH = originalPath;
      }
    });

    addCase('uses Node executable to restore session when process.execPath is a non-Node binary', async () => {
      const stub = "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({host:'opencode',context:'opencode-bun-fallback-marker'}));\n";
      const restoreBridge = replaceTemporarily(bridgePath, stub);

      const originalExecPath = process.execPath;
      const fakeOpencodeBinary = process.platform === 'win32'
        ? 'C:\\Users\\<windows-username>\\AppData\\Local\\opencode\\opencode.exe'
        : '/usr/local/bin/opencode';

      try {
        process.execPath = fakeOpencodeBinary;
        assert.strictEqual(process.execPath, fakeOpencodeBinary, 'execPath override must take effect');

        const project = path.join(tempDir, 'workspaces', 'non-node-runtime');
        fs.mkdirSync(project, { recursive: true });

        const calls = [];
        const hooks = await EgcGuardianCrusher({ client: clientWith(calls), directory: project });
        await hooks.event({ event: sessionEvent('ses_non_node', project) });

        assert.strictEqual(calls.length, 1);
        assert.match(calls[0].body.parts[0].text, /opencode-bun-fallback-marker/);
      } finally {
        process.execPath = originalExecPath;
        restoreBridge();
      }
    });

    // A stand-in for the OpenCode 2 plugin context: setup registers callbacks
    // through tool.hook and session.hook, and the test calls them directly.
    function fakeContext(directory, options = {}) {
      const registered = { tool: {}, session: {} };
      const disposed = [];
      const gets = [];
      const held = [];
      const register = domain => async (name, callback) => {
        if (options.hookThrows === domain) throw new Error(`${domain}.hook refused`);
        registered[domain][name] = callback;
        if (options.noDispose === domain) return undefined;
        if (options.disposeThrows === domain) {
          return { dispose: () => { throw new Error(`${domain}.${name} dispose refused`); } };
        }
        if (options.disposeRejects === domain) {
          return { dispose: () => Promise.reject(new Error(`${domain}.${name} dispose failed`)) };
        }
        return { dispose: async () => { disposed.push(`${domain}.${name}`); } };
      };
      // session.get answers the way OpenCode 2 does: the session's location
      // when the test gave it one, a bare record otherwise. With get 'held'
      // it answers only when the test calls release().
      const session = { hook: register('session') };
      if (options.get !== 'missing') {
        session.get = async ({ sessionID }) => {
          gets.push(sessionID);
          if (options.get === 'throws') throw new Error('no such session');
          if (options.get === 'held') await new Promise(resolve => held.push(resolve));
          const own = options.sessions?.[sessionID];
          return own ? { id: sessionID, location: { directory: own } } : { id: sessionID };
        };
      }
      return {
        registered,
        disposed,
        gets,
        // The host is asked in a microtask after the request starts, so the
        // release waits one turn before answering the requests held so far,
        // all of them or the oldest `count`.
        release: async (count = Infinity) => {
          await new Promise(resolve => setImmediate(resolve));
          held.splice(0, count).forEach(resolve => resolve());
        },
        ctx: {
          location: { directory },
          tool: { hook: register('tool') },
          session,
        },
      };
    }

    function contextEvent(sessionID) {
      return { sessionID, system: [], messages: [], options: {}, agent: 'build', tools: {} };
    }

    addCase('OpenCode 2: setup registers the tool hook with Guardian and Crusher behavior', async () => {
      const fake = fakeContext(tempDir);
      const cleanup = await plugin.setup(fake.ctx);
      const before = fake.registered.tool['execute.before'];
      assert.strictEqual(typeof before, 'function');
      await assert.rejects(
        () => before({ tool: 'bash', sessionID: 'ses_v2', input: { command: 'rm -rf /' } }),
        /EGC Guardian BLOCKED/
      );
      await assert.rejects(
        () => before({ tool: 'write', sessionID: 'ses_v2', input: { filePath: path.join(tempDir, '.ssh', 'id_rsa'), content: 'x' } }),
        /EGC Guardian BLOCKED/
      );
      const read = { tool: 'read', sessionID: 'ses_v2', input: { filePath: '/tmp/x' } };
      await before(read);
      assert.deepStrictEqual(read.input, { filePath: '/tmp/x' });
      await before({ tool: 'bash', sessionID: 'ses_v2', input: {} });
      await before({ tool: 'bash', sessionID: 'ses_v2' });
      const safe = { tool: 'bash', sessionID: 'ses_v2', input: { command: 'git status' } };
      await before(safe);
      assert.strictEqual(safe.input.command, 'git status');
      process.env.EGC_ASSUME_EGC_CLI = '1';
      try {
        const crushable = { tool: 'bash', sessionID: 'ses_v2', input: { command: 'npm test' } };
        await before(crushable);
        assert.strictEqual(crushable.input.command, 'egc run npm test');
      } finally {
        process.env.EGC_ASSUME_EGC_CLI = '0';
      }
      assert.strictEqual(typeof cleanup, 'function', 'setup returns the cleanup of its registrations');
      await cleanup();
      assert.deepStrictEqual(fake.disposed.sort(), ['session.context', 'tool.execute.before']);
    });

    addCase('OpenCode 2: the context hook carries the project memory on every request, loaded once per session', async () => {
      const project = path.join(tempDir, 'workspaces', 'v2-context');
      fs.mkdirSync(project, { recursive: true });
      writeState(tempDir, project, 'opencode-v2-context-marker');
      const counter = path.join(tempDir, 'v2-bridge-runs');
      const stub = "#!/usr/bin/env node\nrequire('fs').appendFileSync(process.env.EGC_TEST_BRIDGE_COUNTER, 'x');\n"
        + "process.stdout.write(JSON.stringify({host:'opencode',context:'opencode-v2-context-marker'}));\n";
      const restore = replaceTemporarily(bridgePath, stub);
      try {
        await withEnvironment('EGC_TEST_BRIDGE_COUNTER', counter, async () => {
          const fake = fakeContext(project);
          await plugin.setup(fake.ctx);
          const context = fake.registered.session.context;
          assert.strictEqual(typeof context, 'function');
          const first = contextEvent('ses_v2_a');
          await context(first);
          assert.strictEqual(first.system.length, 1);
          assert.strictEqual(first.system[0].type, 'text');
          assert.match(first.system[0].text, /opencode-v2-context-marker/);
          const again = contextEvent('ses_v2_a');
          await context(again);
          assert.strictEqual(again.system.length, 1, 'the next request of the same session carries the memory too');
          assert.strictEqual(fs.readFileSync(counter, 'utf8'), 'x', 'the bridge ran once for the session');
          const other = contextEvent('ses_v2_b');
          await context(other);
          assert.strictEqual(other.system.length, 1, 'another session loads its own copy');
          assert.strictEqual(fs.readFileSync(counter, 'utf8'), 'xx');
        });
      } finally { restore(); }
    });

    addCase('OpenCode 2: each session gets the memory of its own checkout, asked of the host once', async () => {
      const home = path.join(tempDir, 'workspaces', 'v2-home-checkout');
      const other = path.join(tempDir, 'workspaces', 'v2-other-checkout');
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(other, { recursive: true });
      writeState(tempDir, home, 'v2-home-checkout-marker');
      writeState(tempDir, other, 'v2-other-checkout-marker');

      const fake = fakeContext(home, { sessions: { ses_v2_other: other } });
      await plugin.setup(fake.ctx);
      const context = fake.registered.session.context;
      const atHome = contextEvent('ses_v2_home');
      await context(atHome);
      assert.match(atHome.system[0].text, /v2-home-checkout-marker/);
      const elsewhere = contextEvent('ses_v2_other');
      await context(elsewhere);
      assert.match(elsewhere.system[0].text, /v2-other-checkout-marker/);
      assert.doesNotMatch(elsewhere.system[0].text, /v2-home-checkout-marker/);
      await context(contextEvent('ses_v2_other'));
      await fake.registered.tool['execute.before']({ tool: 'read', sessionID: 'ses_v2_other', input: { filePath: '/tmp/x' } });
      assert.deepStrictEqual(fake.gets, ['ses_v2_home', 'ses_v2_other'], 'the host is asked once per session');

      const throwing = fakeContext(home, { get: 'throws' });
      await plugin.setup(throwing.ctx);
      const fallback = contextEvent('ses_v2_fallback');
      await throwing.registered.session.context(fallback);
      assert.match(fallback.system[0].text, /v2-home-checkout-marker/, 'a host that cannot say leaves the location in charge');

      const without = fakeContext(home, { get: 'missing' });
      await plugin.setup(without.ctx);
      const noGet = contextEvent('ses_v2_no_get');
      await without.registered.session.context(noGet);
      assert.match(noGet.system[0].text, /v2-home-checkout-marker/, 'a host without session.get leaves the location in charge');
    });

    addCase('OpenCode 2: concurrent requests share one load and one lookup per session', async () => {
      const project = path.join(tempDir, 'workspaces', 'v2-concurrent');
      fs.mkdirSync(project, { recursive: true });
      const counter = path.join(tempDir, 'v2-concurrent-runs');
      const stub = "#!/usr/bin/env node\nrequire('fs').appendFileSync(process.env.EGC_TEST_BRIDGE_COUNTER, 'x');\n"
        + "process.stdout.write(JSON.stringify({host:'opencode',context:'v2-concurrent-marker'}));\n";
      const restore = replaceTemporarily(bridgePath, stub);
      try {
        await withEnvironment('EGC_TEST_BRIDGE_COUNTER', counter, async () => {
          const fake = fakeContext(project);
          await plugin.setup(fake.ctx);
          const context = fake.registered.session.context;
          const before = fake.registered.tool['execute.before'];
          const a = contextEvent('ses_v2_c1');
          const b = contextEvent('ses_v2_c1');
          const c = contextEvent('ses_v2_c2');
          await Promise.all([
            context(a),
            context(b),
            before({ tool: 'read', sessionID: 'ses_v2_c1', input: { filePath: '/tmp/x' } }),
            context(c),
          ]);
          assert.match(a.system[0].text, /v2-concurrent-marker/);
          assert.match(b.system[0].text, /v2-concurrent-marker/);
          assert.match(c.system[0].text, /v2-concurrent-marker/);
          assert.strictEqual(fs.readFileSync(counter, 'utf8'), 'xx', 'one bridge run per session');
          assert.deepStrictEqual(fake.gets.sort(), ['ses_v2_c1', 'ses_v2_c2'], 'one session.get per session, concurrent requests included');
        });
      } finally { restore(); }
    });

    addCase('OpenCode 2: the Guardian judges a tool call against the session directory, with or without a session id', async () => {
      const other = path.join(tempDir, 'workspaces', 'v2-guardian-other');
      fs.mkdirSync(other, { recursive: true });
      const fake = fakeContext(tempDir, { sessions: { ses_v2_other: other } });
      await plugin.setup(fake.ctx);
      const before = fake.registered.tool['execute.before'];
      const relativeSecret = path.join('.ssh', 'id_rsa');
      // A relative path is resolved against the session's own directory: the
      // refusal names the home for the session at home and the other checkout
      // for the session there, never the plugin location for both.
      await assert.rejects(
        () => before({ tool: 'write', sessionID: 'ses_v2_at_home', input: { filePath: relativeSecret, content: 'x' } }),
        error => /EGC Guardian BLOCKED/.test(error.message) && error.message.includes(path.join(tempDir, '.ssh', 'id_rsa'))
      );
      await assert.rejects(
        () => before({ tool: 'write', sessionID: 'ses_v2_other', input: { filePath: relativeSecret, content: 'x' } }),
        error => /EGC Guardian BLOCKED/.test(error.message) && error.message.includes(path.join(other, '.ssh', 'id_rsa'))
      );
      await assert.rejects(
        () => before({ tool: 'bash', input: { command: 'rm -rf /' } }),
        /EGC Guardian BLOCKED/,
        'a call without a session id is still judged, against the plugin location'
      );
      const noSession = { system: [], messages: [], options: {} };
      await fake.registered.session.context(noSession);
      assert.strictEqual(noSession.system.length, 0, 'a request without a session id gets no memory and no error');
    });

    addCase('OpenCode 2: a hook the host refuses leaves the other one working', async () => {
      const project = path.join(tempDir, 'workspaces', 'v2-partial');
      fs.mkdirSync(project, { recursive: true });
      writeState(tempDir, project, 'v2-partial-marker');

      const noTool = fakeContext(project, { hookThrows: 'tool' });
      const cleanupNoTool = await plugin.setup(noTool.ctx);
      assert.strictEqual(noTool.registered.tool['execute.before'], undefined);
      const event = contextEvent('ses_v2_partial');
      await noTool.registered.session.context(event);
      assert.match(event.system[0].text, /v2-partial-marker/);
      await cleanupNoTool();
      assert.deepStrictEqual(noTool.disposed, ['session.context']);

      const noSession = fakeContext(project, { hookThrows: 'session' });
      await plugin.setup(noSession.ctx);
      assert.strictEqual(noSession.registered.session.context, undefined);
      await assert.rejects(
        () => noSession.registered.tool['execute.before']({ tool: 'bash', sessionID: 'ses_v2_partial', input: { command: 'rm -rf /' } }),
        /EGC Guardian BLOCKED/
      );
    });

    addCase('OpenCode 2: the context hook fails open on empty context, a bridge timeout and a malformed event', async () => {
      const empty = path.join(tempDir, 'workspaces', 'v2-empty');
      fs.mkdirSync(empty, { recursive: true });
      let fake = fakeContext(empty);
      await plugin.setup(fake.ctx);
      const event = contextEvent('ses_v2_empty');
      await fake.registered.session.context(event);
      assert.strictEqual(event.system.length, 0);
      await assert.doesNotReject(() => fake.registered.session.context({ sessionID: 'ses_v2_no_system' }));
      await assert.doesNotReject(() => fake.registered.session.context(undefined));

      const restore = replaceTemporarily(bridgePath, "#!/usr/bin/env node\nsetTimeout(() => {}, 10000);\n");
      try {
        await withEnvironment('EGC_SESSION_CONTEXT_TIMEOUT_MS', '150', async () => {
          fake = fakeContext(tempDir);
          await plugin.setup(fake.ctx);
          const slow = contextEvent('ses_v2_timeout');
          const started = Date.now();
          await assert.doesNotReject(() => fake.registered.session.context(slow));
          assert.ok(Date.now() - started < 2000, 'the timeout path returns promptly');
          assert.strictEqual(slow.system.length, 0);
        });
      } finally { restore(); }
    });

    addCase('OpenCode 2: the context hook carries the mesh notice when the bus moved, on every request and after the memory, and nothing on a quiet bus (#2097)', async () => {
      const project = path.join(tempDir, 'workspaces', 'v2-mesh');
      fs.mkdirSync(project, { recursive: true });
      writeState(tempDir, project, 'v2-mesh-memory-marker');
      const memoryDir = path.join(tempDir, '.egc', 'memory');
      const store = path.join(memoryDir, 'state.db');
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(store, 'the bus store of this home');
      const fake = fakeContext(project);
      await plugin.setup(fake.ctx);
      const context = fake.registered.session.context;

      const first = contextEvent('ses_v2_mesh');
      await context(first);
      assert.strictEqual(first.system.length, 2, 'the memory and the notice travel together on the first look');
      assert.match(first.system[0].text, /v2-mesh-memory-marker/, 'the memory comes first');
      assert.strictEqual(first.system[1].type, 'text');
      assert.match(first.system[1].text, /^\[egc-mesh\] /, 'the notice follows the memory');
      assert.ok(fs.existsSync(path.join(tempDir, '.egc', 'mesh', 'notice-ses_v2_mesh.json')), 'the look of this session is recorded');

      const quiet = contextEvent('ses_v2_mesh');
      await context(quiet);
      assert.strictEqual(quiet.system.length, 1, 'a bus that did not move adds nothing to the next request');
      assert.match(quiet.system[0].text, /v2-mesh-memory-marker/);

      // The store moves again (a write from another session): the next
      // request of the same session is woken again, with no cache in between.
      const later = new Date(Date.now() + 60000);
      fs.utimesSync(store, later, later);
      const woken = contextEvent('ses_v2_mesh');
      await context(woken);
      assert.strictEqual(woken.system.length, 2, 'a bus that moved again wakes the session on its next request');
      assert.match(woken.system[1].text, /^\[egc-mesh\] /);

      const other = contextEvent('ses_v2_mesh_other');
      await context(other);
      assert.strictEqual(other.system.length, 2, 'another session has a look of its own and is woken on its first request');

      const noSession = { system: [], messages: [], options: {} };
      await context(noSession);
      assert.strictEqual(noSession.system.length, 0, 'a request without a session id gets no notice, so it never consumes the look of another session');
    });

    addCase('OpenCode 2: an install without the mesh script keeps the memory and adds no notice (#2097)', async () => {
      const olderHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-older-'));
      try {
        // The layout of an install made before the notice: the plugin of
        // today next to the hook scripts, without the mesh script.
        const olderRoot = install(olderHome);
        fs.rmSync(path.join(olderRoot, 'scripts', 'hooks', 'mesh-events-inject.js'));
        fs.writeFileSync(path.join(olderRoot, 'plugins', 'package.json'), '{ "type": "module" }\n');
        const older = (await import(pathToFileURL(path.join(olderRoot, 'plugins', 'opencode-egc-plugin.js')).href)).default;
        const project = path.join(tempDir, 'workspaces', 'v2-mesh-older');
        fs.mkdirSync(project, { recursive: true });
        writeState(tempDir, project, 'v2-mesh-older-marker');
        const fake = fakeContext(project);
        await older.setup(fake.ctx);
        const event = contextEvent('ses_v2_mesh_older');
        await assert.doesNotReject(() => fake.registered.session.context(event));
        assert.strictEqual(event.system.length, 1, 'the memory alone: the bus store exists in this home, but the install has no script to read it');
        assert.match(event.system[0].text, /v2-mesh-older-marker/);
      } finally {
        fs.rmSync(olderHome, { recursive: true, force: true });
      }
    });

    addCase('OpenCode 2: setup without the hook domains fails open', async () => {
      await assert.doesNotReject(() => plugin.setup({ location: { directory: tempDir } }));
      await assert.doesNotReject(() => plugin.setup({}));
      await assert.doesNotReject(() => plugin.setup());

      // A host with the session domain only, no location and no session.get:
      // the context hook has no directory to load from and says nothing.
      const bare = fakeContext(undefined, { get: 'missing' });
      delete bare.ctx.tool;
      await plugin.setup(bare.ctx);
      const event = contextEvent('ses_v2_no_dir');
      await assert.doesNotReject(() => bare.registered.session.context(event));
      // The mesh notice belongs to the machine, not to a directory, so it may
      // still travel; the memory, which needs a directory, never does.
      const memoryParts = event.system.filter(part => !part.text.startsWith('[egc-mesh] '));
      assert.deepStrictEqual(memoryParts, [], 'a session without any directory gets no memory and no error');
    });

    addCase('OpenCode 2: a disposer that throws does not stop the other disposer or the cache cleanup', async () => {
      const counter = path.join(tempDir, 'v2-dispose-bridge-runs');
      const stub = "#!/usr/bin/env node\nrequire('fs').appendFileSync(process.env.EGC_TEST_BRIDGE_COUNTER, 'x');\n"
        + "process.stdout.write(JSON.stringify({host:'opencode',context:'v2-dispose-marker'}));\n";
      const restore = replaceTemporarily(bridgePath, stub);
      try {
        await withEnvironment('EGC_TEST_BRIDGE_COUNTER', counter, async () => {
          const fake = fakeContext(tempDir, { disposeThrows: 'tool' });
          const cleanup = await plugin.setup(fake.ctx);
          const before = fake.registered.tool['execute.before'];
          const context = fake.registered.session.context;
          await before({ tool: 'read', sessionID: 'ses_v2_dispose', input: { filePath: '/tmp/x' } });
          await context(contextEvent('ses_v2_dispose'));
          assert.deepStrictEqual(fake.gets, ['ses_v2_dispose']);
          assert.strictEqual(fs.readFileSync(counter, 'utf8'), 'x');

          await assert.doesNotReject(() => cleanup(), 'a synchronous throw of one disposer is contained');
          assert.deepStrictEqual(fake.disposed, ['session.context'], 'the other registration is still disposed');

          await before({ tool: 'read', sessionID: 'ses_v2_dispose', input: { filePath: '/tmp/x' } });
          const after = contextEvent('ses_v2_dispose');
          await context(after);
          assert.deepStrictEqual(fake.gets, ['ses_v2_dispose', 'ses_v2_dispose'], 'the directory cache was cleared all the same');
          assert.strictEqual(fs.readFileSync(counter, 'utf8'), 'xx', 'the memory cache was cleared too: the bridge ran again');
          assert.match(after.system[0].text, /v2-dispose-marker/);
        });
      } finally { restore(); }
    });

    addCase('OpenCode 2: a rejecting disposer and a registration without a dispose handle do not fail the cleanup', async () => {
      const fake = fakeContext(tempDir, { disposeRejects: 'session', noDispose: 'tool' });
      const cleanup = await plugin.setup(fake.ctx);
      assert.strictEqual(typeof fake.registered.tool['execute.before'], 'function', 'the hook registered without a dispose handle still works');
      await assert.rejects(
        () => fake.registered.tool['execute.before']({ tool: 'bash', sessionID: 'ses_v2_nodispose', input: { command: 'rm -rf /' } }),
        /EGC Guardian BLOCKED/
      );
      await assert.doesNotReject(() => cleanup(), 'a rejected dispose is contained');
      assert.deepStrictEqual(fake.disposed, []);
    });

    addCase('OpenCode 2: a host answer that lands after the cleanup is not kept', async () => {
      const fake = fakeContext(tempDir, { get: 'held' });
      const cleanup = await plugin.setup(fake.ctx);
      const before = fake.registered.tool['execute.before'];

      const late = before({ tool: 'read', sessionID: 'ses_v2_late', input: { filePath: '/tmp/x' } });
      await cleanup();
      await fake.release();
      await late;

      const again = before({ tool: 'read', sessionID: 'ses_v2_late', input: { filePath: '/tmp/x' } });
      await fake.release();
      await again;
      assert.deepStrictEqual(fake.gets, ['ses_v2_late', 'ses_v2_late'], 'the request after the cleanup asks the host again');
    });

    addCase('OpenCode 2: the session cap bounds the requests still in flight too', async () => {
      const fake = fakeContext(tempDir, { get: 'held' });
      await plugin.setup(fake.ctx);
      const before = fake.registered.tool['execute.before'];

      // One session past MAX_CACHED_SESSIONS of the plugin, none answered yet.
      const inFlight = Array.from({ length: 65 }, (_, index) =>
        before({ tool: 'read', sessionID: `ses_v2_many_${index}`, input: { filePath: '/tmp/x' } })
      );
      const oldest = before({ tool: 'read', sessionID: 'ses_v2_many_0', input: { filePath: '/tmp/x' } });
      const getsOf = sessionID => fake.gets.filter(entry => entry === sessionID).length;

      // The evicted lookup of the first session lands first; the lookup that
      // replaced it must stay shared by the requests that follow.
      await fake.release(1);
      assert.strictEqual(getsOf('ses_v2_many_0'), 2, 'the oldest in-flight session left the cache, so its next request asked the host again');
      const shared = before({ tool: 'read', sessionID: 'ses_v2_many_0', input: { filePath: '/tmp/x' } });
      await fake.release(0);
      assert.strictEqual(getsOf('ses_v2_many_0'), 2, 'the evicted lookup did not drop the one that replaced it');
      assert.strictEqual(getsOf('ses_v2_many_64'), 1, 'the newest in-flight session is still shared');

      await fake.release();
      await Promise.all([...inFlight, oldest, shared]);

      // Settled values are bounded by the same cap: the oldest settled session
      // (the second one, since the first landed again at the end) is gone.
      const evicted = before({ tool: 'read', sessionID: 'ses_v2_many_1', input: { filePath: '/tmp/x' } });
      await fake.release();
      await evicted;
      assert.strictEqual(getsOf('ses_v2_many_1'), 2, 'the oldest settled session left the cache');
      await before({ tool: 'read', sessionID: 'ses_v2_many_64', input: { filePath: '/tmp/x' } });
      assert.strictEqual(getsOf('ses_v2_many_64'), 1, 'a settled session inside the cap is still served from it');
    });

    // The cases share the installed layout and the imported plugin, so they
    // run one after another, in the order they were added.
    results = await cases.reduce(
      (chain, run) => chain.then(async done => [...done, await run()]),
      Promise.resolve([])
    );
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// A case that leaves a promise pending ends the process with nothing left to
// run and no summary printed, which Node exits from with code 0: that is a
// failure, not a pass.
let finished = false;
process.on('exit', code => {
  if (finished || code !== 0) return;
  console.error('  ✗ the suite ended before its summary: a case left a promise pending');
  process.exitCode = 1;
});

runTests()
  .then(() => { finished = true; })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
