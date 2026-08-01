'use strict';

// Token Crusher engine: compresses shell command output before it reaches the
// model. Conservative by design: errors, warnings and failures are never
// dropped, small outputs pass through untouched, and every crushed payload
// carries the CRUSH_MARKER so downstream reducers can no-op instead of
// compressing twice.

const CRUSH_MARKER = '[egc-crusher]';
const MIN_BYTES_TO_CRUSH = 2048;
const GIT_LOG_MAX_LINES = 40;
const GIT_DIFF_MAX_BYTES = 8192;

function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function tryRequire(modulePath) {
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}

// Reuses the SmartCrusher from egc-guardian when its build is present; JSON
// payloads stay uncompressed otherwise rather than duplicating that logic.
const arrayCrusher = tryRequire('../../../mcp/servers/egc-guardian/build/egc-array-crusher.js');

// Keep-word list, English plus the error/warning/failure terms of the
// locales EGC ships READMEs for (pt, es, fr, de, it) -- a localized CLI
// (e.g. git or a test runner under LANG=pt_BR) must not have its failures
// silently dropped just because they're not in English. Split into
// per-language regexes (rather than one large alternation) to keep each
// one's cyclomatic complexity within SonarCloud's limit.
//
// \b in JavaScript regex is ASCII-only ([A-Za-z0-9_]): it does not treat
// accented letters as "word" characters, so a standalone word starting
// with one (e.g. "Échec", "Pânico") can sit between two non-word
// positions and never trigger a \b boundary at all, silently failing to
// match. \p{L}/\p{N} (with the u flag) are Unicode-aware, so lookaround
// built from them correctly treats accented letters as word characters.
const KEEP_WORD_EN_RE = /(?<![\p{L}\p{N}_])(error|fail|failed|failing|warn|warning|fatal|denied|refused|exception|panic)(?![\p{L}\p{N}_])/iu;
const KEEP_WORD_PT_RE = /(?<![\p{L}\p{N}_])(erro|falha|aviso|negado|recusado|exceção|pânico)(?![\p{L}\p{N}_])/iu;
const KEEP_WORD_ES_RE = /(?<![\p{L}\p{N}_])(fallo|falló|falla|fallé|fallando|fallado|fallaron|advertencia|denegado|rechazado|excepción)(?![\p{L}\p{N}_])/iu;
const KEEP_WORD_FR_DE_IT_RE = /(?<![\p{L}\p{N}_])(erreur|échec|panne|avertissement|warnung|fehler|errore|avviso)(?![\p{L}\p{N}_])/iu;

// The boundary regexes above require a NON-word character on both sides,
// which is correct for a standalone word ("error: x") but wrongly rejects
// the same keyword used as a PascalCase compound-identifier suffix
// (TypeError, AssertionError, NullPointerException): the letter immediately
// before the capitalized keyword ("...e" in "TypeError") fails the negative
// lookbehind, so the exception class name was silently dropped from every
// language's test/traceback output. Case-sensitive on purpose -- this only
// needs to catch the capitalized suffix form; the lowercase standalone form
// is already covered by KEEP_WORD_EN_RE above.
const KEEP_WORD_PASCAL_SUFFIX_RE = /(?<=[\p{L}\p{N}_])(Error|Exception|Fatal|Warning|Failure|Panic)(?![\p{L}\p{N}_])/u;

function matchesKeepWord(line) {
  return KEEP_WORD_EN_RE.test(line)
    || KEEP_WORD_PT_RE.test(line)
    || KEEP_WORD_ES_RE.test(line)
    || KEEP_WORD_FR_DE_IT_RE.test(line)
    || KEEP_WORD_PASCAL_SUFFIX_RE.test(line);
}

// Stack-trace frame lines carry no keep-word of their own (a Python
// traceback's `File "app.py", line 42, in main` or a JS `at Object.<...>`
// line never says "error") but dropping them guts the exact context a
// debugger -- human or model -- needs to find the failure. Matches the
// common frame shapes across Python, JS/Node, Java, and C/C++ tracebacks.
// Split into one regex per frame shape (rather than one alternation) to
// keep each one's cyclomatic complexity within SonarCloud's limit.
const STACK_FRAME_AT_RE = /^\s*at\s+\S+/i;
const STACK_FRAME_PY_RE = /^\s*File\s+"[^"]+",\s+line\s+\d+/i;
const STACK_FRAME_NATIVE_RE = /^\s*#\d+\s+0x[0-9a-f]+/i;
const STACK_FRAME_CAUSE_RE = /^\s*(Caused by:|\.{3}\s+\d+\s+more)/i;

function isStackFrame(line) {
  return STACK_FRAME_AT_RE.test(line)
    || STACK_FRAME_PY_RE.test(line)
    || STACK_FRAME_NATIVE_RE.test(line)
    || STACK_FRAME_CAUSE_RE.test(line);
}

// Assertion-detail continuation lines: the summary line ("assertion failed",
// "AssertionError") already contains a keep-word, but the actual expected/
// actual values a debugger needs are printed on separate lines that never
// repeat that word, so they were silently stripped even though they are the
// entire point of keeping the failure. One pattern per shape (rather than one
// alternation) to keep cyclomatic complexity within SonarCloud's limit.
// Both Go and Rust patterns require at least one leading space: real
// assertion-detail lines are always indented under a failure header
// (--- FAIL:, assertion `left == right` failed), while requiring
// indentation measurably narrows (without a whole-output failure-context
// state machine, out of scope here) the odds of matching an unrelated
// line of normal column-0 output that happens to start with the same
// word, audit EGC-547.
//
// The pytest pattern can't require indentation the same way: a real
// pytest detail line ("E       assert 1 == 2") is itself column-0, and so
// is npm's own "> pkg@version script-name" banner line that `npm run
// <script>`/`npm test` always prints first -- both start with `>`/`E` at
// the same indentation, so an indentation requirement would just trade
// one false positive for a false negative on real pytest output. The npm
// banner is excluded by position instead (see npmScriptBannerLineCount
// below), not by shape, since its second line ("> resolved-command") has
// no shape of its own to exclude.
const ASSERT_DETAIL_PYTEST_RE = /^\s*[>E]\s+\S/;
const ASSERT_DETAIL_GO_RE = /^\s+(expected|actual|got|want)\s*:/i;
const ASSERT_DETAIL_RUST_RE = /^\s+(left|right)\s*:\s/;
const ASSERT_DETAIL_CARET_RE = /^\s*\^[\^~]*\s*$/;

function isAssertionDetail(line) {
  return ASSERT_DETAIL_PYTEST_RE.test(line)
    || ASSERT_DETAIL_GO_RE.test(line)
    || ASSERT_DETAIL_RUST_RE.test(line)
    || ASSERT_DETAIL_CARET_RE.test(line);
}

// npm's own two-line banner -- "> pkg@version script-name" followed by
// "> resolved-command" -- is always printed together at the very start of
// `npm run <script>`/`npm test`, before any of the script's own output.
// Both lines share the same column-0 "> " shape as a real pytest detail
// line, so isAssertionDetail() can't tell them apart by shape alone: the
// first line has a recognizable pkg@version marker, but the second is just
// whatever command package.json resolved to, with no shape of its own.
// Recognized by position instead -- this banner can only ever be the first
// two lines of the whole output.
const NPM_SCRIPT_BANNER_RE = /^>\s+\S+@\S+\s/;
const NPM_BANNER_CONTINUATION_RE = /^>\s+\S/;

function npmScriptBannerLineCount(lines) {
  if (NPM_SCRIPT_BANNER_RE.test(lines[0] || '') && NPM_BANNER_CONTINUATION_RE.test(lines[1] || '')) {
    return 2;
  }
  return 0;
}

// System-level failure signals that never contain the word "error": a
// killed or crashed process, or an HTTP status line/code carrying a
// standard reason phrase. The HTTP pattern requires a known reason phrase
// (not just any 3-digit number) so it doesn't false-positive on ordinary
// counts like "processed 404 items".
const SYSTEM_FAILURE_RE = /\b(segmentation fault|core dumped|killed|out of memory|oom[- ]?killed|aborted|stack overflow)\b/i;
const HTTP_ERROR_RE = /\b(?:HTTP\/[\d.]+\s+)?[45]\d{2}\s+(Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Conflict|Gone|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i;

function shouldKeepLine(line) {
  return matchesKeepWord(line)
    || isStackFrame(line)
    || isAssertionDetail(line)
    || SYSTEM_FAILURE_RE.test(line)
    || HTTP_ERROR_RE.test(line);
}

// Terminal color codes glue onto words (ESC[31merror) and break the \b
// word boundary, silently dropping colored error lines from the kept set.
// Built via the constructor because eslint forbids control chars in literals.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
function stripAnsi(line) {
  return line.replace(ANSI_RE, '');
}

// EGC_CRUSHER_SKIP_PREFIXES names other local CLI proxies; their prefix is
// stripped so the underlying command is still classified correctly.
function stripProxyPrefix(command) {
  const trimmed = command.trim();
  const prefixes = (process.env.EGC_CRUSHER_SKIP_PREFIXES || '')
    .split(',')
    .map(p => p.trim())
    .filter(p => /^[\w.-]+$/.test(p));
  for (const prefix of prefixes) {
    if (trimmed.startsWith(`${prefix} `)) return trimmed.slice(prefix.length + 1);
  }
  return trimmed;
}

// Global git flags that can appear between `git` and the subcommand (e.g.
// `git -C /repo log`, common in scripts and CI). Each alternative consumes
// its own trailing whitespace so the group can repeat for stacked flags.
const GIT_GLOBAL_FLAG =
  String.raw`(?:-C|-c|--git-dir|--work-tree|--namespace)(?:=\S+|\s+\S+)\s+`
  + String.raw`|(?:--no-pager|--paginate|-p)\s+`;
const GIT_GLOBAL_PREFIX_RE = new RegExp(String.raw`^git\s+(?:${GIT_GLOBAL_FLAG})*`); // NOSONAR: bounded alternation over a fixed flag set, no backtracking blowup

function stripGitGlobalFlags(command) {
  return command.replace(GIT_GLOBAL_PREFIX_RE, 'git ');
}

// Test runners across every language EGC ships coding-style rules for, not
// just the JS ones: go/cargo/dotnet/mvn/gradle/phpunit/pest/rspec/mix each
// produce their own kind of noisy pass/fail spam that never touched
// crushTestRunner() before, silently falling through to 'generic' (0%
// compression) for the majority of the catalog's supported languages.
function isTestRunnerCommand(normalized) {
  return /\b(jest|vitest|pytest|mocha|phpunit|pest|rspec)\b/.test(normalized)
    || /(?:^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/.test(normalized)
    || /node\s+\S*tests?\//.test(normalized)
    || /^go\s+test\b/.test(normalized)
    || /^cargo\s+test\b/.test(normalized)
    || /^dotnet\s+test\b/.test(normalized)
    || isMvnGradleTestCommand(normalized)
    || /^mix\s+test\b/.test(normalized);
}

// mvn/gradle take a goal list (e.g. `mvn clean test`), so the goal can
// appear anywhere after the binary name. A single `.*\btest\b` regex for
// that is super-linear on adversarial input (backtracking blowup on long
// inputs with no "test" anywhere), so this checks the prefix and the
// "test" keyword as two separate, individually-linear regexes instead --
// but scoped to just the first LOGICAL line of `normalized`, not the
// whole (possibly multi-line, compound) command string. Without that
// scoping, an unrelated "test" on a later line of a compound command
// (e.g. `mvn clean\necho "a test message"`) would wrongly flag the whole
// thing as a test-runner command. A backslash immediately before the
// newline is a shell line continuation (e.g. `mvn clean \` + newline +
// `test`), not a separate command, so those are joined back into one
// logical line before splitting -- otherwise a goal on the continuation
// line would be missed.
function isMvnGradleTestCommand(normalized) {
  const logicalFirstLine = normalized.replace(/\\\r?\n/g, ' ').split(/\r?\n/, 1)[0];
  return /^(mvn|\.\/?gradlew|gradle)\s/.test(logicalFirstLine) && /\btest\b/.test(logicalFirstLine);
}

// Package/dependency install commands across every language EGC installs
// rules for, not just the npm ecosystem -- pip/poetry/cargo/go/composer/
// bundle installs each emit their own kind of noisy install spam that fell
// through to 'generic' before.
function isPmInstallCommand(normalized) {
  return /^(npm|yarn|pnpm|bun)\s+(install|ci|add|i)\b/.test(normalized)
    || /^pip3?\s+install\b/.test(normalized)
    || /^poetry\s+(install|add|update)\b/.test(normalized)
    || /^pipenv\s+install\b/.test(normalized)
    || /^uv\s+(sync|add|pip\s+install)\b/.test(normalized)
    || /^cargo\s+(build|install|add)\b/.test(normalized)
    || /^go\s+(mod\s+download|get)\b/.test(normalized)
    || /^composer\s+(install|update|require)\b/.test(normalized)
    || /^bundle\s+install\b/.test(normalized);
}

function commandKind(command) {
  const normalized = stripGitGlobalFlags(stripProxyPrefix(command));
  if (/^git\s+log\b/.test(normalized)) return 'git-log';
  if (/^git\s+diff\b/.test(normalized)) return 'git-diff';
  if (isTestRunnerCommand(normalized)) return 'test-runner';
  if (isPmInstallCommand(normalized)) return 'pm-install';
  if (/^gh\b.*--json\b/.test(normalized)) return 'gh-json';
  return 'generic';
}

function headTail(lines, head, tail) {
  if (lines.length <= head + tail + 1) return lines;
  return [
    ...lines.slice(0, head),
    `... (${lines.length - head - tail} lines omitted)`,
    ...lines.slice(-tail),
  ];
}

// Verbose formats (--stat, the default, etc.) emit one "commit <hash>" header
// line per commit followed by several body lines (author, date, message,
// diffstat) -- counting raw lines omitted would wildly overstate how many
// commits remain. Formats with no such header (e.g. --oneline) put exactly
// one commit per line, so falling back to a line count there is accurate.
const GIT_LOG_COMMIT_HEADER_RE = /^commit [0-9a-f]{7,40}\b/;

function crushGitLog(output) {
  const lines = output.split('\n');
  if (lines.length <= GIT_LOG_MAX_LINES) return null;

  const shownLines = lines.slice(0, GIT_LOG_MAX_LINES);
  const remainingLines = lines.slice(GIT_LOG_MAX_LINES);
  const hasCommitHeaders = lines.some(line => GIT_LOG_COMMIT_HEADER_RE.test(line));
  const remainingCount = hasCommitHeaders
    ? remainingLines.filter(line => GIT_LOG_COMMIT_HEADER_RE.test(line)).length
    : remainingLines.length;

  return [...shownLines, `... (${remainingCount} more commits)`].join('\n');
}

function crushGitDiff(output) {
  if (Buffer.byteLength(output, 'utf8') <= GIT_DIFF_MAX_BYTES) return null;
  const lines = output.split('\n');
  const fileHeaders = lines.filter(l => l.startsWith('diff --git') || l.startsWith('+++ ') || l.startsWith('@@'));
  const additions = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
  const deletions = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
  return [
    `diff too large for context: +${additions}/-${deletions} across ${lines.filter(l => l.startsWith('diff --git')).length} file(s)`,
    ...headTail(fileHeaders, 30, 10),
  ].join('\n');
}

function crushTestRunner(output) {
  const lines = output.split('\n');
  const bannerLineCount = npmScriptBannerLineCount(lines);
  const kept = lines.filter((raw, i) => {
    if (i < bannerLineCount) return false;
    const l = stripAnsi(raw);
    return shouldKeepLine(l)
      || /^\s*(Tests|Test Suites|Snapshots|Time|Ran all|passed|failed|\u2715|\u2717|\u2716|FAIL|PASS:?\s*$)/i.test(l.trim())
      || /^\s*\d+ (passed|failed|skipped|pending)/i.test(l);
  });
  const summaryTail = lines.slice(-5).filter(l => l.trim());
  const merged = [...new Set([...kept, ...summaryTail])];
  if (merged.length >= lines.length) return null;
  return merged.join('\n');
}

function crushPmInstall(output) {
  const lines = output.split('\n');
  const kept = lines.filter(l => shouldKeepLine(stripAnsi(l)));
  const tail = lines.slice(-6).filter(l => l.trim());
  const merged = [...new Set([...kept, ...tail])];
  if (merged.length >= lines.length) return null;
  return merged.join('\n');
}

function crushGhJson(output) {
  if (!arrayCrusher || typeof arrayCrusher.reduceJsonArray !== 'function') return null;
  const result = arrayCrusher.reduceJsonArray(output);
  if (!result) return null;
  return `${result.crushed}\n(${result.rows_before} rows reduced to ${result.rows_after})`;
}

// `gh ... --json` was the only command pattern that ever routed to
// crushGhJson, so a `curl`, `kubectl -o json`, or `cat big.json` payload
// -- equally "giant JSON" by any reasonable reading of that promise --
// fell through to 'generic' untouched. Detecting by the shape of the
// OUTPUT rather than enumerating every possible JSON-emitting command
// generalizes this without needing to keep chasing new command names.
// Only runs past the byte-length gate crushOutput() already applies, and
// only when the command didn't already match a more specific kind.
function looksLikeJsonPayload(output) {
  const trimmed = output.trim();
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

const CRUSHERS = {
  'git-log': crushGitLog,
  'git-diff': crushGitDiff,
  'test-runner': crushTestRunner,
  'pm-install': crushPmInstall,
  'gh-json': crushGhJson,
  'json-output': crushGhJson,
  generic: () => null,
};

// Returns { crushed, kind, bytesIn, bytesOut, tokensSaved } or null when the
// output should pass through untouched.
function crushOutput(command, output) {
  if (!output || Buffer.byteLength(output, 'utf8') < MIN_BYTES_TO_CRUSH) return null;
  if (output.includes(CRUSH_MARKER)) return null;

  let kind = commandKind(command);
  if (kind === 'generic' && looksLikeJsonPayload(output)) {
    kind = 'json-output';
  }
  const crushed = CRUSHERS[kind](output);
  if (crushed === null || Buffer.byteLength(crushed, 'utf8') >= Buffer.byteLength(output, 'utf8')) {
    return null;
  }

  const bytesIn = Buffer.byteLength(output, 'utf8');
  const bytesOut = Buffer.byteLength(crushed, 'utf8');
  const tokensSaved = estimateTokens(output) - estimateTokens(crushed);
  const stamped = `${crushed}\n${CRUSH_MARKER} saved ~${tokensSaved} tokens (full output: rerun with --raw)`;

  return { crushed: stamped, kind, bytesIn, bytesOut, tokensSaved };
}

module.exports = {
  CRUSH_MARKER,
  MIN_BYTES_TO_CRUSH,
  commandKind,
  crushOutput,
  estimateTokens,
  looksLikeJsonPayload,
};
