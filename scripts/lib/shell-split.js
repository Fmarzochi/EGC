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
      // A plain indexOf() for the closing quote treats an escaped quote
      // inside a double-quoted span (`<<"EO\"F"`) as the real closer,
      // truncating the delimiter early — the real terminator line (which
      // must match the FULL, correctly-unescaped word) then never matches
      // this too-short guess, so the heredoc body never closes and every
      // command after it goes unvalidated (the same failure shape as the
      // EOF-1 truncation bug above, just via escaping instead of a
      // narrow character class). Single quotes have no escape mechanism in
      // bash (the first `'` always closes), so only `"` needs this.
      const quoteChar = ch;
      let j = i + 1;
      let inner = '';
      let closed = false;
      while (j < command.length) {
        const c = command[j];
        if (quoteChar === '"' && c === '\\' && j + 1 < command.length) {
          const escaped = command[j + 1];
          // Bash only strips the backslash inside "..." when it precedes
          // one of these five characters; before anything else the
          // backslash is kept literally in the string. Always stripping it
          // (as this used to) computed a too-short delimiter value for
          // forms like <<"EO\NF" (backslash-N is not special), so the real
          // terminator line — which bash resolves to the correct, longer
          // value including the literal backslash — never matched, and the
          // heredoc body never closed.
          if (escaped === '$' || escaped === '`' || escaped === '"' || escaped === '\\' || escaped === '\n') {
            inner += escaped;
            j += 2;
          } else {
            inner += c;
            j += 1;
          }
          continue;
        }
        if (c === quoteChar) { closed = true; j += 1; break; }
        inner += c;
        j += 1;
      }
      if (!closed) return null;
      value += inner;
      literal = true;
      i = j;
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

// Shared heredoc tracking used by both splitShellSegments and
// extractSubstitutionBodies. A heredoc redirect (<<EOF, <<-EOF, <<'EOF', ...)
// suspends normal scanning until a line consisting of exactly the delimiter
// is found; everything up to that line is body text, not further shell
// syntax to split on or scan for substitutions/comments in. Keeping this
// state machine in one place means a fix to it (like the EOF-1/v1.0
// delimiter-parsing fixes documented above parseHeredocDelimiterWord)
// automatically applies to both consumers instead of needing to be
// hand-ported to each — which is exactly how splitShellSegments ended up
// without # comment support in the first place: extractSubstitutionBodies
// gained it in a later audit round and the sibling parser was never updated
// to match, so a `#`-prefixed remark like `echo hi # note: rm -rf / &&
// something` had its trailing `&&` read as a real separator and produced a
// spurious extra segment ("something") that was never live shell syntax.
function createHeredocState() {
  return {
    state: null, // null | 'awaiting-body' | 'in-body'
    delimiter: null,
    stripLeadingTabs: false,
    literal: false,
    queue: [],
    atLineStart: false,
  };
}

// Applies a heredoc operator just parsed by parseHeredocOperator: starts
// waiting for the first heredoc's body, or queues a later one on the same
// command line (`cmd <<A <<B`) to be consumed once the first one's body
// closes.
function applyHeredocOperator(hd, op) {
  if (hd.state === null) {
    hd.delimiter = op.delimiter;
    hd.stripLeadingTabs = op.stripLeadingTabs;
    hd.literal = op.literal;
    hd.state = 'awaiting-body';
  } else {
    hd.queue.push({ delimiter: op.delimiter, stripLeadingTabs: op.stripLeadingTabs, literal: op.literal });
  }
}

// Checks whether the line starting at command[i] (only called when hd.state
// is 'in-body' and hd.atLineStart is true) is the heredoc's terminator line.
// If it is, advances to the next queued heredoc (or clears hd back to no
// active heredoc) and returns the raw terminator line so the caller can fold
// it into whatever it is building; otherwise clears atLineStart and reports
// no match so the caller keeps scanning this line as ordinary body text.
function matchHeredocTerminator(command, i, hd) {
  const lineEnd = command.indexOf('\n', i);
  const rawLine = lineEnd === -1 ? command.slice(i) : command.slice(i, lineEnd);
  const line = rawLine.replace(/\r$/, '');
  const candidate = hd.stripLeadingTabs ? line.replace(/^\t+/, '') : line;
  if (candidate !== hd.delimiter) {
    hd.atLineStart = false;
    return { matched: false };
  }
  const next = hd.queue.shift();
  if (next) {
    hd.delimiter = next.delimiter;
    hd.stripLeadingTabs = next.stripLeadingTabs;
    hd.literal = next.literal;
  } else {
    hd.state = null;
    hd.delimiter = null;
    hd.atLineStart = false;
  }
  return { matched: true, rawLine };
}

// A `#` starts a comment (running to the end of the line, never split on or
// scanned for substitutions) only when it is not inside a quote or an
// already-open heredoc body, and only when it begins a new word — `foo#bar`
// is one identifier, not a comment, matching bash's own rule that `#` is
// only special in a word-start position.
function isCommentStart(command, i, quote, heredocState) {
  return heredocState !== 'in-body' && !quote && command[i] === '#'
    && (i === 0 || HEREDOC_WORD_STOP_RE.test(command[i - 1]));
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
 *
 * A `# comment` runs to the end of its line and is folded into the current
 * segment as inert text, not scanned for operators — `echo hi # note: rm -rf
 * / && something` is one segment, the same way a real shell never treats the
 * `&&` after a `#` as a live separator. (Security fix, EGC-539: this parser
 * previously had no comment awareness at all, so that `&&` was read as a
 * real separator and produced a spurious extra segment, "something", that
 * was never live shell syntax — a parsing divergence from
 * extractSubstitutionBodies below, which already handled comments.)
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
  // swallowed into the body instead of ending the segment. See
  // createHeredocState()'s doc comment for why this tracking is shared with
  // extractSubstitutionBodies below.
  const hd = createHeredocState();
  // True from an unquoted, word-starting `#` until (not including) the next
  // newline -- reset unconditionally on every newline below, same as
  // extractSubstitutionBodies's inComment tracking.
  let inComment = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === '\n') inComment = false;

    if (hd.state === 'in-body') {
      if (hd.atLineStart) {
        const term = matchHeredocTerminator(command, i, hd);
        if (term.matched) {
          current += term.rawLine;
          i += term.rawLine.length - 1;
          continue;
        }
      }
      if (ch === '\n') hd.atLineStart = true;
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

    if (!inComment && isCommentStart(command, i, quote, hd.state)) {
      inComment = true;
      current += ch;
      continue;
    }

    if (inComment) {
      current += ch;
      continue;
    }

    if (hd.state === 'awaiting-body' && ch === '\n') {
      current += ch;
      hd.state = 'in-body';
      hd.atLineStart = true;
      continue;
    }

    if (hd.state !== 'in-body' && ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const op = parseHeredocOperator(command, i);
      if (op) {
        applyHeredocOperator(hd, op);
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
  if (ch === '$' && next === '(' && command[i + 2] === '(') {
    const end = findMatchingParen(command, i + 2);
    if (end !== -1) {
      // Arithmetic expansion $((...)) never executes its expression as a
      // shell command -- only a real $(...) or `...` substitution does.
      // findMatchingParen(i+2) treats the arithmetic's own inner '(' as an
      // extra nesting level and returns the OUTER closing paren, so without
      // this the whole "(expr)" text gets pushed as if it were command
      // content -- miscounting as one more level of command-substitution
      // nesting toward MAX_SUBSTITUTION_DEPTH even for something as
      // harmless as `$((1+2))`. If the expression's own text contains no
      // `$(`/backtick anywhere, there is categorically nothing to validate
      // inside it (both require that literal syntax to exist), so no body
      // is pushed at all. If it DOES contain one (bash really does execute
      // `$(( $(cat x) + 1 ))`'s inner substitution), fall through to the
      // ordinary handling below unchanged -- never unwrap it here directly,
      // which would recurse outside pre-bash-guardian-validate.js's depth
      // counter and defeat the cap entirely for deeply-nested arithmetic.
      const inner = command.slice(i + 3, end - 1);
      if (!inner.includes('$(') && !inner.includes('`')) {
        return end;
      }
    }
  }
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
  // See createHeredocState()'s doc comment: this tracking is shared with
  // splitShellSegments above.
  const hd = createHeredocState();
  let inComment = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === '\n') inComment = false;

    if (hd.state === 'in-body') {
      if (hd.atLineStart) {
        const term = matchHeredocTerminator(command, i, hd);
        if (term.matched) {
          i += term.rawLine.length - 1;
          continue;
        }
      }
      if (ch === '\n') hd.atLineStart = true;
      if (hd.literal) continue;
      // Bare/unquoted-delimiter heredoc body: falls through to the normal
      // scan below, since bash still expands $(...) here.
    }

    if (hd.state !== 'in-body' && quote === "'") {
      if (ch === quote) quote = null;
      continue;
    }

    if (hd.state !== 'in-body' && quote === '"' && ch === '\\' && i + 1 < command.length) {
      i += 1;
      continue;
    }

    if (hd.state !== 'in-body' && quote === '"' && ch === quote) {
      quote = null;
      continue;
    }

    if (hd.state !== 'in-body' && !quote && ch === '\\' && i + 1 < command.length) {
      i += 1;
      continue;
    }

    if (hd.state !== 'in-body' && !quote && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }

    if (!inComment && isCommentStart(command, i, quote, hd.state)) {
      inComment = true;
      continue;
    }

    if (inComment) continue;

    if (hd.state === 'awaiting-body' && ch === '\n') {
      hd.state = 'in-body';
      hd.atLineStart = true;
      continue;
    }

    if (hd.state !== 'in-body' && !quote && ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const op = parseHeredocOperator(command, i);
      if (op) {
        applyHeredocOperator(hd, op);
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
