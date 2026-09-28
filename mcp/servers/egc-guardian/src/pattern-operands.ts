// A program, a pattern or a filter a command is handed is text it reads,
// not a file it opens: sed's script, awk's program, jq's and yq's filter,
// the pattern of rg and ag, tr's sets. A protected name inside one
// (`jq '.env'`, `sed 's/process.env.X/y/'`) is not the file it looks like;
// the files and the commands the program's own text names are read in its
// language (program-refs.ts) and judged. Each table lists the options of the
// command's manual: those that take a value (the next word, or glued on),
// those that take none, those whose value may only be glued on (a file when
// given), those that hand the program in (then every operand is a file),
// those whose value is a file the command reads or writes, and those whose
// value is program text. An option a table does not know leaves the command
// judged as before, every word a path, so a missing entry never lets a file
// through.

interface ProgramSpec {
  values: Set<string>;
  flags: Set<string>;
  optional?: Set<string>;
  program: Set<string>;
  files: Set<string>;
  // The language of the program text: sed, awk, jq or yq.
  language?: string;
  // Options whose value is program text (sed -e, gawk --source).
  programValues?: Set<string>;
  // Options whose value is NAME=value (awk -v): the value may name a file.
  assignOptions?: Set<string>;
  // Options whose value is a command the tool runs (ag --pager, rg --pre).
  commandOptions?: Set<string>;
  // jq --arg NAME VALUE: two words, the second a file when true.
  pairs?: Map<string, boolean>;
  // yq: a first word that names the mode, not the filter.
  modes?: Set<string>;
  // awk: a NAME=value operand sets a variable, whose value may name a file.
  assignments?: boolean;
  // tr: every operand is a set of characters.
  textOperands?: boolean;
  // jq --args, --jsonargs: the operands after them are values.
  argsAfter?: Set<string>;
}

const set = (words: string): Set<string> => new Set(words.split(' '));

const AWK: ProgramSpec = {
  values: set('-F --field-separator -v --assign -f --file -e --source -i --include -l --load -E --exec -W'),
  flags: set('-b --characters-as-bytes -c --traditional -C --copyright -g --gen-pot -h --help -M --bignum -n --non-decimal-data -N --use-lc-numeric -O --optimize -P --posix -r --re-interval -s --no-optimize -S --sandbox -t --lint-old -V --version'),
  optional: set('-d --dump-variables -D --debug -L --lint -o --pretty-print -p --profile'),
  program: set('-f --file -e --source -E --exec'),
  files: set('-f --file -i --include -l --load -E --exec'),
  language: 'awk',
  programValues: set('-e --source'),
  assignOptions: set('-v --assign'),
  assignments: true,
};

const PROGRAM_SPECS: Record<string, ProgramSpec> = {
  sed: {
    values: set('-e --expression -f --file -l --line-length'),
    flags: set('-n --quiet --silent -E -r --regexp-extended -s --separate -z --null-data -u --unbuffered --posix --debug --sandbox --follow-symlinks -b --binary --help --version'),
    optional: set('-i --in-place'),
    program: set('-e --expression -f --file'),
    files: set('-f --file'),
    language: 'sed',
    programValues: set('-e --expression'),
  },
  awk: AWK,
  gawk: AWK,
  mawk: AWK,
  nawk: AWK,
  jq: {
    values: set('-f --from-file -L --indent'),
    flags: set('-n --null-input -r --raw-output -j --join-output -a --ascii-output -c --compact-output -s --slurp -e --exit-status -S --sort-keys -C --color-output -M --monochrome-output --tab --stream --stream-errors --seq -R --raw-input --raw-output0 --unbuffered -h --help -V --version --build-configuration --args --jsonargs'),
    program: set('-f --from-file'),
    files: set('-f --from-file -L'),
    language: 'jq',
    pairs: new Map([['--arg', false], ['--argjson', false], ['--slurpfile', true], ['--rawfile', true]]),
    argsAfter: set('--args --jsonargs'),
  },
  yq: {
    values: set('-o --output-format -p --input-format -I --indent --from-file --expression -s --split-exp --front-matter'),
    flags: set('-i --inplace -P --prettyPrint -C --colors -M --no-colors -N --no-doc -e --exit-status -n --null-input -r --unwrapScalar -v --verbose -V --version -h --help -0 --nul-output'),
    program: set('--from-file --expression'),
    files: set('--from-file'),
    language: 'yq',
    programValues: set('--expression'),
    modes: set('eval e eval-all ea'),
  },
  rg: {
    values: set('-e --regexp -f --file -g --glob --iglob -t --type -T --type-not --type-add --type-clear -A --after-context -B --before-context -C --context -m --max-count -d --max-depth --max-filesize -j --threads -M --max-columns -r --replace -E --encoding --ignore-file --pre --pre-glob --sort --sortr --colors --color --path-separator --context-separator --field-match-separator --field-context-separator --engine --dfa-size-limit --regex-size-limit'),
    flags: set('-i --ignore-case -s --case-sensitive -S --smart-case -w --word-regexp -x --line-regexp -v --invert-match -n --line-number -N --no-line-number -l --files-with-matches --files-without-match -c --count --count-matches -o --only-matching -F --fixed-strings -P --pcre2 -U --multiline --multiline-dotall -u --unrestricted -. --hidden -L --follow -z --search-zip -a --text --no-ignore --no-ignore-vcs --no-ignore-dot --no-ignore-global --no-ignore-parent --no-ignore-exclude --no-ignore-files --json -q --quiet --files -0 --null --vimgrep --heading --no-heading -b --byte-offset --column --no-column --trim --stats -H --with-filename -I --no-filename -p --pretty --no-messages --binary --crlf --passthru --no-config --one-file-system --line-buffered --block-buffered --sort-files --null-data -h --help -V --version'),
    program: set('-e --regexp -f --file'),
    files: set('-f --file --ignore-file'),
    commandOptions: set('--pre'),
  },
  ag: {
    values: set('-A --after -B --before -C --context -G --file-search-regex -g --ignore --ignore-dir -m --max-count --depth -W --width --pager -p --path-to-ignore'),
    flags: set('-a --all-types -c --count -D --debug -f --follow -F --fixed-strings -H --heading --noheading -i --ignore-case -l --files-with-matches -L --files-without-matches -n --norecurse -Q --literal -s --case-sensitive -S --smart-case -t --all-text -u --unrestricted -U --skip-vcs-ignores -v --invert-match -w --word-regexp -z --search-zip -0 --null --print0 --column --nocolor --color --hidden --silent --stats --vimgrep -o --only-matching --nofilename --filename -h --help --version'),
    program: set('-g'),
    files: set('-p --path-to-ignore'),
    commandOptions: set('--pager'),
  },
  tr: {
    values: new Set(),
    flags: set('-c -C -d -s -t --complement --delete --squeeze-repeats --truncate-set1 --help --version'),
    program: new Set(),
    files: new Set(),
    textOperands: true,
  },
};

const bare = (word: string): string => word.replaceAll('\\', '').replaceAll(/["']/g, '');

interface OptionRead {
  // Words after this one the option takes as its value.
  consumed: number;
  program?: boolean;
  file?: string;
  text?: string;
  command?: string;
  argsAfter?: boolean;
}

// The value of NAME=value, which an awk program may use as a file name.
const assignedValue = (word: string | undefined): string | undefined => /^[A-Za-z_]\w*=([^]*)$/.exec(word ?? '')?.[1];

// The file an option's value names: its value for a file option, the value
// it assigns for an assignment option.
function optionFile(spec: ProgramSpec, name: string, value: string | undefined): string | undefined {
  if (spec.files.has(name)) return value;
  return spec.assignOptions?.has(name) ? assignedValue(value) : undefined;
}

// An option that takes a value: glued on (`--file=x`, `-fx`) or the next word.
function optionValue(spec: ProgramSpec, name: string, glued: string | null, next: string | undefined): OptionRead {
  const value = glued ?? next;
  return {
    consumed: glued === null ? 1 : 0,
    program: spec.program.has(name),
    file: optionFile(spec, name, value),
    text: spec.programValues?.has(name) ? value : undefined,
    command: spec.commandOptions?.has(name) ? value : undefined,
  };
}

// An option whose value may only be glued on names a file when it has one
// (sed -i.bak writes a backup, gawk -d.env dumps its variables there).
const optionalRead = (glued: string | null): OptionRead => ({ consumed: 0, file: glued || undefined });

// jq's two-word options: the second word is a file only for --slurpfile and
// --rawfile.
const pairRead = (fileSecond: boolean, args: string[], at: number): OptionRead =>
  fileSecond ? { consumed: 2, file: args[at + 2] } : { consumed: 2 };

function readLongOption(spec: ProgramSpec, word: string, args: string[], at: number): OptionRead | null {
  const eq = word.indexOf('=');
  const name = eq < 0 ? word : word.slice(0, eq);
  const glued = eq < 0 ? null : word.slice(eq + 1);
  const pair = spec.pairs?.get(name);
  if (pair !== undefined) return glued === null ? pairRead(pair, args, at) : null;
  if (spec.values.has(name)) return optionValue(spec, name, glued, args[at + 1]);
  if (spec.optional?.has(name)) return optionalRead(glued);
  if (glued === null && spec.flags.has(name)) return { consumed: 0, argsAfter: spec.argsAfter?.has(name) };
  return null;
}

function readShortOptions(spec: ProgramSpec, word: string, args: string[], at: number): OptionRead | null {
  for (let letter = 1; letter < word.length; letter++) {
    const name = `-${word[letter]}`;
    const rest = word.slice(letter + 1);
    if (spec.values.has(name)) return optionValue(spec, name, rest === '' ? null : rest, args[at + 1]);
    if (spec.optional?.has(name)) return optionalRead(rest);
    if (!spec.flags.has(name)) return null;
  }
  return { consumed: 0 };
}

function readOption(spec: ProgramSpec, args: string[], at: number): OptionRead | null {
  const word = bare(args[at]);
  if (spec.flags.has(word) && !word.startsWith('--')) return { consumed: 0 };
  return word.startsWith('--') ? readLongOption(spec, word, args, at) : readShortOptions(spec, word, args, at);
}

interface OperandState {
  programGiven: boolean;
  programSeen: boolean;
  argsOnly: boolean;
  firstOperand: boolean;
}

/** What a command whose first operand is a program names: the files among its words, the program texts it runs and their language, and the commands its options run. */
export interface ProgramRead {
  files: string[];
  programs: string[];
  commands: string[];
  language: string | null;
}

// A program as the tool gets it: on Windows a word can still carry the
// quotes around it, which the tool never sees.
const programText = (raw: string): string =>
  process.platform === 'win32' && /^(["']).*\1$/s.test(raw) ? raw.slice(1, -1) : raw;

// An operand once the options before it are read: the mode word, a value
// after --args and a character set name nothing; the first one is the
// program; an assignment names the file its value may be; the rest are files.
function readOperand(spec: ProgramSpec, state: OperandState, raw: string, out: ProgramRead): void {
  const word = bare(raw);
  const isMode = state.firstOperand && spec.modes?.has(word) === true;
  state.firstOperand = false;
  if (isMode || state.argsOnly || spec.textOperands) return;
  if (!state.programGiven && !state.programSeen) {
    state.programSeen = true;
    out.programs.push(programText(raw));
    return;
  }
  const assigned = spec.assignments ? assignedValue(word) : undefined;
  out.files.push(assigned ?? raw);
}

/**
 * What a command whose first operand is a program, a pattern or a filter
 * names: its operands after that one, the values of its file options and
 * the program texts it runs. null when the command is not one of these, or
 * uses an option its table does not know; then every word is judged.
 */
export function programCommandOf(command: string, args: string[]): ProgramRead | null {
  const spec = PROGRAM_SPECS[command];
  if (!spec) return null;
  const out: ProgramRead = { files: [], programs: [], commands: [], language: spec.language ?? null };
  const state: OperandState = { programGiven: false, programSeen: false, argsOnly: false, firstOperand: true };
  let options = true;
  for (let at = 0; at < args.length; at++) {
    const word = bare(args[at]);
    if (options && word === '--') {
      options = false;
      continue;
    }
    if (options && isOption(word)) {
      const read = readOption(spec, args, at);
      if (read === null) return null;
      at += noteOption(state, out, read);
      continue;
    }
    readOperand(spec, state, args[at], out);
  }
  return out;
}

const isOption = (word: string): boolean => word.length > 1 && word.startsWith('-');

// What an option read tells: whether it handed the program in, whether the
// operands after it are values, its file, its program text; how many words
// after it it took.
function noteOption(state: OperandState, out: ProgramRead, read: OptionRead): number {
  state.programGiven ||= read.program === true;
  state.argsOnly ||= read.argsAfter === true;
  if (read.file !== undefined) out.files.push(read.file);
  if (read.text !== undefined) out.programs.push(read.text);
  if (read.command !== undefined) out.commands.push(read.command);
  return read.consumed;
}

// The options whose value is text in each git subcommand (a message, a
// search, a date or a format), the short ones as letters, and the other
// short letters that take a value, which end the reading of a bundle.
interface GitTextOptions {
  short: string;
  long: Set<string>;
  valued: string;
}

const GIT_LOG_TEXT: GitTextOptions = {
  short: 'SG',
  long: set('--grep --author --committer --grep-reflog --format --pretty --since --until --after --before --date --since-as-filter'),
  valued: 'n',
};

const GIT_TEXT_OPTIONS: Record<string, GitTextOptions> = {
  commit: { short: 'm', long: set('--message --author --date --trailer'), valued: 'FtCcuS' },
  tag: { short: 'm', long: set('--message'), valued: 'uFn' },
  merge: { short: 'm', long: set('--message'), valued: 'sXF' },
  stash: { short: 'm', long: set('--message'), valued: '' },
  notes: { short: 'm', long: set('--message'), valued: 'FCc' },
  log: GIT_LOG_TEXT,
  show: GIT_LOG_TEXT,
  shortlog: GIT_LOG_TEXT,
  whatchanged: GIT_LOG_TEXT,
  'rev-list': GIT_LOG_TEXT,
  reflog: GIT_LOG_TEXT,
};

// How many words a text option takes out, from this one: 0 when the word is
// not one, 1 when its value is glued on, 2 when the value is the next word.
function textOptionWidth(text: GitTextOptions, word: string): number {
  if (word.startsWith('--')) return longTextWidth(text, word);
  return word.startsWith('-') ? shortTextWidth(text, word) : 0;
}

function longTextWidth(text: GitTextOptions, word: string): number {
  const eq = word.indexOf('=');
  if (!text.long.has(eq < 0 ? word : word.slice(0, eq))) return 0;
  return eq < 0 ? 2 : 1;
}

function shortTextWidth(text: GitTextOptions, word: string): number {
  for (let letter = 1; letter < word.length; letter++) {
    if (text.short.includes(word[letter])) return letter + 1 < word.length ? 1 : 2;
    if (text.valued.includes(word[letter])) return 0;
  }
  return 0;
}

const GIT_GREP_VALUED = set('-A -B -C -m --max-count --max-depth --threads --context --after-context --before-context');

// A short bundle of git grep: whether it hands the pattern in (-e, which is
// text, or -f, whose file stays judged) and whether its value is the next
// word.
function gitGrepBundle(word: string): { pattern: boolean; text: boolean; next: boolean } {
  for (let letter = 1; letter < word.length; letter++) {
    const last = letter === word.length - 1;
    if (word[letter] === 'e') return { pattern: true, text: true, next: last };
    if ('fABCm'.includes(word[letter])) return { pattern: word[letter] === 'f', text: false, next: last };
  }
  return { pattern: false, text: false, next: false };
}

// git grep [options] <pattern> [<rev>...] [--] [<pathspec>...]: the pattern
// and the -e values are text; everything else stays judged.
function gitGrepWords(rest: string[]): string[] {
  const kept: string[] = [];
  const state = { patternGiven: false };
  for (let at = 0; at < rest.length; at++) {
    const word = bare(rest[at]);
    if (word === '--') return [...kept, ...rest.slice(at)];
    if (word.startsWith('--')) at += keepLongGrepOption(rest, at, word, kept);
    else if (isOption(word)) at += readGrepBundle(rest, at, word, kept, state);
    else if (state.patternGiven) kept.push(rest[at]);
    else state.patternGiven = true;
  }
  return kept;
}

// A long option of git grep stays judged, with its value when it takes one;
// how many words after it it took.
function keepLongGrepOption(rest: string[], at: number, word: string, kept: string[]): number {
  kept.push(rest[at]);
  if (!GIT_GREP_VALUED.has(word) || at + 1 >= rest.length) return 0;
  kept.push(rest[at + 1]);
  return 1;
}

// A short bundle of git grep: an -e value is text and leaves with its
// option, anything else stays judged; how many words after it it took.
function readGrepBundle(rest: string[], at: number, word: string, kept: string[], state: { patternGiven: boolean }): number {
  const bundle = gitGrepBundle(word);
  state.patternGiven ||= bundle.pattern;
  if (!bundle.text) kept.push(rest[at]);
  if (!bundle.next || at + 1 >= rest.length) return 0;
  if (!bundle.text) kept.push(rest[at + 1]);
  return 1;
}

/**
 * The words after a git subcommand that can name a file: its words without
 * the values of its text options (a commit message, a log search) and, for
 * grep, without the pattern. Everything else stays, as before.
 */
export function gitWordsNamingFiles(subcommand: string, rest: string[]): string[] {
  if (subcommand === 'grep') return gitGrepWords(rest);
  const text = GIT_TEXT_OPTIONS[subcommand];
  if (!text) return rest;
  const kept: string[] = [];
  for (let at = 0; at < rest.length; at++) {
    const word = bare(rest[at]);
    if (word === '--') return [...kept, ...rest.slice(at)];
    const width = textOptionWidth(text, word);
    if (width === 0) kept.push(rest[at]);
    at += Math.max(width - 1, 0);
  }
  return kept;
}
