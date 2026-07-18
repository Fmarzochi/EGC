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

const KEEP_LINE_RE = /\b(error|fail|failed|failing|warn|warning|fatal|denied|refused|exception)\b/i;

function commandKind(command) {
  const normalized = command.trim().replace(/^rtk\s+/, '');
  if (/^git\s+log\b/.test(normalized)) return 'git-log';
  if (/^git\s+diff\b/.test(normalized)) return 'git-diff';
  if (/\b(jest|vitest|pytest|mocha)\b/.test(normalized) || /npm\s+(run\s+)?test\b/.test(normalized) || /node\s+\S*tests?\//.test(normalized)) return 'test-runner';
  if (/^(npm|yarn|pnpm|bun)\s+(install|ci|add|i)\b/.test(normalized)) return 'pm-install';
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

function crushGitLog(output) {
  const lines = output.split('\n');
  if (lines.length <= GIT_LOG_MAX_LINES) return null;
  return [...lines.slice(0, GIT_LOG_MAX_LINES), `... (${lines.length - GIT_LOG_MAX_LINES} more commits)`].join('\n');
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
  const kept = lines.filter(l =>
    KEEP_LINE_RE.test(l)
    || /^\s*(Tests|Test Suites|Snapshots|Time|Ran all|passed|failed|✕|✗|✖|FAIL|PASS:?\s*$)/i.test(l.trim())
    || /^\s*\d+ (passed|failed|skipped|pending)/i.test(l)
  );
  const summaryTail = lines.slice(-5).filter(l => l.trim());
  const merged = [...new Set([...kept, ...summaryTail])];
  if (merged.length >= lines.length) return null;
  return merged.join('\n');
}

function crushPmInstall(output) {
  const lines = output.split('\n');
  const kept = lines.filter(l => KEEP_LINE_RE.test(l));
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

const CRUSHERS = {
  'git-log': crushGitLog,
  'git-diff': crushGitDiff,
  'test-runner': crushTestRunner,
  'pm-install': crushPmInstall,
  'gh-json': crushGhJson,
  generic: () => null,
};

// Returns { crushed, kind, bytesIn, bytesOut, tokensSaved } or null when the
// output should pass through untouched.
function crushOutput(command, output) {
  if (!output || Buffer.byteLength(output, 'utf8') < MIN_BYTES_TO_CRUSH) return null;
  if (output.includes(CRUSH_MARKER)) return null;

  const kind = commandKind(command);
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
};
