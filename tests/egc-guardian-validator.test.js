'use strict';
/**
 * Tests for mcp/servers/egc-guardian/src/validator.ts (via the compiled build).
 *
 * Covers the dispatch-map allowlist introduced when the command validator was
 * refactored out of a single long switch: multica is not allowlisted, the
 * Windows read commands dir/where honor protected paths (the old switch let
 * them fall through unchecked), and the docker/gh/prisma guards block host
 * escapes, deletes and data-loss while leaving plain dev use alone.
 *
 * Run with: node tests/egc-guardian-validator.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(
  __dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'validator.js',
);

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

const { validateCommand } = require(buildPath);

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
const run = (name, fn) => { if (test(name, fn)) passed++; else failed++; };

console.log('\n=== Testing egc-guardian command validator ===\n');

const denied = [
  'multica issue list',                 // not in any allowlist
  'dir ~/.ssh',                          // Windows read command over protected path
  'docker run -v /:/host alpine',        // host mount escapes the sandbox
  'docker run --privileged x',           // privilege escalation
  'gh api -X DELETE /repos/x',           // destructive verb as option value
  'gh api --method DELETE',
  'prisma db execute --file x.sql',      // arbitrary SQL
  'prisma migrate reset',                // data loss
  'git push --force',
  'git push --force-with-lease',
  'rm -rf x',                            // always-denied destructive command
  'cat ~/.ssh/id_rsa',                   // protected file
];

const allowed = [
  'docker build .',
  'docker compose up',
  'gh pr list',
  'prisma generate',
  'npm install',
  'node -e code',
  'php -r code',
  'git status',
  'ls /tmp',
  'where mytool',
];

for (const cmd of denied) {
  run(`denies: ${cmd}`, () => {
    assert.strictEqual(validateCommand(cmd).allowed, false, `${cmd} should be denied`);
  });
}
for (const cmd of allowed) {
  run(`allows: ${cmd}`, () => {
    assert.strictEqual(validateCommand(cmd).allowed, true, `${cmd} should be allowed`);
  });
}

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
