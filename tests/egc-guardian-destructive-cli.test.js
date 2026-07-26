'use strict';
/**
 * Tests the destructive-CLI hard blocks in validateCommand: docker/gh/prisma
 * data-destroying variants must return a DANGEROUS (blocking) verdict, while
 * their benign forms keep the advisory allowlist-miss verdict so the
 * enforcement hook does not block them.
 *
 * Run with: node tests/egc-guardian-destructive-cli.test.js
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

// The hook only blocks verdicts whose reason is outside its advisory list,
// so a hard block must be allowed:false, DANGEROUS, and not an
// allowlist-miss reason.
function assertHardBlocked(command) {
  const v = validateCommand(command);
  assert.strictEqual(v.allowed, false, `${command} should be denied`);
  assert.strictEqual(v.trust_level, 'DANGEROUS', `${command} should be DANGEROUS, got ${v.trust_level}`);
  assert.ok(!v.reason.includes('is not in the allowlist'), `${command} must not fall through to the advisory allowlist miss`);
}

// Benign forms keep today's behavior: denied only by the advisory
// allowlist miss, which the enforcement hook never blocks on.
function assertAdvisoryOnly(command) {
  const v = validateCommand(command);
  assert.strictEqual(v.allowed, false, `${command} stays outside the allowlist`);
  assert.ok(v.reason.includes('is not in the allowlist'), `${command} should be an advisory allowlist miss, got: ${v.reason}`);
}

console.log('\n=== Testing egc-guardian destructive CLI hard blocks ===\n');

// docker: data destruction
run('docker system prune -af is hard-blocked', () => assertHardBlocked('docker system prune -af'));
run('docker rm container is hard-blocked', () => assertHardBlocked('docker rm my-container'));
run('docker rmi image is hard-blocked', () => assertHardBlocked('docker rmi my-image'));
run('docker volume prune is hard-blocked', () => assertHardBlocked('docker volume prune'));
run('docker compose down -v is hard-blocked', () => assertHardBlocked('docker compose down -v'));
run('docker-compose down --volumes is hard-blocked', () => assertHardBlocked('docker-compose down --volumes'));

// docker: sandbox escape
run('docker run --privileged is hard-blocked', () => assertHardBlocked('docker run --privileged img'));
run('docker run with host mount is hard-blocked', () => assertHardBlocked('docker run -v /:/host img'));
run('docker run --mount= is hard-blocked', () => assertHardBlocked('docker run --mount=type=bind,src=/,dst=/host img'));
run('docker create --cap-add is hard-blocked', () => assertHardBlocked('docker create --cap-add SYS_ADMIN img'));
run('/usr/bin/docker rm resolves by basename and is hard-blocked', () => assertHardBlocked('/usr/bin/docker rm c1'));

// gh: deletions in any spelling
run('gh repo delete is hard-blocked', () => assertHardBlocked('gh repo delete owner/repo --yes'));
run('gh api -X DELETE is hard-blocked', () => assertHardBlocked('gh api -X DELETE repos/o/r'));
run('gh api --method=delete is hard-blocked', () => assertHardBlocked('gh api --method=delete repos/o/r'));
run('gh release delete is hard-blocked', () => assertHardBlocked('gh release delete v1.0.0'));

// prisma: data loss
run('prisma migrate reset is hard-blocked', () => assertHardBlocked('prisma migrate reset'));
run('prisma db push --force-reset is hard-blocked', () => assertHardBlocked('prisma db push --force-reset'));
run('prisma db push --accept-data-loss is hard-blocked', () => assertHardBlocked('prisma db push --accept-data-loss'));
run('prisma db execute is hard-blocked', () => assertHardBlocked('prisma db execute --file drop.sql'));

// Benign forms stay advisory: the hook keeps letting them run.
run('docker ps stays advisory', () => assertAdvisoryOnly('docker ps'));
run('docker build stays advisory', () => assertAdvisoryOnly('docker build -t img .'));
run('docker compose up stays advisory', () => assertAdvisoryOnly('docker compose up -d'));
run('docker run without mounts stays advisory', () => assertAdvisoryOnly('docker run img'));
run('gh pr list stays advisory', () => assertAdvisoryOnly('gh pr list'));
run('gh api GET stays advisory', () => assertAdvisoryOnly('gh api repos/o/r'));
run('prisma migrate dev stays advisory', () => assertAdvisoryOnly('prisma migrate dev'));
run('prisma generate stays advisory', () => assertAdvisoryOnly('prisma generate'));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
