'use strict';

const assert = require('assert');
const { maybeSkipBaselineAbsent } = require('../lib/baseline-absent');

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (error) {
    if (maybeSkipBaselineAbsent(error, name)) return true;
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

console.log('\n=== Testing MCP management docs ===\n');

test('token optimization guide separates Gemini MCP disables from EGC config filters', () => {
  const source = read('docs/guides/token-optimization.md');

  assert.ok(
    source.includes('Use `/mcp` to disable Gemini Code MCP servers'),
    'Token guide should direct Gemini Code users to /mcp for runtime MCP disables'
  );
  assert.ok(
    source.includes('Gemini Code persists those runtime disables in `~/.gemini.json`'),
    'Token guide should name ~/.gemini.json as the observed runtime disable store'
  );
  assert.ok(
    source.includes('`EGC_DISABLED_MCPS` only affects EGC-generated MCP config output'),
    'Token guide should scope EGC_DISABLED_MCPS to config generation'
  );
  assert.ok(
    !source.includes('Use `disabledMcpServers` in project config to disable servers per-project'),
    'Token guide should not tell users that project settings disable Gemini runtime MCP servers'
  );
});

test('token optimization overview points at the guide and scopes EGC_DISABLED_MCPS to install time', () => {
  const source = read('docs/token-optimization.md');

  assert.ok(
    source.includes('[guide](guides/token-optimization.md)'),
    'Token overview should link to the guide instead of repeating it'
  );
  assert.ok(
    source.includes('`EGC_DISABLED_MCPS` filters the EGC entries the installer and the Codex merge write; it never touches a server the tool loaded at runtime.'),
    'Token overview should scope EGC_DISABLED_MCPS to install and sync time'
  );
  assert.ok(
    !source.includes('disabledMcpServers'),
    'Token overview should not tell users that a project setting disables runtime MCP servers'
  );
});

test('README MCP guidance avoids settings.json disable instructions', () => {
  const source = read('README.md');

  assert.ok(
    source.includes('registers the two local MCP servers in each of them'),
    'README should say EGC registers its two local MCP servers and no other'
  );
  assert.ok(
    !source.includes('`EGC_DISABLED_MCPS` is a live'),
    'README should not present EGC_DISABLED_MCPS as a live runtime toggle'
  );
  assert.ok(
    !source.includes('// In your project\'s .gemini/settings.json\n{\n  "disabledMcpServers"'),
    'README should not show disabledMcpServers under .gemini/settings.json'
  );
  assert.ok(
    !source.includes('Use `disabledMcpServers` in project config to disable unused ones'),
    'README quick reference should not repeat stale project-config guidance'
  );
});

if (failed > 0) {
  console.log(`\nFailed: ${failed}`);
  process.exit(1);
}

console.log(`\nPassed: ${passed}`);
