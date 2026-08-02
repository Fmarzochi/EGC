'use strict';
/**
 * Tests for scripts/hooks/pre-bash-crusher-rewrite.js
 *
 * Covers the fail-open contract of the Token Crusher rewrite: simple crushable
 * commands route through `egc run`; recognized pipelines and compound commands
 * route through `egc run --shell '<escaped>'` on POSIX with a bash-verified round
 * trip proving the escaping is exact; backgrounding, redirection, generic,
 * wrapped and malformed input all pass through untouched. The --shell path is
 * POSIX-only (single-quote escaping), so on Windows pipelines fail open.
 *
 * Run with: node tests/hooks/pre-bash-crusher-rewrite.test.js
 */
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const rewriteScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'pre-bash-crusher-rewrite.js');
const { run, computeCrushedCommand } = require(rewriteScript);

const POSIX = process.platform !== 'win32';

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
const runCase = (name, fn) => { if (test(name, fn)) passed++; else failed++; };

function invoke(command) {
  const out = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
  return JSON.parse(out).tool_input.command;
}

// Lets bash itself re-parse the single argument the rewrite produced, so the
// test proves the escaping is exact rather than trusting the regex. printf only
// echoes the argument; it never executes the wrapped command. POSIX-only.
function bashSees(rewritten) {
  const arg = rewritten.replace(/^egc run --shell /, '');
  return execFileSync('/bin/bash', ['-c', `printf '%s' ${arg}`], { encoding: 'utf8' });
}

console.log('\n=== Testing pre-bash-crusher-rewrite ===\n');

process.env.EGC_ASSUME_EGC_CLI = '1';

// --- Universal cases (every platform) ---

runCase('simple crushable command routes through egc run', () => {
  assert.strictEqual(invoke('git log --oneline -200'), 'egc run git log --oneline -200');
});

runCase('generic command passes through', () => {
  assert.strictEqual(invoke('ls -la src'), 'ls -la src');
});

runCase('gh --jq flag without a pipe stays a simple egc run', () => {
  assert.strictEqual(
    invoke("gh pr list --json number --jq '.[].number'"),
    "egc run gh pr list --json number --jq '.[].number'",
  );
});

runCase('backgrounding passes through untouched', () => {
  assert.strictEqual(invoke('npm test &'), 'npm test &');
  assert.strictEqual(invoke('git log | tail &'), 'git log | tail &');
});

runCase('redirection passes through untouched', () => {
  assert.strictEqual(invoke('git diff > out.txt'), 'git diff > out.txt');
  assert.strictEqual(invoke('git log 2> err.txt'), 'git log 2> err.txt');
});

runCase('already wrapped or raw commands pass through', () => {
  assert.strictEqual(invoke('egc run git log'), 'egc run git log');
  assert.strictEqual(invoke('git log --raw'), 'git log --raw');
});

runCase('malformed input passes through unchanged', () => {
  assert.strictEqual(run('not json'), 'not json');
});

runCase('without the egc CLI nothing is rewritten', () => {
  process.env.EGC_ASSUME_EGC_CLI = '0';
  assert.strictEqual(invoke('git log | head'), 'git log | head');
  process.env.EGC_ASSUME_EGC_CLI = '1';
});

// --- POSIX-only: the --shell path uses POSIX single-quote escaping ---

if (POSIX) {
  runCase('recognized pipeline routes through --shell', () => {
    assert.strictEqual(invoke('git log | head -5'), "egc run --shell 'git log | head -5'");
  });

  runCase('recognized chaining routes through --shell', () => {
    assert.strictEqual(invoke('git log && git status'), "egc run --shell 'git log && git status'");
  });

  runCase('gh json piped to jq is wrapped and bash re-parses it exactly', () => {
    const original = "gh pr list --json number | jq '.[].number'";
    const rewritten = invoke(original);
    assert.ok(rewritten.startsWith("egc run --shell '"), rewritten);
    assert.strictEqual(bashSees(rewritten), original);
  });

  runCase('escaping survives embedded single quotes, pipes and double quotes', () => {
    const original = 'gh pr view 950 --json x --jq \'.x[] | select(.name=="a")\' | cat';
    const rewritten = invoke(original);
    assert.strictEqual(bashSees(rewritten), original);
  });

  runCase('command substitution is re-parsed by bash, not altered', () => {
    const original = 'git log --format=%H | grep $(git rev-parse HEAD)';
    const rewritten = invoke(original);
    assert.strictEqual(bashSees(rewritten), original);
  });

  runCase('&& is not mistaken for backgrounding', () => {
    assert.ok(invoke('npm test && echo ok').startsWith('egc run --shell'));
  });
} else {
  runCase('pipelines fail open on Windows (POSIX escaping only)', () => {
    assert.strictEqual(invoke('git log | head -5'), 'git log | head -5');
    assert.strictEqual(invoke('git log && git status'), 'git log && git status');
  });
}

// --- EGC-512: shell metacharacters inside quotes must not force the --shell
// wrap; only *active* (unquoted, unescaped) syntax should.

runCase('a metacharacter inside single quotes stays a simple egc run', () => {
  assert.strictEqual(
    invoke("git log --grep='fix: a & b'"),
    "egc run git log --grep='fix: a & b'",
  );
});

runCase('pipe/semicolon/redirect inside double quotes stay a simple egc run', () => {
  assert.strictEqual(
    invoke('git log --grep="fix: a | b; c > d"'),
    'egc run git log --grep="fix: a | b; c > d"',
  );
});

runCase('a backslash-escaped metacharacter outside quotes stays a simple egc run', () => {
  assert.strictEqual(invoke('git log --grep=foo\\&bar'), 'egc run git log --grep=foo\\&bar');
});

if (POSIX) {
  runCase('an active $ inside double quotes still routes through --shell', () => {
    const original = 'git log --grep="fix: $(true)"';
    const rewritten = invoke(original);
    assert.ok(rewritten.startsWith("egc run --shell '"), rewritten);
    assert.strictEqual(bashSees(rewritten), original);
  });

  runCase('a backtick inside double quotes still routes through --shell', () => {
    const original = 'git log --grep="fix: `date +%Y`"';
    const rewritten = invoke(original);
    assert.ok(rewritten.startsWith("egc run --shell '"), rewritten);
    assert.strictEqual(bashSees(rewritten), original);
  });

  runCase('an unterminated quote falls back to the safer --shell path', () => {
    const original = "git log --grep='unterminated";
    const rewritten = invoke(original);
    assert.ok(rewritten.startsWith("egc run --shell '"), rewritten);
    assert.strictEqual(bashSees(rewritten), original);
  });
}

// --- computeCrushedCommand: shared by cursor-crusher-adapter.js and
// junie-crusher-adapter.js (cubic-dev-ai duplication finding, PR #1081) ---

runCase('computeCrushedCommand returns the rewritten command for a crushable input', () => {
  assert.strictEqual(computeCrushedCommand('git log --stat -n 300'), 'egc run git log --stat -n 300');
});

runCase('computeCrushedCommand returns null for a non-crushable command', () => {
  assert.strictEqual(computeCrushedCommand('echo hi'), null);
});

runCase('computeCrushedCommand returns null for an empty/falsy command', () => {
  assert.strictEqual(computeCrushedCommand(''), null);
  assert.strictEqual(computeCrushedCommand(undefined), null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
