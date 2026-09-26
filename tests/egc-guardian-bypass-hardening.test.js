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
run('git config alias.x \'!\'evil is hard-blocked', () => assertHardBlocked("git config alias.x '!'evil"));
run('git config alias.x \\!evil is hard-blocked', () => assertHardBlocked('git config alias.x \\!evil'));
run('git config --global alias.x "\'!\'sh -c evil" is hard-blocked', () => assertHardBlocked('git config --global alias.x "\'!\'sh -c evil"'));
run('git config alias.x status stays allowed', () => assertAllowed('git config alias.x status'));
run('git config alias.egcprobe "config --local core.hooksPath /tmp/x" is hard-blocked', () => assertHardBlocked('git config alias.egcprobe "config --local core.hooksPath /tmp/x"'));
run('git config ALIAS.egcprobe "config --local core.hooksPath /tmp/x" is hard-blocked', () => assertHardBlocked('git config ALIAS.egcprobe "config --local core.hooksPath /tmp/x"'));
run('git -c alias.egcprobe="config --local core.hooksPath /tmp/x" egcprobe is hard-blocked', () => assertHardBlocked('git -c alias.egcprobe="config --local core.hooksPath /tmp/x" egcprobe'));
run('git config alias.x "-c core.hooksPath=/tmp/e config --get core.hooksPath" is hard-blocked', () => assertHardBlocked('git config alias.x "-c core.hooksPath=/tmp/e config --get core.hooksPath"'));
run('git -c alias.x="-c core.hooksPath=/tmp/e status" x is hard-blocked', () => assertHardBlocked('git -c alias.x="-c core.hooksPath=/tmp/e status" x'));
run('git config alias.x "--config-env core.hooksPath=EVIL commit" is hard-blocked', () => assertHardBlocked('git config alias.x "--config-env core.hooksPath=EVIL commit"'));
run('git -c alias.x="--config-env core.hooksPath=EVIL commit" x is hard-blocked', () => assertHardBlocked('git -c alias.x="--config-env core.hooksPath=EVIL commit" x'));
run('git config alias.x "--config-env=core.hooksPath=EVIL commit" is hard-blocked', () => assertHardBlocked('git config alias.x "--config-env=core.hooksPath=EVIL commit"'));
run('git -c alias.x="--config-env=core.hooksPath=EVIL commit" x is hard-blocked', () => assertHardBlocked('git -c alias.x="--config-env=core.hooksPath=EVIL commit" x'));
run('git config alias.x "-ccore.hooksPath=/tmp/e status" is hard-blocked', () => assertHardBlocked('git config alias.x "-ccore.hooksPath=/tmp/e status"'));
run('git config alias.x "-c=core.hooksPath=/tmp/e status" is hard-blocked', () => assertHardBlocked('git config alias.x "-c=core.hooksPath=/tmp/e status"'));
run('git config --comment=x core.hooksPath /tmp/x is hard-blocked', () => assertHardBlocked('git config --comment=x core.hooksPath /tmp/x'));
run('git config --value=y core.hooksPath /tmp/x is hard-blocked', () => assertHardBlocked('git config --value=y core.hooksPath /tmp/x'));
run('git config core.hooksPath -/tmp/evil is hard-blocked', () => assertHardBlocked('git config core.hooksPath -/tmp/evil'));
run('git config --local core.hooksPath -evil is hard-blocked', () => assertHardBlocked('git config --local core.hooksPath -evil'));
run('git config alias.egcprobe "--no-pager config --local core.hooksPath /tmp/x" is hard-blocked', () => assertHardBlocked('git config alias.egcprobe "--no-pager config --local core.hooksPath /tmp/x"'));
run('git config alias.x "-C \'/tmp/my dir\' config --local core.hooksPath /tmp/x" is hard-blocked', () => assertHardBlocked("git config alias.x \"-C '/tmp/my dir' config --local core.hooksPath /tmp/x\""));
run('git config alias.x "--git-dir \'/tmp/a b/.git\' config core.hooksPath /tmp/x" is hard-blocked', () => assertHardBlocked("git config alias.x \"--git-dir '/tmp/a b/.git' config core.hooksPath /tmp/x\""));
run('git config alias.x "-C \'/tmp/my dir\' status" stays allowed', () => assertAllowed("git config alias.x \"-C '/tmp/my dir' status\""));
run('git config -- core."hooksPath" /tmp/x is hard-blocked', () => assertHardBlocked('git config -- core."hooksPath" /tmp/x'));
run('git config -- core.hooks\'P\'ath /tmp/x is hard-blocked', () => assertHardBlocked("git config -- core.hooks'P'ath /tmp/x"));
run('git -c core.hooks\'P\'ath=/tmp/x status is hard-blocked', () => assertHardBlocked("git -c core.hooks'P'ath=/tmp/x status"));
run('git -ccore.hooks"Path"=/tmp/x status is hard-blocked', () => assertHardBlocked('git -ccore.hooks"Path"=/tmp/x status'));
run('git config alias.x "con\'f\'ig --local core.hooksPath /tmp/x" is hard-blocked', () => assertHardBlocked('git config alias.x "con\'f\'ig --local core.hooksPath /tmp/x"'));
run('git config core.hooks\'P\'ath /tmp/x is hard-blocked', () => assertHardBlocked("git config core.hooks'P'ath /tmp/x"));
run('git config user.na\'m\'e Felipe stays allowed', () => assertAllowed("git config user.na'm'e Felipe"));
run('git config merge.evil.driver "rm -rf /" is hard-blocked', () => assertHardBlocked('git config merge.evil.driver "rm -rf /"'));
run('git config user.name "Felipe" stays allowed (benign key)', () => assertAllowed('git config user.name "Felipe"'));
run('git config alias.co checkout stays allowed (non-bang alias)', () => assertAllowed('git config alias.co checkout'));
run('git config alias.co Config stays allowed (Config is not config subcommand)', () => assertAllowed('git config alias.co Config'));
run('git config --get core.hooksPath stays allowed (read, not write)', () => assertAllowed('git config --get core.hooksPath'));
run('git config --unset core.hooksPath stays allowed (removal, not write)', () => assertAllowed('git config --unset core.hooksPath'));
run('git push origin "+main" is hard-blocked', () => assertHardBlocked('git push origin "+main"'));
run('git push origin \'+main\' is hard-blocked', () => assertHardBlocked("git push origin '+main'"));
run('git push origin "+HEAD:main" is hard-blocked', () => assertHardBlocked('git push origin "+HEAD:main"'));
run('git push origin \'+HEAD:main\' is hard-blocked', () => assertHardBlocked("git push origin '+HEAD:main'"));

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

console.log('\nWrapper options are read the way the wrapper reads them:');
for (const command of [
  'sudo -Hu root rm -rf /',
  'sudo -nHu root rm -rf /',
  'sudo -Huroot rm -rf /',
  'doas -nu root rm -rf /',
  'env -iu HOME rm -rf /',
  'timeout -vk 9 5 rm -rf /',
  'xargs -0n 1 rm -rf /',
  'ionice -tc 3 rm -rf /',
  'flock -nw 5 /tmp/l rm -rf /',
  'watch -tn 1 rm -rf /',
  'time -po out rm -rf /',
]) {
  run(`grouped short flags: ${command} is hard-blocked (the value letter takes the next word)`, () => assertHardBlocked(command));
}
for (const command of [
  'sudo -T 10 rm -rf /',
  'sudo --command-timeout 10 rm -rf /',
  'sudo --user=root rm -rf /',
  'sudo -h host rm -rf /',
  'timeout --kill-after=5 10 rm -rf /',
  'sudo -a pam rm -rf /',
  'sudo -c default rm -rf /',
  'doas -a style rm -rf /',
  'env -a name rm -rf /',
  'env -f vars.env rm -rf /',
  'exec -a name rm -rf /',
  'ionice -u 0 rm -rf /',
  'strace -u root rm -rf /',
  'strace --user root rm -rf /',
  'strace -fX raw rm -rf /',
  'watch -q 3 rm -rf /',
  'watch --equexit 3 rm -rf /',
  'strace --verbose all rm -rf /',
  'strace --decode-pids comm rm -rf /',
  'systemd-run --on-active 5 rm -rf /',
  'systemd-run --background red rm -rf /',
  'xargs --process-slot-var SLOT rm -rf /',
]) {
  run(`value flags: ${command} is hard-blocked (the flag value is not taken for the command)`, () => assertHardBlocked(command));
}
for (const command of [
  'xargs -i rm -rf /',
  'xargs -l rm -rf /',
  'xargs -in rm -rf /',
  'watch -d rm -rf /',
]) {
  run(`optional values: ${command} is hard-blocked (an optional value is only ever attached)`, () => assertHardBlocked(command));
}
for (const command of [
  'env -iS "rm -rf /"',
  'env -vS "rm -rf /"',
  'env -S"rm -rf /"',
  'flock /tmp/l -c "rm -rf /"',
  'flock -n /tmp/l --command "rm -rf /"',
]) {
  run(`command strings: ${command} is hard-blocked (the wrapper hands its value to a shell)`, () => assertHardBlocked(command));
}
for (const command of [
  'sudo --us root rm -rf /',
  'sudo --login-c default rm -rf /',
  'timeout --kill 5 10 rm -rf /',
  'strace --stack-trace-frame-limit 5 rm -rf /',
  'strace --stack-trace-f 5 rm -rf /',
  'systemd-run --json short rm -rf /',
]) {
  run(`long option abbreviations: ${command} is hard-blocked (a unique prefix is read as the option it names)`, () => assertHardBlocked(command));
}
for (const command of [
  'sudo --login rm -rf /',
  'strace --stack-trace rm -rf /',
  'strace --summary rm -rf /',
  'sudo --log rm -rf /',
  'strace --stack rm -rf /',
  'nice -- rm -rf /',
  'xargs --max-l rm -rf /',
]) {
  run(`long option abbreviations: ${command} is hard-blocked (an exact or ambiguous name is not stretched into a value option)`, () => assertHardBlocked(command));
}
run('long option abbreviations: env --split "rm -rf /" is hard-blocked (an abbreviated --split-string still splits)', () => assertHardBlocked('env --split "rm -rf /"'));
for (const command of [
  'parallel --tmpdir /x rm ::: /',
  'parallel --TMPDIR /x rm ::: /',
  'parallel --tmpd /x rm ::: /',
  'parallel --workdir /w rm ::: /',
  'parallel -a args.txt rm',
  'parallel --replace {} rm ::: /',
  'parallel -i {} rm ::: /',
  'parallel --max-lines 2 rm ::: /',
  'parallel --max-lines .5 rm ::: /',
  'parallel --n 1 rm ::: /',
]) {
  run(`GNU parallel options: ${command} is hard-blocked (read the way its Getopt::Long reads them)`, () => assertHardBlocked(command));
}
run('GNU parallel options: each option word spans the words its Getopt::Long takes', () => {
  const { readParallelOption } = require(path.join(path.dirname(buildPath), 'parallel-options.js'));
  const width = (word, next) => readParallelOption(word, next).width;
  assert.strictEqual(width('--jo', '4'), 1, 'an ambiguous prefix (joblog, jobs) is an error, not a value option');
  assert.strictEqual(width('--', 'rm'), 1, 'a bare -- takes no value');
  assert.strictEqual(width('--tmpdir=/x', 'rm'), 1, 'a value written with = stays in its word');
  assert.strictEqual(width('--n', '1'), 2, 'a single letter written after -- is that option');
  assert.strictEqual(width('-kj4', 'rm'), 1, 'a value attached in a bundle stays in its word');
  assert.strictEqual(width('-kj', '4'), 2, 'a bundle ending in a value letter takes the next word');
  assert.strictEqual(width('-i', '{}'), 2, 'an optional string takes a next word that is not an option');
  assert.strictEqual(width('-i', '-k'), 1, 'an optional string does not take an option');
  assert.strictEqual(width('--max-lines', 'x'), 1, 'an optional number takes only a number');
  assert.strictEqual(width('--max-lines', '-2'), 2, 'a negative number is a number');
  for (const number of ['.5', '5.', '1e3', '+2']) {
    assert.strictEqual(width('--max-lines', number), 2, `${number} is a number to Getopt::Long`);
  }
  assert.strictEqual(width('--max-lines', '.'), 1, 'a lone point is not a number');
  assert.strictEqual(width('--jobs', undefined), 1, 'nothing left means nothing taken');
  assert.strictEqual(width('--U', 'rm'), 1, '--U is lowered to the flag u, not the value option U');
  assert.strictEqual(width('--J', '4'), 2, '--J is lowered to the value option j');
  assert.strictEqual(width('--B', 'x'), 1, '--B has no b and is an ambiguous prefix');
  assert.strictEqual(width('-wd', 'x'), 1, 'an unknown letter ends the bundle');
});
for (const command of [
  'parallel -kj4 rm ::: /',
  'parallel --max-lines rm ::: /',
  'parallel --dry-run rm ::: /',
  'parallel --U rm ::: /',
  'parallel -wd rm ::: /',
]) {
  run(`GNU parallel options: ${command} is hard-blocked (a flag or a non-numeric word is not taken as a value)`, () => assertHardBlocked(command));
}
for (const command of [
  'sudo -Hu root npm install',
  'sudo -uroot npm install',
  'sudo --us root npm install',
  'parallel -j4 ls ::: a',
  'parallel --replace {} ls {} ::: a',
  'timeout -k 5 10 npm test',
  'xargs -I{} ls {}',
  'xargs -I {} ls {}',
  'flock /tmp/l npm test',
  'env ls -lS',
]) {
  run(`${command} stays allowed`, () => assertAllowed(command));
}

console.log('\nGemini CLI cross-CLI fail-open fix (2026-07-27 audit):');
run('.gemini/config/mcp_config.json write is blocked (guardian-bin.js now trusts this file to resolve the CLI)', () => {
  const v = validateWrite('.gemini/config/mcp_config.json');
  assert.strictEqual(v.allowed, false, 'expected .gemini/config/mcp_config.json write to be blocked');
});
run('.gemini/GEMINI.md write stays allowed (functional file, not a credential/trust-anchor)', () => {
  const v = validateWrite('.gemini/GEMINI.md');
  assert.strictEqual(v.allowed, true, `expected .gemini/GEMINI.md to stay allowed, got: ${v.reason}`);
});

console.log('\nAntigravity/OpenCode cross-CLI fail-open fix (internal audit EGC-460/461, 2026-07-27):');
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

// Internal audit EGC-533 findings (2026-08-02): trailing-whitespace path
// bypass and git includeIf bypass.
run('.env write with a trailing newline is still blocked (audit EGC-533, Finding 1)', () => {
  const v = validateWrite('.env\n');
  assert.strictEqual(v.allowed, false, 'a trailing newline must not defeat the $-anchored protected-path patterns');
});
run('.bashrc write with trailing whitespace is still blocked (audit EGC-533, Finding 1)', () => {
  const v = validateWrite('.bashrc   ');
  assert.strictEqual(v.allowed, false, 'trailing whitespace must not defeat the $-anchored protected-path patterns');
});
run('git config includeIf.<condition>.path write is blocked (audit EGC-533, Finding 2)', () => {
  const v = validateCommand('git config includeIf.gitdir:~/work/.path /tmp/evil');
  assert.strictEqual(v.allowed, false, 'includeIf.*.path loads another config file wholesale, same as include.path');
});

// Reading and writing carry different risk. Writing into these directories
// can hijack execution or plant persistence; reading a manifest or a service
// config only tells you how your own install is set up, and denying that was
// blocking legitimate diagnosis.
run('reading a functional file under a write-protected directory is allowed', () => {
  const home = require('node:os').homedir();
  for (const cmd of [
    `cat ${path.join(home, '.egc', 'bin', 'manifest.json')}`,
    `ls ${path.join(home, '.egc', 'bin')}`,
    'cat /etc/systemd/oomd.conf',
  ]) {
    assert.strictEqual(validateCommand(cmd).allowed, true, `${cmd} exposes no secret and must be readable`);
  }
});

run('reading an actual secret is still refused', () => {
  const home = require('node:os').homedir();
  for (const cmd of [
    `cat ${path.join(home, '.ssh', 'id_rsa')}`,
    `cat ${path.join(home, '.egc', 'encryption.key')}`,
    `cat ${path.join(home, '.npmrc')}`,
    'cat /etc/shadow',
  ]) {
    assert.strictEqual(validateCommand(cmd).allowed, false, `${cmd} exposes a credential and must stay denied`);
  }
});

run('recursive walks stay out of protected trees, readable subdirectory or not', () => {
  const home = require('node:os').homedir();
  // Direct denied roots, and -- the case that actually matters here -- a
  // directory whose *contents* are readable one file at a time. `cat
  // ~/.egc/bin/manifest.json` is allowed; walking ~/.egc/bin is not, because
  // tree-walking commands keep the full write-protection check rather than
  // the narrower read one.
  for (const cmd of [
    `grep -r secret ${path.join(home, '.egc')}`,
    `find ${path.join(home, '.config', 'github-copilot')} -name "*.json"`,
    `grep -r token ${path.join(home, '.egc', 'bin')}`,
    `find ${path.join(home, '.egc', 'metrics')} -name "*.jsonl"`,
  ]) {
    assert.strictEqual(validateCommand(cmd).allowed, false, `${cmd} walks a protected tree`);
  }

  // The single-file reads inside those same directories stay allowed, which
  // is the whole point of the split.
  assert.strictEqual(
    validateCommand(`cat ${path.join(home, '.egc', 'bin', 'manifest.json')}`).allowed,
    true,
    'reading one operational file must still work'
  );
});

run('a case variant cannot name a secret past the guard', () => {
  // macOS and Windows open .ENV and /etc/SHADOW as the same files their
  // lower-case spellings name. The check folds case there, so the variant is
  // refused; on Linux these are genuinely different paths and the assertion
  // only applies where the filesystem behaves that way.
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  const home = require('node:os').homedir();
  for (const cmd of ['cat /etc/SHADOW', 'cat .ENV', `cat ${path.join(home, '.egc', 'ENCRYPTION.KEY')}`]) {
    assert.strictEqual(validateCommand(cmd).allowed, false, `${cmd} names a protected file`);
  }

  // The same folding has to apply to the readable side, or the case fix
  // would turn harmless reads into denials on exactly those systems.
  for (const cmd of [
    `cat ${path.join(home, '.BASHRC')}`,
    `cat ${path.join(home, '.GITCONFIG')}`,
    `cat ${path.join(home, '.egc', 'BIN', 'manifest.json')}`,
  ]) {
    assert.strictEqual(validateCommand(cmd).allowed, true, `${cmd} names a harmless file`);
  }
});

run('credential stores outside the readable areas stay denied', () => {
  const home = require('node:os').homedir();
  // These are covered by the write protection and are not on the read-safe
  // list, so subtraction keeps them denied without restating them.
  for (const cmd of [
    `cat ${path.join(home, '.codex', 'auth.json')}`,
    `cat ${path.join(home, '.gemini', 'google_accounts.json')}`,
    `cat ${path.join(home, '.local', 'share', 'kiro-cli', 'data.sqlite3')}`,
  ]) {
    assert.strictEqual(validateCommand(cmd).allowed, false, `${cmd} is a credential store`);
  }
});

run('a persistence-file name cannot unlock a credential directory', () => {
  const home = require('node:os').homedir();
  // .bashrc and .gitconfig are readable where they normally live, but the
  // filename must not make them readable inside a credential store, and the
  // .git/config pattern must not stretch to .git/config_keys.
  for (const cmd of [
    `cat ${path.join(home, '.ssh', '.gitconfig')}`,
    `cat ${path.join(home, '.aws', '.bashrc')}`,
    `cat ${path.join(home, '.ssh', '.git', 'config')}`,
    `cat ${path.join(home, '.ssh', '.git', 'config_keys')}`,
  ]) {
    assert.strictEqual(validateCommand(cmd).allowed, false, `${cmd} sits inside a credential store`);
  }
});

run('system secrets are denied without having to be enumerated', () => {
  // The readable set is narrow on purpose (specific directories, not whole
  // trees), so none of these had to be listed anywhere to stay protected --
  // which is the point, since an audit found every one of them missing from
  // an earlier attempt that opened /etc and ~/.egc wholesale.
  const home = require('node:os').homedir();
  for (const cmd of [
    'cat /etc/shadow-',
    'cat /etc/gshadow-',
    'cat /etc/sudoers.tmp',
    'cat /etc/ssl/private/server.key',
    'cat /etc/wireguard/wg0.conf',
    'cat /etc/krb5.keytab',
    'cat /etc/master.passwd',
    `cat ${path.join(home, '.egc', 'encryption.key.bak')}`,
    `cat ${path.join(home, '.egc', 'state.bak')}`,
    `cat ${path.join(home, '.egc', 'state', 'project.md')}`,
  ]) {
    assert.strictEqual(validateCommand(cmd).allowed, false, `${cmd} must stay denied`);
  }
});

run('write protection is untouched by the read split', () => {
  const home = require('node:os').homedir();
  for (const target of [
    path.join(home, '.egc', 'bin', 'git'),
    path.join(home, '.ssh', 'authorized_keys'),
    '/etc/passwd',
  ]) {
    assert.strictEqual(validateWrite(target).allowed, false, `${target} must remain write-protected`);
  }
});

// Local wrappers from util-linux, coreutils, polkit, busybox and bubblewrap
// run the command that follows their own options, read the way each reads
// them (tables taken from their sources: util-linux 2.41 and master).
for (const command of [
  'setsid rm -rf /',
  'setsid -fw rm -rf /',
  'setsid --fork rm -rf /',
  'taskset 0x1 rm -rf /',
  'taskset -c 0 rm -rf /',
  'chrt -f 1 rm -rf /',
  'chrt 1 rm -rf /',
  'chrt -o rm -rf /',
  'chrt -d -T 5 -P 10 0 rm -rf /',
  'chrt --sched-runtime 5 --deadline 0 rm -rf /',
  'unshare -r rm -rf /',
  'unshare -R /x rm -rf /',
  'unshare --wd /x rm -rf /',
  'unshare --mount=/x rm -rf /',
  'unshare --load-interp x rm -rf /',
  'unshare -rmR/x rm -rf /',
  'nsenter -t 1 -m rm -rf /',
  'nsenter --net rm -rf /',
  'nsenter -n rm -rf /',
  'nsenter --target 1 --mount rm -rf /',
  'nsenter -t1 -S 0 rm -rf /',
  'runuser -u root rm -rf /',
  'runuser -u root -- rm -rf /',
  'runuser --user root -- rm -rf /',
  'runuser --us root -- rm -rf /',
  'prlimit --nofile=1 rm -rf /',
  'prlimit -n rm -rf /',
  'prlimit -o x rm -rf /',
  'chroot / rm -rf /',
  'chroot --userspec 0:0 / rm -rf /',
  'numactl -C 0 rm -rf /',
  'numactl --physcpubind=0 rm -rf /',
  'numactl --interleave all rm -rf /',
  'numactl -aC 0 rm -rf /',
  'pkexec rm -rf /',
  'pkexec --user root rm -rf /',
  'pkexec -u root rm -rf /',
  'busybox rm -rf /',
  'busybox sh -c "rm -rf /"',
  'bwrap --bind / / rm -rf /',
  'bwrap --overlay a b c rm -rf /',
  'bwrap --setenv A B rm -rf /',
  'bwrap --unshare-all -- rm -rf /',
  'bwrap --ro-bind / / --chdir / rm -rf /',
  'sudo setsid taskset 0x1 rm -rf /',
]) {
  run(`local wrappers: ${command} is hard-blocked (the wrapped command is judged)`, () => assertHardBlocked(command));
}

// Wrappers that hand a string, or the words after a user, to a shell.
for (const command of [
  'runuser root -c "rm -rf /"',
  'runuser -c "rm -rf /" root',
  'runuser --comm "rm -rf /" root',
  'runuser --session-command "rm -rf /" root',
  'su --comm "rm -rf /"',
  'su --session-command "rm -rf /"',
  'su root notes.sh',
  'su - root notes.sh',
  'runuser root notes.sh',
  'script -c "rm -rf /"',
  'script -qc "rm -rf /" /dev/null',
  'script --command "rm -rf /"',
  'script --comm "rm -rf /"',
  'script --command="rm -rf /"',
  'sg wheel "rm -rf /"',
  'sg wheel -c "rm -rf /"',
  'sg - wheel "rm -rf /"',
]) {
  run(`local wrappers: ${command} is hard-blocked (a string or the words after a user reach a shell)`, () => assertHardBlocked(command));
}

for (const command of [
  'setsid ls',
  'taskset -c 0 ls',
  'chrt -o 0 ls',
  'chrt -o ls',
  'unshare -r ls',
  'nsenter -t 1 -n ls',
  'prlimit --nofile=1024 ls',
  'numactl -C 0 ls',
  'chroot / ls',
  'pkexec ls',
  'busybox ls',
  'bwrap --ro-bind / / ls',
  'runuser -u nobody -- ls',
]) {
  run(`local wrappers: ${command} stays allowed (a benign command behind the wrapper)`, () => assertAllowed(command));
}

run('local wrappers: su and runuser with only a user are not hard-blocked', () => {
  for (const command of ['su - root', 'su root', 'runuser root', 'su -l postgres', 'sg wheel', 'su root -s /bin/bash', 'runuser postgres -l', 'su - root --shell=/bin/zsh']) {
    const v = validateCommand(command);
    assert.notStrictEqual(v.trust_level, 'DANGEROUS', `${command}: ${v.reason}`);
  }
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
