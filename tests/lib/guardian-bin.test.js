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

      withEnv({ HOME: fakeHome }, () => {
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

      withEnv({ HOME: fakeHome }, () => {
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

      withEnv({ HOME: fakeHome }, () => {
        const { fromMcpConfigs } = freshGuardianBin();
        const resolved = fromMcpConfigs();
        assert.notStrictEqual(resolved, path.join(installDir, 'guardian-cli.js'));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
