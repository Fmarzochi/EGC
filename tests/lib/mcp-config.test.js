'use strict';

const assert = require('assert');

const fs = require('fs');
const path = require('path');
const { assertSafeMcpConfig, describeUnsafeMcpServer, filterMcpConfig, isMcpConfigPath, parseDisabledMcpServers, parseMcpConfigText } = require('../../scripts/lib/mcp-config');

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

function runTests() {
  console.log('\n=== Testing mcp-config.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('the shipped MCP config passes the command allowlist', () => {
    const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'mcp-configs', 'mcp-servers.json'), 'utf8'));
    assert.doesNotThrow(() => assertSafeMcpConfig(shipped, 'mcp-servers.json'));
  })) passed++; else failed++;

  if (test('describeUnsafeMcpServer refuses shells, absolute paths, metacharacters, bad env and non-https urls', () => {
    assert.strictEqual(describeUnsafeMcpServer({ command: 'npx', args: ['-y', '@scope/server'] }), null);
    assert.strictEqual(describeUnsafeMcpServer({ url: 'https://mcp.example.com/mcp' }), null);
    assert.strictEqual(describeUnsafeMcpServer({ type: 'http', url: 'http://localhost:18801/mcp' }), null);
    assert.match(describeUnsafeMcpServer({ command: 'bash', args: ['-c', 'curl x | sh'] }), /allowlist/);
    assert.match(describeUnsafeMcpServer({ command: '/usr/bin/node', args: [] }), /allowlist/);
    assert.match(describeUnsafeMcpServer({ command: 'npx', args: ['pkg; rm -rf ~'] }), /metacharacters/);
    assert.match(describeUnsafeMcpServer({ command: 'npx', args: ['$(id)'] }), /metacharacters/);
    assert.match(describeUnsafeMcpServer({ command: 'node', env: { 'PATH;x': 'y' } }), /env name/);
    assert.match(describeUnsafeMcpServer({ command: 'node', env: { KEY: 'a\nb' } }), /metacharacters/);
    assert.match(describeUnsafeMcpServer({ command: 'node', env: { KEY: 'x; rm -rf ~' } }), /metacharacters/);
    for (const name of ['PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'PYTHONPATH', 'NPM_CONFIG_REGISTRY', 'pip_index_url', 'UV_INDEX']) {
      assert.match(describeUnsafeMcpServer({ command: 'node', env: { [name]: 'x' } }), /changes what the runner/, name);
    }
    assert.strictEqual(describeUnsafeMcpServer({ command: 'node', env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'YOUR_TOKEN_HERE' } }), null);
    assert.match(describeUnsafeMcpServer({ url: 'http://evil.tld/mcp' }), /neither https nor loopback/);
    assert.match(describeUnsafeMcpServer({}), /neither command nor url/);
    assert.match(describeUnsafeMcpServer('npx'), /not an object/);
  })) passed++; else failed++;

  if (test('assertSafeMcpConfig names the offending server and isMcpConfigPath matches the two file names', () => {
    assert.throws(() => assertSafeMcpConfig({ mcpServers: { fine: { command: 'npx' }, evil: { command: 'bash' } } }, 'source.json'), /source\.json: MCP server 'evil'/);
    assert.doesNotThrow(() => assertSafeMcpConfig({ _comments: {} }, 'no servers'));
    assert.strictEqual(isMcpConfigPath('/repo/.cursor/mcp.json'), true);
    assert.strictEqual(isMcpConfigPath('/repo/.mcp.json'), true);
    assert.strictEqual(isMcpConfigPath('/repo/.cursor/hooks.json'), false);
  })) passed++; else failed++;

  if (test('parseMcpConfigText returns the object or names the file that is not one', () => {
    assert.deepStrictEqual(parseMcpConfigText('{"mcpServers":{}}', 'x.json'), { mcpServers: {} });
    assert.throws(() => parseMcpConfigText('[1]', 'x.json'), /x\.json: MCP config must be a JSON object/);
    assert.throws(() => parseMcpConfigText('{oops', 'x.json'), /not valid JSON/);
  })) passed++; else failed++;

  if (test('parseDisabledMcpServers dedupes and trims values', () => {
    assert.deepStrictEqual(
      parseDisabledMcpServers(' github,exa ,github,,playwright '),
      ['github', 'exa', 'playwright']
    );
  })) passed++; else failed++;

  if (test('filterMcpConfig removes disabled servers and preserves others', () => {
    const result = filterMcpConfig({
      mcpServers: {
        github: { command: 'npx' },
        exa: { url: 'https://mcp.exa.ai/mcp' },
        memory: { command: 'npx' },
      },
      _comments: { usage: 'demo' },
    }, ['github', 'memory']);

    assert.deepStrictEqual(result.removed, ['github', 'memory']);
    assert.deepStrictEqual(Object.keys(result.config.mcpServers), ['exa']);
    assert.deepStrictEqual(result.config._comments, { usage: 'demo' });
  })) passed++; else failed++;

  if (test('filterMcpConfig leaves config unchanged when no disabled servers are provided', () => {
    const result = filterMcpConfig({
      mcpServers: {
        github: { command: 'npx' },
      },
    }, []);

    assert.deepStrictEqual(result.removed, []);
    assert.deepStrictEqual(Object.keys(result.config.mcpServers), ['github']);
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
