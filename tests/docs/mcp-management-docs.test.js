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

test('token optimization guide keeps MCP disables in the tool and names the two EGC servers', () => {
  const source = read('docs/token-optimization.md');

  assert.ok(
    source.includes('EGC registers two local MCP servers in each tool it installs into, `egc-guardian` and `egc-memory`, and nothing else.'),
    'Token guide should name the two servers EGC registers and no other'
  );
  assert.ok(
    source.includes('Disable the servers you do not use in the tool\'s own MCP settings; each tool keeps its own list, and EGC never edits it.'),
    'Token guide should send MCP disables to the tool\'s own settings, not to EGC'
  );
  assert.ok(
    !source.includes('disabledMcpServers'),
    'Token guide should not tell users that a project setting disables runtime MCP servers'
  );
  assert.ok(
    !source.includes('EGC_DISABLED_MCPS'),
    'Token guide should not document an EGC filter that does not exist'
  );
});

test('README MCP guidance avoids settings.json disable instructions', () => {
  const source = read('README.md');

  assert.ok(
    source.includes('registers the two local MCP servers in each of them'),
    'README should say EGC registers its two local MCP servers and no other'
  );
  assert.ok(
    !source.includes('EGC_DISABLED_MCPS'),
    'README should not document an EGC filter that does not exist'
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
