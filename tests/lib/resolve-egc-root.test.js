/**
 * Tests for scripts/lib/resolve-egc-root.js
 *
 * Every scenario runs twice: through resolveEGCRoot() and through the inline
 * copy that commands and hooks/hooks.json embed, so the two cannot drift.
 * Resolution order:
 *   1. EGC_PLUGIN_ROOT / ECC_PLUGIN_ROOT / GEMINI_PLUGIN_ROOT (set by EGC's own runners)
 *   2. CLAUDE_PLUGIN_ROOT, EGC_DIR, then the directory of the tool in use, when they hold the probe
 *   3. The Claude Code plugin under ~/.claude/plugins, then its marketplace cache
 *   4. The npm package, found from the egc executable on PATH
 *   5. The tool directories EGC installs its scripts into
 *   6. Fallback to ~/.egc
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { resolveEGCRoot, resolveEccRoot, INLINE_RESOLVE, INLINE_RESOLVE_FN } = require('../../scripts/lib/resolve-egc-root');

const UTILS_PROBE = path.join('scripts', 'lib', 'utils.js');
const HEALTH_PROBE = path.join('scripts', 'skills-health.js');

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

function withTempDir(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'egc-root-test-')));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withScripts(dir, probes = [UTILS_PROBE]) {
  for (const probe of probes) {
    fs.mkdirSync(path.dirname(path.join(dir, probe)), { recursive: true });
    fs.writeFileSync(path.join(dir, probe), '// stub');
  }
  return dir;
}

function packageOnPath(base, probes = [UTILS_PROBE]) {
  const root = withScripts(path.join(base, 'npm', 'lib', 'node_modules', '@egchq', 'egc'), [...probes, path.join('scripts', 'egc.js')]);
  const binDir = path.join(base, 'npm', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(path.join(root, 'scripts', 'egc.js'), path.join(binDir, 'egc'));
  return { root, binDir };
}

function runInline(home, env, probe) {
  return execFileSync(process.execPath, ['-e', `console.log(${INLINE_RESOLVE_FN}(${JSON.stringify(probe)}))`], {
    env: { HOME: home, USERPROFILE: home, PATH: '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...env },
    encoding: 'utf8',
  }).trim();
}

function resolvesTo(home, env, expected, probe = UTILS_PROBE) {
  assert.strictEqual(resolveEGCRoot({ homeDir: home, env, probe }), expected, 'module');
  assert.strictEqual(runInline(home, env, probe), expected, 'inline');
}

function explicitRootCases() {
  return [
    test('EGC_PLUGIN_ROOT counts when it holds EGC scripts, trimmed', () => withTempDir(home => {
      const custom = withScripts(path.join(home, 'custom'));
      withScripts(path.join(home, '.claude'));
      resolvesTo(home, { EGC_PLUGIN_ROOT: `  ${custom}  `, CLAUDECODE: '1' }, custom);
    })),
    test('GEMINI_PLUGIN_ROOT, which EGC runners set for their children, counts when it holds EGC scripts', () => withTempDir(home => {
      const runner = withScripts(path.join(home, 'runner'));
      resolvesTo(home, { GEMINI_PLUGIN_ROOT: runner }, runner);
    })),
    test('an explicit root without the requested script falls through to one that has it', () => withTempDir(home => {
      const runner = withScripts(path.join(home, 'runner'));
      const prefix = path.join(home, 'prefix');
      const root = withScripts(path.join(prefix, 'node_modules', '@egchq', 'egc'), [UTILS_PROBE, HEALTH_PROBE]);
      resolvesTo(home, { GEMINI_PLUGIN_ROOT: runner, PATH: prefix }, root, HEALTH_PROBE);
    })),
    test('an empty or blank explicit root is skipped', () => withTempDir(home => {
      const claude = withScripts(path.join(home, '.claude'));
      resolvesTo(home, { EGC_PLUGIN_ROOT: '   ', CLAUDECODE: '1' }, claude);
    })),
    test('CLAUDE_PLUGIN_ROOT counts only when it holds EGC scripts', () => withTempDir(home => {
      const plugin = withScripts(path.join(home, 'plugin'));
      resolvesTo(home, { CLAUDE_PLUGIN_ROOT: plugin }, plugin);
      resolvesTo(home, { CLAUDE_PLUGIN_ROOT: path.join(home, 'another-plugin') }, path.join(home, '.egc'));
    })),
    test('EGC_DIR counts when it holds EGC scripts', () => withTempDir(home => {
      const chosen = withScripts(path.join(home, 'chosen'));
      withScripts(path.join(home, '.claude'));
      resolvesTo(home, { EGC_DIR: chosen, CLAUDECODE: '1' }, chosen);
    })),
  ];
}

function toolInUseCases() {
  return [
    test('the Claude Code shell finds ~/.claude before any other tool directory', () => withTempDir(home => {
      const claude = withScripts(path.join(home, '.claude'));
      withScripts(path.join(home, '.gemini'));
      resolvesTo(home, { CLAUDECODE: '1' }, claude);
    })),
    test('Antigravity hooks find ~/.gemini', () => withTempDir(home => {
      withScripts(path.join(home, '.claude'));
      const gemini = withScripts(path.join(home, '.gemini'));
      resolvesTo(home, { GEMINI_PROJECT_DIR: '/work' }, gemini);
    })),
    test('the tool in use comes before the npm package', () => withTempDir(home => {
      const claude = withScripts(path.join(home, '.claude'));
      const { binDir } = packageOnPath(home);
      resolvesTo(home, { CLAUDECODE: '1', PATH: binDir }, claude);
    })),
    test('a probe the tool directory lacks is found in the npm package', () => withTempDir(home => {
      withScripts(path.join(home, '.claude'));
      const { root, binDir } = packageOnPath(home, [UTILS_PROBE, HEALTH_PROBE]);
      resolvesTo(home, { CLAUDECODE: '1', PATH: binDir }, root, HEALTH_PROBE);
    })),
  ];
}

function pluginCases() {
  return [
    ...[['egc'], ['egc@egc'], ['marketplace', 'egc']].map(segments =>
      test(`finds the Claude Code plugin at ~/.claude/plugins/${segments.join('/')}`, () => withTempDir(home => {
        const plugin = withScripts(path.join(home, '.claude', 'plugins', ...segments));
        resolvesTo(home, {}, plugin);
      }))),
    test('finds the Claude Code marketplace cache', () => withTempDir(home => {
      const cached = withScripts(path.join(home, '.claude', 'plugins', 'cache', 'egc', 'egc', '1.1.22'));
      resolvesTo(home, {}, cached);
    })),
    test('an installed plugin comes before the cache', () => withTempDir(home => {
      const plugin = withScripts(path.join(home, '.claude', 'plugins', 'marketplace', 'egc'));
      withScripts(path.join(home, '.claude', 'plugins', 'cache', 'egc', 'egc', '1.1.22'));
      resolvesTo(home, {}, plugin);
    })),
    ...[['everything-gemini'], ['everything-gemini@everything-gemini'], ['marketplace', 'everything-gemini']].map(segments =>
      test(`keeps the legacy identifier resolvable at ~/.claude/plugins/${segments.join('/')} (docs/spec compatibility commitment)`, () => withTempDir(home => {
        const plugin = withScripts(path.join(home, '.claude', 'plugins', ...segments));
        resolvesTo(home, {}, plugin);
      }))),
    test('finds the legacy marketplace cache even when the current one is absent', () => withTempDir(home => {
      const cached = withScripts(path.join(home, '.claude', 'plugins', 'cache', 'everything-gemini', 'everything-gemini', '1.0.0'));
      resolvesTo(home, {}, cached);
    })),
    test('the retired Gemini CLI plugin tree is not searched', () => withTempDir(home => {
      withScripts(path.join(home, '.gemini', 'plugins', 'everything-gemini'));
      resolvesTo(home, {}, path.join(home, '.egc'));
    })),
  ];
}

function packageCases() {
  const cases = [
    test('finds the npm package through node_modules next to a PATH entry (Windows layout)', () => withTempDir(home => {
      const prefix = path.join(home, 'prefix');
      const root = withScripts(path.join(prefix, 'node_modules', '@egchq', 'egc'));
      resolvesTo(home, { PATH: prefix }, root);
    })),
  ];
  if (process.platform !== 'win32') {
    cases.push(
      test('finds the npm package through the egc executable on PATH', () => withTempDir(home => {
        const { root, binDir } = packageOnPath(home);
        resolvesTo(home, { PATH: binDir }, root);
      })),
      test('with no tool in use, the npm package comes before the tool directories', () => withTempDir(home => {
        withScripts(path.join(home, '.gemini'));
        const { root, binDir } = packageOnPath(home);
        resolvesTo(home, { PATH: binDir }, root);
      })),
    );
  }
  return cases;
}

function fallbackCases() {
  return [
    test('with nothing else, the first tool directory holding the scripts', () => withTempDir(home => {
      const windsurf = withScripts(path.join(home, '.codeium', 'windsurf'));
      resolvesTo(home, {}, windsurf);
    })),
    test('the tool directories scanned are every one getEGCDir() knows', () => withTempDir(home => {
      const kiro = withScripts(path.join(home, '.kiro'));
      resolvesTo(home, {}, kiro);
    })),
    test('with nothing at all, ~/.egc', () => withTempDir(home => {
      resolvesTo(home, {}, path.join(home, '.egc'));
    })),
    test('resolveEccRoot stays an alias', () => withTempDir(home => {
      const claude = withScripts(path.join(home, '.claude'));
      assert.strictEqual(resolveEccRoot({ homeDir: home, env: { CLAUDECODE: '1' } }), claude);
    })),
  ];
}

function inlineShapeCases() {
  return [
    test('INLINE_RESOLVE is the inline function applied to scripts/lib/utils.js', () => {
      assert.strictEqual(INLINE_RESOLVE, `${INLINE_RESOLVE_FN}('scripts/lib/utils.js')`);
    }),
    test('the inline copy embeds unchanged in a double-quoted shell string and in JSON', () => {
      for (const character of ['"', '$', '`', '!', '%', '\\', '\n']) {
        assert.ok(!INLINE_RESOLVE_FN.includes(character), `must not contain ${JSON.stringify(character)}`);
      }
    }),
  ];
}

function runTests() {
  console.log('\n=== Testing resolve-egc-root.js ===\n');
  const results = [
    ...explicitRootCases(),
    ...toolInUseCases(),
    ...pluginCases(),
    ...packageCases(),
    ...fallbackCases(),
    ...inlineShapeCases(),
  ];
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
