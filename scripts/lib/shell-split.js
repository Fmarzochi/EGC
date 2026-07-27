'use strict';

function pushSegment(current, segments) {
  if (current.trim()) segments.push(current.trim());
}

function handleInsideQuotes(ch, i, command, quote) {
  if (ch === '\\' && i + 1 < command.length) {
    return { chars: ch + command[i + 1], advance: 1, closeQuote: false };
  }
  return { chars: ch, advance: 0, closeQuote: ch === quote };
}

function handleEscape(ch, i, command) {
  if (ch === '\\' && i + 1 < command.length) {
    return { chars: ch + command[i + 1], advance: 1, handled: true };
  }
  return { handled: false };
}

function handleDoubleOperator(ch, next, current, segments) {
  if (ch === '&' && next === '&') {
    pushSegment(current, segments);
    return { current: '', advance: 1, handled: true };
  }
  if (ch === '|' && next === '|') {
    pushSegment(current, segments);
    return { current: '', advance: 1, handled: true };
  }
  return { handled: false };
}

function handleSingleAmpersand(ch, next, prev, current, segments) {
  if (ch !== '&') return { handled: false };
  if (next === '>' || prev === '>') {
    return { current: current + ch, handled: true };
  }
  pushSegment(current, segments);
  return { current: '', handled: true };
}

// Matches a heredoc redirect operator (<<EOF, <<-EOF, <<'EOF', <<"EOF") at
// the start of the given string. Group 1/2 capture a quoted delimiter
// (quotes stripped, no escape processing needed inside); group 3 captures a
// bare or backslash-escaped delimiter word.
const HEREDOC_OPERATOR_RE = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|(\\?[A-Za-z_]\w*))/;

/**
 * Split a shell command into segments by operators (&&, ||, ;, &)
 * while respecting quoting (single/double) and escaped characters.
 * Redirection operators (&>, >&, 2>&1) are NOT treated as separators.
 *
 * A heredoc body (<<EOF ... EOF) is never split on its own embedded
 * newlines/operators — its content is literal data for the command that
 * requested it, not further shell syntax, so a line inside it that merely
 * resembles a destructive command (e.g. a code example in a commit message
 * template) must not be judged as its own segment. Only one heredoc is
 * tracked at a time (the common case); a line consisting of exactly the
 * delimiter (leading tabs stripped first for the `<<-` form) ends the body.
 *
 * options.splitOnPipe (default false) additionally splits on a bare `|`
 * (not `||`, already handled above). Off by default because an existing
 * caller (dev-server-block) is tested against pipelines staying one
 * segment; the guardian command validator opts in, since a pipeline stage
 * can itself be a wrapper/destructive command (`echo x | xargs rm -rf`)
 * that needs to be judged as its own segment.
 */
function splitShellSegments(command, options = {}) { // NOSONAR: shell segment parser state machine kept inline for auditability
  const splitOnPipe = Boolean(options.splitOnPipe);
  const segments = [];
  let current = '';
  let quote = null;
  // Heredoc state machine: null (no heredoc pending) -> 'awaiting-body' (the
  // <<DELIM operator was just parsed; the body starts at the NEXT newline,
  // not immediately) -> 'in-body' (scanning body lines for the terminator)
  // -> null again. Keeping this as one variable (rather than a heredocState
  // flag plus a separate "seen delimiter" flag) is deliberate: two
  // independently-updated flags previously went out of sync exactly at this
  // transition, causing the terminator's own trailing newline to be
  // swallowed into the body instead of ending the segment.
  let heredocState = null;
  let heredocDelimiter = null;
  let heredocStripLeadingTabs = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (heredocState === 'in-body') {
      const lineEnd = command.indexOf('\n', i);
      const rawLine = lineEnd === -1 ? command.slice(i) : command.slice(i, lineEnd);
      const line = rawLine.replace(/\r$/, '');
      const candidate = heredocStripLeadingTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === heredocDelimiter) {
        current += rawLine;
        i += rawLine.length - 1;
        heredocState = null;
        heredocDelimiter = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (quote) {
      const r = handleInsideQuotes(ch, i, command, quote);
      current += r.chars;
      i += r.advance;
      if (r.closeQuote) quote = null;
      continue;
    }

    const esc = handleEscape(ch, i, command);
    if (esc.handled) {
      current += esc.chars;
      i += esc.advance;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (heredocState === 'awaiting-body' && ch === '\n') {
      current += ch;
      heredocState = 'in-body';
      continue;
    }

    if (heredocState === null && ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const m = HEREDOC_OPERATOR_RE.exec(command.slice(i));
      if (m) {
        heredocDelimiter = m[1] ?? m[2] ?? m[3].replace(/\\/g, '');
        heredocStripLeadingTabs = m[0].startsWith('<<-');
        heredocState = 'awaiting-body';
        current += m[0];
        i += m[0].length - 1;
        continue;
      }
    }

    if (ch === '\n' || ch === '\r') {
      pushSegment(current, segments);
      current = '';
      continue;
    }

    const next = command[i + 1] || '';
    const prev = i > 0 ? command[i - 1] : '';

    const dbl = handleDoubleOperator(ch, next, current, segments);
    if (dbl.handled) {
      current = dbl.current;
      i += dbl.advance;
      continue;
    }

    if (ch === ';') {
      pushSegment(current, segments);
      current = '';
      continue;
    }

    if (splitOnPipe && ch === '|') {
      pushSegment(current, segments);
      current = '';
      continue;
    }

    const amp = handleSingleAmpersand(ch, next, prev, current, segments);
    if (amp.handled) {
      current = amp.current;
      continue;
    }

    current += ch;
  }

  pushSegment(current, segments);
  return segments;
}

// Finds the index of the `)` that matches the `(` implicitly opened at
// `start` (i.e. `start` is the position right after that `(`), honoring
// quotes so an unbalanced paren inside a quoted string doesn't close early.
// Returns -1 if the input is malformed (no matching close) — callers must
// treat that as "nothing to extract here", not throw.
function findMatchingParen(command, start) {
  let depth = 1;
  let quote = null;
  for (let i = start; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) { i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingBacktick(command, start) {
  for (let i = start; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && i + 1 < command.length) { i += 1; continue; }
    if (ch === '`') return i;
  }
  return -1;
}

function pushSubstitutionAt(command, i, bodies) {
  const next = command[i + 1] || '';
  const ch = command[i];
  if ((ch === '$' || ch === '<' || ch === '>') && next === '(') {
    const end = findMatchingParen(command, i + 2);
    if (end !== -1) {
      bodies.push(command.slice(i + 2, end));
      return end;
    }
  }
  if (ch === '`') {
    const end = findMatchingBacktick(command, i + 1);
    if (end !== -1) {
      bodies.push(command.slice(i + 1, end));
      return end;
    }
  }
  return -1;
}

/**
 * Extracts the inner text of every top-level command substitution
 * (`$(...)`), process substitution (`<(...)`, `>(...)`), and legacy
 * backtick substitution (`` `...` ``) in a command string, honoring quotes.
 * A command hidden inside one of these executes exactly like the rest of
 * the command line — `echo $(rm -rf /)` still runs `rm -rf /` — but neither
 * character (`$`/backtick) is itself a segment separator, so without this
 * extraction its content is invisible to segment-based validation and is
 * covered only by the advisory (non-blocking) metacharacter check.
 *
 * Double quotes do NOT suppress `$(...)`/backtick expansion in a real shell
 * (only single quotes do), so both are still recognized while quote === '"'
 * — `echo "$(rm -rf /)"` is just as live as the unquoted form. Process
 * substitution (`<(...)`/`>(...)`) has no special meaning inside either
 * quote type (it is a bare word there), so it is only recognized unquoted.
 *
 * Not recursive by itself — a caller that re-scans each returned body finds
 * substitutions nested inside substitutions; keeping recursion at the call
 * site (with its own depth guard) keeps this function simple and testable
 * in isolation.
 */
function extractSubstitutionBodies(command) {
  const bodies = [];
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote === "'") {
      if (ch === quote) quote = null;
      continue;
    }

    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) { i += 1; continue; }
      if (ch === quote) { quote = null; continue; }
      const end = pushSubstitutionAt(command, i, bodies);
      if (end !== -1) { i = end; continue; }
      continue;
    }

    if (ch === '\\' && i + 1 < command.length) { i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }

    const end = pushSubstitutionAt(command, i, bodies);
    if (end !== -1) { i = end; continue; }
  }

  return bodies;
}

module.exports = { splitShellSegments, extractSubstitutionBodies };
