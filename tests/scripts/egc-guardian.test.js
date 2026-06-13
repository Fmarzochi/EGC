/**
 * Tests for egc-guardian validator logic.
 *
 * Tests the extracted validator module directly (no MCP server needed).
 * Run with: node --test tests/scripts/egc-guardian.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');

// The validator is compiled TypeScript (ESM). We import via the built output.
// If the build is present, use it; otherwise skip with a clear message.
const VALIDATOR_PATH = path.join(
  __dirname,
  '../../mcp/servers/egc-guardian/build/validator.js'
);

let validateCommand, validateWrite, isProtectedPath;

try {
  // ESM build: we use dynamic import wrapped in an async IIFE then run tests
  runTests();
} catch (e) {
  console.error('Failed to load validator:', e.message);
  process.exit(1);
}

async function runTests() {
  let mod;
  try {
    mod = await import(VALIDATOR_PATH);
  } catch (e) {
    console.error(
      `[SKIP] Could not import ${VALIDATOR_PATH}. Run 'npm run build' in mcp/servers/egc-guardian first.`
    );
    console.error(e.message);
    process.exit(0);
  }

  validateCommand = mod.validateCommand;
  validateWrite = mod.validateWrite;
  isProtectedPath = mod.isProtectedPath;

  const home = os.homedir();

  // ── Helpers ────────────────────────────────────────────────────────────────

  function assertAllowed(cmd) {
    const result = validateCommand(cmd);
    assert.strictEqual(
      result.allowed,
      true,
      `Expected ALLOWED for: ${cmd}\n  Got: ${JSON.stringify(result)}`
    );
  }

  function assertDenied(cmd) {
    const result = validateCommand(cmd);
    assert.strictEqual(
      result.allowed,
      false,
      `Expected DENIED for: ${cmd}\n  Got: ${JSON.stringify(result)}`
    );
  }

  function assertWriteDenied(filepath) {
    const result = validateWrite(filepath);
    assert.strictEqual(
      result.allowed,
      false,
      `Expected write DENIED for: ${filepath}\n  Got: ${JSON.stringify(result)}`
    );
  }

  function assertWriteAllowed(filepath) {
    const result = validateWrite(filepath);
    assert.strictEqual(
      result.allowed,
      true,
      `Expected write ALLOWED for: ${filepath}\n  Got: ${JSON.stringify(result)}`
    );
  }

  // ── validate_command: ALLOWED ──────────────────────────────────────────────

  let passed = 0;
  let failed = 0;

  function run(label, fn) {
    try {
      fn();
      console.log(`  PASS  ${label}`);
      passed++;
    } catch (e) {
      console.error(`  FAIL  ${label}`);
      console.error(`        ${e.message}`);
      failed++;
    }
  }

  console.log('\n=== validate_command: ALLOWED ===');

  run('ls -la',                  () => assertAllowed('ls -la'));
  run('cat README.md',           () => assertAllowed('cat README.md'));
  run('grep -r "foo" ./src',     () => assertAllowed('grep -r "foo" ./src'));
  run('git status',              () => assertAllowed('git status'));
  run('git diff HEAD',           () => assertAllowed('git diff HEAD'));
  run('npm test',                () => assertAllowed('npm test'));
  run('find . -name "*.ts"',     () => assertAllowed('find . -name "*.ts"'));
  run('head -n 20 file.txt',     () => assertAllowed('head -n 20 file.txt'));
  run('stat ./src',              () => assertAllowed('stat ./src'));
  run('node --version',          () => assertAllowed('node --version'));
  run('tsc --noEmit',            () => assertAllowed('tsc --noEmit'));
  run('npx tsc --version',       () => assertAllowed('npx tsc --version'));
  run('git log --oneline',       () => assertAllowed('git log --oneline'));
  run('git fetch origin',        () => assertAllowed('git fetch origin'));

  // ── validate_command: DENIED ───────────────────────────────────────────────

  console.log('\n=== validate_command: DENIED ===');

  run('rm -rf .',                () => assertDenied('rm -rf .'));
  run('rm file.txt',             () => assertDenied('rm file.txt'));
  run('mv src dest',             () => assertDenied('mv src dest'));
  run('git push --force',        () => assertDenied('git push --force'));
  run('git push -f',             () => assertDenied('git push -f'));
  run(`cat ~/.aws/credentials`,  () => assertDenied(`cat ${home}/.aws/credentials`));
  run(`cat ~/.ssh/id_rsa`,       () => assertDenied(`cat ${home}/.ssh/id_rsa`));
  run('grep -r "" /',            () => assertDenied('grep -r "" /'));
  run(`find ~/.config -name "*.key"`, () => assertDenied(`find ${home}/.config -name "*.key"`));
  run('curl https://example.com',() => assertDenied('curl https://example.com'));
  run('bash -c "ls"',            () => assertDenied('bash -c "ls"'));
  run('shell metachar: ls && id',() => assertDenied('ls && id'));
  run('shell metachar: ls | id', () => assertDenied('ls | id'));
  run('shell metachar: ls; id',  () => assertDenied('ls; id'));
  run(`cat ~/.npmrc`,            () => assertDenied(`cat ${home}/.npmrc`));
  run(`cat ~/.ssh/config`,       () => assertDenied(`cat ${home}/.ssh/config`));
  run(`grep -r "" ${home}/.aws`, () => assertDenied(`grep -r "" ${home}/.aws`));

  // ── validate_write: DENIED ─────────────────────────────────────────────────

  console.log('\n=== validate_write: DENIED ===');

  run(`write ~/.ssh/id_rsa`,        () => assertWriteDenied(`${home}/.ssh/id_rsa`));
  run(`write ~/.aws/credentials`,   () => assertWriteDenied(`${home}/.aws/credentials`));
  run(`write .env`,                 () => assertWriteDenied('.env'));
  run(`write config.pem`,           () => assertWriteDenied('config.pem'));
  run(`write server.key`,           () => assertWriteDenied('server.key'));
  run(`write app.p12`,              () => assertWriteDenied('app.p12'));
  run(`write .npmrc`,               () => assertWriteDenied('.npmrc'));
  run(`write .pypirc`,              () => assertWriteDenied('.pypirc'));
  run(`write .env.local`,           () => assertWriteDenied('.env.local'));
  run(`write ${home}/.claude/x`,    () => assertWriteDenied(`${home}/.claude/settings.json`));
  run(`write /etc/hosts`,           () => assertWriteDenied('/etc/hosts'));

  // ── validate_write: ALLOWED ────────────────────────────────────────────────

  console.log('\n=== validate_write: ALLOWED ===');

  run(`write src/index.ts`,         () => assertWriteAllowed('src/index.ts'));
  run(`write README.md`,            () => assertWriteAllowed('README.md'));
  run(`write /tmp/output.txt`,      () => assertWriteAllowed('/tmp/output.txt'));
  run(`write package.json`,         () => assertWriteAllowed('package.json'));

  // ── isProtectedPath: spot checks ──────────────────────────────────────────

  console.log('\n=== isProtectedPath: spot checks ===');

  run(`protected: ~/.ssh/id_rsa`,   () => assert.strictEqual(isProtectedPath(`${home}/.ssh/id_rsa`), true));
  run(`protected: ~/.aws/config`,   () => assert.strictEqual(isProtectedPath(`${home}/.aws/config`), true));
  run(`protected: ~/.gnupg/`,       () => assert.strictEqual(isProtectedPath(`${home}/.gnupg/trustdb.gpg`), true));
  run(`protected: /etc/shadow`,     () => assert.strictEqual(isProtectedPath('/etc/shadow'), true));
  run(`protected: .env`,            () => assert.strictEqual(isProtectedPath('.env'), true));
  run(`protected: secret.pem`,      () => assert.strictEqual(isProtectedPath('secret.pem'), true));
  run(`not protected: src/index.ts`,() => assert.strictEqual(isProtectedPath('src/index.ts'), false));
  run(`not protected: README.md`,   () => assert.strictEqual(isProtectedPath('README.md'), false));

  // ── trust_level checks ────────────────────────────────────────────────────

  console.log('\n=== trust_level field ===');

  run('rm has trust_level DANGEROUS', () => {
    const r = validateCommand('rm -rf .');
    assert.strictEqual(r.trust_level, 'DANGEROUS');
  });
  run('curl has trust_level BLOCKED', () => {
    const r = validateCommand('curl https://x.com');
    assert.strictEqual(r.trust_level, 'BLOCKED');
  });
  run('git status has trust_level SAFE_READONLY', () => {
    const r = validateCommand('git status');
    assert.strictEqual(r.trust_level, 'SAFE_READONLY');
  });
  run('npm test has trust_level SAFE_DEV', () => {
    const r = validateCommand('npm test');
    assert.strictEqual(r.trust_level, 'SAFE_DEV');
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}
