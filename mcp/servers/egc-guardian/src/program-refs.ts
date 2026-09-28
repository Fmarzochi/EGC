// The files and the commands the text of a program names, read in the
// program's own language: the file of a sed r, R, w or W command or of an
// s///w flag and the command of a sed e; the file an awk program reads with
// getline or writes with print, and the command it runs with system() or a
// pipe; the file a jq import or include reads; the file a yq load reads. A
// command or a file the program builds from the data it reads cannot be
// judged before it runs: `opaque` says what does that.

export interface ProgramRefs {
  files: string[];
  commands: string[];
  opaque: string | null;
}

const noRefs = (): ProgramRefs => ({ files: [], commands: [], opaque: null });

// The index just past the delimiter that closes a run started at `from`, a
// backslash escaping the character after it; a newline ends an open run.
function pastDelimiter(text: string, from: number, delimiter: string): number {
  for (let at = from; at < text.length; at++) {
    if (text[at] === '\\') at++;
    else if (text[at] === delimiter) return at + 1;
    else if (text[at] === '\n') return at;
  }
  return text.length;
}

function lineEnd(text: string, from: number): number {
  const newline = text.indexOf('\n', from);
  return newline < 0 ? text.length : newline;
}

// Where a label ends: at a semicolon or a newline, as GNU sed reads one.
function labelEnd(text: string, from: number): number {
  for (let at = from; at < text.length; at++) {
    if (text[at] === ';' || text[at] === '\n') return at;
  }
  return text.length;
}

function nextVisible(text: string, from: number): number {
  let at = from;
  while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at++;
  return at;
}

// sed: separators, then an address (line numbers, $, a regex between
// slashes or after a backslash, ranges and negation), then one command.
function sedRefs(script: string): ProgramRefs {
  const refs = noRefs();
  let at = 0;
  while (at < script.length) {
    at = skipSedAddress(script, skipSedSeparators(script, at));
    if (at < script.length) at = readSedCommand(script, at, refs);
  }
  return refs;
}

function skipSedSeparators(script: string, from: number): number {
  let at = from;
  while (at < script.length && /[\s;{}]/.test(script[at])) at++;
  return at;
}

const skipRegexModifiers = (script: string, from: number): number => {
  let at = from;
  while (script[at] === 'I' || script[at] === 'M') at++;
  return at;
};

function skipSedAddress(script: string, from: number): number {
  let at = from;
  while (at < script.length) {
    const char = script[at];
    if (char === '/') at = skipRegexModifiers(script, pastDelimiter(script, at + 1, '/'));
    else if (char === '\\' && at + 1 < script.length) at = skipRegexModifiers(script, pastDelimiter(script, at + 2, script[at + 1]));
    else if (/[\d$,~+! \t]/.test(char)) at++;
    else return at;
  }
  return at;
}

function noteSedFile(name: string, refs: ProgramRefs): void {
  const file = name.trim();
  if (file) refs.files.push(file);
}

function readSedCommand(script: string, at: number, refs: ProgramRefs): number {
  const command = script[at];
  const end = lineEnd(script, at);
  if ('rRwW'.includes(command)) {
    noteSedFile(script.slice(at + 1, end), refs);
    return end;
  }
  if (command === 'e') {
    const inner = script.slice(at + 1, end).trim();
    if (inner) refs.commands.push(inner);
    else refs.opaque = 'runs its pattern space as a command (sed e)';
    return end;
  }
  if (command === 's') return readSedSubstitute(script, at, refs);
  if (command === 'y') return pastDelimiter(script, pastDelimiter(script, at + 2, script[at + 1]), script[at + 1]);
  if ('aic#'.includes(command)) return end;
  if ('btT:v'.includes(command)) return labelEnd(script, at + 1);
  return at + 1;
}

// s/regex/replacement/flags: a w flag writes to the file up to the end of
// the line, an e flag runs the result as a command.
function readSedSubstitute(script: string, at: number, refs: ProgramRefs): number {
  const delimiter = script[at + 1];
  if (delimiter === undefined) return at + 1;
  let flag = pastDelimiter(script, pastDelimiter(script, at + 2, delimiter), delimiter);
  for (; flag < script.length && !';\n}'.includes(script[flag]); flag++) {
    if (script[flag] === 'w') {
      noteSedFile(script.slice(flag + 1, lineEnd(script, flag)), refs);
      return lineEnd(script, flag);
    }
    if (script[flag] === 'e') refs.opaque = 'runs the result of a substitution as a command (s///e)';
  }
  return flag;
}

// awk: string literals, regular expressions (a slash where an operand can
// start), comments, pipes and system() calls.
interface AwkLiteral {
  value: string;
  start: number;
  end: number;
}

interface AwkScan {
  literals: AwkLiteral[];
  pipes: number[];
  systems: number[];
  previous: string;
}

const AWK_REGEX_AFTER = new Set(['', '(', ',', '~', '!', '{', '}', ';', '&', '|', '=', '\n', '?', ':', '[']);

const unescapeAwk = (value: string): string => value.replaceAll(/\\(.)/g, '$1');

function scanAwk(program: string): AwkScan {
  const scan: AwkScan = { literals: [], pipes: [], systems: [], previous: '' };
  let at = 0;
  while (at < program.length) at = stepAwk(program, at, scan);
  return scan;
}

function stepAwk(program: string, at: number, scan: AwkScan): number {
  const char = program[at];
  if (char === '"') return readAwkString(program, at, scan);
  if (char === '/' && AWK_REGEX_AFTER.has(scan.previous)) {
    scan.previous = '/';
    return pastDelimiter(program, at + 1, '/');
  }
  if (char === '#') return lineEnd(program, at);
  if (char === '|') return readAwkPipe(program, at, scan);
  if (startsCall(program, at, 'system')) scan.systems.push(at);
  if (char !== ' ' && char !== '\t') scan.previous = char;
  return at + 1;
}

function readAwkString(program: string, at: number, scan: AwkScan): number {
  const end = pastDelimiter(program, at + 1, '"');
  scan.literals.push({ value: unescapeAwk(program.slice(at + 1, end - 1)), start: at, end });
  scan.previous = '"';
  return end;
}

function readAwkPipe(program: string, at: number, scan: AwkScan): number {
  scan.previous = '|';
  if (program[at + 1] === '|') return at + 2;
  scan.pipes.push(at);
  return at + (program[at + 1] === '&' ? 2 : 1);
}

function startsCall(program: string, at: number, name: string): boolean {
  if (!program.startsWith(name, at) || /\w/.test(program[at - 1] ?? '')) return false;
  return program[nextVisible(program, at + name.length)] === '(';
}

// The literal that alone fills a place starting at `from`: what follows it
// ends the expression (a closing, a separator or the end).
function soleLiteralAt(program: string, scan: AwkScan, from: number): AwkLiteral | null {
  const literal = scan.literals.find(item => item.start === nextVisible(program, from));
  if (!literal) return null;
  const after = program[nextVisible(program, literal.end)];
  return after === undefined || ';})\n'.includes(after) ? literal : null;
}

// A file an awk program reads or writes: a literal right after <, > or >>.
const redirectsTo = (program: string, start: number): boolean => /[<>]$/.test(program.slice(0, start).trimEnd());

function awkRefs(program: string): ProgramRefs {
  const scan = scanAwk(program);
  const refs = noRefs();
  for (const literal of scan.literals) {
    if (redirectsTo(program, literal.start)) refs.files.push(literal.value);
  }
  for (const at of scan.systems) noteAwkCommand(soleLiteralAt(program, scan, program.indexOf('(', at) + 1), refs, 'system()');
  for (const at of scan.pipes) noteAwkCommand(pipeCommand(program, scan, at), refs, 'a pipe');
  return refs;
}

function noteAwkCommand(literal: AwkLiteral | null, refs: ProgramRefs, place: string): void {
  if (literal) refs.commands.push(literal.value);
  else refs.opaque = `runs a command it builds from the data it reads through ${place}`;
}

// The command a pipe runs: the literal after it (print | "cmd"), or the
// literal before it when getline reads from it ("cmd" | getline).
function pipeCommand(program: string, scan: AwkScan, at: number): AwkLiteral | null {
  const right = nextVisible(program, at + (program[at + 1] === '&' ? 2 : 1));
  if (!program.startsWith('getline', right)) return soleLiteralAt(program, scan, right);
  const end = program.slice(0, at).trimEnd().length;
  const literal = scan.literals.find(item => item.end === end);
  if (!literal) return null;
  const before = program.slice(0, literal.start).trimEnd();
  return before === '' || /[;{}(,\n]$/.test(before) ? literal : null;
}

// The string literals right after a pattern in a jq or yq program, and
// whether one of the places takes no literal.
function quotedAfter(text: string, pattern: RegExp): { values: string[]; computed: boolean } {
  const values: string[] = [];
  let computed = false;
  for (const match of text.matchAll(pattern)) {
    const from = nextVisible(text, (match.index ?? 0) + match[0].length);
    if (text[from] === '"') values.push(unescapeAwk(text.slice(from + 1, pastDelimiter(text, from + 1, '"') - 1)));
    else computed = true;
  }
  return { values, computed };
}

function yqRefs(expression: string): ProgramRefs {
  const loads = quotedAfter(expression, /\bload(?:_str|_xml|_props|_base64|_sops)?\s*\(/g);
  return { files: loads.values, commands: [], opaque: loads.computed ? 'loads a file whose path the expression computes (yq load)' : null };
}

/** The files and the commands a sed, awk, jq or yq program names in its text. */
export function programRefs(language: string | null, text: string): ProgramRefs {
  if (language === 'sed') return sedRefs(text);
  if (language === 'awk') return awkRefs(text);
  if (language === 'jq') return { files: quotedAfter(text, /\b(?:import|include)\b/g).values, commands: [], opaque: null };
  if (language === 'yq') return yqRefs(text);
  return noRefs();
}
