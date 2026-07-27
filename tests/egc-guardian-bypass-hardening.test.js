'use strict';
/**
 * Tests for the 2026-07-27 Guardian bypass-hardening fixes (EGC-457/458/459):
 * quote/escape-stripped base commands, recursive wrapper unwrap (xargs,
 * timeout, nice, ...), the always-denied `eval` builtin, `su -c`, dangerous
 * git-persistence env vars, persistent `git config` writes to hook/exec
 * keys, direct .git/hooks writes, and the metachar-check reordering that
 * previously let a stray $/pipe elsewhere in the command swallow a real
 * DANGEROUS verdict.
 *
 * Run with: node tests/egc-guardian-bypass-hardening.test.js
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

const { validateCommand, validateWrite } = require(buildPath);

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

function assertHardBlocked(command) {
  const v = validateCommand(command);
  assert.strictEqual(v.allowed, false, `${command} should be denied`);
  assert.strictEqual(v.trust_level, 'DANGEROUS', `${command} should be DANGEROUS, got ${v.trust_level}`);
  assert.ok(!v.reason.includes('is not in the allowlist'), `${command} must not fall through to the advisory allowlist miss`);
  assert.ok(!v.reason.includes('Shell chaining/metacharacters'), `${command} must not fall through to the metachar advisory`);
}

function assertAllowed(command) {
  const v = validateCommand(command);
  assert.strictEqual(v.allowed, true, `${command} should be allowed, got: ${v.reason}`);
}

console.log('\n=== Testing Guardian bypass hardening (2026-07-27) ===\n');

console.log('bareToken normalization on the base command:');
run('quoted "rm" -rf / is hard-blocked', () => assertHardBlocked('"rm" -rf /'));
run("quoted 'rm' -rf / is hard-blocked", () => assertHardBlocked("'rm' -rf /"));
run('backslash-escaped \\rm -rf / is hard-blocked', () => assertHardBlocked('\\rm -rf /'));
run('quoted "bash" -c inline eval is hard-blocked', () => assertHardBlocked('"bash" -c "rm -rf /"'));

console.log('\nrecursive wrapper unwrap:');
run('xargs rm -rf / is hard-blocked', () => assertHardBlocked('xargs rm -rf /'));
run('timeout 5 rm -rf / is hard-blocked (duration positional skipped)', () => assertHardBlocked('timeout 5 rm -rf /'));
run('nice -n 10 rm -rf / is hard-blocked (value flag skipped)', () => assertHardBlocked('nice -n 10 rm -rf /'));
run('stdbuf -oL rm -rf / is hard-blocked', () => assertHardBlocked('stdbuf -oL rm -rf /'));
run('flock /tmp/lock rm -rf / is hard-blocked (lockfile positional skipped)', () => assertHardBlocked('flock /tmp/lock rm -rf /'));
run('watch rm -rf / is hard-blocked', () => assertHardBlocked('watch rm -rf /'));
run('strace rm -rf / is hard-blocked', () => assertHardBlocked('strace rm -rf /'));
run('systemd-run rm -rf / is hard-blocked', () => assertHardBlocked('systemd-run rm -rf /'));
run('doas rm -rf / is hard-blocked', () => assertHardBlocked('doas rm -rf /'));
run('parallel rm -rf / is hard-blocked', () => assertHardBlocked('parallel rm -rf /'));
run('sudo -u root rm -rf /etc is hard-blocked (value flag no longer misparsed as the command)', () => assertHardBlocked('sudo -u root rm -rf /etc'));
run('stacked wrappers: sudo timeout 5 xargs rm -rf / is hard-blocked', () => assertHardBlocked('sudo timeout 5 xargs rm -rf /'));
run('sudo npm install stays allowed (benign command behind a wrapper)', () => assertAllowed('sudo npm install'));
run('timeout 30 npm test stays allowed (benign command, duration skipped)', () => assertAllowed('timeout 30 npm test'));

console.log('\neval / su -c always-denied execution primitives:');
run('eval "rm -rf /" is hard-blocked', () => assertHardBlocked('eval "rm -rf /"'));
run('eval with no args is not hard-blocked (nothing to execute; falls through to the ordinary allowlist-miss, same as any bare unknown command)', () => {
  const v = validateCommand('eval');
  assert.notStrictEqual(v.trust_level, 'DANGEROUS', 'bare eval with no args must not hit the DANGEROUS eval-execution check');
});
run('su -c "rm -rf /" is hard-blocked', () => assertHardBlocked('su -c "rm -rf /"'));
run('su --command="rm -rf /" is hard-blocked', () => assertHardBlocked('su --command="rm -rf /"'));

console.log('\ndangerous git-persistence env var assignments:');
run('GIT_CONFIG_PARAMETERS=... git status is hard-blocked', () => assertHardBlocked("GIT_CONFIG_PARAMETERS='core.hookspath=/tmp/evil' git status"));
run('GIT_EXEC_PATH=/tmp/evil git status is hard-blocked', () => assertHardBlocked('GIT_EXEC_PATH=/tmp/evil git status'));
run('GIT_SSH_COMMAND=/tmp/evil git fetch is hard-blocked', () => assertHardBlocked('GIT_SSH_COMMAND=/tmp/evil git fetch'));
run('harmless FOO=bar git status stays allowed', () => assertAllowed('FOO=bar git status'));

console.log('\npersistent git config writes:');
run('git config core.hooksPath /tmp/evil is hard-blocked', () => assertHardBlocked('git config core.hooksPath /tmp/evil'));
run('git config --global core.hooksPath /tmp/evil is hard-blocked', () => assertHardBlocked('git config --global core.hooksPath /tmp/evil'));
run('git config credential.helper /tmp/evil is hard-blocked', () => assertHardBlocked('git config credential.helper /tmp/evil'));
run('git config alias.co "!rm -rf /" is hard-blocked', () => assertHardBlocked('git config alias.co "!rm -rf /"'));
run('git config merge.evil.driver "rm -rf /" is hard-blocked', () => assertHardBlocked('git config merge.evil.driver "rm -rf /"'));
run('git config user.name "Felipe" stays allowed (benign key)', () => assertAllowed('git config user.name "Felipe"'));
run('git config alias.co checkout stays allowed (non-bang alias)', () => assertAllowed('git config alias.co checkout'));
run('git config --get core.hooksPath stays allowed (read, not write)', () => assertAllowed('git config --get core.hooksPath'));
run('git config --unset core.hooksPath stays allowed (removal, not write)', () => assertAllowed('git config --unset core.hooksPath'));

console.log('\nmetacharacter-check reordering (must not swallow a real DANGEROUS verdict):');
run('rm -rf $HOME is hard-blocked (not downgraded to metachar advisory)', () => assertHardBlocked('rm -rf $HOME'));
run('git commit -m "fix: a && b" is not hard-blocked (quoted metachars in a benign command fall through to the pre-existing, hook-advisory metachar reason, not a real DANGEROUS verdict)', () => {
  const v = validateCommand('git commit -m "fix: a && b"');
  assert.notStrictEqual(v.trust_level, 'DANGEROUS', 'a benign quoted command must not be judged DANGEROUS');
});

console.log('\n.git/hooks and .git/config write protection:');
run('.git/hooks/pre-commit write is blocked', () => {
  const v = validateWrite('.git/hooks/pre-commit');
  assert.strictEqual(v.allowed, false, 'expected .git/hooks/pre-commit write to be blocked');
});
run('.git/hooks/ (directory) write is blocked', () => {
  const v = validateWrite('.git/hooks/');
  assert.strictEqual(v.allowed, false, 'expected .git/hooks/ write to be blocked');
});
run('.git/config write is blocked', () => {
  const v = validateWrite('.git/config');
  assert.strictEqual(v.allowed, false, 'expected .git/config write to be blocked');
});
run('.git/info/exclude write stays allowed (not a hooks/config path)', () => {
  const v = validateWrite('.git/info/exclude');
  assert.strictEqual(v.allowed, true, `expected .git/info/exclude to stay allowed, got: ${v.reason}`);
});

console.log('\ncubic-dev-ai PR review findings (2026-07-27, follow-up round):');
run('env -S "rm -rf /" is hard-blocked (split-string re-execs its value)', () => assertHardBlocked('env -S "rm -rf /"'));
run('env --split-string="rm -rf /" is hard-blocked', () => assertHardBlocked('env --split-string="rm -rf /"'));
run('env -i FOO=bar npm test stays allowed (ordinary env usage, no -S)', () => assertAllowed('env -i FOO=bar npm test'));

run('export GIT_SSH_COMMAND=/tmp/evil is hard-blocked (persists like a bare VAR= prefix)', () => assertHardBlocked('export GIT_SSH_COMMAND=/tmp/evil'));
run('export GIT_SSH_COMMAND=/tmp/evil && git fetch is hard-blocked (segment 1 alone already denies)', () => assertHardBlocked('export GIT_SSH_COMMAND=/tmp/evil && git fetch'));
run('export FOO=bar stays allowed (harmless env var)', () => assertAllowed('export FOO=bar'));
run('export -- GIT_SSH_COMMAND=/tmp/evil is hard-blocked (-- end-of-options no longer hides the assignment)', () => assertHardBlocked('export -- GIT_SSH_COMMAND=/tmp/evil'));
run('export -f -- GIT_SSH_COMMAND=/tmp/evil is hard-blocked (flag before -- still skipped correctly)', () => assertHardBlocked('export -f -- GIT_SSH_COMMAND=/tmp/evil'));
run('export -- FOO=bar stays allowed (harmless var behind --)', () => assertAllowed('export -- FOO=bar'));
run('export -p is not hard-blocked (no assignment present, falls through like any unknown command)', () => {
  const v = validateCommand('export -p');
  assert.notStrictEqual(v.trust_level, 'DANGEROUS', 'export -p (listing, no assignment) must not hit the DANGEROUS export check');
});

run('git config --show-scope core.hooksPath /tmp/evil is hard-blocked (output-annotator flag no longer exempts a real SET)', () => assertHardBlocked('git config --show-scope core.hooksPath /tmp/evil'));
run('git config --name-only core.hooksPath /tmp/evil is hard-blocked', () => assertHardBlocked('git config --name-only core.hooksPath /tmp/evil'));
run('git config --edit is hard-blocked unconditionally (opaque editor session)', () => assertHardBlocked('git config --edit'));
run('git config -e is hard-blocked unconditionally', () => assertHardBlocked('git config -e'));
run('git config --show-scope --get core.hooksPath stays allowed (genuine read)', () => assertAllowed('git config --show-scope --get core.hooksPath'));

run('git config "--global" core.hooksPath /tmp/evil is hard-blocked (quoted flag no longer misread as a positional)', () => assertHardBlocked('git config "--global" core.hooksPath /tmp/evil'));

run('git -c foo=bar config core.hooksPath /tmp/evil is hard-blocked (global flag before config no longer hides the subcommand)', () => assertHardBlocked('git -c foo=bar config core.hooksPath /tmp/evil'));
run('git -C /tmp config core.hooksPath /tmp/evil is hard-blocked (global -C flag+value skipped correctly)', () => assertHardBlocked('git -C /tmp config core.hooksPath /tmp/evil'));
run('git -C config status stays allowed (literal "config" as a -C value is not mistaken for the subcommand)', () => assertAllowed('git -C config status'));

run('git config core.fsmonitor /tmp/evil is hard-blocked (expanded dangerous-key coverage)', () => assertHardBlocked('git config core.fsmonitor /tmp/evil'));
run('git config filter.lfs.clean /tmp/evil is hard-blocked', () => assertHardBlocked('git config filter.lfs.clean /tmp/evil'));
run('git config filter.lfs.smudge /tmp/evil is hard-blocked', () => assertHardBlocked('git config filter.lfs.smudge /tmp/evil'));
run('git config filter.lfs.process /tmp/evil is hard-blocked', () => assertHardBlocked('git config filter.lfs.process /tmp/evil'));
run('git config diff.evil.command /tmp/evil is hard-blocked', () => assertHardBlocked('git config diff.evil.command /tmp/evil'));

run('sudo -U rm -rf / is not silently misparsed by case-insensitive flag lookup (unknown flag stays boolean, rm is still reached)', () => assertHardBlocked('sudo -U rm -rf /'));

console.log('\nGemini CLI cross-CLI fail-open fix (2026-07-27 audit):');
run('.gemini/config/mcp_config.json write is blocked (guardian-bin.js now trusts this file to resolve the CLI)', () => {
  const v = validateWrite('.gemini/config/mcp_config.json');
  assert.strictEqual(v.allowed, false, 'expected .gemini/config/mcp_config.json write to be blocked');
});
run('.gemini/GEMINI.md write stays allowed (functional file, not a credential/trust-anchor)', () => {
  const v = validateWrite('.gemini/GEMINI.md');
  assert.strictEqual(v.allowed, true, `expected .gemini/GEMINI.md to stay allowed, got: ${v.reason}`);
});

console.log('\nAntigravity/OpenCode cross-CLI fail-open fix (Multica audit EGC-460/461, 2026-07-27):');
run('.gemini/antigravity-cli/mcp_config.json write is blocked (guardian-bin.js now trusts this file too)', () => {
  const v = validateWrite('.gemini/antigravity-cli/mcp_config.json');
  assert.strictEqual(v.allowed, false, 'expected .gemini/antigravity-cli/mcp_config.json write to be blocked');
});
run('.config/opencode/config.json write is blocked (guardian-bin.js now trusts this file too)', () => {
  const v = validateWrite('.config/opencode/config.json');
  assert.strictEqual(v.allowed, false, 'expected .config/opencode/config.json write to be blocked');
});

console.log('\nCodex TOML + install-marker gap fixes (2026-07-27, EGC-465):');
run('.codex/config.toml write is blocked (guardian-bin.js now trusts this file too)', () => {
  const v = validateWrite('.codex/config.toml');
  assert.strictEqual(v.allowed, false, 'expected .codex/config.toml write to be blocked');
});
run('.codex/config.toml write via home-relative path is blocked', () => {
  const v = validateWrite(path.join(require('node:os').homedir(), '.codex', 'config.toml'));
  assert.strictEqual(v.allowed, false, 'expected ~/.codex/config.toml write to be blocked');
});
run('.egc/guardian-cli-path.json write is blocked (guardian-bin.js now trusts this file too)', () => {
  const v = validateWrite('.egc/guardian-cli-path.json');
  assert.strictEqual(v.allowed, false, 'expected .egc/guardian-cli-path.json write to be blocked');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
