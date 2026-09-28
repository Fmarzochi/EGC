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

// A redirection word, and whether it takes the next word as its target.
const isRedirection = value => /^\d*[<>]/.test(value) || value.startsWith('&>');
const takesTarget = value => /^\d*[<>]+&?$/.test(value) || value === '&>';

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

// The file a command reads on standard input through `<` or `0<`.
function inputFile(values) {
  for (let i = 1; i < values.length; i += 1) {
    const match = /^0?<(?![<&(])(.*)$/.exec(values[i]);
    if (match) return match[1] || values[i + 1] || null;
  }
  return null;
}

function shellReads(words) {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === '--') return i + 1 >= words.length;
    if (!/^[-+]/.test(word)) return false;
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

function interpreterReads(name, words) {
  const valued = new Set(INTERPRETER_VALUES[name]);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === '-') return true;
    if (word === '--') return words[i + 1] === undefined || words[i + 1] === '-';
    if (!word.startsWith('-')) return false;
    if (PROGRAM_OPTIONS.has(word) || (name === 'pwsh' && /^-(?:file|f)$/i.test(word))) return words[i + 1] === '-';
    if (valued.has(word)) i += 1;
  }
  return true;
}

// Whether the command in `values` reads the program it runs from its
// standard input: { kind: 'shell' | 'scheduler' | 'interpreter', name,
// files }, files being the scripts at is given instead; null otherwise.
function stdinReaderOf(values) {
  const name = baseName(values[0]);
  const words = commandWords(values);
  if (SHELLS.has(name)) return shellReads(words) && inputFile(values) === null ? { kind: 'shell', name, files: [] } : null;
  if (SCHEDULERS.has(name)) {
    const files = schedulerFiles(words, values);
    return files === null ? null : { kind: 'scheduler', name, files };
  }
  const interpreter = interpreterOf(name);
  return interpreter && interpreterReads(interpreter, words) && inputFile(values) === null ? { kind: 'interpreter', name, files: [] } : null;
}

// The escapes echo -e and printf read that end or break a line.
const unescaped = text => text.replaceAll(String.raw`\n`, '\n').replaceAll(String.raw`\t`, '\t').replaceAll(String.raw`\r`, '\n');

function echoText(words) {
  let i = 0;
  let escapes = false;
  while (i < words.length && /^-[neE]+$/.test(words[i])) {
    if (words[i].includes('e')) escapes = true;
    if (words[i].includes('E')) escapes = false;
    i += 1;
  }
  const text = `${words.slice(i).join(' ')}\n`;
  return escapes ? unescaped(text) : text;
}

function printfText(words) {
  const [format = '', ...args] = words[0] === '--' ? words.slice(1) : words;
  let k = 0;
  return unescaped(format.replaceAll(/%[-+ #0-9.]*[sbdiqc]/g, () => args[k++] ?? ''));
}

// What the command in `values` writes to standard output, when it is a
// program the hook can read: { text } for echo, printf and a heredoc cat
// hands on, { files } for the files cat reads; null when it cannot be read.
function producedProgram(values, heredocBody) {
  const name = baseName(values[0]);
  const words = commandWords(values);
  if (name === 'echo') return { text: echoText(words) };
  if (name === 'printf') return { text: printfText(words) };
  if (name !== 'cat') return null;
  const files = words.filter(word => !word.startsWith('-') || word === '-');
  if (files.length > 0) return files.includes('-') ? null : { files };
  if (heredocBody !== null && heredocBody !== undefined) return { text: heredocBody };
  const redirected = inputFile(values);
  return redirected ? { files: [redirected] } : null;
}

module.exports = { stdinReaderOf, producedProgram };
