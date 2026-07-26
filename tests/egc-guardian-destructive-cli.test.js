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

// Bypass spellings from the adversarial audit: quoting, escapes, bundled
// and glued short flags, method gluing, value suffixes, package runners.
run('docker system "prune" (quoted) is hard-blocked', () => assertHardBlocked('docker system "prune"'));
run("gh repo 'delete' o/r (quoted) is hard-blocked", () => assertHardBlocked("gh repo 'delete' owner/repo"));
run('prisma migrate \\reset (escaped) is hard-blocked', () => assertHardBlocked('prisma migrate \\reset'));
run('docker run -itv /:/host (bundled) is hard-blocked', () => assertHardBlocked('docker run -itv /:/host img'));
run('docker run -v/:/host (glued) is hard-blocked', () => assertHardBlocked('docker run -v/:/host img'));
run('docker run -e FOO -v /:/host (value flag) is hard-blocked', () => assertHardBlocked('docker run -e FOO -v /:/host img'));
run('gh api -XDELETE (glued) is hard-blocked', () => assertHardBlocked('gh api -XDELETE repos/o/r'));
run('gh api --method DELETE is hard-blocked', () => assertHardBlocked('gh api --method DELETE repos/o/r'));
run('prisma db push --force-reset=true is hard-blocked', () => assertHardBlocked('prisma db push --force-reset=true'));
run('docker compose down --volumes=true is hard-blocked', () => assertHardBlocked('docker compose down --volumes=true'));
run('npx prisma migrate reset is hard-blocked', () => assertHardBlocked('npx prisma migrate reset'));
run('npx -y prisma@5 db execute unwraps and is hard-blocked', () => assertHardBlocked('npx -y prisma@5 db execute --file x.sql'));
run('pnpm dlx prisma migrate reset is hard-blocked', () => assertHardBlocked('pnpm dlx prisma migrate reset'));

// yarn is outside the allowlist, so the wrapped destructive form must be
// the DANGEROUS verdict, not the advisory allowlist miss.
run('yarn prisma migrate reset is hard-blocked', () => assertHardBlocked('yarn prisma migrate reset'));

// False positives from the adversarial audit: all must keep today's
// advisory (or allowed) behavior.
run('docker run alpine rm -rf /tmp/foo stays advisory (rm runs inside the container)', () => assertAdvisoryOnly('docker run alpine rm -rf /tmp/foo'));
run('docker compose run web rm -rf cache stays advisory', () => assertAdvisoryOnly('docker compose run web rm -rf cache'));
run('docker build -t prune . stays advisory', () => assertAdvisoryOnly('docker build -t prune .'));
run('docker tag my-image rm stays advisory', () => assertAdvisoryOnly('docker tag my-image rm'));
run('docker run img tar -xvf a.tar stays advisory (flags after the image)', () => assertAdvisoryOnly('docker run img tar -xvf a.tar'));
run('gh issue list --search delete stays advisory', () => assertAdvisoryOnly('gh issue list --search delete'));
run('gh issue create --title "delete old keys" stays advisory', () => assertAdvisoryOnly('gh issue create --title "delete old keys"'));
run('gh repo view delete stays advisory (repo named delete)', () => assertAdvisoryOnly('gh repo view delete'));
run('prisma migrate dev --name reset stays advisory (migration named reset)', () => assertAdvisoryOnly('prisma migrate dev --name reset'));

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
