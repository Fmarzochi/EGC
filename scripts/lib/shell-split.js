'use strict';

function pushSegment(current, segments) {
  if (current.trim()) segments.push(current.trim());
}

function handleEscape(ch, i, command) {
  if (ch === '\\' && i + 1 < command.length) {
    // A backslash before '\r\n' escapes only the '\r' (bash has no special
    // treatment of CR), leaving the '\n' unescaped to end the line normally
    // and a following '#' to start a real comment -- confirmed against a
    // real bash shell (cubic review, EGC-539 PR #1147, correcting an earlier
    // change that wrongly swallowed all three characters as one unit).
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
  if (next === '>' || prev === '>' || prev === '<') {
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
// Parses a single quoted span (`'...'` or `"..."`) inside a heredoc
// delimiter word, starting right after the opening quote at `start`.
// Bash only strips the backslash inside "..." when it precedes one of
// these five characters; before anything else the backslash is kept
// literally in the string. Always stripping it (as this used to) computed
// a too-short delimiter value for forms like <<"EO\NF" (backslash-N is not
// special), so the real terminator line — which bash resolves to the
// correct, longer value including the literal backslash — never matched,
// and the heredoc body never closed. Returns `closed: false` if the
// command ends before the closing quote is found.
function parseHeredocQuotedSpan(command, quoteChar, start) {
  let j = start;
  let inner = '';
  let closed = false;
  while (j < command.length) {
    const c = command[j];
    if (quoteChar === '"' && c === '\\' && j + 1 < command.length) {
      const escaped = command[j + 1];
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
  return { inner, closed, nextIndex: j };
}

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
      const span = parseHeredocQuotedSpan(command, ch, i + 1);
      if (!span.closed) return null;
      value += span.inner;
      literal = true;
      i = span.nextIndex;
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

// Word-start characters for comment detection specifically -- deliberately
// narrower than HEREDOC_WORD_STOP_RE. `)`, `<`, and `>` are NOT reliable
// word-start cues here: bash concatenates $(...)/`<(...)`/`>(...)` with
// whatever literal text immediately follows into a single word (`$(date)#c`
// is the one word `$(date)#c`, not a command substitution followed by a
// comment), and `>`/`<` are redirection operators where a following `#` is
// part of a filename (`echo hi >#x` redirects into a file literally named
// `#x`). Cubic review (EGC-539, PR #1147) caught that reusing
// HEREDOC_WORD_STOP_RE here made splitShellSegments silently fold a live
// `&&`/`;`/`|` separator into what it mistook for a comment, hiding a
// destructive command from Guardian's per-segment validation -- exactly
// the class of divergence this file exists to prevent.
const COMMENT_WORD_START_RE = /[\s;&|(]/;

// Bash removes an unescaped-backslash-then-newline pair entirely before
// tokenizing (a line continuation), so 'foo\<newline>#bar' is the single
// word 'foo#bar', not 'foo' followed by a comment starting at '#'. Walking
// back from `i` (the position of a candidate word-start character, usually
// a newline) over any such continuations finds the character bash would
// actually treat as preceding the current position. A run of N consecutive
// backslashes immediately before the newline continues the line only when
// N is odd (each adjacent pair of backslashes is itself an escaped literal
// backslash and cancels out; the escaping power passes to the newline only
// off the single unpaired backslash left when the count is odd).
//
// A backslash before '\r\n' does NOT continue the line -- it escapes only
// the '\r' (bash has no special handling of a lone CR), so the '\n' right
// after it still ends the line for real, and this function must not walk
// past it. Confirmed against a real bash shell (cubic review, EGC-539 PR
// #1147, correcting an earlier change that treated '\'+'\r'+'\n' as one
// continuation unit).
function skipLineContinuations(command, i) {
  while (i >= 0 && command[i] === '\n') {
    let backslashes = 0;
    let j = i - 1;
    while (j >= 0 && command[j] === '\\') { backslashes += 1; j -= 1; }
    if (backslashes % 2 === 0) break; // even (incl. zero): a real, unescaped newline
    i = j; // odd: backslash-newline continuation, keep walking back from before it
  }
  return i;
}

// A `#` starts a comment (running to the end of the line, never split on or
// scanned for substitutions) only when it is not inside a quote or an
// already-open heredoc body, and only when it begins a new word — `foo#bar`
// is one identifier, not a comment, matching bash's own rule that `#` is
// only special in a word-start position.
function isCommentStart(command, i, quote, heredocState, paramDepth = 0) {
  if (heredocState === 'in-body' || quote || paramDepth > 0 || command[i] !== '#') return false;
  if (i === 0) return true;
  const precedingIndex = skipLineContinuations(command, i - 1);
  return precedingIndex < 0 || COMMENT_WORD_START_RE.test(command[precedingIndex]);
}

// The index of the character closing the command substitution (`$(...)`,
// `$((...))`), process substitution (`<(...)`, `>(...)`) or backquoted
// command that opens at `i`; -1 when none opens there. One that never
// closes runs to the end of the line, since bash reads no command out of it.
function nestedSubstitutionEnd(command, i) {
  if (command[i] === '$' && command[i + 1] === '{') return -1;
  const end = constructEnd(command, i);
  if (end === null) return -1;
  return end === -1 ? command.length - 1 : end;
}

// The constructs bash reads whole wherever they sit, as it reads them: a
// command body (`$(...)`, `<(...)`, `>(...)`, `$((...))`) closes at its own
// `)`, a parameter expansion at its own `}`, a backquoted command at the next
// unescaped backquote. Inside, an escape, a quoted string and a nested
// construct are read whole, and in a command body a `(` of its own nests and
// a `#` that opens a word is a comment up to its newline, so no quote, paren
// or brace inside any of those closes the outer construct early.

// Where the construct opening at `i` closes (the index of its closing
// character); null when none opens there, -1 when it never closes.
function constructEnd(command, i) {
  const ch = command[i];
  const next = command[i + 1];
  if (ch === '`') return backquoteEnd(command, i + 1);
  if (ch === '$' && next === '{') return bodyEnd(command, i + 2, '}', false);
  if ((ch === '$' || ch === '<' || ch === '>') && next === '(') return bodyEnd(command, i + 2, ')', true);
  return null;
}

function backquoteEnd(command, start) {
  for (let j = start; j < command.length; j++) {
    if (command[j] === '\\') j += 1;
    else if (command[j] === '`') return j;
  }
  return -1;
}

// A double-quoted string whose body starts at `start`: the index of its
// closing quote, a construct inside it read whole; -1 when it never closes.
function doubleQuoteEnd(command, start) {
  let j = start;
  while (j < command.length) {
    const ch = command[j];
    if (ch === '"') return j;
    // Inside double quotes `<(` and `>(` are plain text, not a process
    // substitution.
    let end = null;
    if (ch === '\\') end = j + 1;
    else if (ch !== '<' && ch !== '>') end = constructEnd(command, j);
    if (end === -1) return -1;
    j = (end ?? j) + 1;
  }
  return -1;
}

// `$'...'`: backslash escapes, including an escaped quote.
function ansiQuoteEnd(command, start) {
  for (let j = start; j < command.length; j++) {
    if (command[j] === '\\') j += 1;
    else if (command[j] === "'") return j;
  }
  return -1;
}

// Where the quoted string opening at `i` closes, read as bash reads it: a
// single-quoted one at the next quote, with no escape at all; `$'...'` past
// its backslash escapes; a double-quoted one past its escapes and the
// constructs inside it (see doubleQuoteEnd). null when no quote opens at
// `i`, -1 when it never closes.
function quotedEnd(command, i) {
  const ch = command[i];
  if (ch === "'") return command.indexOf("'", i + 1);
  if (ch === '$' && command[i + 1] === "'") return ansiQuoteEnd(command, i + 2);
  if (ch === '"') return doubleQuoteEnd(command, i + 1);
  return null;
}

// The end of a span read whole at `j`: an escape, a quoted string, a
// comment in a command body, or a nested construct. null when none starts
// there, -1 when it never closes.
function spanEnd(command, j, inCommand) {
  const ch = command[j];
  if (ch === '\\') return j + 1;
  const quoted = quotedEnd(command, j);
  if (quoted !== null) return quoted;
  if (inCommand && ch === '#' && isCommentStart(command, j, null, null)) {
    const newline = command.indexOf('\n', j);
    return newline === -1 ? -1 : newline - 1;
  }
  return constructEnd(command, j);
}

// Where a parameter expansion (closing at `}`) or a command body (closing at
// its own `)`) whose content starts at `start` closes; -1 when it never does.
function bodyEnd(command, start, close, inCommand) {
  let depth = 0;
  let j = start;
  while (j < command.length) {
    const end = spanEnd(command, j, inCommand);
    if (end === -1) return -1;
    const ch = command[j];
    if (end !== null) j = end;
    else if (inCommand && ch === '(') depth += 1;
    else if (ch === close && depth === 0) return j;
    else if (inCommand && ch === ')') depth -= 1;
    j += 1;
  }
  return -1;
}

// Reads the heredoc body at command[i] (hd.state is 'in-body'): the raw
// terminator line when one starts here (see matchHeredocTerminator), else
// null, after marking that a newline starts the next body line.
function readHeredocBodyAt(command, i, hd) {
  if (hd.atLineStart) {
    const term = matchHeredocTerminator(command, i, hd);
    if (term.matched) return term.rawLine;
  }
  if (command[i] === '\n') hd.atLineStart = true;
  return null;
}

// The newline after a heredoc operator starts its body, not the operator
// itself.
function beginHeredocBody(hd, ch) {
  if (hd.state !== 'awaiting-body' || ch !== '\n') return false;
  hd.state = 'in-body';
  hd.atLineStart = true;
  return true;
}

// The heredoc operator (`<<`, not `<<<`) at command[i], already applied to hd;
// null when none starts there.
function heredocOperatorAt(command, i, hd) {
  if (hd.state === 'in-body' || command[i] !== '<' || command[i + 1] !== '<' || command[i + 2] === '<') return null;
  const op = parseHeredocOperator(command, i);
  if (op) applyHeredocOperator(hd, op);
  return op;
}

// Opens or closes a ${...} parameter expansion at command[i] and returns the
// text read ('${' or '}'); null when neither is there.
function stepParamBrace(st, ch) {
  if (ch === '$' && st.command[st.i + 1] === '{') {
    st.paramDepth += 1;
    st.i += 1;
    return '${';
  }
  if (ch === '}' && st.paramDepth > 0) {
    st.paramDepth -= 1;
    return '}';
  }
  return null;
}

function quotedOrNestedEnd(st) {
  const { command, i } = st;
  // A quoted string is text whole, read as bash reads it (quotedEnd): no
  // operator, comment or line break inside it splits the segment.
  const quoted = quotedEnd(command, i);
  if (quoted !== null) return quoted === -1 ? command.length - 1 : quoted;
  // Inside ${...}, a command substitution or a backquoted command is read
  // whole: a `}` of its own does not close the expansion.
  const nested = st.paramDepth > 0 ? nestedSubstitutionEnd(command, i) : -1;
  return nested === -1 ? null : nested;
}

function appendWholeText(st, ch) {
  const esc = handleEscape(ch, st.i, st.command);
  if (esc.handled) {
    st.current += esc.chars;
    st.i += esc.advance;
    return true;
  }
  const end = quotedOrNestedEnd(st);
  if (end === null) return false;
  st.current += st.command.slice(st.i, end + 1);
  st.i = end;
  return true;
}

function appendHeredocBody(st, ch) {
  const terminator = readHeredocBodyAt(st.command, st.i, st.hd);
  if (terminator === null) {
    st.current += ch;
    return;
  }
  st.current += terminator;
  st.i += terminator.length - 1;
}

function appendComment(st, ch) {
  if (!st.stripComments) st.current += ch;
}

function endSegment(st) {
  pushSegment(st.current, st.segments);
  st.current = '';
  return true;
}

function splitAtSeparator(st, ch) {
  if (ch === '\n' || ch === '\r') return endSegment(st);
  const { command, i } = st;
  const next = command[i + 1] || '';
  const prev = i > 0 ? command[i - 1] : '';
  const dbl = handleDoubleOperator(ch, next, st.current, st.segments);
  if (dbl.handled) {
    st.current = dbl.current;
    st.i += dbl.advance;
    return true;
  }
  if (ch === ';' || (st.splitOnPipe && ch === '|')) return endSegment(st);
  const amp = handleSingleAmpersand(ch, next, prev, st.current, st.segments);
  if (!amp.handled) return false;
  st.current = amp.current;
  return true;
}

function splitStep(st) {
  const { command, hd } = st;
  const ch = command[st.i];

  // A comment runs to the end of its line as inert text: a quote or a
  // backslash inside it opens nothing, as bash reads it, so the next line
  // is split and judged like any other.
  if (st.inComment && ch !== '\n') {
    appendComment(st, ch);
    return;
  }
  st.inComment = false;

  if (hd.state === 'in-body') {
    appendHeredocBody(st, ch);
    return;
  }
  if (appendWholeText(st, ch)) return;

  const brace = stepParamBrace(st, ch);
  if (brace !== null) {
    st.current += brace;
    return;
  }
  if (isCommentStart(command, st.i, null, hd.state, st.paramDepth)) {
    st.inComment = true;
    appendComment(st, ch);
    return;
  }
  if (beginHeredocBody(hd, ch)) {
    st.current += ch;
    return;
  }
  const op = heredocOperatorAt(command, st.i, hd);
  if (op) {
    st.current += command.slice(st.i, st.i + op.length);
    st.i += op.length - 1;
    return;
  }
  if (!splitAtSeparator(st, ch)) st.current += ch;
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
function splitShellSegments(command, options = {}) {
  const st = {
    command,
    splitOnPipe: Boolean(options.splitOnPipe),
    // When set, the inert text of a `# comment` is left out of the segment
    // instead of folded into it, so a caller that judges the segment (the
    // Guardian) never reads a path or an operator that only sits in a comment.
    // Off by default, so callers that want the verbatim line are unaffected.
    stripComments: Boolean(options.stripComments),
    segments: [],
    current: '',
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
    hd: createHeredocState(),
    // True from an unquoted, word-starting `#` until (not including) the next
    // newline -- reset unconditionally on every newline, same as
    // extractSubstitutionBodies's inComment tracking.
    inComment: false,
    // Open ${...} parameter expansions. Inside one, a `#` is a literal part of
    // the expansion (`${x:-a # b}`), not a comment, so the segment after it
    // (e.g. `; rm -rf /`) is still live and must be split and judged. Tracked
    // only outside quotes; a quote already keeps `#` from starting a comment.
    paramDepth: 0,
    i: 0,
  };
  while (st.i < command.length) {
    splitStep(st);
    st.i += 1;
  }
  pushSegment(st.current, st.segments);
  return st.segments;
}

// Finds the index of the `)` that matches the `(` implicitly opened at
// `start` (i.e. `start` is the position right after that `(`), reading the
// body the way bash reads a command body (see constructEnd): quotes,
// backquoted commands, nested substitutions and comments inside it never
// close it early. Returns -1 if the input is malformed (no matching close), // callers must treat that as "nothing to extract here", not throw.
function findMatchingParen(command, start) {
  return bodyEnd(command, start, ')', true);
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
    const end = backquoteEnd(command, i + 1);
    if (end !== -1) {
      bodies.push(command.slice(i + 1, end));
      return end;
    }
  }
  return -1;
}

// Outside a heredoc body, what a quote holds is skipped: a single-quoted
// string whole, an escape, the quotes that open and close a string, and
// `$'...'`, which holds no substitution and which an escaped quote does not
// close. true when command[i] was consumed here.
function skipQuoting(st, ch) {
  const { command } = st;
  if (st.quote === "'") {
    if (ch === "'") st.quote = null;
    return true;
  }
  if (ch === '\\' && st.i + 1 < command.length) {
    st.i += 1;
    return true;
  }
  if (st.quote === '"') {
    if (ch !== '"') return false;
    st.quote = null;
    return true;
  }
  if (ch === '$' && command[st.i + 1] === "'") {
    const end = ansiQuoteEnd(command, st.i + 2);
    st.i = end === -1 ? command.length : end;
    return true;
  }
  if (ch !== '"' && ch !== "'") return false;
  st.quote = ch;
  return true;
}

function extractStep(st) {
  const { command, hd } = st;
  const ch = command[st.i];

  // See splitStep: a comment is inert up to its newline, whatever quote or
  // backslash it holds.
  if (st.inComment && ch !== '\n') return;
  st.inComment = false;

  if (hd.state === 'in-body') {
    const terminator = readHeredocBodyAt(command, st.i, hd);
    if (terminator !== null) {
      st.i += terminator.length - 1;
      return;
    }
    // Bare/unquoted-delimiter heredoc body: falls through to the normal
    // scan below, since bash still expands $(...) here.
    if (hd.literal) return;
  } else if (skipQuoting(st, ch)) {
    return;
  }

  if (stepParamBrace(st, ch) !== null) return;
  if (isCommentStart(command, st.i, st.quote, hd.state, st.paramDepth)) {
    st.inComment = true;
    return;
  }
  if (beginHeredocBody(hd, ch)) return;
  const op = st.quote ? null : heredocOperatorAt(command, st.i, hd);
  if (op) {
    st.i += op.length - 1;
    return;
  }

  // Reached only in an unquoted or double-quoted context, outside a
  // comment and outside a literal heredoc body (single-quoted spans and
  // literal heredoc bodies already returned above): the contexts where a
  // real shell still expands $(...)/`...` (see the doc comment below).
  const end = pushSubstitutionAt(command, st.i, st.bodies);
  if (end !== -1) st.i = end;
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
function extractSubstitutionBodies(command) {
  const st = {
    command,
    bodies: [],
    quote: null,
    // See createHeredocState()'s doc comment: this tracking is shared with
    // splitShellSegments above.
    hd: createHeredocState(),
    inComment: false,
    // See splitShellSegments: inside ${...} a `#` is literal, not a comment.
    paramDepth: 0,
    i: 0,
  };
  while (st.i < command.length) {
    extractStep(st);
    st.i += 1;
  }
  return st.bodies;
}

module.exports = { splitShellSegments, extractSubstitutionBodies, constructEnd };
