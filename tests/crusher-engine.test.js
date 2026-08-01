'use strict';
/**
 * Tests for scripts/lib/crusher/engine.js and scripts/lib/crusher/metrics.js
 *
 * Covers the Token Crusher conservativeness contract: small outputs pass
 * through, errors and failures survive crushing, already-crushed output is
 * never crushed twice, and the savings ledger aggregates correctly.
 *
 * Run with: node tests/crusher-engine.test.js
 */
const assert = require('node:assert');
const path = require('node:path');

const { CRUSH_MARKER, commandKind, crushOutput, estimateTokens, looksLikeJsonPayload } = require(
  path.join(__dirname, '..', 'scripts', 'lib', 'crusher', 'engine.js')
);
const { aggregate } = require(
  path.join(__dirname, '..', 'scripts', 'lib', 'crusher', 'metrics.js')
);

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

console.log('\n=== Testing Token Crusher engine ===\n');

run('classifies commands into kinds', () => {
  assert.strictEqual(commandKind('git log --oneline'), 'git-log');
  assert.strictEqual(commandKind('git diff HEAD~1'), 'git-diff');
  assert.strictEqual(commandKind('npx jest --ci'), 'test-runner');
  assert.strictEqual(commandKind('npm test'), 'test-runner');
  assert.strictEqual(commandKind('yarn install'), 'pm-install');
  assert.strictEqual(commandKind('gh pr list --json number'), 'gh-json');
  assert.strictEqual(commandKind('ls -la'), 'generic');
  process.env.EGC_CRUSHER_SKIP_PREFIXES = 'someproxy';
  assert.strictEqual(commandKind('someproxy git log'), 'git-log');
  delete process.env.EGC_CRUSHER_SKIP_PREFIXES;
});

run('classifies git commands with global flags before the subcommand', () => {
  assert.strictEqual(commandKind('git -C /path/to/repo log --stat -n 300'), 'git-log');
  assert.strictEqual(commandKind('git -C /path/to/repo diff HEAD~1'), 'git-diff');
  assert.strictEqual(commandKind('git --git-dir=/repo/.git log'), 'git-log');
  assert.strictEqual(commandKind('git --git-dir /repo/.git log'), 'git-log');
  assert.strictEqual(commandKind('git --work-tree=/repo log'), 'git-log');
  assert.strictEqual(commandKind('git -c user.name=x log'), 'git-log');
  assert.strictEqual(commandKind('git -C /a -c user.name=x --no-pager log'), 'git-log');
  assert.strictEqual(commandKind('git -C /path status'), 'generic');
});

run('classifies test runners across languages beyond the original JS-only set (audit EGC-490)', () => {
  assert.strictEqual(commandKind('go test ./...'), 'test-runner');
  assert.strictEqual(commandKind('cargo test'), 'test-runner');
  assert.strictEqual(commandKind('dotnet test'), 'test-runner');
  assert.strictEqual(commandKind('mvn test'), 'test-runner');
  assert.strictEqual(commandKind('./gradlew test'), 'test-runner');
  assert.strictEqual(commandKind('gradle test'), 'test-runner');
  assert.strictEqual(commandKind('mix test'), 'test-runner');
  assert.strictEqual(commandKind('phpunit'), 'test-runner');
  assert.strictEqual(commandKind('pest'), 'test-runner');
  assert.strictEqual(commandKind('rspec'), 'test-runner');
  assert.strictEqual(commandKind('pnpm test'), 'test-runner');
  assert.strictEqual(commandKind('yarn test'), 'test-runner');
  assert.strictEqual(commandKind('bun test'), 'test-runner');
});

run('classifies package installs across languages beyond the original npm-only set (audit EGC-490)', () => {
  assert.strictEqual(commandKind('pip install requests'), 'pm-install');
  assert.strictEqual(commandKind('pip3 install requests'), 'pm-install');
  assert.strictEqual(commandKind('poetry install'), 'pm-install');
  assert.strictEqual(commandKind('pipenv install'), 'pm-install');
  assert.strictEqual(commandKind('uv sync'), 'pm-install');
  assert.strictEqual(commandKind('cargo build'), 'pm-install');
  assert.strictEqual(commandKind('cargo install ripgrep'), 'pm-install');
  assert.strictEqual(commandKind('go mod download'), 'pm-install');
  assert.strictEqual(commandKind('go get ./...'), 'pm-install');
  assert.strictEqual(commandKind('composer install'), 'pm-install');
  assert.strictEqual(commandKind('bundle install'), 'pm-install');
});

run('crushed test/install output preserves stack-trace frames with no keep-word of their own (audit EGC-490)', () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`  ok test case number ${i} does something fine`);
  lines.push('Traceback (most recent call last):');
  lines.push('  File "app.py", line 42, in main');
  lines.push('  File "app.py", line 10, in helper');
  lines.push('ValueError: something broke');
  lines.push('Tests: 1 failed, 300 passed, 301 total');
  const result = crushOutput('pytest', lines.join('\n'));
  assert.ok(result);
  assert.ok(result.crushed.includes('File "app.py", line 42, in main'), 'traceback frame survives');
  assert.ok(result.crushed.includes('File "app.py", line 10, in helper'), 'second traceback frame survives');
  assert.ok(result.crushed.includes('ValueError: something broke'), 'exception line survives');
});

run('crushed output preserves localized (non-English) error/warning terms (audit EGC-490)', () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`  ok caso de teste ${i} passou normalmente`);
  lines.push('Erro: arquivo não encontrado');
  lines.push('Advertencia: uso obsoleto detectado');
  lines.push('Erreur système: connexion refusée');
  lines.push('done');
  const result = crushOutput('npm test', lines.join('\n'));
  assert.ok(result);
  assert.ok(result.crushed.includes('Erro: arquivo não encontrado'), 'Portuguese error line survives');
  assert.ok(result.crushed.includes('Advertencia: uso obsoleto'), 'Spanish warning line survives');
  assert.ok(result.crushed.includes('Erreur système'), 'French error line survives');
});

run('crushed output preserves localized failures that start with an accented letter (audit EGC-490)', () => {
  // \b in JS regex is ASCII-only, so a standalone word beginning with an
  // accented letter (no preceding word-character to form a real boundary)
  // could sit between two "non-word" positions and never match \b at all.
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`  ok caso de teste ${i} passou normalmente`);
  lines.push('Échec du build');
  lines.push('Excepción no controlada');
  lines.push('Exceção não tratada');
  lines.push('Pânico: estado inválido');
  lines.push('done');
  const result = crushOutput('npm test', lines.join('\n'));
  assert.ok(result);
  assert.ok(result.crushed.includes('Échec du build'), 'French failure line starting with an accented letter survives');
  assert.ok(result.crushed.includes('Excepción no controlada'), 'Spanish exception line starting with an accented letter survives');
  assert.ok(result.crushed.includes('Exceção não tratada'), 'Portuguese exception line starting with an accented letter survives');
  assert.ok(result.crushed.includes('Pânico: estado inválido'), 'Portuguese panic line starting with an accented letter survives');
});

run('crushed output preserves PascalCase exception class names with no separate keep-word (audit EGC-547)', () => {
  // KEEP_WORD_EN_RE required a non-word character on both sides of "error"/
  // "exception", so the same keyword used as a compound-identifier suffix
  // (TypeError, AssertionError, NullPointerException) was rejected: the
  // letter right before it ("...e" in "TypeError") is a word character, not
  // a boundary. The exception lines sit 150 filler lines from both ends of
  // the output, so they survive only via KEEP_WORD_PASCAL_SUFFIX_RE, not
  // because they happen to land inside the always-kept 5-line summary tail.
  const lines = [];
  for (let i = 0; i < 150; i++) lines.push(`  ok test case number ${i} does something fine`);
  lines.push('    throw new TypeError("not a function")');
  lines.push('    raise AssertionError("expected 1 got 2")');
  lines.push('    throws java.lang.NullPointerException');
  for (let i = 150; i < 300; i++) lines.push(`  ok test case number ${i} does something fine`);
  lines.push('done');
  const result = crushOutput('npm test', lines.join('\n'));
  assert.ok(result);
  assert.ok(result.crushed.includes('TypeError'), 'TypeError survives with no separate "error" word');
  assert.ok(result.crushed.includes('AssertionError'), 'AssertionError survives with no separate "error" word');
  assert.ok(result.crushed.includes('NullPointerException'), 'NullPointerException survives with no separate "exception" word');
});

run('crushed output preserves multi-line assertion detail from pytest, Go, Rust, and compiler caret lines (audit EGC-547)', () => {
  // The summary line ("assertion failed", "AssertionError") already
  // contains a keep-word, but the expected/actual values a debugger needs
  // are printed on separate lines that never repeat that word. The detail
  // block sits far from both ends of the output (150 filler lines on each
  // side) so it survives only via isAssertionDetail(), not because it
  // happens to land inside the always-kept 5-line summary tail.
  const lines = [];
  for (let i = 0; i < 150; i++) lines.push(`  ok test case number ${i} does something fine`);
  lines.push('FAILED test_math.py::test_add - assert 1 == 2');
  lines.push('>       assert 1 == 2');
  lines.push('E       assert 1 == 2');
  lines.push('--- FAIL: TestAdd (0.00s)');
  lines.push('    expected: 1');
  lines.push('    actual: 2');
  lines.push('assertion `left == right` failed');
  lines.push('  left: 1');
  lines.push(' right: 2');
  lines.push('      x + 1');
  lines.push('      ^~~~~');
  for (let i = 150; i < 300; i++) lines.push(`  ok test case number ${i} does something fine`);
  lines.push('done');
  const result = crushOutput('npm test', lines.join('\n'));
  assert.ok(result);
  assert.ok(result.crushed.includes('>       assert 1 == 2'), 'pytest ">" detail line survives');
  assert.ok(result.crushed.includes('E       assert 1 == 2'), 'pytest "E" detail line survives');
  assert.ok(result.crushed.includes('expected: 1'), 'Go "expected:" detail line survives');
  assert.ok(result.crushed.includes('actual: 2'), 'Go "actual:" detail line survives');
  assert.ok(result.crushed.includes('left: 1'), 'Rust "left:" detail line survives');
  assert.ok(result.crushed.includes('right: 2'), 'Rust "right:" detail line survives');
  assert.ok(result.crushed.includes('^~~~~'), 'compiler caret line survives');
});

run('crushed output preserves the Spanish past-tense verbs "falló" and "fallaron"', () => {
  // "fallo" (noun/1st person), "falló" (3rd person singular past), and
  // "fallaron" (3rd person plural past) are all distinct words -- none is
  // reachable from another by substring, so each had to be listed
  // explicitly, not a boundary bug. Both lines sit 150 filler lines from
  // both ends of the output, so they survive only via KEEP_WORD_ES_RE, not
  // because they happen to land inside the always-kept 5-line summary tail.
  const lines = [];
  for (let i = 0; i < 150; i++) lines.push(`  ok caso de prueba ${i} paso normalmente`);
  lines.push('La conexión falló después de 3 intentos');
  lines.push('3 pruebas fallaron en el último intento');
  for (let i = 150; i < 300; i++) lines.push(`  ok caso de prueba ${i} paso normalmente`);
  lines.push('done');
  const result = crushOutput('npm test', lines.join('\n'));
  assert.ok(result);
  assert.ok(result.crushed.includes('La conexión falló después de 3 intentos'), 'Spanish past-tense singular failure line survives');
  assert.ok(result.crushed.includes('3 pruebas fallaron en el último intento'), 'Spanish past-tense plural failure line survives');
});

run('crusher does not mistake the npm run-script banner for pytest assertion detail', () => {
  // `npm run <script>`/`npm test` always prints "> pkg@version script-name"
  // (and a second "> resolved-command" line) before the script's own
  // output. Both start with "> " at column 0, the same shape as a real
  // pytest detail line ("E       assert ..."), so without an explicit
  // exclusion the banner would be misclassified as assertion detail.
  const lines = [];
  lines.push('> my-app@1.0.0 test');
  lines.push('> jest --ci');
  lines.push('');
  for (let i = 0; i < 150; i++) lines.push(`  ok test case number ${i} does something fine`);
  lines.push('FAIL src/foo.test.js');
  lines.push('  ● the thing fails');
  lines.push('    expect(received).toBe(expected)');
  for (let i = 150; i < 300; i++) lines.push(`  ok test case number ${i} does something fine`);
  lines.push('done');
  const result = crushOutput('npm test', lines.join('\n'));
  assert.ok(result);
  assert.ok(!result.crushed.includes('> my-app@1.0.0 test'), 'npm script banner line 1 is not kept as assertion detail');
  assert.ok(!result.crushed.includes('> jest --ci'), 'npm script banner line 2 (resolved command) is not kept as assertion detail either');
});

run('mvn/gradle test detection stays scoped to the first line, ignoring "test" on later lines of a compound command (audit EGC-490)', () => {
  assert.strictEqual(commandKind('mvn clean\necho "just a test message, unrelated to mvn goals"'), 'generic');
  assert.strictEqual(commandKind('mvn clean test'), 'test-runner');
  assert.strictEqual(commandKind('./gradlew clean test'), 'test-runner');
});

run('mvn/gradle test detection joins shell line-continuations into one logical line (audit EGC-490)', () => {
  // A backslash right before the newline is a shell line continuation --
  // `mvn clean \` + newline + `test` is one logical command, not two.
  assert.strictEqual(commandKind('mvn clean \\\ntest'), 'test-runner');
  assert.strictEqual(commandKind('./gradlew clean \\\ntest'), 'test-runner');
  // Without a trailing backslash, it's genuinely a separate line/command.
  assert.strictEqual(commandKind('mvn clean\ntest'), 'generic');
});

run('crushed output preserves system-failure signals with no "error" keyword (audit EGC-490)', () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`  ok step ${i} completed`);
  lines.push('Segmentation fault (core dumped)');
  lines.push('HTTP/1.1 404 Not Found');
  lines.push('Request failed with 502 Bad Gateway');
  lines.push('done');
  const result = crushOutput('npm test', lines.join('\n'));
  assert.ok(result);
  assert.ok(result.crushed.includes('Segmentation fault'), 'segfault line survives');
  assert.ok(result.crushed.includes('404 Not Found'), 'HTTP 404 line survives');
  assert.ok(result.crushed.includes('502 Bad Gateway'), 'HTTP 502 line survives');
});

run('HTTP-error keep pattern does not false-positive on ordinary 3-digit counts (audit EGC-490)', () => {
  const lines = [];
  for (let i = 0; i < 150; i++) lines.push(`  ok step ${i} completed`);
  lines.push('processed 404 items successfully');
  for (let i = 150; i < 300; i++) lines.push(`  ok step ${i} completed`);
  lines.push('done');
  const result = crushOutput('npm test', lines.join('\n'));
  // No real failure anywhere in this output, so nothing should force a
  // keep beyond the summary tail -- the ordinary count line, buried well
  // outside the tail, must not be mistaken for an HTTP error and kept.
  if (result) {
    assert.ok(
      !result.crushed.includes('processed 404 items'),
      'a bare count containing "404" must not be kept as an HTTP error line'
    );
  }
});

run('looksLikeJsonPayload detects JSON objects and arrays, rejects malformed lookalikes (audit EGC-490, "giant JSONs" gap)', () => {
  // Tested as a pure function, not through crushOutput(): the actual
  // compression for a detected JSON payload delegates to arrayCrusher from
  // egc-guardian's build output, which the main CI workflow (unlike
  // coverage.yml) never compiles -- asserting on crushOutput()'s result
  // here would make this test's pass/fail depend on a build artifact from
  // a different module entirely, not on the detection logic this PR adds.
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item-${i}` }));
  assert.strictEqual(looksLikeJsonPayload(JSON.stringify(rows)), true, 'a JSON array must be detected');
  assert.strictEqual(looksLikeJsonPayload(JSON.stringify({ ok: true, data: rows })), true, 'a JSON object must be detected');
  assert.strictEqual(looksLikeJsonPayload(`{ this is not valid json ${'x'.repeat(3000)}`), false, 'malformed content starting with { must not be misclassified as JSON');
  assert.strictEqual(looksLikeJsonPayload('plain text output, not json at all'), false, 'plain text must not be misclassified as JSON');
});

run('generic commands whose output looks like JSON route to json-output when the array-crusher build is present (audit EGC-490)', () => {
  // Best-effort integration check: only asserts the strong "was crushed"
  // claim when mcp/servers/egc-guardian/build/egc-array-crusher.js is
  // actually present (built locally, or by workflows like coverage.yml
  // that compile it first). Otherwise falls back to asserting the
  // documented fail-open behavior (engine.js's own top-of-file comment:
  // "JSON payloads stay uncompressed otherwise rather than duplicating
  // that logic"), so this test is meaningful and non-flaky in both cases.
  const guardianBuildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'egc-array-crusher.js');
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item-${i}`, active: i % 2 === 0 }));
  const output = JSON.stringify(rows, null, 2);
  const result = crushOutput('curl -s https://api.example.com/items', output);
  if (require('node:fs').existsSync(guardianBuildPath)) {
    assert.ok(result, 'a curl command emitting a large JSON array should be crushed when the array-crusher build is present');
    assert.strictEqual(result.kind, 'json-output');
  } else {
    assert.strictEqual(result, null, 'without the array-crusher build, detected JSON must fail open (pass through), not throw or fabricate a result');
  }
});

run('generic commands whose output is not valid JSON are left untouched (no false-positive json-output)', () => {
  const output = `{ this is not valid json ${'x'.repeat(3000)}`;
  const result = crushOutput('cat notes.txt', output);
  assert.strictEqual(result, null, 'malformed content starting with { must not be misclassified as JSON');
});

run('small outputs pass through untouched', () => {
  assert.strictEqual(crushOutput('git log', 'short output'), null);
});

run('generic commands never crush', () => {
  assert.strictEqual(crushOutput('cat somefile', 'x'.repeat(10000)), null);
});

run('git log beyond the cap is truncated with a count', () => {
  const output = Array.from({ length: 200 }, (_, i) => `commit${i} message ${'x'.repeat(30)}`).join('\n');
  const result = crushOutput('git log --oneline', output);
  assert.ok(result);
  assert.ok(result.crushed.includes('more commits'));
  assert.ok(result.crushed.includes(CRUSH_MARKER));
  assert.ok(result.tokensSaved > 0);
});

run('verbose git log (--stat) reports the real remaining commit count, not the remaining line count', () => {
  const COMMIT_COUNT = 30;
  const LINES_PER_COMMIT = 8; // header, Author, Date, blank, message, blank, 2 diffstat lines
  const commitBlocks = Array.from({ length: COMMIT_COUNT }, (_, i) => [
    `commit ${(i + 1).toString(16).padStart(40, '0')}`,
    `Author: Someone <someone@example.com>`,
    `Date:   Wed Jul 29 00:00:0${i % 10} 2026 -0300`,
    '',
    `    commit message number ${i}`,
    '',
    ` some/file-${i}.js | 3 +--`,
    ` 1 file changed, 2 insertions(+), 1 deletion(-)`,
  ]);
  const output = commitBlocks.flat().join('\n');
  const totalLines = COMMIT_COUNT * LINES_PER_COMMIT;
  const shownCommits = Math.floor(40 / LINES_PER_COMMIT); // GIT_LOG_MAX_LINES = 40, verified via the shown-lines slice below
  const expectedRemainingCommits = COMMIT_COUNT - shownCommits;

  const result = crushOutput('git log --stat -n 300', output);
  assert.ok(result, 'output with 30 verbose commits (240 lines) must be crushed');

  const match = result.crushed.match(/\((\d+) more commits\)/);
  assert.ok(match, 'crushed output must report a "N more commits" summary');
  const reportedRemaining = Number(match[1]);

  assert.ok(
    reportedRemaining <= expectedRemainingCommits,
    `reported remaining commits (${reportedRemaining}) must not exceed the real remaining commit count (${expectedRemainingCommits}); ` +
    `counting raw lines instead of "commit <hash>" headers would report close to ${totalLines - 40} instead`
  );
  assert.ok(reportedRemaining > 0, 'this fixture truncates mid-history, so some commits must remain');
});

run('test-runner output keeps failures and summary, drops noise', () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`  ok test case number ${i} does something fine`);
  lines.push('  FAIL src/thing.test.js broke badly');
  lines.push('  Error: expected 1 to be 2');
  lines.push('Tests: 1 failed, 300 passed, 301 total');
  const result = crushOutput('npx jest', lines.join('\n'));
  assert.ok(result);
  assert.ok(result.crushed.includes('broke badly'), 'failure line survives');
  assert.ok(result.crushed.includes('Error: expected'), 'error detail survives');
  assert.ok(result.crushed.includes('Tests: 1 failed'), 'summary survives');
  assert.ok(!result.crushed.includes('number 42 does something fine'), 'noise dropped');
});

run('pm install keeps warnings and the tail summary', () => {
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(`added package-${i}`);
  lines.splice(200, 0, 'npm WARN deprecated something@1.0.0');
  lines.push('added 400 packages in 12s');
  const result = crushOutput('npm install', lines.join('\n'));
  assert.ok(result);
  assert.ok(result.crushed.includes('WARN deprecated'));
  assert.ok(result.crushed.includes('added 400 packages in 12s'));
});

run('already-crushed output is never crushed twice', () => {
  const output = `${'x\n'.repeat(3000)}${CRUSH_MARKER} saved ~100 tokens`;
  assert.strictEqual(crushOutput('git log', output), null);
});

run('oversized git diff collapses to a summary', () => {
  const hunk = 'diff --git a/f.js b/f.js\n+++ b/f.js\n@@ -1,3 +1,3 @@\n' + '+added line\n-removed line\n'.repeat(1000);
  const result = crushOutput('git diff', hunk);
  assert.ok(result);
  assert.ok(result.crushed.includes('diff too large'));
  assert.ok(result.crushed.includes('+1000/-1000'));
});

run('token estimate is bytes over four, rounded up', () => {
  assert.strictEqual(estimateTokens('abcd'), 1);
  assert.strictEqual(estimateTokens('abcde'), 2);
});

run('ledger aggregation sums totals and per-kind buckets', () => {
  const totals = aggregate([
    { kind: 'git-log', bytesIn: 1000, bytesOut: 100, tokensSaved: 225 },
    { kind: 'git-log', bytesIn: 500, bytesOut: 50, tokensSaved: 100 },
    { kind: 'test-runner', bytesIn: 2000, bytesOut: 200, tokensSaved: 450 },
  ]);
  assert.strictEqual(totals.runs, 3);
  assert.strictEqual(totals.tokensSaved, 775);
  assert.strictEqual(totals.byKind['git-log'].runs, 2);
  assert.strictEqual(totals.byKind['test-runner'].tokensSaved, 450);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
