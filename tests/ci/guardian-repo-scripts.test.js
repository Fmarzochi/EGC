'use strict';

// The shell scripts this repository commits are what the Guardian meets
// most. Writing one back as committed must not be refused, a line of one
// must not be refused for anything but the deliberate denials, and the
// shell's own ways of writing a script, a git hook or a scheduled job must
// stay refused. A change to the validator that breaks any of these fails
// here, before it reaches a session.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');
const buildDir = path.join(repoRoot, 'mcp', 'servers', 'egc-guardian', 'build');

if (!fs.existsSync(path.join(buildDir, 'guardian-cli.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

process.env.EGC_GUARDIAN_CLI = path.join(buildDir, 'guardian-cli.js');
// This file deliberately exercises refusals: the CLI writes an audit entry
// for each one (C49), so HOME is pinned to a temp dir for this whole
// process and never the real ~/.egc/audit.log.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-repo-scripts-home-'));
const writeHook = require('../../scripts/hooks/pre-write-guardian-validate');
const bashHook = require('../../scripts/hooks/pre-bash-guardian-validate');
const { validateCommand } = require(path.join(buildDir, 'validator.js'));

// S4036: prefer fixed git locations over a PATH lookup, as session-end.js
// does; the bare name is the last resort for layouts like nix or portable Git.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

const SHELL_EXTENSION_RE = /\.(?:sh|bash|zsh|ksh)$/i;
const SHELL_SHEBANG_RE = /^#![^\n]*\b(?:sh|bash|zsh|ksh|dash|ash)\b/;

// git runs what these directories hold as it runs .git/hooks, so a write
// there is the user's to make.
const HOOK_DIRECTORIES = new Set(['.githooks', '.husky']);

// Scripts that hand a program to an interpreter on standard input: the
// hook cannot read that program, so a write of the script is refused until
// the program moves to a file of its own.
const PROGRAM_ON_STDIN = new Set(['scripts/sync-egc-to-codex.sh']);

// The denials a committed script may meet when a line of it is judged as
// if it were typed now; anything else is a validator refusing a command it
// should not.
const DELIBERATE_DENIALS = [
  /^'[^']+' is a destructive command and is always denied/,
  /^inline code execution via '[^']+' eval flag is forbidden/,
  /^'awk' runs a command, reads a file or writes one from its program/,
];

function git(args) {
  const result = spawnSync(GIT_BIN, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

// The shell scripts of the commit at HEAD, read from the commit itself: the
// ones named as scripts, and those whose committed text opens with a shell
// shebang (git grep narrows the blobs to read to those with a #! line).
function committedScripts() {
  const named = git(['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter(file => SHELL_EXTENSION_RE.test(file));
  const withShebang = git(['grep', '-lIz', '-e', '^#!', 'HEAD']).split('\0').filter(Boolean).map(entry => entry.slice('HEAD:'.length));
  return [...new Set([...named, ...withShebang])]
    .map(file => ({ file, content: git(['cat-file', 'blob', `HEAD:${file}`]) }))
    .filter(({ file, content }) => SHELL_EXTENSION_RE.test(file) || SHELL_SHEBANG_RE.test(content));
}

function isHookDirectory(file) {
  return HOOK_DIRECTORIES.has(file.split('/')[0]);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runBash(command) {
  return bashHook.run({ tool_name: 'Bash', tool_input: { command }, cwd: repoRoot });
}

console.log('\n=== Testing the Guardian against the scripts this repository commits ===\n');

let passed = 0;
let failed = 0;
const scripts = committedScripts();

if (test('the repository commits shell scripts to judge', () => {
  assert.ok(scripts.length >= 20, `only ${scripts.length} shell scripts found`);
})) passed++; else failed++;

if (test('writing a committed script back as committed is accepted, except where git runs hooks from or a program is read from stdin', () => {
  for (const { file, content } of scripts) {
    const target = path.join(repoRoot, file);
    const result = writeHook.run({ tool_name: 'Write', tool_input: { file_path: target, content }, cwd: repoRoot });
    if (isHookDirectory(file)) {
      assert.strictEqual(result.exitCode, 2, `${file} is where git runs hooks from`);
      assert.match(result.stderr, /protected/, file);
    } else if (PROGRAM_ON_STDIN.has(file)) {
      assert.strictEqual(result.exitCode, 2, `${file} hands a program on stdin`);
      assert.match(result.stderr, /write the code to a file/, file);
    } else {
      assert.strictEqual(result.exitCode, 0, `${file}: ${result.stderr}`);
    }
  }
})) passed++; else failed++;

if (test('judged as if typed now, a line of a committed script meets only the deliberate denials', () => {
  for (const { file, content } of scripts) {
    let segments;
    try {
      segments = bashHook.extractSegments(content);
    } catch (error) {
      assert.ok(PROGRAM_ON_STDIN.has(file), `${file}: ${error.message}`);
      continue;
    }
    assert.ok(segments !== null, `${file}: substitutions nest too deep to read`);
    for (const segment of segments) {
      const verdict = validateCommand(segment, repoRoot);
      if (verdict.allowed || verdict.advisory) continue;
      assert.ok(DELIBERATE_DENIALS.some(pattern => pattern.test(verdict.reason)), `${file}: ${segment.slice(0, 120)}: ${verdict.reason}`);
    }
  }
})) passed++; else failed++;

if (test('the shell is refused as a way to write a script, a git hook or a scheduled job', () => {
  for (const command of [
    "printf 'echo hi' >> scripts/egc-new-tool.sh",
    "sed -i 's/a/b/' scripts/release.sh",
    "cat > scripts/egc-new-tool.sh <<'EOF'\necho hi\nEOF",
    'tee -a .githooks/pre-commit',
    'cp /tmp/egc-hook .githooks/pre-push',
    'ln -s /tmp/egc-hook .husky/pre-commit',
    'crontab /tmp/egc-jobs',
    "echo 'echo hi' | at now",
  ]) {
    assert.strictEqual(runBash(command).exitCode, 2, command);
  }
})) passed++; else failed++;

if (test('testing for, reading and listing them is not refused', () => {
  for (const command of ['[ -e .git ]', 'test -d .githooks', 'cat .githooks/pre-commit', "sed -n '1p' scripts/release.sh", 'crontab -l']) {
    const result = runBash(command);
    assert.strictEqual(result.exitCode, 0, `${command}: ${result.stderr}`);
  }
})) passed++; else failed++;

console.log(`\nPassed: ${passed}, Failed: ${failed}\n`);
// run-all.js reads this file's stdout through a pipe; process.exit() can
// truncate it before it flushes, losing the summary line it parses.
process.exitCode = failed > 0 ? 1 : 0;
