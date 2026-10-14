'use strict';

// Shell-word lexing for the Bash guardian hook: ANSI-C/double/single-quote
// decoding and the readShellWord/shellWords tokenizer every other sibling
// module builds on. Part of the pre-bash-guardian-validate.js split (#1712).

const { isRedirection } = require('../lib/stdin-programs');

const BACKSLASH_ESCAPES = process.platform !== 'win32';
const LITERAL = '\u0001';
const ANSI_ESCAPES = { n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', f: '\f', v: '\v', e: '\u001b', E: '\u001b', '\\': '\\', "'": "'", '"': '"', '?': '?' };

// Numeric ANSI-C escapes inside $'...': the introducing letter (none for
// octal), the digit class, the longest run and the radix; `\cX` and the
// named escapes follow. An unknown escape keeps its backslash, as Bash does.
const ANSI_NUMERIC = [['x', /[0-9a-fA-F]/, 2, 16], ['u', /[0-9a-fA-F]/, 4, 16], ['U', /[0-9a-fA-F]/, 8, 16], ['', /[0-7]/, 3, 8]];

// A byte escape above 0x7F (\xHH, octal) names a raw byte the shell passes
// through; a string cannot carry it faithfully, so the word is marked as one
// this hook cannot resolve. A code point beyond Unicode is kept as typed.
function ansiNumeric(text, at) {
  const next = text[at + 1];
  for (const [letter, digit, max, radix] of ANSI_NUMERIC) {
    if (letter && next !== letter) continue;
    let end = at + 1 + letter.length;
    const from = end;
    while (end < text.length && end - from < max && digit.test(text[end])) end += 1;
    if (end === from) return null;
    const point = Number.parseInt(text.slice(from, end), radix);
    if (point > 0x10ffff) return { value: text.slice(at, end), end, unsure: true };
    const byteEscape = (letter === 'x' || letter === '') && point > 0x7f;
    return { value: String.fromCodePoint(point), end, unsure: byteEscape };
  }
  return null;
}


function ansiEscape(text, at) {
  const numeric = ansiNumeric(text, at);
  if (numeric) return numeric;
  const next = text[at + 1];
  if (next === 'c' && text[at + 2] !== undefined) return { value: String.fromCodePoint(text[at + 2].toUpperCase().codePointAt(0) ^ 0x40), end: at + 3 };
  return { value: Object.hasOwn(ANSI_ESCAPES, next) ? ANSI_ESCAPES[next] : `\\${next}`, end: at + 2 };
}



function isQuoteOpener(text, at) {
  const ch = text[at];
  return ch === '"' || ch === "'" || (ch === '$' && (text[at + 1] === '"' || text[at + 1] === "'"));
}

// The body of a quoted run starting at its opening quote (or at the $ of
// $'...' and $"..."): single quotes are literal, double quotes keep their
// escapes for \ " $ and ` and drop a backslash-newline, $'...' decodes the
// ANSI-C escapes.
// What a backslash inside a decoding quote stands for: nothing for a
// dropped backslash-newline, an ANSI-C escape in $'...', one of \ " $ ` in
// double quotes; null when the backslash is literal there.
function decodedEscape(text, at, ansi) {
  const next = text[at + 1];
  if (next === undefined) return null;
  if (next === '\n') return { value: '', end: at + 2 };
  if (ansi) return ansiEscape(text, at);
  return '"\\$`'.includes(next) ? { value: next, end: at + 2 } : null;
}

function readQuoted(text, start) {
  const ansi = text[start] === '$';
  const quote = ansi ? text[start + 1] : text[start];
  const decodes = quote === '"' || ansi;
  let value = '';
  let i = start + (ansi ? 2 : 1);
  let unsure = false;
  let expands = false;
  while (i < text.length && text[i] !== quote) {
    const escaped = text[i] === '\\' && decodes ? decodedEscape(text, i, quote === "'") : null;
    // Double quotes keep $ and ` live: the shell still expands them.
    expands = expands || (!escaped && quote === '"' && (text[i] === '$' || text[i] === '`'));
    value += escaped ? escaped.value : text[i];
    unsure = unsure || Boolean(escaped?.unsure);
    i = escaped ? escaped.end : i + 1;
  }
  return { value, unsure, expands, end: Math.min(i + 1, text.length) };
}



// One shell word as the shell would see it: a backslash-newline is a
// continuation, a backslash outside quotes escapes the next character (on
// Windows it is a path separator instead). `code` masks every literal
// character, so an unquoted wildcard (which the shell would expand) is told
// apart from a quoted one.
// `(` and `)` outside quotes are shell operators, not word characters: a
// subshell `(bash x.sh)` opens and closes around the words it runs. They
// belong to a word only as a substitution or pattern opened after one of
// these characters ($(...), <(...), @(...)), as the `()` of a function
// name, or nested inside such a run, where the matching `)` closes them.
const PAREN_RUN_OPENERS = '$<>@!+?*';

// How a `(` or `)` at `i` is read into `word`: null when it ends the word
// (an operator), otherwise the text it adds and where reading goes on.
function parenStep(text, i, word) {
  if (text[i] === ')') {
    if (word.depth === 0) return null;
    word.depth -= 1;
    return { text: ')', end: i + 1 };
  }
  const before = text[i - 1] ?? '';
  if (word.depth === 0 && !PAREN_RUN_OPENERS.includes(before)) {
    if (text[i + 1] !== ')' || word.value === '') return null;
    return { text: '()', end: i + 2 };
  }
  // <(...) and >(...) stand for a path the shell makes when it runs.
  word.expands = word.expands || (word.depth === 0 && '<>'.includes(before));
  word.depth += 1;
  return { text: '(', end: i + 1 };
}

function readShellWord(text, start) {
  const word = { value: '', code: '', unsure: false, expands: false, bare: false, depth: 0 };
  let i = start;

  while (i < text.length) {
    const ch = text[i];
    if (ch === '(' || ch === ')') {
      const step = parenStep(text, i, word);
      if (step === null) break;
      word.value += step.text;
      word.code += step.text;
      i = step.end;
    } else if (ch === '\\' && text[i + 1] === '\n') {
      i += 2;
    } else if (isQuoteOpener(text, i)) {
      const quoted = readQuoted(text, i);
      word.value += quoted.value;
      word.code += LITERAL.repeat(quoted.value.length);
      word.unsure = word.unsure || quoted.unsure;
      word.expands = word.expands || quoted.expands;
      i = quoted.end;
    } else if (ch === '\\' && BACKSLASH_ESCAPES && i + 1 < text.length) {
      word.value += text[i + 1];
      word.code += LITERAL;
      i += 2;
    } else if (/\s/.test(ch) && word.depth === 0) {
      break;
    } else {
      word.expands = word.expands || ch === '$' || ch === '`';
      word.bare = word.bare || ch === '$' || ch === '`';
      word.value += ch;
      word.code += ch;
      i += 1;
    }
  }
  // `tilde`: an unquoted ~ that the shell turns into a home directory.
  // `bare`: an expansion outside quotes, whose value the shell splits.
  // `redirect`: a redirection the shell performs, not a quoted word that
  // only reads like one. `braced`: an unquoted brace the shell may expand.
  return {
    value: word.value, globbed: /[*?[]/.test(word.code), unsure: word.unsure, expands: word.expands, bare: word.bare, tilde: word.code.startsWith('~'),
    redirect: isRedirection(word.code), braced: /[{}]/.test(word.code), start, end: i,
  };
}

function shellWords(segment) {
  const words = [];
  let i = 0;
  while (i < segment.length) {
    if (/\s/.test(segment[i])) {
      i += 1;
      continue;
    }
    if (segment[i] === '(' || segment[i] === ')') {
      words.push({ value: segment[i], globbed: false, unsure: false, end: i + 1 });
      i += 1;
      continue;
    }
    const word = readShellWord(segment, i);
    words.push(word);
    i = word.end;
  }
  return words;
}

// A script an interpreter is asked to run (`bash deploy.sh`, `sh x.txt`,
// `source env.sh`, `. env.sh`, `/bin/bash "my dir/x.sh"`, `sudo bash x.sh`)
// is judged like typed commands: its own segments join the same validation,
// recursively for the scripts it runs in turn, so writing a denied command
// to a file first, under any name, does not change the verdict. A script
// that cannot be inspected (unreadable, too large, nested too deep) fails
// closed.
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash', 'ash', 'source', '.']);

// Shell options whose value is the next word, not the script it runs.
const SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);

// A short option bundle (-nx) or --noexec asks the shell to read its script
// without running it; then its commands never execute and need no inspection.
function isNoexecFlag(value) {
  if (value === '--noexec') return true;
  return /^-[a-zA-Z]+$/.test(value) && value.includes('n');
}

// A word consumed as the value of the previous option (bash -o noexec): true
// once it is taken, after noting a noexec that arrived that way.
function consumedAsOptionValue(word, state) {
  if (!state.awaiting) return false;
  if ((state.awaiting === '-o' || state.awaiting === '-O') && word.value === 'noexec') state.noexec = true;
  state.awaiting = null;
  return true;
}

// A short option cluster that carries -c: the shell runs its first operand
// as code rather than a script file.
function isCommandStringFlag(value) {
  return /^-[A-Za-z]+$/.test(value) && value.includes('c');
}

// What one of the shell's options tells: -n or --noexec, -c, or an option
// whose value is the next word.
function noteShellOption(value, state) {
  if (isNoexecFlag(value)) state.noexec = true;
  if (isCommandStringFlag(value)) state.command = true;
  state.awaiting = SHELL_VALUE_OPTIONS.has(value) ? value : null;
}

module.exports = { shellWords, SHELL_INTERPRETERS, SHELL_VALUE_OPTIONS, consumedAsOptionValue, noteShellOption };
