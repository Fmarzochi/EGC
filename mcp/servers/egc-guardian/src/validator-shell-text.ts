// Splits a command string into words, honoring single/double quotes and
// backslash escapes so a quoted argument with embedded whitespace (e.g. the
// prompt text in `sudo -p "enter password" cmd`) stays one token. Without
// this, a naive whitespace split misaligns the wrapper-flag skipping in
// unwrapLeadingConstructs below and can leave a stray quote character in the
// slot later read as the base command. Quote/backslash characters are kept
// in the returned tokens (not stripped) — bareToken() strips them at the
// point of use, same as every other check in this file.
interface TokenizerState {
  words: string[];
  current: string;
  quote: string | null;
  hasToken: boolean;
}

// Consumes one character (or an escaped pair, or a run through a quote span)
// starting at `command[i]`, mutating `state` in place, and returns the index
// to resume from.
function consumeTokenChar(command: string, i: number, state: TokenizerState): number {
  const ch = command[i];

  if (state.quote) return consumeQuotedChar(command, i, state);

  if (ch === '\\' && i + 1 < command.length) {
    state.current += ch + command[i + 1];
    state.hasToken = true;
    return i + 2;
  }

  // `$'...'` is read whole, its backslash escapes (an escaped quote too)
  // included.
  if (ch === '$' && command[i + 1] === "'") {
    const end = readAnsiC(command, i + 1).end;
    state.current += command.slice(i, end);
    state.hasToken = true;
    return end;
  }

  if (ch === '"' || ch === "'") {
    state.quote = ch;
    state.current += ch;
    state.hasToken = true;
    return i + 1;
  }

  if (/\s/.test(ch)) {
    if (state.hasToken) { state.words.push(state.current); state.current = ''; state.hasToken = false; }
    return i + 1;
  }

  state.current += ch;
  state.hasToken = true;
  return i + 1;
}

// One character inside a quoted span. In double quotes a backslash escapes
// the next character and a `${...}`, `$(...)` or backquoted command is read
// whole, so a quote of theirs does not close the string; in single quotes
// every character is literal up to the closing quote.
function consumeQuotedChar(command: string, i: number, state: TokenizerState): number {
  const ch = command[i];
  state.hasToken = true;
  if (state.quote === '"') {
    const end = doubleQuotedSpanEnd(command, i);
    if (end !== i) {
      state.current += command.slice(i, end);
      return end;
    }
  }
  state.current += ch;
  if (ch === state.quote) state.quote = null;
  return i + 1;
}

// Index past an escaped character, a parameter expansion, a command
// substitution or a backquoted command opening at `i` inside double quotes;
// `i` itself when none opens there.
function doubleQuotedSpanEnd(command: string, i: number): number {
  const ch = command[i];
  if (ch === '\\' && i + 1 < command.length) return i + 2;
  if (ch === '$' && command[i + 1] === '{') return parameterExpansionEnd(command, i + 2);
  if (ch === '`' || (ch === '$' && command[i + 1] === '(')) return skipSubstitution(command, i);
  return i;
}

export function tokenizeWords(command: string): string[] {
  const state: TokenizerState = { words: [], current: '', quote: null, hasToken: false };
  let i = 0;
  while (i < command.length) {
    i = consumeTokenChar(command, i, state);
  }
  if (state.hasToken) state.words.push(state.current);
  return state.words;
}

// The spellings of an argument that may name a file: the word as the shell
// hands it (see shellWord) and, on Windows, the same word with its
// backslash escapes resolved as well, since a shell there may read them
// either way. Every path check judges an argument through these, so a
// quoted or escaped spelling of a protected path meets the same denial as
// the plain one.
export function unquoteWord(token: string, keepBackslashes = false): string {
  let value = '';
  let i = 0;
  while (i < token.length) {
    const ch = token[i];
    if (ch === '$' && token[i + 1] === "'") {
      const ansi = readAnsiC(token, i + 1);
      value += ansi.value;
      i = ansi.end;
    } else if (ch === '$' && token[i + 1] === '{') {
      // A parameter expansion is kept as written, quotes in its word
      // included, the way readWord keeps it: the shell reads them there.
      const end = skipText(token, i);
      value += token.slice(i, end);
      i = end;
    } else if (ch === '"' || ch === "'") {
      const quoted = readQuoted(token, i);
      value += quoted.value;
      i = quoted.end;
    } else if (ch === '\\' && !keepBackslashes && token[i + 1] === '\n') {
      i += 2;
    } else if (ch === '\\' && !keepBackslashes && i + 1 < token.length) {
      value += token[i + 1];
      i += 2;
    } else {
      value += ch;
      i += 1;
    }
  }
  return value;
}

// ANSI-C quoting: bash resolves the escapes of `$'...'` with the C table
// (a simple escape, `\xHH`, `\NNN`, `\uHHHH`, `\UHHHHHHHH`) before it hands
// the word over, so a path written that way names the same file.
const ANSI_C_SIMPLE: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?',
};
const ANSI_C_NUMERIC_RE = /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3}))/;

// The character an escape at `at` (the position after the backslash)
// stands for, and how many characters it spans.
function ansiCEscape(text: string, at: number): { value: string; length: number } {
  const next = text[at] ?? '';
  if (next in ANSI_C_SIMPLE) return { value: ANSI_C_SIMPLE[next], length: 1 };
  const numeric = ANSI_C_NUMERIC_RE.exec(text.slice(at));
  if (numeric === null) return { value: next, length: 1 };
  const digits = numeric[1] ?? numeric[2] ?? numeric[3] ?? numeric[4];
  const radix = numeric[4] === undefined ? 16 : 8;
  const codePoint = Number.parseInt(digits, radix);
  // A number past the Unicode range names no character; bash prints the
  // bytes as they are, and here the replacement character stands in.
  const value = codePoint > 0x10ffff ? '\ufffd' : String.fromCodePoint(codePoint);
  return { value, length: numeric[0].length };
}

// The `$'...'` span whose quote opens at `start`: its value with the escapes
// resolved, and the index past the closing quote.
export function readAnsiC(token: string, start: number): { value: string; end: number } {
  let value = '';
  let i = start + 1;
  while (i < token.length && token[i] !== "'") {
    if (token[i] !== '\\') {
      value += token[i];
      i += 1;
      continue;
    }
    const escape = ansiCEscape(token, i + 1);
    value += escape.value;
    i += 1 + escape.length;
  }
  return { value, end: Math.min(i + 1, token.length) };
}

// The word the shell hands the command: quotes removed and ANSI-C quoting
// decoded everywhere; outside Windows the backslash escapes are resolved
// as well, while on Windows a backslash separates path components, so it
// stays.
export function shellWord(token: string): string {
  return unquoteWord(token, process.platform === 'win32');
}

// Brace expansion runs where the shell runs it, before quote removal, and
// turns one word into several (`~/.{ssh,aws}/x` is two arguments to the
// command), only where the braces and the comma stand outside quotes and
// unescaped; braces without a comma, and quoted or escaped ones, are
// characters of the name. The alternatives are capped, and a word past the
// cap refuses the whole command, since a path the shell would hand over
// must never go unjudged.
export const MAX_BRACE_EXPANSIONS = 64;

// Position of the next `{` at or after `start` that the shell reads as one
// (outside quotes and unescaped), or -1.
function nextOpenBrace(word: string, start: number): number {
  let i = start;
  while (i < word.length) {
    const skipped = skipText(word, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (word[i] === '{') return i;
    i += 1;
  }
  return -1;
}

// The brace group that opens at `open`: the commas at its own depth and its
// closing brace, or null when it never closes.
function braceGroupAt(word: string, open: number): { commas: number[]; close: number } | null {
  const commas: number[] = [];
  let depth = 0;
  let i = open;
  while (i < word.length) {
    const skipped = skipText(word, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = word[i];
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return { commas, close: i };
    else if (ch === ',' && depth === 1) commas.push(i);
    i += 1;
  }
  return null;
}

// The first brace group of a word that the shell would expand (one with a
// comma at its own depth); a group without one is passed over and its
// inside read, and null means the word has no group to expand.
function findBraceGroup(word: string): { open: number; commas: number[]; close: number } | null {
  let open = nextOpenBrace(word, 0);
  while (open !== -1) {
    const group = braceGroupAt(word, open);
    if (group !== null && group.commas.length > 0) return { open, ...group };
    open = nextOpenBrace(word, open + 1);
  }
  return null;
}

function braceExpansions(word: string): string[] | null {
  const group = findBraceGroup(word);
  if (group === null) return [word];
  const bounds = [group.open, ...group.commas, group.close];
  const out: string[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const rewritten = word.slice(0, group.open) + word.slice(bounds[i] + 1, bounds[i + 1]) + word.slice(group.close + 1);
    const nested = braceExpansions(rewritten);
    if (nested === null || out.length + nested.length > MAX_BRACE_EXPANSIONS) return null;
    out.push(...nested);
  }
  return out;
}

export function expandArguments(words: string[]): string[] | null {
  const out: string[] = [];
  for (const word of words) {
    const expansions = braceExpansions(word);
    if (expansions === null) return null;
    out.push(...expansions);
  }
  return out;
}

// A redirection names a file the shell opens on the command's behalf:
// `> file` writes over it and `< file` reads it, whatever command stands in
// front, and the shell reads the operator glued to its target (`>file`,
// `word>file`) exactly as it reads it spaced (`> file`). The target is
// therefore a filesystem operand like any other and is judged against the
// same protected paths, before the per-command checks, which only see the
// argument the operator was glued to.
//
// The command line is read here the way the shell reads it, on its own and
// not through tokenizeWords: a backslash before a newline joins the two
// lines; single quotes take everything literally; inside double quotes a
// backslash escapes only a quote, a backslash, a dollar sign or a
// backquote; outside quotes it escapes the next character; a parameter
// expansion in braces (`${x:-y}`) is text up to its closing brace; an
// unquoted `#` opening a word starts a comment. A command substitution,
// `$(...)` or backquotes, inside double quotes too, is a command of its own
// and its redirections are read on their own. A heredoc or a here-string
// carries text, not a path; `<&` and a descriptor duplication (`2>&1`,
// `>&-`) name no file; the body of a heredoc, up to its terminator line,
// is data and is left out; a process substitution (`<(cmd)`) reads as an empty
// target and the scan goes on inside the parentheses.
const REDIRECTION_OPERATORS = ['<<<', '<<', '>>', '>|', '>&', '<>', '<&', '>', '<'];
const WORD_BREAKS = new Set([' ', '\t', '\n', '\r', '|', '&', ';', '(', ')', '<', '>']);
const DOUBLE_QUOTE_ESCAPES = new Set(['"', '\\', '$', '`']);

export interface ShellWord {
  raw: string;
  value: string;
  end: number;
}

export interface Redirection {
  target: ShellWord;
  writes: boolean;
}

// The quoted span opening at `start`: its value once the quotes are gone,
// and the index past the closing quote (past the end when it never closes).
function readQuoted(command: string, start: number): { value: string; end: number } {
  const quote = command[start];
  let value = '';
  let i = start + 1;
  while (i < command.length && command[i] !== quote) {
    if (quote === '"' && command[i] === '\\' && command[i + 1] === '\n') {
      i += 2;
      continue;
    }
    // A `${...}`, `$(...)` or backquoted command inside double quotes is read
    // whole: a quote inside it opens a string of its own.
    const nested = quote === '"' && command[i] !== '\\' ? doubleQuotedSpanEnd(command, i) : i;
    if (nested !== i) {
      value += command.slice(i, nested);
      i = nested;
      continue;
    }
    if (quote === '"' && command[i] === '\\' && DOUBLE_QUOTE_ESCAPES.has(command[i + 1] ?? '')) i += 1;
    value += command[i];
    i += 1;
  }
  return { value, end: Math.min(i + 1, command.length) };
}

// The line with its backslash-newline continuations removed, everywhere
// but inside single quotes, where the shell keeps them.
function joinContinuations(command: string): string {
  let joined = '';
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      const end = readQuoted(command, i).end;
      joined += command.slice(i, end);
      i = end;
    } else if (ch === '\\') {
      if (command[i + 1] !== '\n') joined += command.slice(i, i + 2);
      i += 2;
    } else {
      joined += ch;
      i += 1;
    }
  }
  return joined;
}

// Index past the span at `i` the shell reads as text rather than as
// operators (a quoted span, an escaped character, a parameter expansion in
// braces); `i` itself when no such span starts there.
export function skipText(command: string, i: number): number {
  const ch = command[i];
  if (ch === '$' && command[i + 1] === "'") return readAnsiC(command, i + 1).end;
  if (ch === '"' || ch === "'") return readQuoted(command, i).end;
  if (ch === '\\') return Math.min(i + 2, command.length);
  if (ch === '$' && command[i + 1] === '{') return parameterExpansionEnd(command, i + 2);
  return i;
}

// Index past the `}` that closes the `${` whose body starts at `start`. A
// nested `${...}`, a command or process substitution and a backquoted
// command are read whole, so a `}` of theirs does not close it, as bash
// reads it; the end of the line when it never closes.
function parameterExpansionEnd(command: string, start: number): number {
  let i = start;
  while (i < command.length) {
    const skipped = skipNested(command, i, false);
    if (skipped !== i) {
      i = skipped;
    } else if (command[i] === '}') {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return command.length;
}

// Index past the command or process substitution (`$(...)`, `$((...))`,
// `<(...)`, `>(...)`) or backquoted command opening at `i`; `i` itself when
// none opens there.
function skipSubstitution(command: string, i: number): number {
  if (command[i] === '`') {
    let j = i + 1;
    while (j < command.length && command[j] !== '`') j += command[j] === '\\' ? 2 : 1;
    return Math.min(j + 1, command.length);
  }
  if ('$<>'.includes(command[i]) && command[i + 1] === '(') return Math.min(closingParenthesis(command, i + 2) + 1, command.length);
  return i;
}

// Index of the newline that ends the comment a `#` opening a word starts at
// `i` (the end of the line when none follows); `i` itself when no comment
// starts there.
function skipComment(command: string, i: number): number {
  if (command[i] !== '#') return i;
  const prev = i === 0 ? -1 : precedingCharIndex(command, i - 1);
  if (prev >= 0 && !COMMENT_WORD_START.has(command[prev])) return i;
  const newline = command.indexOf('\n', i);
  return newline === -1 ? command.length : newline;
}

// Index past a span read whole at `i`: text (skipText), a substitution, and
// in a command body a comment up to its newline, which a `)` in it does not
// close; `i` itself when none starts there.
function skipNested(command: string, i: number, inCommand: boolean): number {
  const text = skipText(command, i);
  if (text !== i) return text;
  const substitution = skipSubstitution(command, i);
  if (substitution !== i || !inCommand) return substitution;
  return skipComment(command, i);
}

// Characters before an unquoted `#` that let it open a word, so the `#`
// starts a comment. Deliberately excludes `)`, `<` and `>`: `$(date)#c` is
// one word, and `>#x` redirects to a file named `#x` (matches shell-split.js
// and bash itself), so those do not begin a comment.
const COMMENT_WORD_START = new Set([' ', '\t', '\n', '\r', ';', '&', '|', '(']);

// The character before `i` that the shell reads as preceding it, walking back
// over backslash-newline line continuations: bash removes such a pair before
// tokenizing, so `foo\<newline>#bar` is the one word `foo#bar` and the `#` is
// mid-word, not a comment. A run of backslashes continues the line only when
// it is odd (each pair is an escaped literal backslash).
function precedingCharIndex(command: string, i: number): number {
  let j = i;
  while (j >= 0 && command[j] === '\n') {
    let backslashes = 0;
    let k = j - 1;
    while (k >= 0 && command[k] === '\\') { backslashes += 1; k -= 1; }
    if (backslashes % 2 === 0) break;
    j = k;
  }
  return j;
}

// The command line with the inert text of a trailing `# comment` removed, so
// a path or an operator that only sits in a comment is never judged. A `#`
// inside quotes, a `${...}` expansion, or mid-word is left in place (skipText
// walks those spans, and a line continuation before it keeps it mid-word);
// the comment runs to the end of its line.
export function stripTrailingComment(command: string): string {
  let i = 0;
  while (i < command.length) {
    const skipped = skipText(command, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (command[i] === '#') {
      const prev = i === 0 ? -1 : precedingCharIndex(command, i - 1);
      if (prev < 0 || COMMENT_WORD_START.has(command[prev])) {
        const newline = command.indexOf('\n', i);
        return newline === -1 ? command.slice(0, i) : command.slice(0, i) + command.slice(newline);
      }
    }
    i += 1;
  }
  return command;
}

// The word at `start`, leading blanks skipped, up to the next unquoted blank
// or shell metacharacter: as typed, and as the shell would hand it over.
function readWord(command: string, start: number): ShellWord {
  let i = start;
  while (i < command.length && (command[i] === ' ' || command[i] === '\t')) i += 1;
  const from = i;
  let value = '';
  while (i < command.length && !WORD_BREAKS.has(command[i])) {
    const ch = command[i];
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(command, i);
      value += quoted.value;
      i = quoted.end;
    } else if (ch === '\\') {
      value += command.slice(i + 1, i + 2);
      i += 2;
    } else if (ch === '$' && command[i + 1] === '{') {
      const end = skipText(command, i);
      value += command.slice(i, end);
      i = end;
    } else {
      value += ch;
      i += 1;
    }
  }
  return { raw: command.slice(from, i), value, end: i };
}

// Position of the next `<` or `>` at or after `start` that the shell reads
// as an operator, outside quotes and not escaped; -1 when there is none. A
// comment (an unquoted `#` that opens a word) runs to the end of its line
// and is skipped, since what follows the newline is read again.
function nextOperator(command: string, start: number): number {
  let i = start;
  while (i < command.length) {
    const skipped = skipText(command, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = command[i];
    if (ch === '#' && (i === 0 || WORD_BREAKS.has(command[i - 1]))) {
      const newline = command.indexOf('\n', i);
      if (newline === -1) return -1;
      i = newline;
      continue;
    }
    if (ch === '<' || ch === '>') return i;
    i += 1;
  }
  return -1;
}

// The redirection whose operator starts at `at`, null when it names no
// file; the delimiter of the heredoc it opens, if any; and the index the
// scan resumes from.
function redirectionAt(command: string, at: number): { redirection: Redirection | null; heredoc: string | null; next: number } {
  const operator = REDIRECTION_OPERATORS.find(op => command.startsWith(op, at)) ?? command[at];
  const target = readWord(command, at + operator.length);
  if (operator === '<<') return { redirection: null, heredoc: target.value.replace(/^-/, ''), next: target.end };
  const namesNoFile = operator === '<<<' || operator === '<&'
    || (operator === '>&' && /^(?:\d+|-)$/.test(target.value))
    || target.value.length === 0;
  if (namesNoFile) return { redirection: null, heredoc: null, next: target.end };
  return { redirection: { target, writes: operator !== '<' }, heredoc: null, next: target.end };
}

// Index of the newline ending the line that carries `delimiter` alone
// (leading tabs allowed, as `<<-` strips them), searched from `start`; the
// end of the command when that line never comes.
function terminatorLineEnd(command: string, start: number, delimiter: string): number {
  let lineStart = start;
  while (lineStart < command.length) {
    const newline = command.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? command.length : newline;
    if (command.slice(lineStart, lineEnd).replace(/^\t+/, '') === delimiter) return lineEnd;
    lineStart = lineEnd + 1;
  }
  return command.length;
}

// Index of the end of the last terminator line of the heredocs opened on
// the line that ends at `newline`: their bodies follow that line in order,
// carry data, and are left out of the scan.
function heredocBodiesEnd(command: string, newline: number, delimiters: string[]): number {
  let end = newline;
  for (const delimiter of delimiters) end = terminatorLineEnd(command, end + 1, delimiter);
  return end;
}

// Index of the parenthesis closing the substitution whose body starts at
// `start`, quoted spans, nested substitutions, backquoted commands and
// comments read whole (skipNested); the end of the line when it never
// closes.
export function closingParenthesis(command: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < command.length) {
    const skipped = skipNested(command, i, true);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (command[i] === '(') depth += 1;
    if (command[i] === ')') depth -= 1;
    if (depth === 0) return i;
    i += 1;
  }
  return command.length;
}

// The bodies of the command substitutions of the line, `$(...)` and
// backquotes, inside double quotes too; a substitution nested in a body is
// found when that body is read in turn.
function substitutionBodies(command: string): string[] {
  const bodies: string[] = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'" || ch === '\\') {
      i = ch === "'" ? readQuoted(command, i).end : i + 2;
    } else if (ch === '`') {
      const close = command.indexOf('`', i + 1);
      const end = close === -1 ? command.length : close;
      bodies.push(command.slice(i + 1, end));
      i = end + 1;
    } else if (ch === '$' && command[i + 1] === '(') {
      const end = closingParenthesis(command, i + 2);
      bodies.push(command.slice(i + 2, end));
      i = end + 1;
    } else {
      i += 1;
    }
  }
  return bodies;
}

export function redirectionsOf(line: string): Redirection[] {
  const command = joinContinuations(line);
  const found: Redirection[] = [];
  const heredocs: string[] = [];
  let from = 0;
  let at = nextOperator(command, from);
  while (at !== -1) {
    const newline = command.indexOf('\n', from);
    if (heredocs.length > 0 && newline !== -1 && newline < at) {
      from = heredocBodiesEnd(command, newline, heredocs.splice(0));
      at = nextOperator(command, from);
      continue;
    }
    const { redirection, heredoc, next } = redirectionAt(command, at);
    if (heredoc !== null) heredocs.push(heredoc);
    if (redirection !== null) found.push(redirection);
    from = next;
    at = nextOperator(command, from);
  }
  for (const body of substitutionBodies(command)) found.push(...redirectionsOf(body));
  return found;
}
