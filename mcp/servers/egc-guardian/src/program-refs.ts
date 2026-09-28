// The files and the commands the text of a program names, read in the
// program's own language: the file of a sed r, R, w or W command or of an
// s///w flag and the command of a sed e; the file a jq import or include
// reads; the file a yq load reads. An awk program that runs a command, reads
// a file or writes one is refused as a whole (see awkRefs). A command or a
// file the program builds from the data it reads cannot be judged before it
// runs: `opaque` says what does that.

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

// awk is a language of its own, and a slash in it is a division or a
// regular expression depending on its grammar, so a reader of its text can
// be led to take code for a string. What gawk --sandbox turns off is looked
// for in the raw text instead: system(), getline, extensions and includes,
// and a > or | after a print or a printf (an output redirection or a pipe).
// A program that has one is inline code with effects the Guardian cannot
// follow, as perl -e is; the plain text processing awk is used for passes.
const AWK_EFFECT_WORDS = /\b(?:system|getline)\b|@(?:load|include)\b/;

function awkRefs(program: string): ProgramRefs {
  const print = /\bprintf?\b/.exec(program);
  const redirected = print !== null && /[>|]/.test(program.slice(print.index));
  if (!AWK_EFFECT_WORDS.test(program) && !redirected) return noRefs();
  return { files: [], commands: [], opaque: 'runs a command, reads a file or writes one from its program (system(), getline, or a print sent to a file or a pipe)' };
}

// The string literals right after a pattern in a jq or yq program, and
// whether one of the places takes no literal.
function quotedAfter(text: string, pattern: RegExp): { values: string[]; computed: boolean } {
  const values: string[] = [];
  let computed = false;
  for (const match of text.matchAll(pattern)) {
    const from = nextVisible(text, (match.index ?? 0) + match[0].length);
    if (text[from] === '"') values.push(text.slice(from + 1, pastDelimiter(text, from + 1, '"') - 1).replaceAll(/\\(.)/g, '$1'));
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
