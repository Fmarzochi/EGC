/**
 * Security audit log for egc-guardian.
 *
 * Writes append-only NDJSON entries to ~/.egc/audit.log for every
 * blocked/denied call. Rotates at MAX_SIZE_BYTES. Redacts values that
 * look like secrets before persisting.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AUDIT_LOG_DIR = path.join(os.homedir(), '.egc');
export const AUDIT_LOG_PATH = path.join(AUDIT_LOG_DIR, 'audit.log');
export const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// Keys whose values are always redacted, matched by the words the key is
// made of (token, apiToken, x-api-key, client_secret, sessionCookie, ...),
// not by an exact spelling.
const REDACTED_KEY_WORDS = /(?:^|[^a-z])(?:token|secret|password|passwd|pwd|credential|authorization|auth|cookie|session[-_]?id|private[-_]?key|api[-_]?key|access[-_]?key|secret[-_]?key|signing[-_]?key|apikey|privatekey)(?:$|[^a-z])/;

function isRedactedKey(key: string): boolean {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  return REDACTED_KEY_WORDS.test(spaced);
}

// Secrets embedded inside free text such as a shell command. Each prefix
// pattern stops exactly where the secret value starts; the value itself
// (quoted, or a bare run up to whitespace) is consumed in code, which keeps
// every pattern short. scripts/hooks/post-bash-command-log.js carries the
// same list for the Bash command log: change both together.
const SECRET_VALUE_PREFIXES: RegExp[] = [
  /authorization\s*:\s*(?:bearer|basic|token)\s+/gi,
  /(?:x-)?(?:api|secret|access|private|auth)[-_]?(?:key|secret|token)\s*:\s*/gi,
  // basic auth: --user=name:password anywhere; -u name:password only inside
  // a curl invocation, since -u is an ordinary flag for rsync, sudo and others
  /--user(?:=|\s+)["']?[^\s:"']+:/gi,
  /--?(?:token|password|passwd|secret|auth|credentials?)(?:=|\s+)/gi,
  /--?(?:api|access|private)[-_]?(?:key|secret)(?:=|\s+)/gi,
  /\b[\w-]*(?:token|password|passwd|secret|apikey)[\w-]*\s*=\s*/gi,
  /\b[\w-]*(?:api|access|private)[-_]?key[\w-]*\s*=\s*/gi,
  /\b(?:auth|authorization|credentials?)\s*=\s*/gi,
];
const SECRET_SHAPES: RegExp[] = [
  /(:\/\/[^\s/:@]+:)[^\s@]+(?=@)/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_\w{20,}\b/g,
  /\bsk-[\w-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bglpat-[\w-]{20,}\b/g,
  /\bAIza[\w-]{35}\b/g,
  /\bey[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g,
];
const REDACTED = '[REDACTED]';
// Command lines nest through substitutions and shell -c bodies; past this
// many levels a body is replaced whole instead of being read.
const MAX_NESTING = 64;


// The end (exclusive) of a secret value starting at `start`: a quoted value
// runs to its closing quote, a bare one to the next blank or shell
// delimiter. After a space-separated option a bare run starting with '-'
// is the next flag, not a value; a value attached with '=' or ':' is taken
// as is.
const BARE_VALUE_END = /[\s"'&;]/;

function secretValueEnd(text: string, start: number, attached: boolean): number {
  const first = text[start];
  if (!attached && first === '-') return start;
  if (first === '"' || first === "'") {
    const close = text.indexOf(first, start + 1);
    return close < 0 ? text.length : close + 1;
  }
  const stop = text.slice(start).search(BARE_VALUE_END);
  return stop < 0 ? text.length : start + stop;
}

// A character that came from a quoted run, an escape or a substitution:
// literal text the outer command never treats as syntax.
const LITERAL = '\u0001';
const ANSI_NAMED: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', f: '\f', v: '\v', e: '\u001b', E: '\u001b', '\\': '\\', "'": "'", '"': '"', '?': '?' };

// curl's -u name:password in any spelling, redacted in one left-to-right
// pass over shell words read the way the shell reads them. A separator
// starts a new command, a substitution is a command line of its own, and a
// value is touched only after curl appeared in that command (-u is an
// ordinary flag for rsync, sudo and others). Backslashes escape outside
// quotes only where the platform's shell reads them so.
const COMMAND_SEPARATORS = ';|&\n';
const BACKSLASH_ESCAPES = process.platform !== 'win32';

type ShellWord = { raw: string; value: string; code: string; end: number };
type Piece = { value: string; raw: string; end: number };

function digitRun(text: string, from: number, max: number, digit: RegExp): string {
  let end = from;
  while (end < text.length && end - from < max && digit.test(text[end])) end += 1;
  return text.slice(from, end);
}

// One ANSI-C escape starting at the backslash inside $'...': hex (\xHH),
// unicode (\uHHHH, \UHHHHHHHH), control (\cX), octal (\NNN) and the named
// ones; an unknown escape keeps its backslash, as Bash does.
// A decoded code point, or the escape kept as typed when it is beyond what a
// string can hold (Bash would reject it; the log must not fail open).
function codePointPiece(point: number, text: string, at: number, end: number): Piece {
  const raw = text.slice(at, end);
  return { value: point > 0x10ffff ? raw : String.fromCodePoint(point), raw, end };
}

function ansiEscape(text: string, at: number): Piece {

  const next = text[at + 1];
  const hexWidth = { x: 2, u: 4, U: 8 }[next as 'x' | 'u' | 'U'];
  if (hexWidth) {
    const run = digitRun(text, at + 2, hexWidth, /[0-9a-fA-F]/);
    if (run) return codePointPiece(Number.parseInt(run, 16), text, at, at + 2 + run.length);

  } else if (next === 'c' && text[at + 2] !== undefined) {
    return { value: String.fromCodePoint((text[at + 2].toUpperCase().codePointAt(0) ?? 0) ^ 0x40), raw: text.slice(at, at + 3), end: at + 3 };
  } else {
    const run = digitRun(text, at + 1, 3, /[0-7]/);
    if (run) return codePointPiece(Number.parseInt(run, 8), text, at, at + 1 + run.length);

  }
  const value = Object.hasOwn(ANSI_NAMED, next) ? ANSI_NAMED[next] : `\\${next}`;
  return { value, raw: text.slice(at, at + 2), end: at + 2 };
}

function isQuoteOpener(text: string, at: number): boolean {
  const ch = text[at];
  return ch === '"' || ch === "'" || (ch === '$' && (text[at + 1] === '"' || text[at + 1] === "'"));
}

function isSubstitutionOpener(text: string, at: number): boolean {
  return text[at] === '`' || ((text[at] === '$' || text[at] === '<' || text[at] === '>') && text[at + 1] === '(');
}

// The end (exclusive) of a `...` substitution: an escaped backtick does
// not close it; the text length when it never closes.
function backtickEnd(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '`') return i + 1;
  }
  return text.length;
}

// The end (exclusive) of a $(...), <(...), >(...) or `...` substitution
// starting at `at`, balanced across nested substitutions and quotes; the
// text length when it never closes.
// Inside double quotes, the index after the escape or the nested
// substitution ($( ) or backticks) that starts at `i`; -1 when `i` is an
// ordinary character. A quote in a nested body belongs to it, not to the
// enclosing run.
function nestedInDoubleQuotes(text: string, i: number, level: number): number {
  if (text[i] === '\\') return i + 2;
  if (text[i] === '`' || (text[i] === '$' && text[i + 1] === '(')) return substitutionEnd(text, i, level + 1);
  return -1;
}

// The index just past the quoted run whose opening quote is at `at`; the
// text length when it never closes.
function quotedRunEnd(text: string, at: number, level = 0): number {
  const quote = text[at];
  let i = at + 1;
  while (i < text.length) {
    if (text[i] === quote) return i + 1;
    const nested = quote === '"' ? nestedInDoubleQuotes(text, i, level) : -1;
    i = nested === -1 ? i + 1 : nested;
  }
  return text.length;
}

// Inside a $( ), the index after the escape, quoted run or backtick
// substitution that starts at `i`; -1 when `i` is an ordinary character.
function nestedInSubstitution(text: string, i: number, level: number): number {
  const ch = text[i];
  if (ch === '\\') return i + 2;
  if (ch === "'" || ch === '"') return quotedRunEnd(text, i, level);
  return ch === '`' ? backtickEnd(text, i) : -1;
}

// The end (exclusive) of a $(...), <(...), >(...) or `...` substitution
// starting at `at`, balanced across nested substitutions and quotes; the
// text length when it never closes. Past the nesting bound the rest of the
// text is one unclosed unit.
function substitutionEnd(text: string, at: number, level = 0): number {
  if (text[at] === '`') return backtickEnd(text, at);
  if (level >= MAX_NESTING) return text.length;
  let depth = 0;
  let i = at + 1;
  while (i < text.length) {
    const nested = nestedInSubstitution(text, i, level);
    if (nested !== -1) {
      i = nested;
      continue;
    }
    depth += parenthesisDelta(text[i]);
    if (depth === 0 && text[i] === ')') return i + 1;
    i += 1;
  }
  return text.length;
}

function parenthesisDelta(ch: string): number {
  if (ch === '(') return 1;
  return ch === ')' ? -1 : 0;
}

// The escape at a backslash inside a decoding quote: a dropped
// backslash-newline, an ANSI-C escape in $'...', or one of \ " $ ` in double
// quotes; null when the backslash is literal there.
function quotedEscape(text: string, at: number, ansi: boolean): Piece | null {
  const next = text[at + 1];
  if (next === undefined) return null;
  if (next === '\n') return { value: '', raw: '', end: at + 2 };
  if (ansi) return ansiEscape(text, at);
  return '"\\$`'.includes(next) ? { value: next, raw: text.slice(at, at + 2), end: at + 2 } : null;
}

// A substitution is a command line of its own: its inside is redacted on
// its own terms and the outer command never sees it as syntax.
function redactSubstitution(inner: string, redactor: CurlRedactor): string {
  const backtick = inner.startsWith('`');
  const closed = backtick ? inner.endsWith('`') && inner.length > 1 : inner.endsWith(')');
  const opener = backtick ? '`' : inner.slice(0, 2);
  const body = inner.slice(opener.length, closed ? -1 : undefined);
  let closer = '';
  if (closed) closer = backtick ? '`' : ')';
  return `${opener}${redactor.redact(body)}${closer}`;

}

// A substitution at `at` as one literal unit, redacted inside.
function substitutionPiece(text: string, at: number, redactor: CurlRedactor): Piece {
  const end = substitutionEnd(text, at);
  const inner = text.slice(at, end);
  return { value: inner, raw: redactSubstitution(inner, redactor), end };
}

// One piece of a quoted run at `at`: a substitution (double quotes run
// them), a decoded escape, or the character itself.
function quotedPiece(text: string, at: number, quote: string, decodes: boolean, redactor: CurlRedactor): Piece {
  if (quote === '"' && isSubstitutionOpener(text, at)) return substitutionPiece(text, at, redactor);
  const escaped = decodes && text[at] === '\\' ? quotedEscape(text, at, quote === "'") : null;
  return escaped ?? { value: text[at], raw: text[at], end: at + 1 };
}

// The body of a quoted run starting at its opening quote (or at the $ of
// $'...' and $"..."): single quotes are literal, double quotes decode their
// escapes and still run the substitutions inside them, $'...' decodes the
// ANSI-C escapes. `raw` is the run as it will be logged.
function readQuoted(text: string, start: number, redactor: CurlRedactor): Piece {
  const opener = text[start] === '$' ? 2 : 1;
  const quote = text[start + opener - 1];
  const decodes = quote === '"' || opener === 2;
  const pieces: Piece[] = [];
  let i = start + opener;
  while (i < text.length && text[i] !== quote) {
    const piece = quotedPiece(text, i, quote, decodes, redactor);
    pieces.push(piece);
    i = piece.end;
  }
  const end = Math.min(i + 1, text.length);
  const body = pieces.map(piece => piece.raw).join('');
  return {
    value: pieces.map(piece => piece.value).join(''),
    raw: `${text.slice(start, start + opener)}${body}${text.slice(i, end)}`,
    end,
  };
}

// One piece of a word at `at`: a dropped continuation, a substitution (one
// literal unit, redacted inside), a quoted run, an escaped character or a
// plain one; null at a separator or blank.
function wordPiece(text: string, at: number, redactor: CurlRedactor): { value: string; code: string; raw: string; end: number } | null {
  const ch = text[at];
  if (ch === '\\' && text[at + 1] === '\n') return { value: '', code: '', raw: '', end: at + 2 };
  if (isSubstitutionOpener(text, at)) {
    const piece = substitutionPiece(text, at, redactor);
    return { value: piece.value, code: LITERAL.repeat(piece.value.length), raw: piece.raw, end: piece.end };
  }

  if (isQuoteOpener(text, at)) {
    const quoted = readQuoted(text, at, redactor);
    return { value: quoted.value, code: LITERAL.repeat(quoted.value.length), raw: quoted.raw, end: quoted.end };
  }
  if (ch === '\\' && BACKSLASH_ESCAPES && at + 1 < text.length) {
    return { value: text[at + 1], code: LITERAL, raw: text.slice(at, at + 2), end: at + 2 };
  }
  if (COMMAND_SEPARATORS.includes(ch) || /\s/.test(ch)) return null;
  return { value: ch, code: ch, raw: ch, end: at + 1 };
}

// One shell word starting at `start`, read the way the shell reads it. `raw`
// is the word as it will be logged, `value` the word the program receives,
// `code` the same word with every literal character masked so syntax is
// only looked for where the shell would see it.
function readShellWord(text: string, start: number, redactor: CurlRedactor): ShellWord {
  const word = { raw: '', value: '', code: '', end: start };
  while (word.end < text.length) {
    const piece = wordPiece(text, word.end, redactor);
    if (!piece) break;
    word.value += piece.value;
    word.code += piece.code;
    word.raw += piece.raw;
    word.end = piece.end;
  }
  return word;
}

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'ash']);
const CURL_NAME_RE = /^curl(?:\.exe|\.cmd|\.bat)?$/i;
const GLUED_USER_FLAGS = ['--user=', '-u=', '-u'];

function basename(value: string): string {
  return value.split(/[\\/]/).pop() ?? '';
}

// Whether a shell's option word asks for a command string (-c, -lc, -ic).
function isCommandStringFlag(value: string): boolean {
  if (!value.startsWith('-') || value.length < 2) return false;
  const letters = value.slice(1);
  return letters.toLowerCase().includes('c') && [...letters].every(ch => /[a-z]/i.test(ch));
}

// An ANSI-C quoted run may hide or shift the separator behind escapes:
// everything after the first separator goes, or the whole run; null when
// the credential has no such run.
// The index of the dollar of an unescaped $'...' opener outside quotes,
// read with the mask's own steps; -1 when none.
function ansiOpenerIndex(raw: string): number {
  const state: MaskState = { quote: null, dollarBefore: false };
  for (let at = 0; at < raw.length;) {
    const wasAnsi = state.quote === 'ansi';
    const step = maskStep(raw, at, state);
    if (!wasAnsi && state.quote === 'ansi') return at - 1;
    at = step.end;
  }
  return -1;
}

function ansiCredential(raw: string, colon: number): string | null {
  const ansiAt = ansiOpenerIndex(raw);
  if (ansiAt === -1) return null;

  if (colon !== -1 && colon < ansiAt) return `${raw.slice(0, colon + 1)}${REDACTED}`;
  return `${raw.slice(0, ansiAt)}$'${REDACTED}'`;
}

// What follows the redacted password as typed: the closing quote of a
// quoted credential, or the delimiters that closed a substitution.
function credentialTail(raw: string, colon: number): string {
  const quoteAt = raw.startsWith('$') ? 1 : 0;
  const quote = raw[quoteAt] === '"' || raw[quoteAt] === "'" ? raw[quoteAt] : '';
  if (quote && raw.length > quoteAt + 1 && raw.endsWith(quote)) return quote;
  let keep = raw.length;
  while (keep > colon + 1 && (raw[keep - 1] === ')' || raw[keep - 1] === '`')) keep -= 1;
  return raw.slice(keep);
}

// The redaction of one command line, word by word, with the state of the
// command being read: whether curl or a shell has been seen, and whether
// the next word is a credential or a command string.
let nesting = 0;

class CurlRedactor {

  private sawCurl = false;
  private sawShell = false;
  private valueNext = false;
  private bodyNext = false;

  private reset(): void {
    this.sawCurl = false;
    this.sawShell = false;
    this.valueNext = false;
    this.bodyNext = false;
  }

  // Nested command lines recurse through this entry; the counter bounds them.
  redact(text: string): string {
    if (nesting >= MAX_NESTING) return REDACTED;
    nesting += 1;
    try {
      return this.redactLine(text);
    } finally {
      nesting -= 1;
    }
  }

  private redactLine(text: string): string {
    const nested = new CurlRedactor();

    let out = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (COMMAND_SEPARATORS.includes(ch) || /\s/.test(ch)) {
        if (COMMAND_SEPARATORS.includes(ch)) nested.reset();
        out += ch;
        i += 1;
        continue;
      }
      const word = readShellWord(text, i, nested);
      i = word.end;
      out += nested.word(word);
    }
    return out;
  }

  private word(word: ShellWord): string {
    if (this.bodyNext) {
      this.bodyNext = false;
      return this.quotedBody(word.raw);
    }
    if (this.valueNext) {
      this.valueNext = false;
      return this.credential(word.raw, word.value);
    }
    if (SHELL_NAMES.has(basename(word.value).toLowerCase())) {
      this.sawShell = true;
    } else if (this.sawShell && isCommandStringFlag(word.value)) {
      this.bodyNext = true;
    } else if (this.isCurl(word)) {
      this.sawCurl = true;
    } else if (this.sawCurl && (word.value === '-u' || word.value === '--user')) {
      this.valueNext = true;
    } else if (this.sawCurl) {
      const glued = GLUED_USER_FLAGS.find(flag => word.raw.startsWith(flag) && word.raw.length > flag.length);
      if (glued) return `${glued}${this.credential(word.raw.slice(glued.length), word.value.slice(glued.length))}`;
    }
    return word.raw;
  }

  // curl by basename, with or without a Windows executable suffix, also
  // behind a group opener the shell would execute ({curl, (curl); a
  // substitution is a unit of its own and never names the outer command.
  private isCurl(word: ShellWord): boolean {
    let skip = 0;
    while (skip < word.code.length && (word.code[skip] === '(' || word.code[skip] === '{')) skip += 1;
    return CURL_NAME_RE.test(basename(word.value.slice(skip)));
  }

  // A quoted word that a shell runs as a command line (the operand of sh -c,
  // bash -lc and the like) is redacted inside its quotes.
  private quotedBody(raw: string): string {
    const prefix = raw.startsWith('$') ? 2 : 1;
    const quote = raw[prefix - 1];
    if ((quote !== '"' && quote !== "'") || raw.length < prefix + 1 || !raw.endsWith(quote)) return raw;
    return `${raw.slice(0, prefix)}${this.redact(raw.slice(prefix, -1))}${quote}`;
  }

  // The credential as typed, with the password replaced.
  private credential(raw: string, value: string): string {
    const masked = maskSubstitutions(raw);
    const colon = masked.indexOf(':');
    const ansi = ansiCredential(masked, colon);
    if (ansi !== null) return ansi;
    if (colon === -1) return masked === raw && value.includes(':') ? REDACTED : masked;
    return `${masked.slice(0, colon + 1)}${REDACTED}${credentialTail(masked, colon)}`;
  }
}

// The quote state after the character at `at`, outside any substitution:
// null, a plain quote, or 'ansi' inside $'...' (an apostrophe right after
// an unescaped dollar; `dollarBefore` says whether that dollar was one).
function quoteAfter(raw: string, at: number, quote: string | null, dollarBefore: boolean): string | null {
  const ch = raw[at];
  if (quote === null) {
    if (ch === '"') return '"';
    if (ch === "'") return dollarBefore ? 'ansi' : "'";
    return null;
  }
  const closer = quote === '"' ? '"' : "'";
  return ch === closer ? null : quote;
}

// How many characters the backslash at `at` consumes: the next one inside
// double quotes and $'...' (an escape), or outside quotes where the shell
// reads it so; one (a literal backslash) inside single quotes.
function escapeLength(raw: string, at: number, quote: string | null): number {
  if (raw[at] !== '\\' || quote === "'") return 1;
  if (quote === '"' || quote === 'ansi') return 2;
  return BACKSLASH_ESCAPES ? 2 : 1;
}

// Whether the shell would run the substitution at `at` in the current quote
// state: any opener outside quotes, $( and backticks inside double quotes,
// nothing inside single or ANSI-C quotes.
function activeSubstitution(raw: string, at: number, quote: string | null): boolean {
  if (quote === "'" || quote === 'ansi') return false;
  if (quote === null) return isSubstitutionOpener(raw, at);
  return raw[at] === '`' || (raw[at] === '$' && raw[at + 1] === '(');
}


// The shape of a substitution with its body replaced.
function maskedShape(inner: string): string {
  const backtick = inner.startsWith('`');
  const closed = backtick ? inner.length > 1 && inner.endsWith('`') : inner.endsWith(')');
  let closer = '';
  if (closed) closer = backtick ? '`' : ')';
  return `${backtick ? '`' : inner.slice(0, 2)}${REDACTED}${closer}`;
}

type MaskState = { quote: string | null; dollarBefore: boolean };

// One step of the credential mask at `at`: a substitution the shell would
// run comes back masked, anything else as typed; `state` follows the quote
// the shell is in and whether an unescaped dollar just went by.
function maskStep(raw: string, at: number, state: MaskState): { text: string; end: number } {
  if (activeSubstitution(raw, at, state.quote)) {
    const end = substitutionEnd(raw, at);
    state.dollarBefore = false;
    return { text: maskedShape(raw.slice(at, end)), end };
  }
  const step = escapeLength(raw, at, state.quote);
  if (step === 1) state.quote = quoteAfter(raw, at, state.quote, state.dollarBefore);
  state.dollarBefore = step === 1 && raw[at] === '$';
  return { text: raw.slice(at, at + step), end: at + step };
}

// Every substitution the shell would run inside a credential, with its body
// replaced: the command line that produces a credential is a secret in its
// own right. A $( ) spelled inside single quotes or behind a backslash is
// plain text and stays.
function maskSubstitutions(raw: string): string {
  const state: MaskState = { quote: null, dollarBefore: false };
  const parts: string[] = [];
  for (let at = 0; at < raw.length;) {
    const step = maskStep(raw, at, state);
    parts.push(step.text);
    at = step.end;
  }
  return parts.join('');
}

function redactCurlBasicAuth(text: string): string {
  return new CurlRedactor().redact(text);
}

function redactValuesAfter(text: string, prefixPattern: RegExp): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(prefixPattern)) {
    const start = (match.index ?? 0) + match[0].length;
    if (start < last) continue;
    const end = secretValueEnd(text, start, /[=:]$/.test(match[0]));
    if (end === start) continue;
    out += `${text.slice(last, start)}${REDACTED}`;
    last = end;
  }
  return out + text.slice(last);
}

/**
 * Replaces secret-looking runs inside free text (a shell command, a URL, a
 * header) with "[REDACTED]", keeping the surrounding text so the audit
 * entry still says what happened.
 */
export function redactSecretsInText(text: string): string {
  let out = text;
  for (const prefix of SECRET_VALUE_PREFIXES) out = redactValuesAfter(out, prefix);
  try {
    out = redactCurlBasicAuth(out);
  } catch { // NOSONAR: a command the reader cannot parse is logged whole as redacted, never dropped
    return REDACTED;
  }

  for (const shape of SECRET_SHAPES) out = out.replace(shape, (match, keep?: string) => (typeof keep === 'string' ? `${keep}${REDACTED}` : REDACTED));
  return out;
}

// Pattern for values that look like secrets (long hex/base64 strings, JWTs).
// A value that is a secret by shape alone: a JWT, a long hex or base64
// run, a PEM block, or a vendor token, even under an innocent key.
const SECRET_VALUE_RE = /^(ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2}|[A-Za-z0-9_-]{40,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*|(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|glpat-[\w-]{20,}|AIza[\w-]{35})$/;


/**
 * Returns a shallow copy of `payload` with secret-looking values replaced by
 * the string "[REDACTED]". Nested objects and arrays are walked recursively.
 */
function redactArrayItem(item: unknown): unknown {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    return redactPayload(item as Record<string, unknown>);
  }
  if (typeof item === 'string') {
    return SECRET_VALUE_RE.test(item) ? '[REDACTED]' : redactSecretsInText(item);
  }
  return item;
}

export function redactPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (isRedactedKey(k)) {

      out[k] = '[REDACTED]';
    } else if (typeof v === 'string') {
      out[k] = SECRET_VALUE_RE.test(v) ? '[REDACTED]' : redactSecretsInText(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map(redactArrayItem);
    } else if (v !== null && typeof v === 'object') {
      out[k] = redactPayload(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Append one NDJSON audit entry to ~/.egc/audit.log.
 *
 * @param action   Short identifier, e.g. "COMMAND_EXECUTION"
 * @param status   "DENIED" | "BLOCKED" | "RATE_LIMITED" | ...
 * @param details  Tool / filepath / reason / ... (will be redacted)
 */
export function writeAuditEntry(
  action: string,
  status: string,
  details: Record<string, unknown> = {},
  logDir: string = AUDIT_LOG_DIR,
  logPath: string = AUDIT_LOG_PATH,
  maxSizeBytes: number = MAX_SIZE_BYTES,
): void {
  let entry: string;
  try {
    entry =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        action,
        status,
        ...redactPayload(details),
      }) + '\n';
  } catch {
    // best-effort: non-serializable payload should not crash the guardian
    return;
  }

  try {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }

  try { fs.chmodSync(logDir, 0o700); } catch { /* non-critical */ }

  // Rotate if needed
  try {
    const stats = fs.statSync(logPath);
    if (stats.size >= maxSizeBytes) {
      fs.renameSync(logPath, `${logPath}.${Date.now()}.bak`);
    }
  } catch { /* file may not exist yet */ }

  try {
    fs.appendFileSync(logPath, entry, { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(logPath, 0o600);
  } catch {
    // best-effort: never let a log write crash the guardian
  }
}
