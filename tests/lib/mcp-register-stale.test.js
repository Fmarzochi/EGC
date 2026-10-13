/**
 * Tests for the refresh of stale script paths in registered MCP servers.
 *
 * Run with: node tests/lib/mcp-register-stale.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  registerJson,
  registerToml,
  registerZedContextServers,
  registerOpenCodeMcp,
  registerCrushMcp,
} = require('../../scripts/lib/mcp-register');
const { isStaleScript } = require('../../scripts/lib/mcp-register-stale');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-register-stale-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeBins(dir) {
  const guardianBin = path.join(dir, 'current', 'egc-guardian', 'index.js');
  const memoryBin = path.join(dir, 'current', 'egc-memory', 'index.js');
  for (const bin of [guardianBin, memoryBin]) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '');
  }
  return { guardianBin, memoryBin };
}

const GONE_GUARDIAN = path.join(os.tmpdir(), 'wt-gone', 'egc-guardian', 'index.js');
const GONE_MEMORY = path.join(os.tmpdir(), 'wt-gone', 'egc-memory', 'index.js');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function run() {
  let passed = 0;
  let failed = 0;
  const tally = ok => { if (ok) passed++; else failed++; };

  tally(test('isStaleScript is true only for an absolute script path that is gone and not the current one', () => withTempDir(dir => {
    const { guardianBin } = makeBins(dir);
    assert.strictEqual(isStaleScript(GONE_GUARDIAN, guardianBin), true);
    assert.strictEqual(isStaleScript(guardianBin, guardianBin), false);
    assert.strictEqual(isStaleScript(path.join(dir, 'current', 'egc-memory', 'index.js'), guardianBin), false);
    assert.strictEqual(isStaleScript('node', guardianBin), false);
    assert.strictEqual(isStaleScript('--flag', guardianBin), false);
    assert.strictEqual(isStaleScript(path.join(dir, 'nowhere', 'readme.md'), guardianBin), false);
  })));

  tally(test('registerJson rewrites only the stale path and keeps every other key', () => withTempDir(dir => {
    const bins = makeBins(dir);
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, JSON.stringify({
      theme: 'dark',
      mcpServers: {
        'egc-guardian': { command: 'node', args: [GONE_GUARDIAN, '--keep'], env: { A: '1' } },
        'egc-memory': { command: 'node', args: [GONE_MEMORY] },
        other: { command: 'x', args: ['/never/exists.js'] },
      },
    }));
    assert.strictEqual(registerJson(file, bins), true);
    const after = JSON.parse(read(file));
    assert.deepStrictEqual(after.mcpServers['egc-guardian'], { command: 'node', args: [bins.guardianBin, '--keep'], env: { A: '1' } });
    assert.deepStrictEqual(after.mcpServers['egc-memory'].args, [bins.memoryBin]);
    assert.deepStrictEqual(after.mcpServers.other.args, ['/never/exists.js']);
    assert.strictEqual(after.theme, 'dark');
    assert.strictEqual(registerJson(file, bins), false);
  })));

  tally(test('registerJson leaves a registration that points at another existing install', () => withTempDir(dir => {
    const bins = makeBins(dir);
    const other = path.join(dir, 'other-install.js');
    fs.writeFileSync(other, '');
    const file = path.join(dir, 'mcp.json');
    const original = JSON.stringify({
      mcpServers: {
        'egc-guardian': { command: 'node', args: [other] },
        'egc-memory': { command: 'node', args: [other] },
      },
    }, null, 2) + '\n';
    fs.writeFileSync(file, original);
    assert.strictEqual(registerJson(file, bins), false);
    assert.strictEqual(read(file), original);
  })));

  tally(test('registerOpenCodeMcp rewrites the stale path inside the command list', () => withTempDir(dir => {
    const bins = makeBins(dir);
    const file = path.join(dir, 'opencode.json');
    fs.writeFileSync(file, JSON.stringify({
      mcp: {
        'egc-guardian': { type: 'local', command: ['node', GONE_GUARDIAN] },
        'egc-memory': { type: 'local', command: ['node', GONE_MEMORY], enabled: false },
      },
    }));
    assert.strictEqual(registerOpenCodeMcp(file, bins), true);
    const after = JSON.parse(read(file));
    assert.deepStrictEqual(after.mcp['egc-guardian'].command, ['node', bins.guardianBin]);
    assert.deepStrictEqual(after.mcp['egc-memory'], { type: 'local', command: ['node', bins.memoryBin], enabled: false });
  })));

  tally(test('registerCrushMcp rewrites the stale path inside args', () => withTempDir(dir => {
    const bins = makeBins(dir);
    const file = path.join(dir, 'crush.json');
    fs.writeFileSync(file, JSON.stringify({
      mcp: {
        'egc-guardian': { type: 'stdio', command: 'node', args: [GONE_GUARDIAN] },
        'egc-memory': { type: 'stdio', command: 'node', args: [bins.memoryBin] },
      },
    }));
    assert.strictEqual(registerCrushMcp(file, bins), true);
    const after = JSON.parse(read(file));
    assert.deepStrictEqual(after.mcp['egc-guardian'].args, [bins.guardianBin]);
    assert.strictEqual(registerCrushMcp(file, bins), false);
  })));

  tally(test('registerZedContextServers rewrites the stale path and keeps the settings', () => withTempDir(dir => {
    const bins = makeBins(dir);
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      vim_mode: true,
      context_servers: {
        'egc-guardian': { command: 'node', args: [GONE_GUARDIAN] },
        'egc-memory': { command: 'node', args: [GONE_MEMORY] },
      },
    }));
    assert.strictEqual(registerZedContextServers(file, bins), true);
    const after = JSON.parse(read(file));
    assert.deepStrictEqual(after.context_servers['egc-guardian'].args, [bins.guardianBin]);
    assert.deepStrictEqual(after.context_servers['egc-memory'].args, [bins.memoryBin]);
    assert.strictEqual(after.vim_mode, true);
  })));

  tally(test('registerToml per-server rewrites only the stale path and leaves the rest of the text', () => withTempDir(dir => {
    const bins = makeBins(dir);
    const file = path.join(dir, 'config.toml');
    const text = [
      '# my codex settings',
      'model = "gpt"',
      '',
      '[mcp_servers.egc-guardian]',
      'command = "node"',
      `args = ["${GONE_GUARDIAN}"]`,
      '',
      '[mcp_servers.egc-memory]',
      'command = "node"',
      `args = ["${bins.memoryBin}"]`,
      '',
    ].join('\n');
    fs.writeFileSync(file, text);
    assert.strictEqual(registerToml(file, bins, { tomlTables: 'per-server' }), true);
    assert.strictEqual(read(file), text.replace(GONE_GUARDIAN, bins.guardianBin));
    assert.strictEqual(registerToml(file, bins, { tomlTables: 'per-server' }), false);
  })));

  tally(test('registerToml with [[mcp_servers]] tables rewrites the stale path', () => withTempDir(dir => {
    const bins = makeBins(dir);
    const file = path.join(dir, 'config.toml');
    const text = [
      '[[mcp_servers]]',
      'name = "egc-guardian"',
      'command = "node"',
      `args = ["${bins.guardianBin}"]`,
      '',
      '[[mcp_servers]]',
      'name = "egc-memory"',
      'command = "node"',
      `args = ["${GONE_MEMORY}"]`,
      '',
    ].join('\n');
    fs.writeFileSync(file, text);
    assert.strictEqual(registerToml(file, bins), true);
    assert.strictEqual(read(file), text.replace(GONE_MEMORY, bins.memoryBin));
  })));

  tally(test('registerToml refreshes a stale path while appending the server that is missing', () => withTempDir(dir => {
    const bins = makeBins(dir);
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, [
      '[mcp_servers.egc-guardian]',
      'command = "node"',
      `args = ["${GONE_GUARDIAN}"]`,
      '',
    ].join('\n'));
    assert.strictEqual(registerToml(file, bins, { tomlTables: 'per-server' }), true);
    const written = read(file);
    assert.ok(written.includes(bins.guardianBin), written);
    assert.ok(written.includes(bins.memoryBin), written);
    assert.ok(!written.includes(GONE_GUARDIAN), written);
  })));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
