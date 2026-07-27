/**
 * Tests for scripts/lib/guardian-bin.js
 *
 * Covers the fix for the RCE reported in the 2026-07-15 audit (EGC-128):
 * a project-local .mcp.json used to be a trusted source for locating the
 * guardian CLI binary, which let a malicious repo point resolution at a
 * payload script it shipped alongside a crafted config.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function withCwd(dir, fn) {
  const saved = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(saved);
  }
}

function freshGuardianBin() {
  // guardian-bin.js reads os.homedir() at call time (not at require time),
  // so a plain require() cache hit is fine across tests as long as HOME is
  // set before resolveGuardianCli() is invoked.
  delete require.cache[require.resolve('../../scripts/lib/guardian-bin')];
  return require('../../scripts/lib/guardian-bin');
}

function main() {
  let passed = 0;
  let failed = 0;
  function run(name, fn) {
    if (test(name, fn)) passed++;
    else failed++;
  }

  console.log('\nguardian-bin.js — resolveGuardianCli()');

  run('never trusts a project-local .mcp.json (RCE closed)', () => {
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    const fakeRepo = createTempDir('egc-guardian-bin-repo-');
    try {
      // Payload the "malicious repo" ships: if this ever gets picked up and
      // executed by callGuardian(), the guardian would have run our binary.
      const payloadDir = path.join(fakeRepo, 'egc-guardian', 'build');
      fs.mkdirSync(payloadDir, { recursive: true });
      fs.writeFileSync(path.join(payloadDir, 'guardian-cli.js'), '// payload\n');
      fs.writeFileSync(
        path.join(fakeRepo, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'egc-guardian': {
              command: 'node',
              args: [path.join(payloadDir, 'index.js')],
            },
          },
        }),
      );

      // os.homedir() reads USERPROFILE on Windows, not HOME -- both must be
      // overridden together or the fake home is silently ignored there and
      // resolution falls through to the real (nonexistent in CI) user home.
      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        withCwd(fakeRepo, () => {
          // Test fromMcpConfigs() directly, not resolveGuardianCli(): the
          // full resolution chain would mask this specific check whenever
          // fromPackageLayout() also succeeds (e.g. running this suite from
          // an actual EGC checkout with a build present).
          const { fromMcpConfigs } = freshGuardianBin();
          const resolved = fromMcpConfigs();
          assert.notStrictEqual(
            resolved,
            path.join(payloadDir, 'guardian-cli.js'),
            'fromMcpConfigs() picked up the repo-local .mcp.json payload path',
          );
        });
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  run('still resolves via a trusted ~/.claude.json entry', () => {
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const installDir = path.join(fakeHome, 'somewhere', 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// real cli\n');
      fs.writeFileSync(
        path.join(fakeHome, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            'egc-guardian': {
              command: 'node',
              args: [path.join(installDir, 'index.js')],
            },
          },
        }),
      );

      // os.homedir() reads USERPROFILE on Windows, not HOME -- both must be
      // overridden together or the fake home is silently ignored there and
      // resolution falls through to the real (nonexistent in CI) user home.
      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromMcpConfigs } = freshGuardianBin();
        const resolved = fromMcpConfigs();
        assert.strictEqual(resolved, path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  run('args-path match no longer depends on path.join\'s platform-specific separator (audit EGC-128)', () => {
    // The bug this fixes only reproduces when path.join()'s separator (OS-
    // dependent) differs from the separator already in the config value —
    // e.g. a '/'-separated config read by a path.join() that would itself
    // produce '\' (Windows). That specific mismatch can't be forced in a
    // portable test without mocking the platform-dependent path module
    // itself, so this checks the actual invariant the fix establishes: the
    // match no longer goes through path.join() at all, for any separator
    // style the config value already uses. A forward-slash args path (the
    // portable, common case, and the shape a synced/cross-OS config would
    // have) must always match, independent of what OS reads it.
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const installDir = path.join(fakeHome, 'somewhere', 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// real cli\n');
      const forwardSlashIndexJsPath = path.join(installDir, 'index.js').split(path.sep).join('/');
      fs.writeFileSync(
        path.join(fakeHome, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            'egc-guardian': {
              command: 'node',
              args: [forwardSlashIndexJsPath],
            },
          },
        }),
      );

      // os.homedir() reads USERPROFILE on Windows, not HOME -- both must be
      // overridden together or the fake home is silently ignored there and
      // resolution falls through to the real (nonexistent in CI) user home.
      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromMcpConfigs } = freshGuardianBin();
        const resolved = fromMcpConfigs();
        assert.strictEqual(resolved, path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  run('rejects a ~/.claude.json entry pointing outside the home directory', () => {
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    const outsideDir = createTempDir('egc-guardian-bin-outside-');
    try {
      const installDir = path.join(outsideDir, 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// outside cli\n');
      fs.writeFileSync(
        path.join(fakeHome, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            'egc-guardian': {
              command: 'node',
              args: [path.join(installDir, 'index.js')],
            },
          },
        }),
      );

      // os.homedir() reads USERPROFILE on Windows, not HOME -- both must be
      // overridden together or the fake home is silently ignored there and
      // resolution falls through to the real (nonexistent in CI) user home.
      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromMcpConfigs } = freshGuardianBin();
        const resolved = fromMcpConfigs();
        assert.notStrictEqual(resolved, path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  run('resolves via ~/.gemini/config/mcp_config.json on a Gemini-CLI-only install (no ~/.claude.json)', () => {
    // 2026-07-27 audit (Guardian cross-CLI fail-open fix): guardian-bin.js
    // used to check ~/.gemini/settings.json, a file Gemini CLI never writes
    // for MCP config — a Gemini-only install (no Claude Code alongside it)
    // had no working config-based fallback at all and failed open silently.
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const installDir = path.join(fakeHome, 'somewhere', 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// real cli\n');
      fs.mkdirSync(path.join(fakeHome, '.gemini', 'config'), { recursive: true });
      fs.writeFileSync(
        path.join(fakeHome, '.gemini', 'config', 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            'egc-guardian': {
              command: 'node',
              args: [path.join(installDir, 'index.js')],
            },
          },
        }),
      );

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromMcpConfigs } = freshGuardianBin();
        const resolved = fromMcpConfigs();
        assert.strictEqual(resolved, path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  run('resolves via ~/.gemini/antigravity-cli/mcp_config.json on an Antigravity-only install', () => {
    // Multica squad audit (EGC-460/461, 2026-07-27): this is a SEPARATE file
    // from ~/.gemini/config/mcp_config.json above despite sharing the
    // ~/.gemini home root -- a pure-Antigravity install (no Claude Code, no
    // Gemini CLI alongside it) had no working config-based fallback here
    // either and failed open silently.
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const installDir = path.join(fakeHome, 'somewhere', 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// real cli\n');
      fs.mkdirSync(path.join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true });
      fs.writeFileSync(
        path.join(fakeHome, '.gemini', 'antigravity-cli', 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            'egc-guardian': {
              command: 'node',
              args: [path.join(installDir, 'index.js')],
            },
          },
        }),
      );

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromMcpConfigs } = freshGuardianBin();
        const resolved = fromMcpConfigs();
        assert.strictEqual(resolved, path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  run('resolves via ~/.config/opencode/config.json on an OpenCode-only install', () => {
    // Same audit: OpenCode's real MCP registration file (scripts/lib/
    // mcp-register.js's "OpenCode" target) was never consulted either.
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const installDir = path.join(fakeHome, 'somewhere', 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// real cli\n');
      fs.mkdirSync(path.join(fakeHome, '.config', 'opencode'), { recursive: true });
      fs.writeFileSync(
        path.join(fakeHome, '.config', 'opencode', 'config.json'),
        JSON.stringify({
          mcpServers: {
            'egc-guardian': {
              command: 'node',
              args: [path.join(installDir, 'index.js')],
            },
          },
        }),
      );

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromMcpConfigs } = freshGuardianBin();
        const resolved = fromMcpConfigs();
        assert.strictEqual(resolved, path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  run('no longer checks the dead ~/.gemini/settings.json path', () => {
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const installDir = path.join(fakeHome, 'somewhere', 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// real cli\n');
      fs.mkdirSync(path.join(fakeHome, '.gemini'), { recursive: true });
      fs.writeFileSync(
        path.join(fakeHome, '.gemini', 'settings.json'),
        JSON.stringify({
          mcpServers: {
            'egc-guardian': {
              command: 'node',
              args: [path.join(installDir, 'index.js')],
            },
          },
        }),
      );

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromMcpConfigs } = freshGuardianBin();
        const resolved = fromMcpConfigs();
        assert.strictEqual(resolved, null, 'settings.json should no longer be consulted');
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  console.log('\nguardian-bin.js: fromCodexToml()');

  run('resolves via ~/.codex/config.toml written by registerToml() (round-trip)', () => {
    // Uses the real registerToml() writer (scripts/lib/mcp-register.js) so
    // this test breaks if the two ever drift out of sync with each other,
    // not just against a hand-written fixture.
    const { registerToml } = require('../../scripts/lib/mcp-register');
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const installDir = path.join(fakeHome, 'somewhere', 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// real cli\n');
      const configPath = path.join(fakeHome, '.codex', 'config.toml');
      registerToml(configPath, {
        guardianBin: path.join(installDir, 'index.js'),
        memoryBin: path.join(installDir, '..', 'egc-memory', 'index.js'),
      });

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromCodexToml } = freshGuardianBin();
        const resolved = fromCodexToml();
        assert.strictEqual(resolved, path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  run('ignores unrelated TOML tables and ends the mcp_servers block at the next header', () => {
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const installDir = path.join(fakeHome, 'somewhere', 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// real cli\n');
      const configPath = path.join(fakeHome, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        [
          '[some_other_table]',
          'unrelated = "value"',
          '',
          '[[mcp_servers]]',
          'name = "egc-guardian"',
          'command = "node"',
          `args = ["${path.join(installDir, 'index.js').replaceAll('\\', '\\\\')}"]`,
          '',
          '[another_table]',
          'also_unrelated = true',
          '',
        ].join('\n'),
      );

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromCodexToml } = freshGuardianBin();
        const resolved = fromCodexToml();
        assert.strictEqual(resolved, path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  run('unescapes a backslash inside a TOML basic string (round-trip through the real tomlEscape())', () => {
    // path.join() never produces a '\' on Linux, so a path built the normal
    // way never actually exercises tomlUnescapeBasicString's escape-
    // resolution branch (it would just take the pass-through path every
    // time). A literal backslash is a perfectly legal filename character on
    // Linux, so embedding one in the install dir name forces registerToml()'s
    // real tomlEscape() to double it, and fromCodexToml() must reverse that
    // correctly to find the file back.
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const { registerToml } = require('../../scripts/lib/mcp-register');
      const installDir = path.join(fakeHome, 'somewhere', 'weird\\dir', 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// real cli\n');
      registerToml(path.join(fakeHome, '.codex', 'config.toml'), {
        guardianBin: path.join(installDir, 'index.js'),
        memoryBin: path.join(installDir, '..', 'egc-memory', 'index.js'),
      });

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromCodexToml } = freshGuardianBin();
        assert.strictEqual(fromCodexToml(), path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  run('handles a multi-line args array', () => {
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const installDir = path.join(fakeHome, 'somewhere', 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// real cli\n');
      const configPath = path.join(fakeHome, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        [
          '[[mcp_servers]]',
          'name = "egc-guardian"',
          'command = "node"',
          'args = [',
          `  "${path.join(installDir, 'index.js').replaceAll('\\', '\\\\')}",`,
          ']',
          '',
        ].join('\n'),
      );

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromCodexToml } = freshGuardianBin();
        const resolved = fromCodexToml();
        assert.strictEqual(resolved, path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  run('rejects a config.toml entry pointing outside the home directory', () => {
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    const outsideDir = createTempDir('egc-guardian-bin-outside-');
    try {
      const installDir = path.join(outsideDir, 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// outside cli\n');
      const configPath = path.join(fakeHome, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        [
          '[[mcp_servers]]',
          'name = "egc-guardian"',
          'command = "node"',
          `args = ["${path.join(installDir, 'index.js').replaceAll('\\', '\\\\')}"]`,
          '',
        ].join('\n'),
      );

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromCodexToml } = freshGuardianBin();
        const resolved = fromCodexToml();
        assert.notStrictEqual(resolved, path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  run('returns null (never throws) when config.toml does not exist', () => {
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromCodexToml } = freshGuardianBin();
        assert.strictEqual(fromCodexToml(), null);
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  run('returns null (never throws) on a malformed/garbage config.toml', () => {
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const configPath = path.join(fakeHome, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, '[[mcp_servers]\nname = egc-guardian broken toml {{{');

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromCodexToml } = freshGuardianBin();
        assert.strictEqual(fromCodexToml(), null);
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  console.log('\nguardian-bin.js: fromEgcHomeMarker()');

  run('resolves via ~/.egc/guardian-cli-path.json (Copilot/CodeBuddy fallback, EGC-465)', () => {
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const packageRoot = path.join(fakeHome, 'somewhere', 'the-package');
      const installDir = path.join(packageRoot, 'mcp', 'servers', 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// real cli\n');
      const markerPath = path.join(fakeHome, '.egc', 'guardian-cli-path.json');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({ packageRoot }));

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromEgcHomeMarker } = freshGuardianBin();
        assert.strictEqual(fromEgcHomeMarker(), path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  run('allows a marker packageRoot outside $HOME (system-wide Node install, no version manager)', () => {
    // The content is NOT restricted to $HOME, unlike fromMcpConfigs()/
    // fromCodexToml() -- a system Node install (apt install nodejs + sudo
    // npm install -g) legitimately puts npm root -g outside $HOME, and
    // that is exactly the deployment shape this strategy exists to cover.
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    const outsideDir = createTempDir('egc-guardian-bin-outside-');
    try {
      const packageRoot = outsideDir;
      const installDir = path.join(packageRoot, 'mcp', 'servers', 'egc-guardian', 'build');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'guardian-cli.js'), '// real cli\n');
      const markerPath = path.join(fakeHome, '.egc', 'guardian-cli-path.json');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({ packageRoot }));

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromEgcHomeMarker } = freshGuardianBin();
        assert.strictEqual(fromEgcHomeMarker(), path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  run('returns null (never throws) when the marker file does not exist', () => {
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromEgcHomeMarker } = freshGuardianBin();
        assert.strictEqual(fromEgcHomeMarker(), null);
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  run('returns null (never throws) on a malformed marker file', () => {
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const markerPath = path.join(fakeHome, '.egc', 'guardian-cli-path.json');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, 'not json {{{');

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromEgcHomeMarker } = freshGuardianBin();
        assert.strictEqual(fromEgcHomeMarker(), null);
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  run('returns null when the marker\'s packageRoot has no guardian-cli.js at the expected relative path', () => {
    const fakeHome = createTempDir('egc-guardian-bin-home-');
    try {
      const markerPath = path.join(fakeHome, '.egc', 'guardian-cli-path.json');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({ packageRoot: path.join(fakeHome, 'nonexistent-package') }));

      withEnv({ HOME: fakeHome, USERPROFILE: fakeHome }, () => {
        const { fromEgcHomeMarker } = freshGuardianBin();
        assert.strictEqual(fromEgcHomeMarker(), null);
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
