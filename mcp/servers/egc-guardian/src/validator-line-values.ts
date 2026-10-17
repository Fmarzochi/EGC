import { session, type ValidationResult } from './validator-session.js';
import { unquoteWord, type ShellWord } from './validator-shell-text.js';
import { isProtectedPath, isReadDeniedPath } from './validator-protected-paths.js';

// Filesystem targets an argument can carry: a bare operand (URIs excluded,
// they are download targets, not local paths), a --flag=value value, or a
// value glued to a short flag (`-o~/.bashrc`).
// file:///path and file://localhost/path name a local file, so the path
// inside gets the same protected-path check as a bare operand would; every
// other scheme is a download/read target with no local path in it.
const FILE_URI_RE = /^file:\/\/(?:localhost)?(?=\/)/i;

function unwrapFileUri(arg: string): string {
  const match = FILE_URI_RE.exec(arg);
  if (!match) return arg;
  // A query or fragment is not part of the file a client opens.
  const tail = arg.slice(match[0].length);
  const cut = tail.search(/[?#]/);
  const rest = cut === -1 ? tail : tail.slice(0, cut);
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // A malformed escape keeps the raw text; the check still sees the path.
  }
  // file:///C:/Users/x carries a slash before the drive letter.
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

export function pathSpellings(arg: string): string[] {
  return withLineValues(process.platform === 'win32' ? [arg, unquoteWord(arg)] : [arg]);
}

const MAX_LINE_VALUES = 64;
const MAX_LINE_DEPTH = 4;

// The verdict of a command whose line gives a variable more values than one
// resolution reads: a target spelled with it could go unjudged.
export const LINE_OVERFLOW_VERDICT: ValidationResult = {
  allowed: false,
  reason: `A variable the command line sets takes more values than this check reads (${MAX_LINE_VALUES}), so a target spelled with it could go unjudged; run the command with fewer values at a time`,
  trust_level: 'BLOCKED',
  advisory: false,
};

// The parameter operators whose result the line decides. With the variable
// set to a value, `:+` and `+` yield the word and the others the value (an
// operator that edits the value, as `%` or `/`, is read as the value, an
// approximation that only adds spellings). With it unset, `:-`, `-`, `:=`
// and `=` yield the word, `:+` and `+` nothing, and the rest stay as written.
const WORD_WHEN_SET = new Set([':+', '+']);
const WORD_WHEN_UNSET = new Set([':-', '-', ':=', '=']);
// The operators that edit the value: on an unset variable they yield nothing.
const EDITING_OPERATORS = new Set([':', '#', '%', '/', ',', '^']);
// Under these, an empty value counts as unset, as the shell counts it.
const CONDITIONAL_COLON = new Set([':-', ':=', ':+', ':?']);

// How many spellings one resolution may still produce; shared by every
// reference and every level of the spelling being resolved.
interface LineBudget { left: number }
const PARAMETER_OPERATORS = [':-', ':=', ':+', ':?', '-', '=', '+', '?'];
const NAME_RE = /^[A-Za-z_]\w*/;

// `indirect` is `${!NAME}`: the value of NAME names the variable read.
interface VariableReference { name: string; indirect: boolean; operator: string | null; word: string; end: number }

// The reference the `$` at `at` opens: `$NAME`, `${NAME}`, `${!NAME}` or
// `${NAME<operator>word}`, braces nested in the word read whole; null for
// anything else (`$(`, `$1`, a lone `$`, a brace never closed).
function variableReferenceAt(spelling: string, at: number): VariableReference | null {
  const braced = spelling[at + 1] === '{';
  const indirect = braced && spelling[at + 2] === '!';
  const nameStart = at + (braced ? 2 : 1) + (indirect ? 1 : 0);
  const name = NAME_RE.exec(spelling.slice(nameStart))?.[0];
  if (name === undefined) return null;
  const afterName = nameStart + name.length;
  return braced ? bracedReference(spelling, name, indirect, afterName) : { name, indirect, operator: null, word: '', end: afterName };
}

// The rest of a `${NAME...}` reference from the character after the name.
function bracedReference(spelling: string, name: string, indirect: boolean, at: number): VariableReference | null {
  if (spelling[at] === '}') return { name, indirect, operator: '', word: '', end: at + 1 };
  if (at >= spelling.length) return null;
  const operator = PARAMETER_OPERATORS.find(candidate => spelling.startsWith(candidate, at)) ?? spelling[at];
  const wordStart = at + operator.length;
  const close = closingBrace(spelling, wordStart);
  return close === -1 ? null : { name, indirect, operator, word: spelling.slice(wordStart, close), end: close + 1 };
}

// `${NAME:offset}` and `${NAME:offset:length}` with literal numbers, a
// negative one counted from the end as the shell counts it; any other word
// leaves the value whole.
function substringOf(value: string, word: string): string {
  const range = /^\s*(-?\d+)\s*(?::\s*(-?\d+)\s*)?$/.exec(word);
  if (range === null) return value;
  const offset = Number(range[1]);
  if (range[2] === undefined) return value.slice(offset);
  const length = Number(range[2]);
  const from = offset < 0 ? Math.max(value.length + offset, 0) : offset;
  return length < 0 ? value.slice(from, length) : value.slice(from, from + length);
}

const GLOB_RE = /[*?[]/;

// `${NAME/pattern/string}` and `${NAME//pattern/string}` with a literal
// pattern; a pattern this check cannot read leaves the value whole.
function replaced(value: string, body: string, every: boolean): string {
  const split = body.indexOf('/');
  const pattern = split === -1 ? body : body.slice(0, split);
  const replacement = split === -1 ? '' : body.slice(split + 1);
  if (pattern === '' || GLOB_RE.test(pattern)) return value;
  return every ? value.split(pattern).join(replacement) : value.replace(pattern, replacement);
}

// `${NAME#pattern}` and `${NAME##pattern}`: the value without the prefix a
// literal pattern names, a `*` at its start standing for anything before.
function withoutPrefix(value: string, body: string, longest: boolean): string {
  const anything = body.startsWith('*');
  const literal = anything ? body.slice(1) : body;
  if (literal === '' || GLOB_RE.test(literal)) return value;
  if (!anything) return value.startsWith(literal) ? value.slice(literal.length) : value;
  const at = longest ? value.lastIndexOf(literal) : value.indexOf(literal);
  return at === -1 ? value : value.slice(at + literal.length);
}

// `${NAME%pattern}` and `${NAME%%pattern}`: the value without the suffix a
// literal pattern names, a `*` at its end standing for anything after.
function withoutSuffix(value: string, body: string, longest: boolean): string {
  const anything = body.endsWith('*');
  const literal = anything ? body.slice(0, -1) : body;
  if (literal === '' || GLOB_RE.test(literal)) return value;
  if (!anything) return value.endsWith(literal) ? value.slice(0, value.length - literal.length) : value;
  const at = longest ? value.indexOf(literal) : value.lastIndexOf(literal);
  return at === -1 ? value : value.slice(0, at);
}

// The pattern operators, in their single and doubled forms.
function patternResult(value: string, operator: string, word: string): string {
  const doubled = word.startsWith(operator);
  const body = doubled ? word.slice(1) : word;
  if (operator === '/') return replaced(value, body, doubled);
  return operator === '#' ? withoutPrefix(value, body, doubled) : withoutSuffix(value, body, doubled);
}

// `${NAME,}`, `${NAME,,}`, `${NAME^}` and `${NAME^^}`: the first character
// or the whole value in lower or upper case; a pattern after the operator
// leaves the value whole.
function caseChanged(value: string, operator: string, word: string): string {
  const whole = word === operator;
  if (word !== '' && !whole) return value;
  const change = operator === ',' ? (text: string) => text.toLowerCase() : (text: string) => text.toUpperCase();
  return whole ? change(value) : change(value.slice(0, 1)) + value.slice(1);
}

// What the values of a set variable become under an operator.
function operatorResult(values: readonly string[], operator: string, word: string): string[] {
  if (WORD_WHEN_SET.has(operator)) return [word];
  if (operator === ':') return values.map(value => substringOf(value, word));
  if (operator === ',' || operator === '^') return values.map(value => caseChanged(value, operator, word));
  if (operator === '#' || operator === '%' || operator === '/') return values.map(value => patternResult(value, operator, word));
  return [...values];
}

// The values the line gives the variable a reference reads: for `${!NAME}`,
// those of every variable the values of NAME name.
function boundValuesOf(reference: VariableReference): readonly string[] {
  const own = session.lineBound.get(reference.name) ?? [];
  if (!reference.indirect) return own;
  return own.flatMap(name => session.lineBound.get(name) ?? []);
}

// The index of the `}` closing the brace open before `from`, braces nested
// in between read whole, quoted text and escapes skipped; -1 when it never
// closes.
function closingBrace(spelling: string, from: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let i = from; i < spelling.length; i += 1) {
    const ch = spelling[i];
    if (quote !== null) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '\\') i += 1;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

// The word of an operator as the shell hands it over: a reference in it is
// read first, and its quotes are removed, since the shell removes them.
function operatorWords(reference: VariableReference, depth: number, budget: LineBudget): string[] {
  const raw = reference.word;
  const resolved = raw.includes('$') ? [raw, ...lineValuesOf(raw, depth + 1, budget)] : [raw];
  return [...new Set(resolved.map(word => unquoteWord(word)))];
}

// What a reference yields on this line, or null when it stays as written.
// Each value is read on its own: under an operator spelled with a colon an
// empty value counts as unset, as the shell counts it. An arithmetic offset
// or a pattern with a wildcard is beyond this check and leaves the value
// whole, which only adds spellings.
function referenceValues(reference: VariableReference, depth: number, budget: LineBudget): string[] | null {
  const { operator } = reference;
  // One value past the budget is enough to overflow it; the rest is never
  // read, so it is never materialized.
  const values = boundValuesOf(reference).slice(0, budget.left + 1);
  if (operator === null || operator === '') return values.length > 0 ? [...values] : null;
  const words = operatorWords(reference, depth, budget);
  const set = CONDITIONAL_COLON.has(operator) ? values.filter(value => value !== '') : [...values];
  const out: string[] = [];
  if (set.length > 0) out.push(...(WORD_WHEN_SET.has(operator) ? words : words.flatMap(word => operatorResult(set, operator, word))));
  if (set.length < values.length || values.length === 0) {
    if (WORD_WHEN_UNSET.has(operator)) out.push(...words);
    else if (WORD_WHEN_SET.has(operator) || EDITING_OPERATORS.has(operator)) out.push('');
    else if (out.length === 0) return null;
  }
  return [...new Set(out)];
}

// Every alternative of every part with the other parts at their first one,
// in rounds across the parts, so no part is starved by the ones before it.
function* oneByOne(parts: string[][], first: string[]): Generator<string> {
  const width = Math.max(...parts.map(alternatives => alternatives.length));
  for (let round = 1; round < width; round += 1) {
    for (const [index, alternatives] of parts.entries()) {
      if (round < alternatives.length) yield [...first.slice(0, index), alternatives[round], ...first.slice(index + 1)].join('');
    }
  }
}

// The product of the parts, in order, built only as far as it is read: an
// odometer over the parts, so a word of thousands of references costs no
// stack.
function* product(parts: string[][]): Generator<string> {
  if (parts.some(alternatives => alternatives.length === 0)) return;
  const index = parts.map(() => 0);
  for (;;) {
    yield parts.map((alternatives, i) => alternatives[index[i]]).join('');
    let i = parts.length - 1;
    while (i >= 0 && ++index[i] === parts[i].length) {
      index[i] = 0;
      i -= 1;
    }
    if (i < 0) return;
  }
}

// Adds the values to `out` while the budget lasts; false when one was left
// out, which marks the resolution as overflowing.
function takeWithin(out: Set<string>, values: Iterable<string>, budget: LineBudget): boolean {
  for (const value of values) {
    if (out.has(value)) continue;
    if (budget.left <= 0) {
      session.lineOverflow = true;
      return false;
    }
    out.add(value);
    budget.left -= 1;
  }
  return true;
}

// The combinations of the alternatives of the parts, within the budget: the
// ones that differ from the first in one part, then the rest of the product.
function combinations(parts: string[][], budget: LineBudget): string[] {
  const first = parts.map(alternatives => alternatives[0] ?? '');
  const out = new Set<string>();
  if (takeWithin(out, [first.join('')], budget) && takeWithin(out, oneByOne(parts, first), budget)) takeWithin(out, product(parts), budget);
  return [...out];
}

// The spelling with every reference the line resolves replaced by what it
// yields, one result per combination; empty when nothing in it resolves.
function lineValuesOnce(spelling: string, depth: number, budget: LineBudget): string[] {
  const parts: string[][] = [];
  let literalFrom = 0;
  let i = 0;
  while (i < spelling.length) {
    const reference = spelling[i] === '$' ? variableReferenceAt(spelling, i) : null;
    const values = reference === null ? null : referenceValues(reference, depth, budget);
    if (reference === null || values === null) {
      i += 1;
      continue;
    }
    parts.push([spelling.slice(literalFrom, i)], values);
    literalFrom = reference.end;
    i = reference.end;
  }
  if (parts.length === 0) return [];
  parts.push([spelling.slice(literalFrom)]);
  return combinations(parts, budget);
}

// What a spelling names once the variables the command line sets are put
// in: every bound variable in it is replaced by each value the line gives
// it, and every result is read again, since a value may name another bound
// variable; the depth of that chain is capped, so a value that names itself
// stops. A variable the line does not set, or sets from a source this check
// cannot read, stays as written, where it names no file. The spellings come
// after the original, so a reading that picks the first ones (pathValue)
// still gets the word as handed over. One budget covers the whole
// resolution of a spelling; a value it cannot fit refuses the command.
function lineValuesOf(spelling: string, depth: number, budget: LineBudget): string[] {
  if (depth >= MAX_LINE_DEPTH || !spelling.includes('$')) return [];
  const out = new Set<string>();
  for (const next of lineValuesOnce(spelling, depth, budget)) {
    out.add(next);
    for (const deeper of lineValuesOf(next, depth + 1, budget)) out.add(deeper);
  }
  return [...out];
}

function withLineValues(spellings: string[]): string[] {
  if (session.lineBound.size === 0) return spellings;
  return [...new Set(spellings.flatMap(spelling => [spelling, ...lineValuesOf(spelling, 0, { left: MAX_LINE_VALUES })]))];
}

// The readings of a path value, one per spelling pathSpellings gives.
export function pathReadings(): number[] {
  return process.platform === 'win32' ? [0, 1] : [0];
}

// A path value read out of an option word the shell handed over (see
// shellWord), in one of its spellings (see pathSpellings), so a quoted
// backslash stays in it and on Windows separates it. `stripped` is the word
// without quotes and backslashes the option was recognized by, and `at`
// where the value starts there; when the flag part does not read the same,
// `stripped` decides.
export function pathValue(word: string, stripped: string, at: number, reading = 0): string {
  const spellings = pathSpellings(word);
  const spelled = spellings[Math.min(reading, spellings.length - 1)];
  return spelled.startsWith(stripped.slice(0, at)) ? spelled.slice(at) : stripped.slice(at);
}

export function isProtectedOperand(arg: string, cwd?: string): boolean {
  return pathSpellings(arg).some(spelling => isProtectedPath(spelling, cwd));
}

export function isReadDeniedOperand(arg: string, cwd?: string): boolean {
  return pathSpellings(arg).some(spelling => isReadDeniedPath(spelling, cwd));
}

// The filesystem targets one spelling of an argument can carry: a bare
// operand (URIs excluded, they are download targets, not local paths), a
// --flag=value value, or a value glued to a short flag (`-o~/.bashrc`).
function candidatesOfSpelling(cased: string): string[] {
  const arg = cased.toLowerCase();
  if (!arg.startsWith('-')) {
    const unwrapped = unwrapFileUri(cased);
    if (unwrapped !== cased) return [unwrapped];
    return /^[a-z][a-z\d+.-]*:\/\//i.test(arg) ? [] : [cased];
  }
  const eq = cased.indexOf('=');
  if (eq > 0) return [unwrapFileUri(cased.slice(eq + 1))];
  if (!arg.startsWith('--') && arg.length > 2) return [unwrapFileUri(cased.slice(2))];
  return [];
}

export function pathCandidatesOf(args: string[]): string[] {
  return args.flatMap(rawArg => pathSpellings(rawArg).flatMap(candidatesOfSpelling));
}

// The spellings of a target that may name the file: what the shell hands
// over and, on Windows, where a backslash separates path components rather
// than escaping the next character, the word as typed.
export function targetSpellings(target: ShellWord): string[] {
  return withLineValues(process.platform === 'win32' ? [target.value, target.raw] : [target.value]);
}
