'use strict';

/**
 * Commands that read the program they run from their standard input, and
 * what the command before them in a pipeline hands them there, for the Bash
 * hook: a shell with no script operand (or with -s), at and batch, which run
 * the shell commands they read, and interpreters of other languages reading
 * their code (`echo 'code' | python3`). Each works on the values of a
 * command's words, environment assignments and wrappers already skipped.
 */

const SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'ash', 'mksh', 'yash']);
// Shell options whose value is the next word.
const SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const SCHEDULERS = new Set(['at', 'batch']);
// at's options: those that take a value, and those after which it reads no
// commands (listing, removing or printing jobs).
const AT_VALUE_LETTERS = 'fqt';
const AT_NO_PROGRAM = /[lrdc]/;
// Interpreters of other languages, and the options of each that take the
// next word as their value; a module (-m) or file (-f) given to them is the
// program, not their input.
const INTERPRETER_VALUES = {
  python: ['-W', '-X', '-Q', '-m'], perl: ['-I', '-M', '-m', '-x'], ruby: ['-I', '-r', '-C', '-E', '-F'],
  node: ['-r', '--require', '--import', '-C', '--conditions', '--loader', '--experimental-loader', '--input-type'],
  php: ['-c', '-d', '-z', '-f', '-t'], lua: ['-l'], pwsh: ['-File', '-f', '-Command', '-c', '-ExecutionPolicy', '-ex'],
  tclsh: [], osascript: ['-l', '-s'],
};
const INTERPRETER_ALIASES = { nodejs: 'node', luajit: 'lua', powershell: 'pwsh', wish: 'tclsh' };
const PROGRAM_OPTIONS = new Set(['-m', '-f']);

const baseName = value => String(value ?? '').split(/[\\/]/).pop().replace(/\.exe$/i, '');

// A name without the version it ends with (python3.12 is python).
function withoutVersion(name) {
  let end = name.length;
  while (end > 0 && '0123456789.'.includes(name[end - 1])) end -= 1;
  return name.slice(0, end);
}

function interpreterOf(name) {
  const plain = withoutVersion(name);
  if (INTERPRETER_VALUES[plain]) return plain;
  return INTERPRETER_ALIASES[name] ?? null;
}

// A path that names the standard input of the process that opens it, and a
// path whose bytes only exist while the command runs: one of its file
// descriptors, or a process substitution.
const STDIN_PATH_RE = /^\/(?:dev\/stdin|dev\/fd\/0|proc\/[^/]+\/fd\/0)$/;
const RUNTIME_PATH_RE = /^(?:\/(?:dev\/(?:stdin|stdout|stderr|fd\/)|proc\/[^/]+\/fd\/)|[<>]\()/;
const isStdinPath = value => STDIN_PATH_RE.test(String(value ?? ''));
const isRuntimeOnly = value => RUNTIME_PATH_RE.test(String(value ?? ''));

// A redirection word, and whether it takes the next word as its target. A
// process substitution (<(...), >(...)) is an operand, not a redirection.
const isRedirection = value => /^\d*[<>](?!\()/.test(value) || value.startsWith('&>');
const takesTarget = value => /^(?:\d*(?:<<<|<<-?|<>|<&|>&|>>|>\||<|>)|&>>?)$/.test(value);

// The words a command reads on its own line, redirections left out: its
// options and its operands.
function commandWords(values) {
  const words = [];
  for (let i = 1; i < values.length; i += 1) {
    if (isRedirection(values[i])) {
      if (takesTarget(values[i])) i += 1;
    } else {
      words.push(values[i]);
    }
  }
  return words;
}

// The file a command reads on standard input through `<`, `0<` or `<>`, the
// last one winning as in the shell; input taken from another descriptor
// (<&3) is that descriptor's path.
function inputFile(values) {
  let file = null;
  for (let i = 1; i < values.length; i += 1) {
    const duplicated = /^0?<&(.*)$/.exec(values[i]);
    const match = duplicated ? null : /^0?<>?(?![<&(])(.*)$/.exec(values[i]);
    if (duplicated) {
      const fd = duplicated[1] || values[i + 1];
      if (/^\d+$/.test(fd ?? '')) file = `/dev/fd/${fd}`;
    } else if (match) {
      file = match[1] || values[i + 1] || null;
    }
  }
  return file;
}

function shellReads(words) {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === '--') return i + 1 >= words.length || isStdinPath(words[i + 1]);
    if (!/^[-+]/.test(word)) return isStdinPath(word);
    if (/^-[a-zA-Z]*c/.test(word) || word === '--command') return false;
    if (/^-[a-zA-Z]*s/.test(word)) return true;
    if (SHELL_VALUE_OPTIONS.has(word)) i += 1;
  }
  return true;
}

// The files at runs the commands of (-f, or its standard input), or [] when
// it reads them from standard input; null when it runs none.
function schedulerFiles(words, values) {
  const files = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (!word.startsWith('-') || word === '-') continue;
    const letters = word.slice(1);
    const valued = [...letters].findIndex(letter => AT_VALUE_LETTERS.includes(letter));
    if (AT_NO_PROGRAM.test(valued < 0 ? letters : letters.slice(0, valued))) return null;
    if (valued < 0) continue;
    const attached = letters.slice(valued + 1);
    const value = attached || words[i + 1];
    if (letters[valued] === 'f' && value) files.push(value);
    if (!attached) i += 1;
  }
  const redirected = inputFile(values);
  return redirected ? [...files, redirected] : files;
}

// Where a program named by `word` comes from: '' for the standard input,
// the word itself for a path that only exists while the command runs, and
// undefined for a file or a module.
function programSource(word) {
  if (word === '-' || isStdinPath(word)) return '';
  return isRuntimeOnly(word) ? word : undefined;
}

// Where an interpreter reads the program it runs, as programSource tells.
function interpreterSource(name, words) {
  const valued = new Set(INTERPRETER_VALUES[name]);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === '-') return '';
    if (word === '--') return programSource(words[i + 1] ?? '-');
    if (!word.startsWith('-')) return programSource(word);
    if (PROGRAM_OPTIONS.has(word) || (name === 'pwsh' && /^-(?:file|f)$/i.test(word))) return programSource(words[i + 1]);
    if (valued.has(word)) i += 1;
  }
  return '';
}

function interpreterReader(name, interpreter, words, redirected) {
  const source = interpreterSource(interpreter, words);
  // Standard input redirected from a file makes that file the program.
  const from = source === '' && redirected !== null ? programSource(redirected) : source;
  if (from === undefined) return null;
  return { kind: 'interpreter', name, files: from === '' ? [] : [from] };
}

// Whether the command in `values` reads the program it runs from its
// standard input: { kind: 'shell' | 'scheduler' | 'interpreter', name,
// files }, files being what it reads instead (the scripts at is given, the
// file a shell's input is redirected from, the path only the running
// command has that an interpreter reads); null otherwise.
function stdinReaderOf(values) {
  const name = baseName(values[0]);
  const words = commandWords(values);
  const redirected = inputFile(values);
  if (SHELLS.has(name)) return shellReads(words) ? { kind: 'shell', name, files: redirected === null ? [] : [redirected] } : null;
  if (SCHEDULERS.has(name)) {
    const files = schedulerFiles(words, values);
    return files === null ? null : { kind: 'scheduler', name, files };
  }
  const interpreter = interpreterOf(name);
  return interpreter ? interpreterReader(name, interpreter, words, redirected) : null;
}

// The escapes echo -e and printf read that end or break a line.
const unescaped = text => text.replaceAll(String.raw`\n`, '\n').replaceAll(String.raw`\t`, '\t').replaceAll(String.raw`\r`, '\n');
const onlyLineEscapes = text => !text.replaceAll(/\\[ntr]/g, '').includes('\\');

// What echo writes. Which escapes it reads depends on the shell that runs
// it (dash reads them all, with or without -e), so a backslash is read only
// as \n, \t or \r under -e; any other leaves the text unknown (null).
function echoText(words) {
  let i = 0;
  let escapes = false;
  while (i < words.length && /^-[neE]+$/.test(words[i])) {
    if (words[i].includes('e')) escapes = true;
    if (words[i].includes('E')) escapes = false;
    i += 1;
  }
  const text = `${words.slice(i).join(' ')}\n`;
  if (!text.includes('\\')) return text;
  return escapes && onlyLineEscapes(text) ? unescaped(text) : null;
}

// The escape or conversion a printf format holds at `i`: the text it stands
// for, or its conversion letter; null when this hook does not read it.
function printfToken(format, i) {
  const next = format[i + 1];
  if (format[i] === '\\') return next !== undefined && 'ntr'.includes(next) ? { text: next === 't' ? '\t' : '\n' } : null;
  if (next === '%') return { text: '%' };
  return next === 's' || next === 'b' ? { conversion: next } : null;
}

// A printf format as literal pieces and the %s or %b between them; null
// when it holds anything else (a width, a precision, %c or %d, an escape
// other than \n, \t or \r), whose output is not the text on the line.
function printfFormat(format) {
  const pieces = [];
  let literal = '';
  for (let i = 0; i < format.length; i += 1) {
    if (format[i] !== '\\' && format[i] !== '%') {
      literal += format[i];
      continue;
    }
    const token = printfToken(format, i);
    if (token === null) return null;
    if (token.conversion) pieces.push(literal, token.conversion);
    literal = token.conversion ? '' : literal + token.text;
    i += 1;
  }
  return [...pieces, literal];
}

// What printf writes: the format is used again until every argument is
// taken, as printf does. null for an option (-v writes a variable) or a
// format or %b argument this hook does not read exactly.
function printfText(words) {
  const [format, ...args] = words[0] === '--' ? words.slice(1) : words;
  if (format === undefined || format.startsWith('-')) return null;
  const pieces = printfFormat(format);
  if (pieces === null) return null;
  const conversions = (pieces.length - 1) / 2;
  let text = '';
  let taken = 0;
  do {
    for (const [p, piece] of pieces.entries()) {
      const arg = p % 2 === 0 ? piece : args[taken++] ?? '';
      if (p % 2 === 1 && piece === 'b' && arg.includes('\\')) return null;
      text += arg;
    }
  } while (conversions > 0 && taken < args.length);
  return text;
}

// The files cat writes out; null when an option changes what it writes (-n
// numbers the lines, -v shows control characters), -u aside, which it
// ignores.
function catFiles(words) {
  const files = [];
  let options = true;
  for (const word of words) {
    if (options && word === '--') options = false;
    else if (options && word.startsWith('-') && word !== '-') {
      if (word !== '-u') return null;
    } else files.push(word);
  }
  return files;
}

const WRITE_RE = /^(\d*|&)(>&|>\||>>?)(.*)$/;
const placed = target => (target === '/dev/null' ? 'null' : 'unknown');

function duplicated(fds, target) {
  if (target === '-') return 'closed';
  return /^\d+$/.test(target) ? fds.get(target) ?? 'unknown' : placed(target);
}

// Whether what a command writes on standard output never reaches the pipe:
// fd 1 sent to /dev/null, closed, or joined to fd 2 while fd 2 is still the
// command's own. Any other target keeps it there: a file can be a link to
// the pipe, a descriptor path or a process substitution can lead back to it.
function stdoutLeavesPipe(values) {
  const fds = new Map([['1', 'pipe'], ['2', 'stderr']]);
  for (let i = 1; i < values.length; i += 1) {
    const match = WRITE_RE.exec(values[i]);
    if (!match) continue;
    const [, fd, operator, attached] = match;
    const target = attached || values[i + 1] || '';
    if (!attached) i += 1;
    const where = operator === '>&' ? duplicated(fds, target) : placed(target);
    const both = fd === '&' || (fd === '' && operator === '>&' && !/^(?:\d+|-)$/.test(target));
    for (const which of both ? ['1', '2'] : [fd || '1']) fds.set(which, where);
  }
  return ['null', 'closed', 'stderr'].includes(fds.get('1'));
}

const textOf = text => (text === null ? null : { text });

// What the command in `values` writes to standard output, when it is a
// program the hook can read: { text } for echo, printf and a heredoc cat
// hands on (empty when its output never reaches the pipe), { files } for
// the files cat reads; null when it cannot be read.
function producedProgram(values, heredocBody) {
  if (stdoutLeavesPipe(values)) return { text: '' };
  const name = baseName(values[0]);
  const words = commandWords(values);
  if (name === 'echo') return textOf(echoText(words));
  if (name === 'printf') return textOf(printfText(words));
  if (name !== 'cat') return null;
  const files = catFiles(words);
  if (files === null || files.some(file => file === '-' || isRuntimeOnly(file))) return null;
  if (files.length > 0) return { files };
  if (heredocBody !== null && heredocBody !== undefined) return { text: heredocBody };
  const redirected = inputFile(values);
  return redirected && !isRuntimeOnly(redirected) ? { files: [redirected] } : null;
}

module.exports = { stdinReaderOf, producedProgram, isRedirection, takesTarget, isRuntimeOnly, isStdinPath };
