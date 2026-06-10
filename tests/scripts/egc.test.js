/**
 * Tests for scripts/egc.js
 */

const assert = require('assert');
const { maybeSkipBaselineAbsent } = require('../lib/baseline-absent');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'egc.js');
const PACKAGE_VERSION = require('../../package.json').version;

function runCli(args, options = {}) {
  const envOverrides = {
    ...(options.env || {}),
  };

  if (typeof envOverrides.HOME === 'string' && !('USERPROFILE' in envOverrides)) {
    envOverrides.USERPROFILE = envOverrides.HOME;
  }

  if (typeof envOverrides.USERPROFILE === 'string' && !('HOME' in envOverrides)) {
    envOverrides.HOME = envOverrides.USERPROFILE;
  }

  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: options.cwd || process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      ...envOverrides,
    },
  });
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function parseJson(stdout) {
  return JSON.parse(stdout.trim());
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    if (maybeSkipBaselineAbsent(error, name)) return true;
    console.log(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
    return false;
  }
}

function main() {
  console.log('\n=== Testing egc.js ===\n');

  let passed = 0;
  let failed = 0;

  const tests = [
    ['shows top-level help', () => {
      const result = runCli(['--help']);
      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /EGC selective-install CLI/);
      assert.match(result.stdout, /catalog/);
      assert.match(result.stdout, /list-installed/);
      assert.match(result.stdout, /doctor/);
      assert.match(result.stdout, /auto-update/);
      assert.match(result.stdout, /consult/);
      assert.match(result.stdout, /loop-status/);
    }],
    ['prints package version with --version', () => {
      const result = runCli(['--version']);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout.trim(), PACKAGE_VERSION);
      assert.strictEqual(result.stderr, '');
    }],
    ['prints package version with -v alias', () => {
      const result = runCli(['-v']);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout.trim(), PACKAGE_VERSION);
      assert.strictEqual(result.stderr, '');
    }],
    ['delegates explicit install command', () => {
      const result = runCli(['install', '--dry-run', '--json', 'typescript']);
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = parseJson(result.stdout);
      assert.strictEqual(payload.dryRun, true);
      assert.strictEqual(payload.plan.mode, 'legacy-compat');
      assert.deepStrictEqual(payload.plan.legacyLanguages, ['typescript']);
      assert.ok(payload.plan.selectedModuleIds.includes('framework-language'));
    }],
    ['routes implicit top-level args to install', () => {
      const result = runCli(['--dry-run', '--json', 'typescript']);
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = parseJson(result.stdout);
      assert.strictEqual(payload.dryRun, true);
      assert.strictEqual(payload.plan.mode, 'legacy-compat');
      assert.deepStrictEqual(payload.plan.legacyLanguages, ['typescript']);
      assert.ok(payload.plan.selectedModuleIds.includes('framework-language'));
    }],
    ['delegates plan command', () => {
      const result = runCli(['plan', '--list-profiles', '--json']);
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = parseJson(result.stdout);
      assert.ok(Array.isArray(payload.profiles));
      assert.ok(payload.profiles.length > 0);
    }],
    ['delegates catalog command', () => {
      const result = runCli(['catalog', 'show', 'framework:nextjs', '--json']);
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = parseJson(result.stdout);
      assert.strictEqual(payload.id, 'framework:nextjs');
      assert.deepStrictEqual(payload.moduleIds, ['framework-language']);
    }],
    ['delegates consult command', () => {
      const result = runCli(['consult', 'security', 'reviews', '--json']);
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = parseJson(result.stdout);
      assert.strictEqual(payload.schemaVersion, 'egc.consult.v1');
      assert.strictEqual(payload.matches[0].componentId, 'capability:security');
    }],
    ['delegates lifecycle commands', () => {
      const homeDir = createTempDir('egc-cli-home-');
      const projectRoot = createTempDir('egc-cli-project-');
      const result = runCli(['list-installed', '--json'], {
        cwd: projectRoot,
        env: { HOME: homeDir },
      });
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = parseJson(result.stdout);
      assert.deepStrictEqual(payload.records, []);
    }],
    ['delegates auto-update command', () => {
      const homeDir = createTempDir('egc-cli-home-');
      const projectRoot = createTempDir('egc-cli-project-');
      const result = runCli(['auto-update', '--dry-run', '--json'], {
        cwd: projectRoot,
        env: { HOME: homeDir },
      });
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = parseJson(result.stdout);
      assert.deepStrictEqual(payload.results, []);
    }],
    ['delegates session-inspect command', () => {
      const homeDir = createTempDir('egc-cli-home-');
      const sessionsDir = path.join(homeDir, '.gemini', 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionsDir, '2026-03-13-a1b2c3d4-session.tmp'),
        '# EGC Session\n\n**Branch:** feat/egc-cli\n'
      );

      const result = runCli(['session-inspect', 'egc:latest'], {
        env: { HOME: homeDir },
      });

      assert.strictEqual(result.status, 0, result.stderr);
      const payload = parseJson(result.stdout);
      assert.strictEqual(payload.adapterId, 'egc-history');
      assert.strictEqual(payload.workers[0].branch, 'feat/egc-cli');
    }],
    ['delegates loop-status command', () => {
      const homeDir = createTempDir('egc-cli-home-');
      const transcriptDir = path.join(homeDir, '.gemini', 'projects', '-tmp-egc');
      fs.mkdirSync(transcriptDir, { recursive: true });
      fs.writeFileSync(
        path.join(transcriptDir, 'session-loop.jsonl'),
        JSON.stringify({
          timestamp: '2026-04-30T09:00:00.000Z',
          sessionId: 'session-loop',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_loop',
                name: 'ScheduleWakeup',
                input: { delaySeconds: 300 },
              },
            ],
          },
        }) + '\n'
      );

      const result = runCli(['loop-status', '--home', homeDir, '--now', '2026-04-30T10:00:00.000Z', '--json']);

      assert.strictEqual(result.status, 0, result.stderr);
      const payload = parseJson(result.stdout);
      assert.strictEqual(payload.schemaVersion, 'egc.loop-status.v1');
      assert.strictEqual(payload.sessions[0].sessionId, 'session-loop');
    }],
    ['supports help for a subcommand', () => {
      const result = runCli(['help', 'repair']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage: node scripts\/repair\.js/);
    }],
    ['supports help for the auto-update subcommand', () => {
      const result = runCli(['help', 'auto-update']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage: node scripts\/auto-update\.js/);
    }],
    ['supports help for the catalog subcommand', () => {
      const result = runCli(['help', 'catalog']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /egc catalog show <component-id>/);
    }],
    ['supports help for the consult subcommand', () => {
      const result = runCli(['help', 'consult']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /node scripts\/consult\.js "security reviews"/);
    }],
    ['fails on unknown commands instead of treating them as installs', () => {
      const result = runCli(['bogus']);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Unknown command: bogus/);
    }],
    ['fails on unknown help subcommands', () => {
      const result = runCli(['help', 'bogus']);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Unknown command: bogus/);
    }],
  ];

  for (const [name, fn] of tests) {
    if (runTest(name, fn)) {
      passed += 1;
    } else {
      failed += 1;
    }
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
