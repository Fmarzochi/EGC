/**
 * Tests for scripts/lib/resolve-egc-root.js
 *
 * Covers the EGC root resolution fallback chain:
 *   1. GEMINI_PLUGIN_ROOT env var
 *   2. Standard install (~/.gemini/)
 *   3. Exact legacy plugin roots under ~/.gemini/plugins/
 *   4. Plugin cache auto-detection
 *   5. Fallback to ~/.gemini/
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CURRENT_PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
).version;

const { resolveEccRoot, INLINE_RESOLVE } = require('../../scripts/lib/resolve-egc-root');

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-root-test-'));
}

function setupStandardInstall(homeDir) {
  const claudeDir = path.join(homeDir, '.gemini');
  const scriptDir = path.join(claudeDir, 'scripts', 'lib');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, 'utils.js'), '// stub');
  return claudeDir;
}

function setupLegacyPluginInstall(homeDir, segments) {
  const legacyDir = path.join(homeDir, '.gemini', 'plugins', ...segments);
  const scriptDir = path.join(legacyDir, 'scripts', 'lib');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, 'utils.js'), '// stub');
  return legacyDir;
}
function setupPluginCache(homeDir, pluginSlug, orgName, version) {
  const cacheDir = path.join(
    homeDir, '.gemini', 'plugins', 'cache',
    pluginSlug, orgName, version
  );
  const scriptDir = path.join(cacheDir, 'scripts', 'lib');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, 'utils.js'), '// stub');
  return cacheDir;
}

function runTests() {
  console.log('\n=== Testing resolve-egc-root.js ===\n');

  let passed = 0;
  let failed = 0;

  // ─── Env Var Priority ───

  if (test('returns GEMINI_PLUGIN_ROOT when set', () => {
    const result = resolveEccRoot({ envRoot: '/custom/plugin/root' });
    assert.strictEqual(result, '/custom/plugin/root');
  })) passed++; else failed++;

  if (test('trims whitespace from GEMINI_PLUGIN_ROOT', () => {
    const result = resolveEccRoot({ envRoot: '  /trimmed/root  ' });
    assert.strictEqual(result, '/trimmed/root');
  })) passed++; else failed++;

  if (test('skips empty GEMINI_PLUGIN_ROOT', () => {
    const homeDir = createTempDir();
    try {
      setupStandardInstall(homeDir);
      const result = resolveEccRoot({ envRoot: '', homeDir });
      assert.strictEqual(result, path.join(homeDir, '.gemini'));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('skips whitespace-only GEMINI_PLUGIN_ROOT', () => {
    const homeDir = createTempDir();
    try {
      setupStandardInstall(homeDir);
      const result = resolveEccRoot({ envRoot: '   ', homeDir });
      assert.strictEqual(result, path.join(homeDir, '.gemini'));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ─── Standard Install ───

  if (test('finds standard install at ~/.gemini/', () => {
    const homeDir = createTempDir();
    try {
      setupStandardInstall(homeDir);
      const result = resolveEccRoot({ envRoot: '', homeDir });
      assert.strictEqual(result, path.join(homeDir, '.gemini'));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('finds current plugin install at ~/.gemini/plugins/egc', () => {
    const homeDir = createTempDir();
    try {
      const expected = setupLegacyPluginInstall(homeDir, ['egc']);
      const result = resolveEccRoot({ envRoot: '', homeDir });
      assert.strictEqual(result, expected);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('finds current plugin install at ~/.gemini/plugins/egc@egc', () => {
    const homeDir = createTempDir();
    try {
      const expected = setupLegacyPluginInstall(homeDir, ['egc@egc']);
      const result = resolveEccRoot({ envRoot: '', homeDir });
      assert.strictEqual(result, expected);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('finds exact legacy plugin install at ~/.gemini/plugins/everything-gemini', () => {
    const homeDir = createTempDir();
    try {
      const expected = setupLegacyPluginInstall(homeDir, ['everything-gemini']);
      const result = resolveEccRoot({ envRoot: '', homeDir });
      assert.strictEqual(result, expected);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('finds exact legacy plugin install at ~/.gemini/plugins/egc@egc', () => {
    const homeDir = createTempDir();
    try {
      const expected = setupLegacyPluginInstall(homeDir, ['egc@egc']);
      const result = resolveEccRoot({ envRoot: '', homeDir });
      assert.strictEqual(result, expected);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('finds marketplace current plugin install at ~/.gemini/plugins/marketplace/egc', () => {
    const homeDir = createTempDir();
    try {
      const expected = setupLegacyPluginInstall(homeDir, ['marketplace', 'egc']);
      const result = resolveEccRoot({ envRoot: '', homeDir });
      assert.strictEqual(result, expected);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('finds marketplace legacy plugin install at ~/.gemini/plugins/marketplace/everything-gemini', () => {
    const homeDir = createTempDir();
    try {
      const expected = setupLegacyPluginInstall(homeDir, ['marketplace', 'everything-gemini']);
      const result = resolveEccRoot({ envRoot: '', homeDir });
      assert.strictEqual(result, expected);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('prefers exact legacy plugin install over plugin cache', () => {
    const homeDir = createTempDir();
    try {
      const expected = setupLegacyPluginInstall(homeDir, ['marketplace', 'egc']);
      setupPluginCache(homeDir, 'egc', 'Fmarzochi', CURRENT_PACKAGE_VERSION);
      const result = resolveEccRoot({ envRoot: '', homeDir });
      assert.strictEqual(result, expected);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;
  // ─── Plugin Cache Auto-Detection ───

  if (test('discovers plugin root from cache directory', () => {
    const homeDir = createTempDir();
    try {
      const expected = setupPluginCache(homeDir, 'egc', 'Fmarzochi', CURRENT_PACKAGE_VERSION);
      const result = resolveEccRoot({ envRoot: '', homeDir });
      assert.strictEqual(result, expected);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('prefers standard install over plugin cache', () => {
    const homeDir = createTempDir();
    try {
      const claudeDir = setupStandardInstall(homeDir);
      setupPluginCache(homeDir, 'egc', 'Fmarzochi', CURRENT_PACKAGE_VERSION);
      const result = resolveEccRoot({ envRoot: '', homeDir });
      assert.strictEqual(result, claudeDir,
        'Standard install should take precedence over plugin cache');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('handles multiple versions in plugin cache', () => {
    const homeDir = createTempDir();
    try {
      setupPluginCache(homeDir, 'everything-gemini', 'legacy-org', '1.7.0');
      const expected = setupPluginCache(homeDir, 'egc', 'Fmarzochi', CURRENT_PACKAGE_VERSION);
      const result = resolveEccRoot({ envRoot: '', homeDir });
      // Should find one of them (either is valid)
      assert.ok(
        result === expected ||
        result === path.join(homeDir, '.gemini', 'plugins', 'cache', 'everything-gemini', 'legacy-org', '1.7.0'),
        'Should resolve to a valid plugin cache directory'
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ─── Fallback ───

  if (test('falls back to ~/.gemini/ when nothing is found', () => {
    const homeDir = createTempDir();
    try {
      fs.mkdirSync(path.join(homeDir, '.gemini'), { recursive: true });
      const result = resolveEccRoot({ envRoot: '', homeDir });
      assert.strictEqual(result, path.join(homeDir, '.gemini'));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('falls back gracefully when ~/.gemini/ does not exist', () => {
    const homeDir = createTempDir();
    try {
      const result = resolveEccRoot({ envRoot: '', homeDir });
      assert.strictEqual(result, path.join(homeDir, '.gemini'));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ─── Custom Probe ───

  if (test('supports custom probe path', () => {
    const homeDir = createTempDir();
    try {
      const claudeDir = path.join(homeDir, '.gemini');
      fs.mkdirSync(path.join(claudeDir, 'custom'), { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'custom', 'marker.js'), '// probe');
      const result = resolveEccRoot({
        envRoot: '',
        homeDir,
        probe: path.join('custom', 'marker.js'),
      });
      assert.strictEqual(result, claudeDir);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // ─── INLINE_RESOLVE ───

  if (test('INLINE_RESOLVE is a non-empty string', () => {
    assert.ok(typeof INLINE_RESOLVE === 'string');
    assert.ok(INLINE_RESOLVE.length > 50, 'Should be a substantial inline expression');
  })) passed++; else failed++;

  if (test('INLINE_RESOLVE returns GEMINI_PLUGIN_ROOT when set', () => {
    const { execFileSync } = require('child_process');
    const result = execFileSync('node', [
      '-e', `console.log(${INLINE_RESOLVE})`,
    ], {
      env: { ...process.env, GEMINI_PLUGIN_ROOT: '/inline/test/root' },
      encoding: 'utf8',
    }).trim();
    assert.strictEqual(result, '/inline/test/root');
  })) passed++; else failed++;

  if (test('INLINE_RESOLVE discovers exact legacy plugin root when env var is unset', () => {
    const homeDir = createTempDir();
    try {
      const expected = setupLegacyPluginInstall(homeDir, ['marketplace', 'egc']);
      const { execFileSync } = require('child_process');
      const result = execFileSync('node', [
        '-e', `console.log(${INLINE_RESOLVE})`,
      ], {
        env: { PATH: process.env.PATH, HOME: homeDir, USERPROFILE: homeDir },
        encoding: 'utf8',
      }).trim();
      assert.strictEqual(result, expected);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;
  if (test('INLINE_RESOLVE discovers plugin cache when env var is unset', () => {
    const homeDir = createTempDir();
    try {
      const expected = setupPluginCache(homeDir, 'egc', 'Fmarzochi', CURRENT_PACKAGE_VERSION);
      const { execFileSync } = require('child_process');
      const result = execFileSync('node', [
        '-e', `console.log(${INLINE_RESOLVE})`,
      ], {
        env: { PATH: process.env.PATH, HOME: homeDir, USERPROFILE: homeDir },
        encoding: 'utf8',
      }).trim();
      assert.strictEqual(result, expected);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('INLINE_RESOLVE falls back to ~/.gemini/ when nothing found', () => {
    const homeDir = createTempDir();
    try {
      const { execFileSync } = require('child_process');
      const result = execFileSync('node', [
        '-e', `console.log(${INLINE_RESOLVE})`,
      ], {
        env: { PATH: process.env.PATH, HOME: homeDir, USERPROFILE: homeDir },
        encoding: 'utf8',
      }).trim();
      assert.strictEqual(result, path.join(homeDir, '.gemini'));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
