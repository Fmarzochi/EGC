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

// Characters that end an unquoted heredoc delimiter word (whitespace or a
// shell metacharacter) — anything else, including punctuation like `-` or
// `.`, is part of the word. A bare regex like [A-Za-z_]\w* previously
// stopped at the first non-identifier character, silently truncating a
// delimiter such as `EOF-1` down to `EOF`: the parser then waited forever
// for a body line that read exactly `EOF` (which never appears, since the
// real terminator is `EOF-1`), so the heredoc body never closed and every
// command after it was swallowed as inert body text instead of validated.
const HEREDOC_WORD_STOP_RE = /[\s;&|()<>]/;

// Parses one (possibly quoted/escaped) word starting at `command[start]`,
// honoring bash's rule that quoted and unquoted parts of the same word can
// be concatenated (`EO"F"1` is the word `EOF1`). Returns null on an
// unterminated quote (malformed input — the caller must not guess a
// delimiter out of it) or if no word is present at all.
function parseHeredocDelimiterWord(command, start) {
  let i = start;
  let value = '';
  let literal = false;
  let consumedAny = false;

  while (i < command.length) {
    const ch = command[i];
    if (ch === '\\' && i + 1 < command.length) {
      value += command[i + 1];
      literal = true;
      i += 2;
      consumedAny = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const closeIndex = command.indexOf(ch, i + 1);
      if (closeIndex === -1) return null;
      value += command.slice(i + 1, closeIndex);
      literal = true;
      i = closeIndex + 1;
      consumedAny = true;
      continue;
    }
    if (HEREDOC_WORD_STOP_RE.test(ch)) break;
    value += ch;
    i += 1;
    consumedAny = true;
  }

  if (!consumedAny) return null;
  return { value, literal, consumedLength: i - start };
}

// Parses a full heredoc redirect operator (<<EOF, <<-EOF, <<'EOF', <<"EOF",
// <<EO"F"1, ...) starting at command[i]. Caller must already have confirmed
// command[i..i+1] is an unescaped `<<` (not `<<<`) — both call sites below
// do this before invoking it, so it is not re-checked here. Returns null if
// there is no usable delimiter word after the operator (e.g. `<<` with
// nothing following it) — the caller then treats the `<<` as ordinary text,
// which is the safe direction: an unrecognized construct is never silently
// swallowed as a heredoc body.
function parseHeredocOperator(command, i) {
  let pos = i + 2;
  let stripLeadingTabs = false;
  if (command[pos] === '-') {
    stripLeadingTabs = true;
    pos += 1;
  }
  while (command[pos] === ' ' || command[pos] === '\t') pos += 1;
  const word = parseHeredocDelimiterWord(command, pos);
  if (!word) return null;
  return {
    delimiter: word.value,
    // Any quoted or backslash-escaped part of the delimiter word disables
    // all expansion inside the heredoc body (parameter/command
    // substitution) — this is what bash itself keys off of, not merely
    // whether the WHOLE word happens to be quoted.
    literal: word.literal,
    stripLeadingTabs,
    length: (pos + word.consumedLength) - i,
  };
}

/**
 * Split a shell command into segments by operators (&&, ||, ;, &)
 * while respecting quoting (single/double) and escaped characters.
 * Redirection operators (&>, >&, 2>&1) are NOT treated as separators.
 *
 * A heredoc body (<<EOF ... EOF) is never split on its own embedded
 * newlines/operators — its content is literal data for the command that
 * requested it, not further shell syntax, so a line inside it that merely
 * resembles a destructive command (e.g. a code example in a commit message
 * template) must not be judged as its own segment. A line consisting of
 * exactly the delimiter (leading tabs stripped first for the `<<-` form)
 * ends the body. A command line can chain multiple heredocs (`cmd <<A <<B`);
 * each `<<` found before the first one's body has started is queued, and
 * bodies are consumed in the order their operators appeared, so the second
 * heredoc's body is never mistaken for ordinary command segments.
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
  // Heredocs queued on the same operator line after the first (e.g. the `B`
  // in `cmd <<A <<B`), consumed in order as each preceding body closes.
  const heredocQueue = [];

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
        const next = heredocQueue.shift();
        if (next) {
          heredocDelimiter = next.delimiter;
          heredocStripLeadingTabs = next.stripLeadingTabs;
          // Stay in 'in-body': the newline right after this terminator line
          // is also the first character of the next queued heredoc's body,
          // not a fresh 'awaiting-body' gap.
        } else {
          heredocState = null;
          heredocDelimiter = null;
        }
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

    if (heredocState !== 'in-body' && ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const op = parseHeredocOperator(command, i);
      if (op) {
        if (heredocState === null) {
          heredocDelimiter = op.delimiter;
          heredocStripLeadingTabs = op.stripLeadingTabs;
          heredocState = 'awaiting-body';
        } else {
          // Already awaiting the first heredoc's body on this same command
          // line — this is a second (or later) chained heredoc; its body
          // comes after the first one's, so only queue it for now.
          heredocQueue.push({ delimiter: op.delimiter, stripLeadingTabs: op.stripLeadingTabs });
        }
        current += command.slice(i, i + op.length);
        i += op.length - 1;
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

// One scan step for findMatchingParen: given the current quote state,
// returns how far to additionally advance past this char (an escaped char
// consumes its pair), the quote state after this char, and how much this
// char changes the paren depth (0 unless it's an unquoted paren). Splitting
// this out of the loop keeps each branch a flat, single-condition early
// return instead of nested ifs, which is what keeps cognitive complexity low.
function scanParenChar(ch, i, command, quote) {
  if (quote) {
    if (ch === '\\' && quote === '"' && i + 1 < command.length) return { advance: 1, quote, delta: 0 };
    return { advance: 0, quote: ch === quote ? null : quote, delta: 0 };
  }
  if (ch === '\\' && i + 1 < command.length) return { advance: 1, quote: null, delta: 0 };
  if (ch === '"' || ch === "'") return { advance: 0, quote: ch, delta: 0 };
  if (ch === '(') return { advance: 0, quote: null, delta: 1 };
  if (ch === ')') return { advance: 0, quote: null, delta: -1 };
  return { advance: 0, quote: null, delta: 0 };
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
    const r = scanParenChar(command[i], i, command, quote);
    quote = r.quote;
    i += r.advance;
    depth += r.delta;
    if (r.delta && depth === 0) return i;
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
 * Also honors the two other places bash text can contain a `$(...)`-shaped
 * substring without it ever being live: a `# comment` (runs to end of line,
 * never expanded) and a heredoc body whose delimiter was quoted/escaped
 * (`<<'EOF'`, `<<"EOF"`, `<<\EOF` — fully literal, no expansion at all). A
 * heredoc with a bare, unquoted delimiter (`<<EOF`) is NOT literal — bash
 * still expands `$(...)` inside it — so that case still scans normally.
 * Without this, a code example inside either construct (e.g. `# example:
 * $(rm -rf /)` in a commit message template) would be extracted and judged
 * as a live command it can never actually become.
 *
 * Not recursive by itself — a caller that re-scans each returned body finds
 * substitutions nested inside substitutions; keeping recursion at the call
 * site (with its own depth guard) keeps this function simple and testable
 * in isolation.
 */
function extractSubstitutionBodies(command) { // NOSONAR: shell scanner state machine kept inline for auditability
  const bodies = [];
  let quote = null;
  let heredocState = null;
  let heredocDelimiter = null;
  let heredocStripLeadingTabs = false;
  let heredocLiteral = false;
  const heredocQueue = [];
  let inComment = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === '\n') inComment = false;

    if (heredocState === 'in-body') {
      const lineEnd = command.indexOf('\n', i);
      const rawLine = lineEnd === -1 ? command.slice(i) : command.slice(i, lineEnd);
      const line = rawLine.replace(/\r$/, '');
      const candidate = heredocStripLeadingTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === heredocDelimiter) {
        i += rawLine.length - 1;
        const next = heredocQueue.shift();
        if (next) {
          heredocDelimiter = next.delimiter;
          heredocStripLeadingTabs = next.stripLeadingTabs;
          heredocLiteral = next.literal;
        } else {
          heredocState = null;
          heredocDelimiter = null;
        }
        continue;
      }
      if (heredocLiteral) continue;
      // Bare/unquoted-delimiter heredoc body: falls through to the normal
      // scan below, since bash still expands $(...) here.
    }

    if (heredocState !== 'in-body' && quote === "'") {
      if (ch === quote) quote = null;
      continue;
    }

    if (heredocState !== 'in-body' && quote === '"' && ch === '\\' && i + 1 < command.length) {
      i += 1;
      continue;
    }

    if (heredocState !== 'in-body' && quote === '"' && ch === quote) {
      quote = null;
      continue;
    }

    if (heredocState !== 'in-body' && !quote && ch === '\\' && i + 1 < command.length) {
      i += 1;
      continue;
    }

    if (heredocState !== 'in-body' && !quote && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }

    if (heredocState !== 'in-body' && !quote && !inComment && ch === '#'
        && (i === 0 || HEREDOC_WORD_STOP_RE.test(command[i - 1]))) {
      inComment = true;
      continue;
    }

    if (inComment) continue;

    if (heredocState === 'awaiting-body' && ch === '\n') {
      heredocState = 'in-body';
      continue;
    }

    if (heredocState !== 'in-body' && !quote && ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const op = parseHeredocOperator(command, i);
      if (op) {
        if (heredocState === null) {
          heredocDelimiter = op.delimiter;
          heredocStripLeadingTabs = op.stripLeadingTabs;
          heredocLiteral = op.literal;
          heredocState = 'awaiting-body';
        } else {
          heredocQueue.push({ delimiter: op.delimiter, stripLeadingTabs: op.stripLeadingTabs, literal: op.literal });
        }
        i += op.length - 1;
        continue;
      }
    }

    // Reached only in an unquoted or double-quoted context, outside a
    // comment and outside a literal heredoc body (single-quoted spans and
    // literal heredoc bodies already `continue`d above) — the contexts
    // where a real shell still expands $(...)/`...` (see the doc comment
    // above).
    const end = pushSubstitutionAt(command, i, bodies);
    if (end !== -1) i += (end - i);
  }

  return bodies;
}

module.exports = { splitShellSegments, extractSubstitutionBodies };
