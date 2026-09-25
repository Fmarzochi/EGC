/**
 * Tests for scripts/lib/mcp-register.js (issue #550)
 *
 * Covers the target list (the retired Gemini CLI and Continue.dev entries
 * stay out of it, whatever directories exist), the JSON/TOML merge
 * behavior, and the registerMcpServers() orchestrator that scripts/init.js
 * delegates to.
 *
 * Run with: node tests/lib/mcp-register.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildMcpRegistrationTargets,
  registerJson,
  registerToml,
  registerZedContextServers,
  registerOpenCodeMcp,
  openCodeConfigPath,
  registerClaudeCli,
  registerMcpServers,
} = require('../../scripts/lib/mcp-register');

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-register-test-'));
}

const bins = {
  guardianBin: '/fake/mcp/servers/egc-guardian/build/index.js',
  memoryBin: '/fake/mcp/servers/egc-memory/build/index.js',
};

// The orchestrator gates Claude Code on `which claude` and Cursor, Kiro,
// Codex and OpenCode on a PATH probe, none of which read the temp home. With
// the PATH pointed at that empty home, a local run can never reach the real
// tools of the machine running the suite.
function registerIsolated(homeDir, options) {
  const savedPath = process.env.PATH;
  process.env.PATH = homeDir;
  try {
    return registerMcpServers(homeDir, bins, options);
  } finally {
    process.env.PATH = savedPath;
  }
}

// Runs fn against an mcp-register loaded the way it is on a user's machine,
// where @iarna/toml is a devDependency that was never installed: every parse
// path is unavailable and the scan alone has to be right.
function withoutTomlParser(fn) {
  const Module = require('node:module');
  const registerPath = require.resolve('../../scripts/lib/mcp-register');
  const cachedRegister = require.cache[registerPath];
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === '@iarna/toml') {
      const err = new Error("Cannot find module '@iarna/toml'");
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[registerPath];
  let parserless;
  try {
    parserless = require('../../scripts/lib/mcp-register');
  } finally {
    Module._load = originalLoad;
    delete require.cache[registerPath];
    if (cachedRegister) require.cache[registerPath] = cachedRegister;
  }
  fn(parserless.registerToml);
}

function runTests() {
  console.log('\n=== Testing scripts/lib/mcp-register.js ===\n');

  let passed = 0;
  let failed = 0;

  // ── buildMcpRegistrationTargets ──────────────────────────────────

  (test('the retired tools are not registration targets, even when their directories exist', () => {
    const tmpHome = makeTempDir();
    fs.mkdirSync(path.join(tmpHome, '.continue', 'mcpServers'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.gemini', 'config'), { recursive: true });
    const targets = buildMcpRegistrationTargets(tmpHome);
    const names = targets.map(t => t.name);
    assert.ok(!names.includes('Gemini CLI'), 'Gemini CLI was retired in #1279 and must not be registered');
    assert.ok(!names.includes('Continue.dev'), 'Continue.dev was retired in #1279 and must not be registered');
    assert.ok(!targets.some(t => t.format === 'continue-yaml'), 'no target may use the Continue YAML format');
    for (const target of targets) {
      assert.ok(!target.path.startsWith(path.join(tmpHome, '.continue')), `${target.name} must not write under ~/.continue`);
      assert.notStrictEqual(target.path, path.join(tmpHome, '.gemini', 'config', 'mcp_config.json'), `${target.name} must not write the standalone Gemini CLI config`);
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('the registration list is the seven tools the documentation names, in order', () => {
    const targets = buildMcpRegistrationTargets('/home/person');
    assert.deepStrictEqual(targets.map(t => t.name), [
      'Antigravity CLI', 'Claude Code (user scope)', 'Cursor',
      'Kiro', 'Codex CLI', 'OpenCode', 'Zed',
    ]);
  }) ? passed++ : failed++);

  (test('OpenCode: a fresh install gets opencode.json with both servers under mcp in OpenCode\'s own shape', () => {
    const tmpHome = makeTempDir();
    // CI runners export XDG_CONFIG_HOME; the temp home must be the directory read.
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const dir = path.join(tmpHome, '.config', 'opencode');
      fs.mkdirSync(dir, { recursive: true });
      const target = buildMcpRegistrationTargets(tmpHome).find(t => t.name === 'OpenCode');
      assert.strictEqual(target.path, path.join(dir, 'opencode.json'), 'the documented file name is used when creating');
      assert.strictEqual(target.format, 'opencode-mcp');
      assert.strictEqual(target.gate(), true, 'the config directory alone opens the gate');

      assert.strictEqual(registerOpenCodeMcp(target.path, bins), true);
      const written = JSON.parse(fs.readFileSync(target.path, 'utf8'));
      assert.deepStrictEqual(written.mcp['egc-guardian'], { type: 'local', command: ['node', bins.guardianBin] });
      assert.deepStrictEqual(written.mcp['egc-memory'], { type: 'local', command: ['node', bins.memoryBin] });
      assert.strictEqual(written.mcpServers, undefined, 'the key OpenCode never reads must not be written');
      assert.strictEqual(registerOpenCodeMcp(target.path, bins), false, 'a second run is a no-op');
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }) ? passed++ : failed++);

  (test('OpenCode: an existing opencode.json keeps its other servers and keys', () => {
    const tmpHome = makeTempDir();
    // CI runners export XDG_CONFIG_HOME; the temp home must be the directory read.
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const dir = path.join(tmpHome, '.config', 'opencode');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'opencode.json');
      fs.writeFileSync(file, JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'anthropic/claude',
        mcp: { 'my-server': { type: 'remote', url: 'https://example.invalid/mcp' } },
      }, null, 2));
      assert.strictEqual(openCodeConfigPath(tmpHome), file);
      assert.strictEqual(registerOpenCodeMcp(file, bins), true);
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(written.$schema, 'https://opencode.ai/config.json');
      assert.strictEqual(written.model, 'anthropic/claude');
      assert.deepStrictEqual(written.mcp['my-server'], { type: 'remote', url: 'https://example.invalid/mcp' });
      assert.strictEqual(written.mcp['egc-guardian'].type, 'local');
      assert.strictEqual(written.mcp['egc-memory'].command[1], bins.memoryBin);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }) ? passed++ : failed++);

  (test('OpenCode: a legacy config.json written by an older EGC is used, and its dead mcpServers block is retired', () => {
    const tmpHome = makeTempDir();
    // CI runners export XDG_CONFIG_HOME; the temp home must be the directory read.
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const dir = path.join(tmpHome, '.config', 'opencode');
      fs.mkdirSync(dir, { recursive: true });
      const legacy = path.join(dir, 'config.json');
      fs.writeFileSync(legacy, JSON.stringify({
        mcpServers: {
          'egc-guardian': { command: 'node', args: [bins.guardianBin] },
          'egc-memory': { command: 'node', args: [bins.memoryBin] },
        },
      }, null, 2));
      assert.strictEqual(openCodeConfigPath(tmpHome), legacy, 'only the legacy file exists, so it is the one edited');
      assert.strictEqual(registerOpenCodeMcp(legacy, bins), true);
      const written = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      assert.strictEqual(written.mcpServers, undefined, 'the block OpenCode never read is gone');
      assert.deepStrictEqual(Object.keys(written.mcp).sort(), ['egc-guardian', 'egc-memory']);
      assert.ok(!fs.existsSync(path.join(dir, 'opencode.json')), 'no second file is created next to the legacy one');
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }) ? passed++ : failed++);

  (test('OpenCode: a foreign mcpServers block keeps its own entries, only ours are removed', () => {
    const tmpHome = makeTempDir();
    // CI runners export XDG_CONFIG_HOME; the temp home must be the directory read.
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const dir = path.join(tmpHome, '.config', 'opencode');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'opencode.json');
      fs.writeFileSync(file, JSON.stringify({
        mcpServers: { theirs: { command: 'x' }, 'egc-guardian': { command: 'node', args: ['old'] } },
        mcp: { 'egc-memory': { type: 'local', command: ['node', '/kept/by/hand'] } },
      }));
      assert.strictEqual(registerOpenCodeMcp(file, bins), true);
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepStrictEqual(written.mcpServers, { theirs: { command: 'x' } }, 'a block with other entries is not ours to delete');
      assert.deepStrictEqual(written.mcp['egc-memory'].command, ['node', '/kept/by/hand'], 'an entry the person already has is never overwritten');
      assert.strictEqual(written.mcp['egc-guardian'].command[1], bins.guardianBin);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }) ? passed++ : failed++);

  (test('OpenCode: with both files present, opencode.json gets the servers and the legacy config.json loses only our stale block', () => {
    const tmpHome = makeTempDir();
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const dir = path.join(tmpHome, '.config', 'opencode');
      fs.mkdirSync(dir, { recursive: true });
      const documented = path.join(dir, 'opencode.json');
      const legacy = path.join(dir, 'config.json');
      fs.writeFileSync(documented, JSON.stringify({ model: 'anthropic/claude' }));
      fs.writeFileSync(legacy, JSON.stringify({
        theme: 'dark',
        mcpServers: { theirs: { command: 'x' }, 'egc-guardian': { command: 'node', args: ['old'] }, 'egc-memory': { command: 'node', args: ['old'] } },
      }));
      assert.strictEqual(openCodeConfigPath(tmpHome), documented, 'the documented file wins when both exist');
      assert.strictEqual(registerOpenCodeMcp(documented, bins), true);
      const written = JSON.parse(fs.readFileSync(documented, 'utf8'));
      assert.deepStrictEqual(Object.keys(written.mcp).sort(), ['egc-guardian', 'egc-memory']);
      const sibling = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      assert.strictEqual(sibling.theme, 'dark', 'the rest of the legacy file is untouched');
      assert.deepStrictEqual(sibling.mcpServers, { theirs: { command: 'x' } }, 'only our stale entries leave the legacy file');
      assert.strictEqual(registerOpenCodeMcp(documented, bins), false, 'nothing left to do in either file');
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }) ? passed++ : failed++);

  (test('OpenCode: an unparsable legacy config.json next to opencode.json is left alone', () => {
    const tmpHome = makeTempDir();
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const dir = path.join(tmpHome, '.config', 'opencode');
      fs.mkdirSync(dir, { recursive: true });
      const documented = path.join(dir, 'opencode.json');
      const legacy = path.join(dir, 'config.json');
      fs.writeFileSync(documented, '{}');
      fs.writeFileSync(legacy, '{ not json');
      assert.strictEqual(registerOpenCodeMcp(documented, bins), true, 'the documented file is still registered into');
      assert.strictEqual(fs.readFileSync(legacy, 'utf8'), '{ not json', 'the broken legacy file is not touched');
      assert.ok(JSON.parse(fs.readFileSync(documented, 'utf8')).mcp['egc-guardian']);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }) ? passed++ : failed++);

  (test('OpenCode: an entry the person set to null is theirs and is not replaced', () => {
    const tmpHome = makeTempDir();
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const dir = path.join(tmpHome, '.config', 'opencode');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'opencode.json');
      fs.writeFileSync(file, JSON.stringify({ mcp: { 'egc-guardian': null } }));
      assert.strictEqual(registerOpenCodeMcp(file, bins), true, 'egc-memory is still added');
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(written.mcp['egc-guardian'], null, 'the null entry stays as set');
      assert.strictEqual(written.mcp['egc-memory'].type, 'local');
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }) ? passed++ : failed++);

  (test('OpenCode: invalid mcp containers are refused and the file is left untouched', () => {
    const tmpHome = makeTempDir();
    // CI runners export XDG_CONFIG_HOME; the temp home must be the directory read.
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const dir = path.join(tmpHome, '.config', 'opencode');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'opencode.json');
      const original = JSON.stringify({ mcp: ['not', 'an', 'object'] });
      fs.writeFileSync(file, original);
      assert.throws(() => registerOpenCodeMcp(file, bins), /invalid mcp object/);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }) ? passed++ : failed++);

  (test('OpenCode: the same gate on every platform, no AppData target, PATH opens it for a never-launched install', () => {
    const tmpHome = makeTempDir();
    const binDir = makeTempDir();
    // A PATH holding only an empty directory: the machine running the tests
    // may have a real opencode installed, and the closed-gate assertion
    // must not depend on that.
    const emptyBinDir = makeTempDir();
    const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const savedPath = process.env.PATH;
    const savedPathExt = process.env.PATHEXT;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    process.env.PATHEXT = '.CMD';
    fs.writeFileSync(path.join(binDir, 'opencode.CMD'), '@echo off\r\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      for (const platform of ['win32', 'linux', 'darwin']) {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        process.env.PATH = emptyBinDir;
        const targets = buildMcpRegistrationTargets(tmpHome);
        assert.strictEqual(targets.filter(t => t.name.startsWith('OpenCode')).length, 1, `${platform}: one OpenCode target only`);
        const target = targets.find(t => t.name === 'OpenCode');
        assert.strictEqual(target.path, path.join(tmpHome, '.config', 'opencode', 'opencode.json'), `${platform}: OpenCode reads the same directory everywhere`);
        assert.strictEqual(target.gate(), false, `${platform}: no directory and no binary keeps the gate closed`);
        process.env.PATH = `${binDir}${path.delimiter}${emptyBinDir}`;
        assert.strictEqual(buildMcpRegistrationTargets(tmpHome).find(t => t.name === 'OpenCode').gate(), true, `${platform}: a PATH-visible opencode opens the gate`);
      }
    } finally {
      if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform);
      process.env.PATH = savedPath;
      if (savedPathExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = savedPathExt;
      if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.rmSync(emptyBinDir, { recursive: true, force: true });
    }
  }) ? passed++ : failed++);

  (test('OpenCode: XDG_CONFIG_HOME moves the directory, matching OpenCode\'s own resolution', () => {
    const tmpHome = makeTempDir();
    const xdg = makeTempDir();
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      assert.strictEqual(openCodeConfigPath(tmpHome), path.join(xdg, 'opencode', 'opencode.json'));
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(xdg, { recursive: true, force: true });
    }
  }) ? passed++ : failed++);


  (test('a tool present on PATH but not yet configured is still registered', () => {
    // Someone who installed Cursor and has not launched it owns no ~/.cursor
    // yet; an existence-only gate would skip them, which is exactly what the
    // shell installers used to prevent with their own `command -v` checks.
    const tmpHome = makeTempDir();
    const binDir = makeTempDir();
    const savedPath = process.env.PATH;
    // Windows only recognizes a PATHEXT extension as executable, so an
    // extension-less stand-in would make this assert nothing there.
    const binName = process.platform === 'win32' ? 'cursor.cmd' : 'cursor';
    fs.writeFileSync(path.join(binDir, binName), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
    try {
      const target = buildMcpRegistrationTargets(tmpHome).find(t => t.name === 'Cursor');
      assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cursor')), false, 'precondition: no config directory');
      assert.strictEqual(target.gate(), true, 'the binary on PATH must be enough to register');
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }) ? passed++ : failed++);

  // ── registerClaudeCli (Claude Code user scope via the CLI) ────────

  (test('quoteForCmdShell quotes cmd-sensitive arguments and leaves plain ones untouched', () => {
    const { quoteForCmdShell } = require('../../scripts/lib/mcp-register');
    assert.strictEqual(quoteForCmdShell('plain-arg'), 'plain-arg');
    assert.strictEqual(
      quoteForCmdShell(String.raw`C:\Users\First Last\egc\build\index.js`),
      String.raw`"C:\Users\First Last\egc\build\index.js"`,
      'a path with a space must be quoted or cmd.exe splits it into two arguments'
    );
    assert.strictEqual(quoteForCmdShell('has"quote'), '"has""quote"', 'embedded quotes double, the cmd convention');
    assert.strictEqual(quoteForCmdShell('C:\\Program Files\\nodejs\\npm.cmd'), '"C:\\Program Files\\nodejs\\npm.cmd"');
    assert.strictEqual(
      quoteForCmdShell('C:\\pct%path%\\index.js'),
      'C:\\pct%path%\\index.js',
      'percent is not a quoting trigger: cmd expands %var% even inside quotes, so quoting would only fake safety'
    );
  }) ? passed++ : failed++);

  (test('no target points at claude_desktop_config.json (dead-file regression)', () => {
    const targets = buildMcpRegistrationTargets('/home/person');
    for (const target of targets) {
      assert.ok(
        !String(target.path).includes('claude_desktop_config.json'),
        `${target.name} must not point at claude_desktop_config.json - Claude Code never reads it`
      );
    }
  }) ? passed++ : failed++);

  if (process.platform !== 'win32') {
    // A fake `claude` CLI on PATH: logs every invocation, and `mcp get`
    // exits with FAKE_GET_STATUS (1 = not registered) so each scenario can
    // steer the handler without a real Claude Code install.
    const makeFakeClaude = (binDir) => {
      const logPath = path.join(binDir, 'calls.log');
      const fake = path.join(binDir, 'claude');
      fs.writeFileSync(fake, [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        String.raw`fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\n');`,
        "if (process.argv[2] === 'mcp' && process.argv[3] === 'get') process.exit(Number(process.env.FAKE_GET_STATUS || 1));",
        "if (process.argv[2] === 'mcp' && process.argv[3] === 'add') { if (Number(process.env.FAKE_ADD_STATUS || 0) !== 0) { process.stderr.write('add refused by fake CLI\\n'); } process.exit(Number(process.env.FAKE_ADD_STATUS || 0)); }",
        'process.exit(0);',
        '',
      ].join('\n'));
      fs.chmodSync(fake, 0o755);
      return logPath;
    };

    const withFakeClaude = (getStatus, fn) => {
      const binDir = makeTempDir();
      const logPath = makeFakeClaude(binDir);
      const savedPath = process.env.PATH;
      const savedLog = process.env.FAKE_CLAUDE_LOG;
      const savedStatus = process.env.FAKE_GET_STATUS;
      process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
      process.env.FAKE_CLAUDE_LOG = logPath;
      process.env.FAKE_GET_STATUS = getStatus;
      try {
        fn(logPath);
      } finally {
        process.env.PATH = savedPath;
        if (savedLog === undefined) delete process.env.FAKE_CLAUDE_LOG; else process.env.FAKE_CLAUDE_LOG = savedLog;
        if (savedStatus === undefined) delete process.env.FAKE_GET_STATUS; else process.env.FAKE_GET_STATUS = savedStatus;
        fs.rmSync(binDir, { recursive: true, force: true });
      }
    };

    (test('registerClaudeCli adds both servers in user scope when none are registered', () => {
      withFakeClaude('1', (logPath) => {
        const changed = registerClaudeCli('/ignored', bins);
        assert.strictEqual(changed, true);
        const calls = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const adds = calls.filter(call => call[1] === 'add');
        assert.deepStrictEqual(adds, [
          ['mcp', 'add', '-s', 'user', 'egc-guardian', '--', 'node', bins.guardianBin],
          ['mcp', 'add', '-s', 'user', 'egc-memory', '--', 'node', bins.memoryBin],
        ]);
      });
    }) ? passed++ : failed++);

    (test('registerClaudeCli is a silent no-op when both servers are already registered', () => {
      withFakeClaude('0', (logPath) => {
        const changed = registerClaudeCli('/ignored', bins);
        assert.strictEqual(changed, false);
        const calls = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.strictEqual(calls.filter(call => call[1] === 'add').length, 0, 'must not re-add registered servers');
      });
    }) ? passed++ : failed++);

    (test('the shell branch delivers intact argv end to end (quoting exercised through a real shell)', () => {
      withFakeClaude('1', (logPath) => {
        // Forcing the shell branch on POSIX runs the exact quoting path the
        // Windows .cmd flow uses; /bin/sh applies the same double-quote
        // grouping rules this code relies on for whitespace, so a path with
        // spaces must still arrive as ONE argv element in the fake CLI.
        const dispatch = require('../../scripts/lib/crusher/shim-dispatch');
        const originalNeedsShell = dispatch.needsShellOnWindows;
        dispatch.needsShellOnWindows = () => true;
        const spacedBins = {
          guardianBin: '/fake dir with space/egc-guardian/build/index.js',
          memoryBin: '/fake dir with space/egc-memory/build/index.js',
        };
        try {
          const changed = registerClaudeCli('/ignored', spacedBins);
          assert.strictEqual(changed, true);
          const calls = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
          const adds = calls.filter(call => call[1] === 'add');
          assert.deepStrictEqual(adds, [
            ['mcp', 'add', '-s', 'user', 'egc-guardian', '--', 'node', spacedBins.guardianBin],
            ['mcp', 'add', '-s', 'user', 'egc-memory', '--', 'node', spacedBins.memoryBin],
          ], 'every argument must survive the shell hop unsplit and unquoted');
        } finally {
          dispatch.needsShellOnWindows = originalNeedsShell;
        }
      });
    }) ? passed++ : failed++);

    (test('registerClaudeCli throws when the CLI refuses an add, so init warns instead of reporting success', () => {
      withFakeClaude('1', () => {
        const savedAdd = process.env.FAKE_ADD_STATUS;
        process.env.FAKE_ADD_STATUS = '2';
        try {
          assert.throws(
            () => registerClaudeCli('/ignored', bins),
            /claude mcp add egc-guardian failed: add refused by fake CLI/
          );
        } finally {
          if (savedAdd === undefined) delete process.env.FAKE_ADD_STATUS; else process.env.FAKE_ADD_STATUS = savedAdd;
        }
      });
    }) ? passed++ : failed++);

    (test('Claude Code gate follows the claude CLI presence on PATH', () => {
      withFakeClaude('1', () => {
        const targets = buildMcpRegistrationTargets('/home/person');
        const target = targets.find(t => t.name === 'Claude Code (user scope)');
        assert.strictEqual(target.gate(), true, 'gate must open when the CLI is on PATH');
      });
      const savedPath = process.env.PATH;
      const emptyDir = makeTempDir();
      process.env.PATH = emptyDir;
      try {
        const targets = buildMcpRegistrationTargets('/home/person');
        const target = targets.find(t => t.name === 'Claude Code (user scope)');
        assert.strictEqual(target.gate(), false, 'gate must close when no CLI exists');
      } finally {
        process.env.PATH = savedPath;
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    }) ? passed++ : failed++);
  }

  // ── registerJson (generic - used by Cursor, Claude, Gemini, Kiro, etc.) ──

  (test('registerJson creates a fresh file with both mcp servers', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.cursor', 'mcp.json');
    const changed = registerJson(target, bins);

    assert.strictEqual(changed, true);
    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepStrictEqual(written.mcpServers['egc-guardian'], { command: 'node', args: [bins.guardianBin] });
    assert.deepStrictEqual(written.mcpServers['egc-memory'], { command: 'node', args: [bins.memoryBin] });

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerJson preserves unrelated existing mcpServers entries', () => {
    const tmpHome = makeTempDir();
    const dir = path.join(tmpHome, '.cursor');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'mcp.json');
    fs.writeFileSync(target, JSON.stringify({
      mcpServers: { 'some-other-server': { command: 'npx', args: ['-y', 'other'] } },
    }, null, 2));

    registerJson(target, bins);

    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.ok(written.mcpServers['some-other-server'], 'pre-existing unrelated server should survive the merge');
    assert.ok(written.mcpServers['egc-guardian'], 'egc-guardian should be added');
    assert.ok(written.mcpServers['egc-memory'], 'egc-memory should be added');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerJson is idempotent: second run reports no change', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.cursor', 'mcp.json');

    const firstRun = registerJson(target, bins);
    const secondRun = registerJson(target, bins);

    assert.strictEqual(firstRun, true, 'first run should report a change');
    assert.strictEqual(secondRun, false, 'second run should report no change (already registered)');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerJson throws (not returns false) on unparseable existing content', () => {
    const tmpHome = makeTempDir();
    const dir = path.join(tmpHome, '.cursor');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'mcp.json');
    fs.writeFileSync(target, 'not valid json {{{');

    // Throwing (rather than quietly returning false) matters: false is
    // also the return value for "already fully registered, nothing to do",
    // and the orchestrator needs to tell those two apart to know whether
    // to warn.
    assert.throws(() => registerJson(target, bins), /not valid JSON/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'not valid json {{{', 'existing content should be untouched, not clobbered');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerJson treats a 0-byte empty file as an empty object and adds both servers', () => {
    const tmpHome = makeTempDir();
    const dir = path.join(tmpHome, '.gemini', 'config');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'mcp_config.json');
    fs.writeFileSync(target, '');

    const changed = registerJson(target, bins);
    assert.strictEqual(changed, true);
    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.ok(written.mcpServers['egc-guardian']);
    assert.ok(written.mcpServers['egc-memory']);

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerJson treats a whitespace-only file as an empty object and adds both servers', () => {
    const tmpHome = makeTempDir();
    const dir = path.join(tmpHome, '.gemini', 'config');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'mcp_config.json');
    fs.writeFileSync(target, '   \n\t  ');

    const changed = registerJson(target, bins);
    assert.strictEqual(changed, true);
    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.ok(written.mcpServers['egc-guardian']);
    assert.ok(written.mcpServers['egc-memory']);

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerJson throws on invalid root shape (array or primitive) to protect user data', () => {
    const tmpHome = makeTempDir();
    const dir = path.join(tmpHome, '.cursor');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'mcp.json');
    fs.writeFileSync(target, '[1, 2, 3]');

    assert.throws(() => registerJson(target, bins), /not a valid MCP config object/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '[1, 2, 3]', 'invalid root file must be left untouched');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerJson throws on invalid mcpServers shape (array or primitive) to protect user data', () => {
    const tmpHome = makeTempDir();
    const dir = path.join(tmpHome, '.cursor');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'mcp.json');
    fs.writeFileSync(target, JSON.stringify({ mcpServers: [1, 2, 3] }));

    assert.throws(() => registerJson(target, bins), /invalid mcpServers object/);

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  // ── registerToml (unchanged behavior, guards against regressions) ──

  (test('registerToml appends both mcp_servers blocks to a fresh file', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');

    const changed = registerToml(target, bins);

    assert.strictEqual(changed, true);
    const content = fs.readFileSync(target, 'utf8');
    assert.ok(content.includes('name = "egc-guardian"'));
    assert.ok(content.includes('name = "egc-memory"'));

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml escapes backslashes in Windows-style bin paths', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
    const winPath = 'C:\\Users\\person\\egc\\mcp\\servers\\egc-guardian\\build\\index.js';

    registerToml(target, { guardianBin: winPath, memoryBin: bins.memoryBin });

    const content = fs.readFileSync(target, 'utf8');
    // "\U" is reserved in TOML for an 8-hex-digit Unicode escape - a raw,
    // unescaped backslash from a Windows path breaks the string the moment
    // it's followed by a hex-ish character (as "\Users" would be here).
    assert.ok(
      content.includes('C:\\\\Users\\\\person\\\\egc\\\\mcp\\\\servers\\\\egc-guardian\\\\build\\\\index.js'),
      'backslashes should be doubled for a valid TOML basic string'
    );

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml output (including Windows paths) parses with a real TOML parser', () => {
    let TOML;
    try {
      TOML = require('@iarna/toml');
    } catch (_) {
      console.log('    (skipped: @iarna/toml not installed)');
      return;
    }

    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
    const winPath = 'C:\\Users\\person\\egc-guardian\\index.js';

    registerToml(target, { guardianBin: winPath, memoryBin: bins.memoryBin });

    const parsed = TOML.parse(fs.readFileSync(target, 'utf8'));
    const guardianEntry = parsed.mcp_servers.find(s => s.name === 'egc-guardian');
    assert.strictEqual(guardianEntry.args[0], winPath, 'path should round-trip exactly through a real TOML parser');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml escapes double quotes so a POSIX path with a quote stays valid TOML', () => {
    let TOML;
    try {
      TOML = require('@iarna/toml');
    } catch (_) {
      console.log('    (skipped: @iarna/toml not installed)');
      return;
    }

    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
    // A double quote is illegal in a Windows path but legal in a POSIX
    // directory name; unescaped it terminates the TOML basic string early and
    // corrupts the file, the same class of bug as an unescaped backslash.
    const quotedPath = '/home/person/we"rd/egc-guardian/index.js';

    registerToml(target, { guardianBin: quotedPath, memoryBin: bins.memoryBin });

    const parsed = TOML.parse(fs.readFileSync(target, 'utf8'));
    const guardianEntry = parsed.mcp_servers.find(s => s.name === 'egc-guardian');
    assert.strictEqual(guardianEntry.args[0], quotedPath, 'a path containing a double quote should round-trip exactly');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml restores a commented-out entry instead of treating it as already registered (audit EGC-128)', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // A plain substring check for '"egc-guardian"' would match this
    // commented-out line and wrongly conclude the server is registered.
    fs.writeFileSync(
      target,
      '# [[mcp_servers]]\n# name = "egc-guardian"\n# command = "node"\n# args = ["/old/path.js"]\n'
    );

    const changed = registerToml(target, bins);

    assert.strictEqual(changed, true, 'should re-register egc-guardian since the only entry is commented out');
    const content = fs.readFileSync(target, 'utf8');
    const activeLines = content
      .split('\n')
      .filter(line => !line.trim().startsWith('#'));
    assert.ok(
      activeLines.some(line => line.includes('name = "egc-guardian"')),
      'an active (uncommented) egc-guardian entry should now exist'
    );

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml treats an existing active entry as already registered (no duplicate)', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    registerToml(target, bins);
    const firstWrite = fs.readFileSync(target, 'utf8');

    const changed = registerToml(target, bins);

    assert.strictEqual(changed, false, 'should be a no-op the second time');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), firstWrite, 'should not duplicate the entries');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml drops an empty inline mcp_servers array before appending (what `vibe mcp remove` leaves behind)', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.vibe', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Byte-for-byte what Mistral Vibe writes after `vibe mcp add x` followed
    // by `vibe mcp remove x`. Appending [[mcp_servers]] to this without
    // dropping the inline array first makes the file invalid TOML, and Vibe
    // then refuses to start at all.
    fs.writeFileSync(target, 'theme = "auto"\nmcp_servers = []\n');

    const changed = registerToml(target, bins);

    assert.strictEqual(changed, true);
    const content = fs.readFileSync(target, 'utf8');
    assert.ok(!/^\s*mcp_servers\s*=\s*\[/m.test(content), 'the empty inline array must be gone');
    assert.ok(content.includes('theme = "auto"'), 'unrelated keys must survive');
    assert.ok(content.includes('name = "egc-guardian"'));
    assert.ok(content.includes('name = "egc-memory"'));

    let TOML;
    try {
      TOML = require('@iarna/toml');
    } catch (_) {
      console.log('    (parse check skipped: @iarna/toml not installed)');
      fs.rmSync(tmpHome, { recursive: true, force: true });
      return;
    }
    const parsed = TOML.parse(content);
    assert.strictEqual(parsed.mcp_servers.length, 2, 'the result must be valid TOML holding both servers');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml leaves a non-empty inline mcp_servers array untouched rather than corrupting it', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.vibe', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Entries the person wrote by hand: appending would break the file, and
    // rewriting the array would mean re-serializing their own configuration.
    // Throwing keeps "could not write" distinguishable from "nothing to do",
    // the same contract registerJson uses for a file it cannot merge into.
    const original = 'theme = "auto"\nmcp_servers = [ { name = "mine", command = "node" } ]\n';
    fs.writeFileSync(target, original);

    assert.throws(() => registerToml(target, bins), /inline array - left untouched/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), original, 'the file must be byte-identical');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml still appends normally when mcp_servers is already an array of tables', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // The shape registerToml itself writes: [[mcp_servers]] tables append
    // cleanly, so the new guard must not treat this as an inline array.
    fs.writeFileSync(target, '[[mcp_servers]]\nname = "other"\ncommand = "node"\nargs = ["/x.js"]\n');

    const changed = registerToml(target, bins);

    assert.strictEqual(changed, true);
    const content = fs.readFileSync(target, 'utf8');
    assert.ok(content.includes('name = "other"'), 'the existing entry must survive');
    assert.ok(content.includes('name = "egc-guardian"'));
    assert.ok(content.includes('name = "egc-memory"'));

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml only reads the root table, so an mcp_servers under a [table] header is left alone', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // TOML offers no way back to the root table: this key belongs to
    // [profile], and deleting the line would silently drop
    // profile.mcp_servers along with it.
    fs.writeFileSync(target, 'theme = "auto"\n\n[profile]\nmcp_servers = []\n');

    const changed = registerToml(target, bins);
    assert.strictEqual(changed, true);

    let TOML;
    try {
      TOML = require('@iarna/toml');
    } catch (_) {
      console.log('    (parse check skipped: @iarna/toml not installed)');
      fs.rmSync(tmpHome, { recursive: true, force: true });
      return;
    }
    const parsed = TOML.parse(fs.readFileSync(target, 'utf8'));
    assert.deepStrictEqual(parsed.profile.mcp_servers, [], 'the table key must survive untouched');
    assert.strictEqual(parsed.mcp_servers.length, 2, 'our two tables are appended at the root');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml ignores a closing bracket that sits inside a comment', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Valid TOML for an empty array. Taking the `]` in the comment as the
    // end would remove only the first line and leave an orphan `]` behind,
    // which is not valid TOML either.
    fs.writeFileSync(target, 'mcp_servers = [ # ]\n]\n');

    const changed = registerToml(target, bins);
    assert.strictEqual(changed, true);

    let TOML;
    try {
      TOML = require('@iarna/toml');
    } catch (_) {
      console.log('    (parse check skipped: @iarna/toml not installed)');
      fs.rmSync(tmpHome, { recursive: true, force: true });
      return;
    }
    const parsed = TOML.parse(fs.readFileSync(target, 'utf8'));
    assert.strictEqual(parsed.mcp_servers.length, 2, 'both lines of the empty array are gone and the file parses');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml recognises the quoted spellings of the mcp_servers key', () => {
    const tmpHome = makeTempDir();
    // "mcp_servers" and 'mcp_servers' name the same root key as the bare
    // spelling; missing either leaves the file invalid after the append.
    const spellings = [['basic', '"mcp_servers"'], ['literal', "'mcp_servers'"]];
    for (const [label, spelling] of spellings) {
      const target = path.join(tmpHome, label, 'config.toml');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${spelling} = []\n`);

      assert.strictEqual(registerToml(target, bins), true, `${spelling} should be handled`);
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(!content.includes(`${spelling} = []`), `${spelling} should be dropped like the bare key`);
      assert.ok(content.includes('name = "egc-guardian"'));
      assert.ok(content.includes('name = "egc-memory"'));
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml does not cut a line out of a multi-line string', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Inside """ this line is text, not a key: removing it would corrupt
    // the person's own note.
    fs.writeFileSync(target, 'note = """\nmcp_servers = []\n"""\n');

    const changed = registerToml(target, bins);
    assert.strictEqual(changed, true);

    let TOML;
    try {
      TOML = require('@iarna/toml');
    } catch (_) {
      console.log('    (parse check skipped: @iarna/toml not installed)');
      fs.rmSync(tmpHome, { recursive: true, force: true });
      return;
    }
    const parsed = TOML.parse(fs.readFileSync(target, 'utf8'));
    assert.ok(parsed.note.includes('mcp_servers = []'), 'the string content must be untouched');
    assert.strictEqual(parsed.mcp_servers.length, 2);

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml is a silent no-op when an inline array already holds both servers', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.vibe', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // The shape someone actually writes after following the error message:
    // each entry carries args, and that inner `]` ends a line-based scan
    // early, hiding every entry after it. The check has to come from a real
    // parse, which is what tomlHasActiveServer does.
    const original = 'mcp_servers = [ { name = "egc-guardian", command = "node", args = ["/a/index.js"] }, '
      + '{ name = "egc-memory", command = "node", args = ["/b/index.js"] } ]\n';
    fs.writeFileSync(target, original);

    assert.strictEqual(registerToml(target, bins), false, 'nothing left to do');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), original, 'the file must be byte-identical');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml does not mistake a delimiter inside a comment for a multi-line string', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // A comment may mention the multi-line delimiter without opening a
    // string. Counting it would put the scan inside a string it never
    // entered, so the empty array below would be missed and the append
    // would break the file.
    fs.writeFileSync(target, '# notes use """ for long text\nmcp_servers = []\n');

    const changed = registerToml(target, bins);
    assert.strictEqual(changed, true);
    const content = fs.readFileSync(target, 'utf8');
    assert.ok(content.includes('# notes use'), 'the comment must survive');

    let TOML;
    try {
      TOML = require('@iarna/toml');
    } catch (_) {
      console.log('    (parse check skipped: @iarna/toml not installed)');
      fs.rmSync(tmpHome, { recursive: true, force: true });
      return;
    }
    assert.strictEqual(TOML.parse(content).mcp_servers.length, 2, 'the result must be valid TOML');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml refuses to write a file the scan would have broken', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // `[3]` on its own line looks like a table header, so the scan stops
    // before the empty array and the append would produce invalid TOML. A
    // line-based scan will always have a corner like this one, so what
    // actually protects the file is parsing the result before writing it.
    const original = 'matrix = [\n  [1, 2],\n  [3]\n]\nmcp_servers = []\n';
    fs.writeFileSync(target, original);

    try {
      require('@iarna/toml');
    } catch (_) {
      console.log('    (skipped: @iarna/toml not installed, nothing to parse with)');
      fs.rmSync(tmpHome, { recursive: true, force: true });
      return;
    }

    assert.throws(() => registerToml(target, bins), /could not be updated without breaking it/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), original, 'the file must be byte-identical');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml refuses rather than act on a delimiter it read inside a single-line string', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // The `'''` here is content of a basic string and opens nothing, but the
    // scan reads it as opening a multi-line string and skips the rest of the
    // file, so the empty array below is never dropped. Refusing is the right
    // outcome: the install does less, and the config still starts the tool.
    const original = 'note = "Here is \'\'\'"\nmcp_servers = []\n';
    fs.writeFileSync(target, original);

    try {
      require('@iarna/toml');
    } catch (_) {
      console.log('    (skipped: @iarna/toml not installed, nothing to compare with)');
      fs.rmSync(tmpHome, { recursive: true, force: true });
      return;
    }

    assert.throws(() => registerToml(target, bins), /could not be updated without breaking it/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), original, 'the file must be byte-identical');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml keeps a `"""` inside a `\'\'\'` string as content, not as a delimiter', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Only the delimiter that opened a string closes it. Counting both kinds
    // would end this string at the inner `"""`, putting the scan back outside
    // and letting it cut the next line out of the person's own note - and the
    // result would still parse, so parsing alone would not catch it.
    fs.writeFileSync(target, "note = '''\nHere is a \"\"\" inside\nmcp_servers = []\n'''\n");

    const changed = registerToml(target, bins);
    assert.strictEqual(changed, true);

    let TOML;
    try {
      TOML = require('@iarna/toml');
    } catch (_) {
      console.log('    (parse check skipped: @iarna/toml not installed)');
      fs.rmSync(tmpHome, { recursive: true, force: true });
      return;
    }
    const parsed = TOML.parse(fs.readFileSync(target, 'utf8'));
    assert.ok(parsed.note.includes('mcp_servers = []'), 'the string content must be untouched');
    assert.strictEqual(parsed.mcp_servers.length, 2);

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerToml recognises a table header whose key is quoted and holds any character', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // A table may be named after anything once the key is quoted. Missing
    // this as a header lets the scan walk into the table and remove a key
    // that is not the root one - and the result still parses.
    fs.writeFileSync(target, '["github.com/x"]\nmcp_servers = []\n');

    const changed = registerToml(target, bins);
    assert.strictEqual(changed, true);

    let TOML;
    try {
      TOML = require('@iarna/toml');
    } catch (_) {
      console.log('    (parse check skipped: @iarna/toml not installed)');
      fs.rmSync(tmpHome, { recursive: true, force: true });
      return;
    }
    const parsed = TOML.parse(fs.readFileSync(target, 'utf8'));
    assert.deepStrictEqual(parsed['github.com/x'].mcp_servers, [], 'the table key must survive untouched');
    assert.strictEqual(parsed.mcp_servers.length, 2, 'our two tables are appended at the root');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('the scan alone gets the string and the quoted table right, with no parser to fall back on', () => {
    // @iarna/toml is a devDependency that never ships, so on a user's machine
    // the parse comparison cannot run and the scan is the only thing standing
    // between an install and a damaged config. Both cases above are checked
    // again with the parser taken away from the module under test.
    let TOML;
    try {
      TOML = require('@iarna/toml');
    } catch (_) {
      console.log('    (skipped: @iarna/toml not installed, nothing to verify with)');
      return;
    }

    withoutTomlParser((parserlessRegisterToml) => {
      const tmpHome = makeTempDir();

      const stringTarget = path.join(tmpHome, 'string', 'config.toml');
      fs.mkdirSync(path.dirname(stringTarget), { recursive: true });
      fs.writeFileSync(stringTarget, "note = '''\nHere is a \"\"\" inside\nmcp_servers = []\n'''\n");
      assert.strictEqual(parserlessRegisterToml(stringTarget, bins), true);
      const stringParsed = TOML.parse(fs.readFileSync(stringTarget, 'utf8'));
      assert.ok(stringParsed.note.includes('mcp_servers = []'), 'the string content must survive without a parser');
      assert.strictEqual(stringParsed.mcp_servers.length, 2);

      const tableTarget = path.join(tmpHome, 'table', 'config.toml');
      fs.mkdirSync(path.dirname(tableTarget), { recursive: true });
      fs.writeFileSync(tableTarget, '["github.com/x"]\nmcp_servers = []\n');
      assert.strictEqual(parserlessRegisterToml(tableTarget, bins), true);
      const tableParsed = TOML.parse(fs.readFileSync(tableTarget, 'utf8'));
      assert.deepStrictEqual(tableParsed['github.com/x'].mcp_servers, [], 'the table key must survive without a parser');
      assert.strictEqual(tableParsed.mcp_servers.length, 2);

      fs.rmSync(tmpHome, { recursive: true, force: true });
    });
  }) ? passed++ : failed++);

  // ── registerZedContextServers ───────────────────────────────────

  (test('registerZedContextServers keeps a Windows bin path valid JSON (backslash escape)', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.config', 'zed', 'settings.json');
    const winPath = 'C:\\Users\\person\\egc\\mcp\\servers\\egc-guardian\\build\\index.js';

    // Substituting the raw Windows path into the JSON template unescaped makes
    // "\U" an invalid JSON escape, so JSON.parse would throw before the file
    // could ever be written.
    const changed = registerZedContextServers(target, { guardianBin: winPath, memoryBin: bins.memoryBin });
    assert.strictEqual(changed, true, 'should register on a fresh settings file');

    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.strictEqual(
      parsed.context_servers['egc-guardian'].command.args[0],
      winPath,
      'the Windows path should round-trip exactly through JSON.parse'
    );

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerZedContextServers keeps a POSIX path with a double quote valid JSON', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.config', 'zed', 'settings.json');
    // A double quote is legal in a POSIX directory name; unescaped it would
    // terminate the JSON string early and corrupt the template.
    const quotedPath = '/home/person/we"rd/egc-guardian/index.js';

    registerZedContextServers(target, { guardianBin: quotedPath, memoryBin: bins.memoryBin });

    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.strictEqual(parsed.context_servers['egc-guardian'].command.args[0], quotedPath, 'a path with a double quote should round-trip exactly');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerZedContextServers treats a 0-byte empty file as an empty object and adds servers', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.config', 'zed', 'settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');

    const changed = registerZedContextServers(target, bins);
    assert.strictEqual(changed, true);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.ok(parsed.context_servers['egc-guardian']);
    assert.ok(parsed.context_servers['egc-memory']);

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerZedContextServers treats a whitespace-only file as an empty object and adds servers', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.config', 'zed', 'settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '  \n\t  ');

    const changed = registerZedContextServers(target, bins);
    assert.strictEqual(changed, true);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.ok(parsed.context_servers['egc-guardian']);
    assert.ok(parsed.context_servers['egc-memory']);

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerZedContextServers throws on invalid settings root or context_servers shape to protect user data', () => {
    const tmpHome = makeTempDir();
    const target = path.join(tmpHome, '.config', 'zed', 'settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '[1, 2, 3]');

    assert.throws(() => registerZedContextServers(target, bins), /not a valid settings object/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '[1, 2, 3]', 'invalid root file must be left untouched');

    fs.writeFileSync(target, JSON.stringify({ context_servers: [1, 2, 3] }));
    assert.throws(() => registerZedContextServers(target, bins), /invalid context_servers object/);

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  // ── registerMcpServers orchestrator ─────────────────────────────

  (test('registerMcpServers in dry-run mode writes nothing', () => {
    const tmpHome = makeTempDir();
    fs.mkdirSync(path.join(tmpHome, '.kiro'));

    const skipped = [];
    registerIsolated(tmpHome, {
      dryRun: true,
      onSkip: (target) => skipped.push(target.name),
    });

    assert.ok(skipped.includes('Kiro'));
    assert.ok(!fs.existsSync(path.join(tmpHome, '.kiro', 'settings')), 'dry-run must not write any files');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  // Regression guard for the P1 fix: onRegister must never fire when
  // nothing was actually written. A gated target (Cursor) whose existing
  // config is unparseable should report through onWarn instead, and the
  // file must be left alone rather than overwritten.
  (test('registerMcpServers calls onWarn (not onRegister) when an existing JSON target is broken', () => {
    const tmpHome = makeTempDir();
    const dir = path.join(tmpHome, '.cursor');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mcp.json'), 'not valid json {{{');

    const registered = [];
    const warned = [];
    registerIsolated(tmpHome, {
      dryRun: false,
      onRegister: (target) => registered.push(target.name),
      onWarn: (target) => warned.push(target.name),
    });

    assert.ok(!registered.includes('Cursor'), 'onRegister must not fire when nothing was written');
    assert.ok(warned.includes('Cursor'), 'onWarn should fire so the failure is not silent');
    assert.strictEqual(
      fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'),
      'not valid json {{{',
      'broken file must be left untouched, not overwritten'
    );

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  // The other side of the same fix: a target that's already fully
  // registered is a legitimate no-op, not a failure, and must stay
  // silent - re-running `egc init` on an already-set-up machine shouldn't
  // print a warning for every tool that's already correctly configured.
  (test('registerMcpServers stays silent (no onRegister, no onWarn) on an already-registered target', () => {
    const tmpHome = makeTempDir();
    const dir = path.join(tmpHome, '.cursor');
    fs.mkdirSync(dir, { recursive: true });
    // Pre-register by calling registerJson directly, simulating a second
    // `egc init` run on a machine that's already set up.
    registerJson(path.join(dir, 'mcp.json'), bins);
    // CI runners export XDG_CONFIG_HOME; the OpenCode gate must read the temp home.
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;

    const registered = [];
    const warned = [];
    const unchanged = [];
    try {
      registerIsolated(tmpHome, {
        dryRun: false,
        onRegister: (target) => registered.push(target.name),
        onWarn: (target) => warned.push(target.name),
        onUnchanged: (target) => unchanged.push(target.name),
      });
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
    }

    assert.ok(!registered.includes('Cursor'), 'nothing changed, so onRegister should not fire again');
    assert.ok(!warned.includes('Cursor'), 'an already-registered target is not an error and should not warn');
    assert.ok(unchanged.includes('Cursor'), 'the caller is told the target was already registered');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  (test('registerMcpServers reports a fresh target through onRegister only, never onUnchanged', () => {
    const tmpHome = makeTempDir();
    fs.mkdirSync(path.join(tmpHome, '.cursor'), { recursive: true });
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;

    const registered = [];
    const unchanged = [];
    try {
      registerIsolated(tmpHome, {
        dryRun: false,
        onRegister: (target) => registered.push(target.name),
        onUnchanged: (target) => unchanged.push(target.name),
      });
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
    }

    assert.ok(registered.includes('Cursor'), 'a fresh target is registered');
    assert.ok(!unchanged.includes('Cursor'), 'a target that was just written is not reported as unchanged');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  }) ? passed++ : failed++);

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
