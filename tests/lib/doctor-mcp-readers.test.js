'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { READERS } = require('../../scripts/lib/doctor-mcp');
const { buildMcpRegistrationTargets } = require('../../scripts/lib/mcp-register');

const AMP_SETTINGS = JSON.stringify({
  'amp.mcpServers': {
    'egc-guardian': { command: 'node', args: ['/x/guardian/build/index.js'] },
    'egc-memory': { command: 'node', args: ['/x/memory/build/index.js'] },
  },
});

const GOOSE_YAML = [
  'extensions:',
  '  - name: egc-guardian',
  '    enabled: true',
  '    transport:',
  '      type: stdio',
  '      command: node',
  '      args:',
  '        - /x/guardian/build/index.js',
  '  - name: egc-memory',
  '    enabled: true',
  '    transport:',
  '      type: stdio',
  '      command: node',
  '      args:',
  '        - /x/memory/build/index.js',
  '',
].join('\n');

test('the amp-settings reader finds both EGC servers under the amp.mcpServers key', () => {
  const servers = READERS['amp-settings']('settings.json', AMP_SETTINGS);
  assert.ok(servers['egc-guardian'], 'egc-guardian is found');
  assert.ok(servers['egc-memory'], 'egc-memory is found');
  assert.equal(servers['egc-guardian'].bin, '/x/guardian/build/index.js');
});

test('the goose-yaml reader finds both EGC servers in the extensions list', () => {
  const servers = READERS['goose-yaml']('config.yaml', GOOSE_YAML);
  assert.ok(servers['egc-guardian'], 'egc-guardian is found');
  assert.ok(servers['egc-memory'], 'egc-memory is found');
  assert.equal(servers['egc-memory'].bin, '/x/memory/build/index.js');
});

test('the amp-settings reader reports neither server when the key is empty', () => {
  const servers = READERS['amp-settings']('settings.json', JSON.stringify({ 'amp.mcpServers': {} }));
  assert.equal(Object.hasOwn(servers, 'egc-guardian'), false);
  assert.equal(Object.hasOwn(servers, 'egc-memory'), false);
});

test('every MCP registration target format has a doctor reader', () => {
  const formats = new Set(buildMcpRegistrationTargets(os.homedir()).map(target => target.format));
  for (const format of formats) {
    assert.ok(READERS[format], `no reader for the ${format} format`);
  }
});
